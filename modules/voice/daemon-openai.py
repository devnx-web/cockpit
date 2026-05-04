"""Daemon Claude Voice (OpenAI TTS) — usa a API tts-1-hd da OpenAI em vez de
modelo local. Não precisa GPU, não carrega modelo, voz idêntica sempre.

Mesma API socket dos outros daemons (daemon.py, daemon-xtts.py):
  {"cmd": "speak", "text": "..."}     -> sintetiza e toca
  {"cmd": "stop"}                     -> interrompe áudio em curso
  {"cmd": "ping"}                     -> health check
  {"cmd": "reload"}                   -> recarrega config.json
  {"cmd": "shutdown"}                 -> encerra o daemon

Config esperado (em voice-config.json):
  api_key            (em "summarize.api_key" — reaproveita do summarize)
  openai_voice       voz default (alloy, echo, fable, onyx, nova, shimmer)
  openai_model       tts-1 (rápido) ou tts-1-hd (qualidade) — default tts-1-hd
  speed              factor 0.25 a 4.0 — nativo da API

Vantagens vs XTTS/OmniVoice locais:
  - 0 GPU, 0 RAM significativa, 0 modelo no disco
  - boot instantâneo (não carrega modelo)
  - voz idêntica sempre, zero variação entre runs
  - cliente em qualquer máquina (precisa só internet)
"""
from __future__ import annotations

import io
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
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
        log(f"engine OpenAI TTS pronto (voice={cfg.get('openai_voice', 'nova')}, model={cfg.get('openai_model', 'tts-1-hd')})", cfg)

    def reload_config(self) -> None:
        self.cfg = load_config()
        self._api_key = get_api_key(self.cfg)
        log("config recarregada", self.cfg)

    def stop_playback(self) -> None:
        self._stop_flag.set()
        sd.stop()

    def _request_pcm(self, text: str) -> bytes:
        """Chama a API e retorna PCM raw (int16 LE 24kHz mono)."""
        if not self._api_key:
            raise RuntimeError("API key ausente")
        cfg = self.cfg
        body = json.dumps({
            "model": cfg.get("openai_model", "tts-1-hd"),
            "input": text,
            "voice": cfg.get("openai_voice", "nova"),
            "response_format": "pcm",  # raw int16 LE 24kHz mono — nada de decode
            "speed": float(cfg.get("speed", 1.0)),
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def speak(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        with self._lock:
            self._stop_flag.clear()
            cfg = self.cfg
            text = apply_pronunciation(text, cfg.get("pronunciation"))
            log(f"sintetizando {len(text)} chars: {text[:80]!r}...", cfg)
            t0 = time.time()
            try:
                pcm_bytes = self._request_pcm(text)
            except urllib.error.HTTPError as e:
                err = e.read().decode("utf-8", errors="replace")[:300]
                log(f"OpenAI HTTP {e.code}: {err}", cfg)
                return
            except Exception as e:
                log(f"erro na chamada OpenAI: {e}", cfg)
                return

            audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
            wav = audio_int16.astype(np.float32) / 32768.0
            volume = float(cfg.get("volume", 1.0))
            if volume != 1.0:
                wav = np.clip(wav * volume, -1.0, 1.0)

            log(f"síntese {time.time() - t0:.2f}s ({len(wav)/self.SAMPLERATE:.1f}s áudio)", cfg)
            if self._stop_flag.is_set():
                return
            sd.play(wav, samplerate=self.SAMPLERATE)
            sd.wait()


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
