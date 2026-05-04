"""Daemon Claude Voice — mantém OmniVoice residente na GPU e expõe Unix socket.

Protocolo (linhas JSON, uma por requisição):
  {"cmd": "speak", "text": "..."}     -> sintetiza e toca
  {"cmd": "stop"}                     -> interrompe áudio em curso
  {"cmd": "ping"}                     -> health check
  {"cmd": "reload"}                   -> recarrega config.json
  {"cmd": "shutdown"}                 -> encerra o daemon

Resposta: {"ok": true} ou {"ok": false, "error": "..."}.
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
from omnivoice import OmniVoice

ROOT = Path(__file__).resolve().parent
# Em produção (Electron + asar) o config fica no userData do app — gravável.
# O cockpit injeta o caminho via VOICE_CONFIG_PATH; sem env var caímos no
# arquivo ao lado do daemon (modo dev / execução standalone).
CONFIG_PATH = Path(os.environ.get("VOICE_CONFIG_PATH") or (ROOT / "config.json"))


def apply_pronunciation(text: str, pron_map: dict | None) -> str:
    """Aplica substituições do dicionário de pronúncia.

    - Siglas em CAIXA ALTA (≥2 letras) usam word boundary pra não bater
      dentro de palavras (ex: "AI" não substitui em "main").
    - Resto é substring literal (ex: ".py" → " ponto pi").
    - Longest-match-first pra evitar conflitos (ex: ".json" antes de ".js").
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
    # Override do config: o cockpit Node passa VOICE_LOG_FILE pra apontar pra
    # userData/voice-logs/daemon.log em produção (o caminho do config.json é
    # hardcoded e em geral não é gravável fora da máquina do desenvolvedor).
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


class VoiceEngine:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._stop_flag = threading.Event()
        device = cfg.get("device", "cuda:0")
        dtype = torch.float16 if cfg.get("dtype", "float16") == "float16" else torch.float32
        log(f"carregando OmniVoice device={device} dtype={dtype}", cfg)
        self.model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice", device_map=device, dtype=dtype
        )
        log("OmniVoice pronto na GPU", cfg)
        self._voice_prompt = None
        self._voice_prompt_key: tuple | None = None
        self._build_voice_prompt()

    def _build_voice_prompt(self) -> None:
        ref_audio = self.cfg["voice_ref"]
        ref_text = self.cfg["voice_ref_text"]
        key = (ref_audio, ref_text)
        if self._voice_prompt is not None and self._voice_prompt_key == key:
            return
        log(f"pré-processando voice prompt: {ref_audio}", self.cfg)
        self._voice_prompt = self.model.create_voice_clone_prompt(
            ref_audio=ref_audio, ref_text=ref_text, preprocess_prompt=True
        )
        self._voice_prompt_key = key
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
            log(f"sintetizando {len(text)} chars: {text[:80]!r}...", cfg)
            t0 = time.time()
            # speed nativo do OmniVoice preserva timbre — diferente de
            # mexer no samplerate (que muda pitch e quebra a voz JARVIS).
            speed = float(cfg.get("speed", 1.0))
            # determinismo: trava o sampling do TTS pra que a voz seja
            # idêntica entre chamadas (sem isso o OmniVoice amostra timbre
            # diferente a cada generate e parece "trocar de voz").
            seed = int(cfg.get("seed", 42))
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
            gen_kwargs = {"text": text}
            if speed and speed != 1.0:
                gen_kwargs["speed"] = speed
            # usa o voice prompt já pré-processado se a API do OmniVoice
            # aceitar; se não, cai no fluxo antigo de ref_audio/ref_text.
            try:
                audio = self.model.generate(voice_prompt=self._voice_prompt, **gen_kwargs)
            except TypeError:
                audio = self.model.generate(
                    ref_audio=cfg["voice_ref"],
                    ref_text=cfg["voice_ref_text"],
                    **gen_kwargs,
                )
            wav = audio[0]
            if isinstance(wav, torch.Tensor):
                wav = wav.detach().cpu().numpy()
            wav = np.asarray(wav, dtype=np.float32)
            volume = float(cfg.get("volume", 1.0))
            if volume != 1.0:
                wav = np.clip(wav * volume, -1.0, 1.0)
            sr = 24000  # samplerate fixo; speed já foi aplicado no generate
            log(f"síntese {time.time() - t0:.2f}s ({len(wav)/24000:.1f}s áudio)", cfg)
            if self._stop_flag.is_set():
                return
            sd.play(wav, samplerate=sr)
            sd.wait()


def handle_client(conn: socket.socket, engine: VoiceEngine) -> None:
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
                        # preempt: interrompe a fala em curso antes de tocar
                        # a nova. O lock dentro de speak() é segurado pela
                        # thread anterior, mas stop_playback() libera o
                        # sd.wait() e ela retorna rápido — a thread nova
                        # então pega o lock e segue.
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
                    f.write((json.dumps({"ok": True, "pong": True}) + "\n").encode())
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

    engine = VoiceEngine(cfg)

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
