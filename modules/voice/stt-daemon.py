"""Daemon STT — mantém faster-whisper residente e expõe Unix socket pra
transcrição. Substitui o dictation.py global (pynput + xdotool) por uma
versão integrada que só atende o cockpit.

Protocolo (mesmo padrão dos daemons TTS):
  {"cmd": "transcribe", "path": "/tmp/x.webm"}  -> {"ok": true, "text": "..."}
  {"cmd": "ping"}                               -> {"ok": true, "pong": true}
  {"cmd": "shutdown"}                           -> {"ok": true}; encerra

Carrega faster-whisper "small" em CUDA (fallback CPU int8). Filtra
alucinações típicas de PT-BR (mesmas do dictation.py). Decode via ffmpeg
(faster-whisper aceita path direto e usa audioread/ffmpeg).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SOCK_PATH = os.environ.get("STT_SOCKET_PATH", "/tmp/cockpit-stt.sock")
LOG_FILE = os.environ.get("STT_LOG_FILE", str(ROOT / "logs" / "stt-daemon.log"))
WHISPER_MODEL = os.environ.get("STT_MODEL", "small")
WHISPER_DEVICE = os.environ.get("STT_DEVICE", "cuda")
WHISPER_COMPUTE = os.environ.get("STT_COMPUTE", "float16")

# Frases que o Whisper inventa quando ouve silêncio/ruído. Match normalizado
# (lower + sem pontuação leve). Lista copiada do dictation.py original.
HALLUCINATIONS = {
    "legendas pela comunidade de amara.org",
    "legendas pela comunidade amara.org",
    "legendas: amara.org",
    "amara.org",
    "obrigado por assistir",
    "obrigada por assistir",
    "obrigado por assistirem",
    "inscreva-se no canal",
    "inscreva se no canal",
    "se inscreva no canal",
    "deixe seu like",
    "valeu pessoal",
    "tchau pessoal",
    "música",
    "[música]",
    "(música)",
    "[aplausos]",
    "(aplausos)",
    "...", ".", ",",
    "ah", "oh", "uh", "ó", "é",
}


def is_hallucination(text: str) -> bool:
    if not text:
        return True
    norm = text.strip().lower().rstrip(".!? ").strip()
    if len(norm) < 2:
        return True
    return norm in HALLUCINATIONS


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class WhisperEngine:
    def __init__(self):
        self._lock = threading.Lock()
        self.model = None
        self.device_in_use = None
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self) -> None:
        with self._lock:
            if self.model is not None:
                return
            from faster_whisper import WhisperModel
            log(f"carregando faster-whisper {WHISPER_MODEL} em {WHISPER_DEVICE}…")
            try:
                self.model = WhisperModel(
                    WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE
                )
                self.device_in_use = WHISPER_DEVICE
            except Exception as e:
                log(f"{WHISPER_DEVICE} falhou ({e}), caindo para CPU int8")
                self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
                self.device_in_use = "cpu"
            # Warmup: primeira inferência compila kernels.
            try:
                import numpy as np
                warm = np.zeros(16000, dtype="float32")
                segs, _ = self.model.transcribe(warm, language="pt", beam_size=1)
                list(segs)
            except Exception as e:
                log(f"warmup falhou (ignorando): {e}")
            log(f"whisper pronto e aquecido em {self.device_in_use}")

    def transcribe(self, path: str) -> str:
        # garante que model carregou
        if self.model is None:
            self._load()
        t0 = time.time()
        segments, info = self.model.transcribe(
            path,
            language="pt",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "threshold": 0.5},
            beam_size=1,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            initial_prompt="Transcrição em português brasileiro de comando de voz para terminal de programação.",
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        log(f"STT {time.time() - t0:.2f}s: {text!r}")
        if is_hallucination(text):
            log(f"alucinação descartada: {text!r}")
            return ""
        return text


def handle_client(conn: socket.socket, engine: WhisperEngine) -> None:
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
                if cmd == "transcribe":
                    path = req.get("path", "")
                    if not path or not os.path.exists(path):
                        f.write((json.dumps({"ok": False, "error": f"arquivo não encontrado: {path}"}) + "\n").encode())
                        return
                    text = engine.transcribe(path)
                    f.write((json.dumps({"ok": True, "text": text}) + "\n").encode())
                elif cmd == "ping":
                    ready = engine.model is not None
                    f.write((json.dumps({"ok": True, "pong": True, "ready": ready, "device": engine.device_in_use}) + "\n").encode())
                elif cmd == "shutdown":
                    f.write((json.dumps({"ok": True}) + "\n").encode())
                    log("shutdown solicitado")
                    os._exit(0)
                else:
                    f.write((json.dumps({"ok": False, "error": f"unknown cmd: {cmd}"}) + "\n").encode())
            except Exception as e:
                log(f"erro no cmd {cmd}: {e}")
                f.write((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
    except Exception as e:
        log(f"erro no client: {e}")


def main() -> int:
    # Limpa socket zumbi
    if os.path.exists(SOCK_PATH):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as test:
                test.settimeout(0.5)
                test.connect(SOCK_PATH)
                test.sendall(b'{"cmd":"ping"}\n')
                if test.recv(64):
                    log("daemon já em execução, abortando")
                    return 1
        except Exception:
            pass
        try:
            os.unlink(SOCK_PATH)
        except Exception:
            pass

    engine = WhisperEngine()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    os.chmod(SOCK_PATH, 0o600)
    server.listen(8)
    log(f"socket pronto em {SOCK_PATH}")

    try:
        while True:
            conn, _ = server.accept()
            threading.Thread(target=handle_client, args=(conn, engine), daemon=True).start()
    except KeyboardInterrupt:
        log("interrompido")
    finally:
        try:
            server.close()
        finally:
            if os.path.exists(SOCK_PATH):
                try:
                    os.unlink(SOCK_PATH)
                except Exception:
                    pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
