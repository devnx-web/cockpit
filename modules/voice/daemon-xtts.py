"""Daemon Claude Voice (XTTS-v2) — mantém Coqui XTTS-v2 residente na GPU/CPU
e expõe Unix socket pra síntese de fala.

Mesma API do daemon.py original (OmniVoice), pra que o cockpit Node fale com
ambos sem distinguir:
  {"cmd": "speak", "text": "..."}     -> sintetiza e toca
  {"cmd": "stop"}                     -> interrompe áudio em curso
  {"cmd": "ping"}                     -> health check
  {"cmd": "reload"}                   -> recarrega config.json
  {"cmd": "shutdown"}                 -> encerra o daemon

Por que XTTS-v2 e não OmniVoice:
  - clonagem de voz mais fiel pra português (em testes locais, o timbre
    Jarvis sai mais próximo da AMOSTRA_APROVADA com XTTS)
  - menos VRAM (~2.5 GB vs ~4.5 GB)
  - suporta CPU (omnivoice é GPU-only)
  - suporta streaming nativo (Fase 2)

Esta primeira versão é request/response (sem streaming) — o speak() ainda
gera o áudio inteiro antes de tocar. Streaming entra na Fase 2.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import torch

# Coqui aceita os termos via env var
os.environ.setdefault("COQUI_TOS_AGREED", "1")
from TTS.api import TTS

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("VOICE_CONFIG_PATH") or (ROOT / "config.json"))


def apply_pronunciation(text: str, pron_map: dict | None) -> str:
    """Aplica substituições do dicionário de pronúncia.
    Mesma lógica do daemon OmniVoice — siglas em CAIXA usam word boundary,
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


# Map config["language"] / heurística de cfg pra código XTTS (ISO-639-1).
# Default 'pt' — o config do cockpit é sempre PT-BR.
def detect_language(cfg: dict) -> str:
    return (cfg.get("language") or "pt").lower()[:2]


class XttsEngine:
    """Wrapper XTTS-v2 com a mesma interface que OmniVoice expunha:
    - reload_config() reload do config.json
    - speak(text) sintetiza + toca (bloqueante)
    - stop_playback() interrompe playback em curso
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._stop_flag = threading.Event()
        device = cfg.get("device", "cuda:0")
        # XTTS-v2 só tem float32 efetivo, dtype no config é ignorado
        log(f"carregando XTTS-v2 device={device}", cfg)
        # gpu=True usa CUDA; pra CPU, gpu=False
        use_gpu = device.startswith("cuda") and torch.cuda.is_available()
        self.tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=use_gpu)
        log("XTTS-v2 pronto", cfg)
        # cache de conditioning latents da voz de referência — XTTS usa o
        # speaker_wav internamente em cada tts() se a gente passar o path,
        # mas ele recomputa toda vez. Pra ganhar velocidade, computamos
        # uma vez aqui no boot e reusamos via inference() direto.
        self._speaker_latents = None
        self._speaker_embedding = None
        self._speaker_key: tuple | None = None
        self._build_voice_prompt()

    def _build_voice_prompt(self) -> None:
        ref_audio = self.cfg["voice_ref"]
        # XTTS não usa ref_text — só áudio de referência
        key = (ref_audio,)
        if self._speaker_latents is not None and self._speaker_key == key:
            return
        log(f"pré-processando voice prompt: {ref_audio}", self.cfg)
        # acesso direto ao modelo Xtts pra cachear latents
        model = self.tts.synthesizer.tts_model
        gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(audio_path=ref_audio)
        self._speaker_latents = gpt_cond_latent
        self._speaker_embedding = speaker_embedding
        self._speaker_key = key
        log("voice prompt cacheado — voz padronizada", self.cfg)

    def reload_config(self) -> None:
        self.cfg = load_config()
        self._build_voice_prompt()
        log("config recarregada", self.cfg)

    def stop_playback(self) -> None:
        self._stop_flag.set()
        sd.stop()

    def speak(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        with self._lock:
            self._stop_flag.clear()
            cfg = self.cfg
            text = apply_pronunciation(text, cfg.get("pronunciation"))
            language = detect_language(cfg)
            speed = float(cfg.get("speed", 1.0))
            seed = int(cfg.get("seed", 42))
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)

            log(f"sintetizando {len(text)} chars: {text[:80]!r}...", cfg)
            t0 = time.time()
            # inference() é a API low-level que aceita latents pré-computados
            # — bem mais rápido que tts() que recomputa toda vez.
            model = self.tts.synthesizer.tts_model
            wav_dict = model.inference(
                text=text,
                language=language,
                gpt_cond_latent=self._speaker_latents,
                speaker_embedding=self._speaker_embedding,
                # XTTS aceita 'speed' direto via temperature/length_penalty
                # mas a forma mais portável é gerar normal e fazer time-stretch
                # depois. Por simplicidade, deixa speed=1.0 aqui — quem quiser
                # pausar a fala usa o setting de fala (padrão Jarvis é 1.0).
            )
            wav = wav_dict["wav"]
            if isinstance(wav, torch.Tensor):
                wav = wav.detach().cpu().numpy()
            wav = np.asarray(wav, dtype=np.float32)

            # XTTS sai em 24kHz por padrão
            sr = 24000

            # speed via resample se != 1.0 (muda pitch — uso curto pra ajuste fino)
            if speed and abs(speed - 1.0) > 0.01:
                # decimação simples por interpolação — ok pra pequenos ajustes
                new_len = int(len(wav) / speed)
                if new_len > 0:
                    x_old = np.linspace(0, 1, len(wav))
                    x_new = np.linspace(0, 1, new_len)
                    wav = np.interp(x_new, x_old, wav).astype(np.float32)

            volume = float(cfg.get("volume", 1.0))
            if volume != 1.0:
                wav = np.clip(wav * volume, -1.0, 1.0)

            log(f"síntese {time.time() - t0:.2f}s ({len(wav)/sr:.1f}s áudio)", cfg)
            if self._stop_flag.is_set():
                return
            sd.play(wav, samplerate=sr)
            sd.wait()


def handle_client(conn: socket.socket, engine: XttsEngine) -> None:
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
                    f.write((json.dumps({"ok": True, "pong": True, "engine": "xtts"}) + "\n").encode())
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

    engine = XttsEngine(cfg)

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
