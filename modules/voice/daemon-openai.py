"""Daemon Claude Voice (OpenAI TTS) — usa a API da OpenAI em vez de modelo
local. Não precisa GPU, não carrega modelo, voz idêntica sempre.

Mesma API socket dos outros daemons (daemon.py, daemon-xtts.py):
  {"cmd": "speak", "text": "..."}     -> [summarize?] -> sintetiza -> toca
  {"cmd": "stop"}                     -> interrompe áudio em curso
  {"cmd": "ping"}                     -> health check
  {"cmd": "reload"}                   -> recarrega config.json
  {"cmd": "shutdown"}                 -> encerra o daemon

Cascata (quando speech_mode == "summary"):
  1. text bruto vai pro gpt-4o-mini com summarize.system_prompt (Járvis style),
     que devolve um roteiro falável (3-5 frases, sem código/markdown).
  2. esse roteiro vai pro gpt-4o-mini-tts (modelo TTS novo, mais barato e
     mais natural que tts-1-hd) que devolve PCM.
  3. PCM é tocado.
Custo total por resposta longa: ~$0.0001 (mini) + ~$0.0001 (tts) ≈ frações de centavo.

Config esperado (em voice-config.json):
  openai_voice            voz default (alloy, echo, fable, onyx, nova, shimmer, …)
  openai_model            modelo TTS — default gpt-4o-mini-tts
  speech_mode             "verbatim" (TTS direto) ou "summary" (passa pelo mini)
  speed                   factor 0.25 a 4.0 — nativo da API
  summarize.enabled       liga/desliga a cascata
  summarize.model         default gpt-4o-mini
  summarize.system_prompt prompt do roteirizador
  summarize.api_key       chave da OpenAI (reusada pelo TTS também)
  summarize.max_tokens    teto da resposta do mini (default 350)
  summarize.timeout       segundos pro mini (default 12)
"""
from __future__ import annotations

import http.client
import io
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from pathlib import Path

import numpy as np
import sounddevice as sd

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("VOICE_CONFIG_PATH") or (ROOT / "config.json"))


def apply_pronunciation(text: str, pron_map: dict | None) -> str:
    """Mesma lógica dos outros daemons — siglas em CAIXA usam word boundary,
    resto é substring literal, longest-match-first.
    """
    if not pron_map or not text:
        return text
    items = sorted(pron_map.items(), key=lambda kv: -len(kv[0]))
    for src, dst in items:
        if not src:
            continue
        if src.isalpha() and src.isupper() and len(src) >= 2:
            text = re.sub(rf"\b{re.escape(src)}\b", dst, text)
        else:
            text = text.replace(src, dst)
    return text


def log(msg: str, cfg: dict | None = None) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log_file = os.environ.get("VOICE_LOG_FILE") or (cfg.get("log_file") if cfg else None)
    if log_file:
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


# Tenta extrair a API key do config — reaproveita do summarize se a key
# dedicada `openai_api_key` não estiver presente. Permite usar apenas uma key.
def get_api_key(cfg: dict) -> str | None:
    return (
        cfg.get("openai_api_key")
        or (cfg.get("summarize") or {}).get("api_key")
        or os.environ.get("OPENAI_API_KEY")
    )


class OpenAITtsEngine:
    """Engine OpenAI TTS — chama API a cada speak. Sem cache de modelo.
    Comportamento de stop_playback / lock idêntico aos outros daemons,
    pra que o cockpit não precise diferenciar.
    """

    SAMPLERATE = 24000  # OpenAI PCM sai em 24kHz mono int16

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._stop_flag = threading.Event()
        api_key = get_api_key(cfg)
        if not api_key:
            log("[openai] API key não encontrada — defina openai_api_key no config ou OPENAI_API_KEY no env", cfg)
        self._api_key = api_key
        # Pool de conexões persistentes — uma pro chat (mini), outra pro TTS.
        # Mantém HTTPS keep-alive aberto entre chamadas, elimina TLS handshake
        # repetido (~1-2s a menos no primeiro request de cada thread).
        self._chat_conn: http.client.HTTPSConnection | None = None
        self._chat_lock = threading.Lock()
        self._tts_conn: http.client.HTTPSConnection | None = None
        self._tts_lock = threading.Lock()
        # Cache LRU de PCM por frase: hit instantâneo pra repetições
        # ("Senhor, …", "Pois não.", "Como deseja prosseguir?"). Key é a
        # frase normalizada (lower+strip) — captura variações triviais.
        # Tamanho 100 entradas, ~24MB no pior caso (5s áudio cada).
        self._pcm_cache: OrderedDict[str, bytes] = OrderedDict()
        self._pcm_cache_lock = threading.Lock()
        self._pcm_cache_max = int(cfg.get("pcm_cache_size", 100))
        self._pcm_cache_hits = 0
        self._pcm_cache_misses = 0
        log(
            f"engine OpenAI TTS pronto (voice={cfg.get('openai_voice', 'nova')}, "
            f"tts_model={cfg.get('openai_model', 'gpt-4o-mini-tts')}, "
            f"speech_mode={cfg.get('speech_mode', 'verbatim')}, "
            f"summarize_model={(cfg.get('summarize') or {}).get('model', 'gpt-4o-mini')})",
            cfg,
        )

    def reload_config(self) -> None:
        self.cfg = load_config()
        self._api_key = get_api_key(self.cfg)
        log("config recarregada", self.cfg)

    def stop_playback(self) -> None:
        self._stop_flag.set()
        sd.stop()

    def _open_conn(self) -> http.client.HTTPSConnection:
        return http.client.HTTPSConnection("api.openai.com", timeout=30)

    def _cache_key(self, text: str) -> str:
        """Key normalizada — lower + strip + colapsa whitespace.
        Inclui voice/instructions/speed pra não devolver PCM errado se config muda.
        """
        cfg = self.cfg
        norm = " ".join(text.strip().lower().split())
        # parâmetros que mudam o áudio entram na key — change config ⇒ cache miss
        suffix = "|".join([
            cfg.get("openai_voice", "nova"),
            cfg.get("openai_model", "gpt-4o-mini-tts"),
            str(cfg.get("speed", 1.0)),
            (cfg.get("tts_instructions") or "")[:64],
        ])
        return f"{norm}::{suffix}"

    def _cache_get(self, text: str) -> bytes | None:
        key = self._cache_key(text)
        with self._pcm_cache_lock:
            pcm = self._pcm_cache.get(key)
            if pcm is not None:
                self._pcm_cache.move_to_end(key)
                self._pcm_cache_hits += 1
                return pcm
            self._pcm_cache_misses += 1
            return None

    def _cache_put(self, text: str, pcm: bytes) -> None:
        if not pcm:
            return
        key = self._cache_key(text)
        with self._pcm_cache_lock:
            self._pcm_cache[key] = pcm
            self._pcm_cache.move_to_end(key)
            while len(self._pcm_cache) > self._pcm_cache_max:
                self._pcm_cache.popitem(last=False)

    def _request_pcm(self, text: str) -> bytes:
        """Chama a API TTS e retorna PCM raw (int16 LE 24kHz mono).
        Usa conexão persistente — primeiro request paga TLS handshake,
        seguintes reutilizam. Cache LRU dá hit instantâneo em repetições."""
        if not self._api_key:
            raise RuntimeError("API key ausente")
        cached = self._cache_get(text)
        if cached is not None:
            log(f"cache HIT ({len(text)} chars, {len(cached)/(self.SAMPLERATE*2):.1f}s áudio)", self.cfg)
            return cached
        cfg = self.cfg
        payload = {
            "model": cfg.get("openai_model", "gpt-4o-mini-tts"),
            "input": text,
            "voice": cfg.get("openai_voice", "nova"),
            "response_format": "pcm",  # raw int16 LE 24kHz mono — nada de decode
            "speed": float(cfg.get("speed", 1.0)),
        }
        # instructions: campo do gpt-4o-mini-tts que controla tom/personalidade
        # da voz (não o conteúdo). Pra Járvis: tom elegante, britânico discreto.
        # Modelos antigos (tts-1, tts-1-hd) ignoram esse campo.
        tts_instructions = cfg.get("tts_instructions")
        if tts_instructions:
            payload["instructions"] = tts_instructions
        body = json.dumps(payload).encode("utf-8")
        with self._tts_lock:
            # request_persistent já adquire o mesmo lock; usamos versão inline
            # pra controlar o read() em chunks (futura otimização de streaming).
            for attempt in (1, 2):
                conn = self._tts_conn
                if conn is None:
                    conn = self._open_conn()
                    self._tts_conn = conn
                try:
                    conn.request("POST", "/v1/audio/speech", body=body, headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                        "Connection": "keep-alive",
                    })
                    resp = conn.getresponse()
                    if resp.status >= 400:
                        err = resp.read().decode("utf-8", errors="replace")
                        raise urllib.error.HTTPError(
                            "https://api.openai.com/v1/audio/speech",
                            resp.status, err, resp.headers, None,
                        )
                    pcm = resp.read()
                    self._cache_put(text, pcm)
                    return pcm
                except (http.client.RemoteDisconnected,
                        http.client.BadStatusLine,
                        ConnectionResetError,
                        BrokenPipeError,
                        OSError):
                    try: conn.close()
                    except Exception: pass
                    self._tts_conn = None
                    if attempt == 2:
                        raise
                    continue

    def _summarize_stream(self, text: str):
        """Gera frases do roteiro conforme tokens chegam do gpt-4o-mini.
        Permite começar a sintetizar TTS antes do mini terminar — primeira fala
        sai em ~1s em vez de esperar 2-3s do roteiro inteiro.

        Yield: string com 1+ frase pronta pra TTS (já com pontuação final).
        Em erro/timeout/sem-key, yield o texto bruto e termina (fallback verbatim).
        """
        if not self._api_key:
            yield text
            return
        sumcfg = (self.cfg.get("summarize") or {})
        if not sumcfg.get("enabled", True):
            yield text
            return
        model = sumcfg.get("model", "gpt-4o-mini")
        system_prompt = sumcfg.get("system_prompt") or (
            "Reescreva a resposta para ser lida em voz alta em português brasileiro. "
            "Ignore código, tabelas, markdown, listas e links. Máximo 3 frases."
        )
        body = json.dumps({
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "max_tokens": int(sumcfg.get("max_tokens", 350)),
            "temperature": 0.4,
            "stream": True,
        }).encode("utf-8")
        timeout = int(sumcfg.get("timeout", 12))
        buf = ""
        MIN_CHARS = 20
        SENT_RE = re.compile(r"(.+?[.!?])(\s|$)", re.S)

        resp = None
        with self._chat_lock:
            for attempt in (1, 2):
                conn = self._chat_conn
                if conn is None:
                    conn = self._open_conn()
                    self._chat_conn = conn
                conn.timeout = timeout
                try:
                    conn.request("POST", "/v1/chat/completions", body=body, headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                        "Connection": "keep-alive",
                    })
                    resp = conn.getresponse()
                    if resp.status >= 400:
                        err = resp.read().decode("utf-8", errors="replace")[:300]
                        log(f"summarize_stream HTTP {resp.status}: {err} — fallback verbatim", self.cfg)
                        # drena pra reusar conn
                        try: resp.read()
                        except Exception: pass
                        yield text
                        return
                    break  # sucesso
                except (http.client.RemoteDisconnected,
                        http.client.BadStatusLine,
                        ConnectionResetError,
                        BrokenPipeError,
                        OSError) as e:
                    try: conn.close()
                    except Exception: pass
                    self._chat_conn = None
                    if attempt == 2:
                        log(f"summarize_stream erro de conexão: {e} — fallback verbatim", self.cfg)
                        yield text
                        return
                    continue
                except Exception as e:
                    log(f"summarize_stream erro: {e} — fallback verbatim", self.cfg)
                    yield text
                    return

        # IMPORTANTE: o iter do response não pode estar dentro do lock — caso
        # contrário o stream segura a conn por toda a duração do mini, e
        # bloqueia outras chamadas. Mas como só temos 1 thread chamando o chat
        # por vez (pipeline single-producer), está OK pra agora.
        saw_done = False
        try:
            for raw in resp:
                if self._stop_flag.is_set():
                    break
                line = raw.strip()
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    saw_done = True
                    break
                try:
                    chunk = json.loads(data.decode("utf-8"))
                except Exception:
                    continue
                try:
                    delta = chunk["choices"][0]["delta"].get("content", "")
                except Exception:
                    delta = ""
                if not delta:
                    continue
                buf += delta
                while len(buf) >= MIN_CHARS:
                    m = SENT_RE.match(buf)
                    if not m:
                        if len(buf) > 120:
                            cv = buf.find(", ")
                            if cv > 40:
                                yield buf[:cv + 1].strip()
                                buf = buf[cv + 1:].lstrip()
                                continue
                        break
                    sentence = m.group(1).strip()
                    consumed = m.end()
                    buf = buf[consumed:].lstrip()
                    if sentence:
                        yield sentence
        except Exception as e:
            log(f"summarize_stream erro durante read: {e}", self.cfg)
            try: self._chat_conn.close()
            except Exception: pass
            self._chat_conn = None
            saw_done = False  # força fechar abaixo

        # Drena o resto do response pra deixar a conn em "Idle" — sem isso
        # http.client mantém estado "Read" e a próxima request falha com
        # "Request-sent". Em SSE streams, após [DONE] vem só "\n" ou EOF.
        if saw_done:
            try:
                while resp.read(4096):
                    pass
            except Exception:
                pass
        else:
            # interrompido (stop_flag, erro de parse): conexão pode estar
            # em estado ambíguo — descarta pra próxima request abrir nova
            try: resp.close()
            except Exception: pass
            try: self._chat_conn.close()
            except Exception: pass
            self._chat_conn = None

        tail = buf.strip()
        if tail:
            yield tail

    def _summarize(self, text: str) -> str:
        """Manda o texto bruto pro gpt-4o-mini com o system_prompt do Járvis
        e devolve o roteiro falável. Se algo falhar (sem key, sem net, timeout),
        retorna o texto original — fallback é falar verbatim.
        """
        if not self._api_key:
            return text
        sumcfg = (self.cfg.get("summarize") or {})
        if not sumcfg.get("enabled", True):
            return text
        model = sumcfg.get("model", "gpt-4o-mini")
        system_prompt = sumcfg.get("system_prompt") or (
            "Reescreva a resposta para ser lida em voz alta em português brasileiro. "
            "Ignore código, tabelas, markdown, listas e links. Máximo 3 frases."
        )
        body = json.dumps({
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "max_tokens": int(sumcfg.get("max_tokens", 350)),
            "temperature": 0.4,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        timeout = int(sumcfg.get("timeout", 12))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                resp = json.loads(r.read().decode("utf-8"))
            roteiro = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
            if not roteiro:
                return text
            return roteiro
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")[:300]
            log(f"summarize HTTP {e.code}: {err} — fallback verbatim", self.cfg)
            return text
        except Exception as e:
            log(f"summarize erro: {e} — fallback verbatim", self.cfg)
            return text

    def _play_pcm(self, pcm_bytes: bytes) -> None:
        cfg = self.cfg
        audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        wav = audio_int16.astype(np.float32) / 32768.0
        volume = float(cfg.get("volume", 1.0))
        if volume != 1.0:
            wav = np.clip(wav * volume, -1.0, 1.0)
        if self._stop_flag.is_set():
            return
        sd.play(wav, samplerate=self.SAMPLERATE)
        sd.wait()

    def _synth_and_play(self, text: str, idx: int = 0) -> None:
        """Aplica pronunciation, chama TTS, toca PCM. Bloqueante.
        Usado tanto em verbatim (1x) quanto em summary streaming (Nx)."""
        cfg = self.cfg
        text = apply_pronunciation(text, cfg.get("pronunciation"))
        if not text.strip():
            return
        t0 = time.time()
        try:
            pcm_bytes = self._request_pcm(text)
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")[:300]
            log(f"TTS HTTP {e.code}: {err}", cfg)
            return
        except Exception as e:
            log(f"erro TTS: {e}", cfg)
            return
        log(
            f"síntese[{idx}] {time.time()-t0:.2f}s ({len(text)} chars → "
            f"{len(pcm_bytes)/(self.SAMPLERATE*2):.1f}s áudio)",
            cfg,
        )
        self._play_pcm(pcm_bytes)

    def speak(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        with self._lock:
            self._stop_flag.clear()
            cfg = self.cfg
            speech_mode = cfg.get("speech_mode", "verbatim")
            t_start = time.time()

            # Atalho pra textos curtos: passar pelo mini gasta ~1-2s e o
            # roteiro mal muda. Confirmações tipo "feito senhor", "rodando",
            # "aplicado em 3 arquivos" vão direto pro TTS. Threshold no config.
            short_threshold = int(cfg.get("summary_min_chars", 60))
            if speech_mode == "summary" and len(text) < short_threshold:
                log(f"short ({len(text)} < {short_threshold}) — skip summarize, verbatim direto", cfg)
                self._synth_and_play(text, idx=0)
                log(f"short total {time.time()-t_start:.2f}s", cfg)
                return

            if speech_mode == "summary":
                self._speak_summary_pipeline(text, t_start)
                return

            # Verbatim: TTS único do texto inteiro
            log(f"verbatim {len(text)} chars: {text[:80]!r}…", cfg)
            self._synth_and_play(text, idx=0)
            log(f"verbatim total {time.time()-t_start:.2f}s", cfg)

    def _speak_summary_pipeline(self, text: str, t_start: float) -> None:
        """Pipeline 2 threads: producer gera mini→TTS→PCM em paralelo enquanto
        player toca PCM em ordem. Pausa entre frases vira ~zero quando o tempo
        de TTS da próxima frase ≤ duração de áudio da atual.

          [main]  speak()
                    │
                    ├─► [producer] mini_stream → frase → tts → pcm ──► pcm_q
                    │
                    └─► [player] pcm_q → sd.play+wait (em ordem)
        """
        cfg = self.cfg
        # bound pra não estourar memória se mini gerar muito mais rápido que TTS toca
        pcm_q: queue.Queue = queue.Queue(maxsize=4)
        producer_done = threading.Event()
        producer_err: list = []

        def producer():
            try:
                log(f"summarize pipeline start ({len(text)} chars in)", cfg)
                first_pcm_at = None
                for i, sentence in enumerate(self._summarize_stream(text)):
                    if self._stop_flag.is_set():
                        break
                    log(f"frase[{i}] ({len(sentence)} chars): {sentence[:80]!r}", cfg)
                    # aplica pronunciation e chama TTS — bloqueia até PCM vir
                    s = apply_pronunciation(sentence, cfg.get("pronunciation"))
                    if not s.strip():
                        continue
                    t_tts = time.time()
                    try:
                        pcm = self._request_pcm(s)
                    except urllib.error.HTTPError as e:
                        err = e.read().decode("utf-8", errors="replace")[:300] if hasattr(e, "read") else str(e)
                        log(f"TTS HTTP erro: {err}", cfg)
                        continue
                    except Exception as e:
                        log(f"TTS erro: {e}", cfg)
                        continue
                    if first_pcm_at is None:
                        first_pcm_at = time.time()
                        log(f"TTFB-pcm {first_pcm_at - t_start:.2f}s", cfg)
                    log(f"síntese[{i}] {time.time()-t_tts:.2f}s ({len(s)} chars → {len(pcm)/(self.SAMPLERATE*2):.1f}s áudio)", cfg)
                    # block aqui se player atrasou (pcm_q cheio) — backpressure
                    while not self._stop_flag.is_set():
                        try:
                            pcm_q.put(pcm, timeout=0.5)
                            break
                        except queue.Full:
                            continue
            except Exception as e:
                producer_err.append(e)
                log(f"producer erro: {e}", cfg)
            finally:
                producer_done.set()
                pcm_q.put(None)  # sentinel pro player

        t_producer = threading.Thread(target=producer, daemon=True)
        t_producer.start()

        # player roda na thread atual — herda o lock self._lock
        idx = 0
        first_play_at = None
        while True:
            try:
                pcm = pcm_q.get(timeout=60)
            except queue.Empty:
                log("player timeout esperando pcm", cfg)
                break
            if pcm is None:
                break
            if self._stop_flag.is_set():
                break
            if first_play_at is None:
                first_play_at = time.time()
                log(f"TTFB-play {first_play_at - t_start:.2f}s", cfg)
            self._play_pcm(pcm)
            idx += 1

        # aguarda producer terminar (se ainda não tiver)
        t_producer.join(timeout=2)
        log(f"summary total {time.time()-t_start:.2f}s ({idx} frases)", cfg)


def handle_client(conn: socket.socket, engine: OpenAITtsEngine) -> None:
    try:
        with conn, conn.makefile("rwb", buffering=0) as f:
            line = f.readline()
            if not line:
                return
            try:
                req = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as e:
                f.write((json.dumps({"ok": False, "error": f"bad json: {e}"}) + "\n").encode())
                return
            cmd = req.get("cmd")
            try:
                if cmd == "speak":
                    if engine.cfg.get("enabled", True):
                        if req.get("preempt"):
                            engine.stop_playback()
                        threading.Thread(
                            target=engine.speak,
                            args=(req.get("text", ""),),
                            daemon=True,
                        ).start()
                    f.write((json.dumps({"ok": True}) + "\n").encode())
                elif cmd == "stop":
                    engine.stop_playback()
                    f.write((json.dumps({"ok": True}) + "\n").encode())
                elif cmd == "ping":
                    f.write((json.dumps({"ok": True, "pong": True, "engine": "openai"}) + "\n").encode())
                elif cmd == "reload":
                    engine.reload_config()
                    f.write((json.dumps({"ok": True}) + "\n").encode())
                elif cmd == "shutdown":
                    f.write((json.dumps({"ok": True}) + "\n").encode())
                    log("shutdown solicitado", engine.cfg)
                    os._exit(0)
                else:
                    f.write((json.dumps({"ok": False, "error": f"unknown cmd: {cmd}"}) + "\n").encode())
            except Exception as e:
                f.write((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
    except Exception as e:
        log(f"erro no client: {e}", engine.cfg)


def main() -> int:
    cfg = load_config()
    sock_path = cfg["socket_path"]
    if os.path.exists(sock_path):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as test:
                test.settimeout(0.5)
                test.connect(sock_path)
                test.sendall(b'{"cmd":"ping"}\n')
                if test.recv(64):
                    log("daemon já em execução, abortando", cfg)
                    return 1
        except Exception:
            pass
        os.unlink(sock_path)

    engine = OpenAITtsEngine(cfg)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(8)
    log(f"socket pronto em {sock_path}", cfg)

    try:
        while True:
            conn, _ = server.accept()
            threading.Thread(target=handle_client, args=(conn, engine), daemon=True).start()
    except KeyboardInterrupt:
        log("interrompido", cfg)
    finally:
        try:
            server.close()
        finally:
            if os.path.exists(sock_path):
                os.unlink(sock_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
