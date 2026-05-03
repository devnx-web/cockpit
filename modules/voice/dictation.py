"""Dictation: hold Left Ctrl por 1s pra ativar STT global.

Fluxo:
  1. Usuário foca uma janela qualquer (ex: prompt do Claude Code).
  2. Segura Left Ctrl SOZINHO por 1s — overlay vermelho aparece no canto.
  3. Continua segurando enquanto fala.
  4. Solta Ctrl — overlay vira amarelo ("Transcrevendo..."), grava é
     transcrita com faster-whisper PT-BR e digitada na janela original
     via xdotool.
  5. Overlay some.

Cancela arming se outra tecla for pressionada durante o hold (evita
falso positivo em Ctrl+C, Ctrl+V, etc).
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from tkinter import Tk, Toplevel, Label

import numpy as np
import sounddevice as sd
from pynput import keyboard

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"

ARM_DURATION = 0.5  # segundos de hold pra ativar
SAMPLE_RATE = 16000
CHANNELS = 1
WHISPER_MODEL = "small"  # base alucina demais em PT-BR; small é melhor e ainda <0.5s
WHISPER_DEVICE = "cuda"
WHISPER_COMPUTE = "float16"
XDOTOOL_DELAY = "0"  # ms entre teclas; 0 = digita instantâneo

LOG_FILE = ROOT / "logs" / "dictation.log"

# Frases que o Whisper inventa quando ouve silêncio/ruído (especialmente
# em PT-BR — vê dataset de legendas comunitárias do YouTube). Match
# normalizado (lower + sem pontuação leve).
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
    """True se o texto é uma alucinação típica do Whisper."""
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
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def get_active_window_id() -> str | None:
    try:
        out = subprocess.check_output(["xdotool", "getactivewindow"], timeout=1)
        return out.decode().strip()
    except Exception as e:
        log(f"xdotool getactivewindow falhou: {e}")
        return None


def restore_focus_and_type(window_id: str | None, text: str) -> None:
    if not text.strip():
        return
    try:
        if window_id:
            subprocess.run(["xdotool", "windowactivate", "--sync", window_id], timeout=2, check=False)
            time.sleep(0.05)
        subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", XDOTOOL_DELAY, text], timeout=10, check=False)
        log(f"texto digitado ({len(text)} chars)")
    except Exception as e:
        log(f"xdotool type falhou: {e}")


class Overlay:
    def __init__(self, root: Tk):
        self.root = root
        self.win = Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-alpha", 0.92)
        self.win.configure(bg="#1a1a1a")
        try:
            self.win.attributes("-type", "splash")
        except Exception:
            pass

        self.label = Label(
            self.win,
            text="🎙  Ouvindo  0.0s",
            font=("Sans", 13, "bold"),
            fg="white",
            bg="#cc0033",
            padx=20,
            pady=10,
        )
        self.label.pack(fill="both", expand=True)
        self._position_bottom_right()
        self.win.withdraw()
        self._pulse_state = 0
        self._start_time = 0.0
        self._timer_after = None

    def _position_bottom_right(self) -> None:
        self.win.update_idletasks()
        sw = self.win.winfo_screenwidth()
        sh = self.win.winfo_screenheight()
        w, h = 240, 56
        x = sw - w - 30
        y = sh - h - 80
        self.win.geometry(f"{w}x{h}+{x}+{y}")

    def show_recording(self) -> None:
        self._start_time = time.time()
        self.label.configure(text="🎙  Ouvindo  0.0s", bg="#cc0033")
        self.win.deiconify()
        self.win.lift()
        self._update_timer()

    def _update_timer(self) -> None:
        elapsed = time.time() - self._start_time
        self._pulse_state = (self._pulse_state + 1) % 2
        bg = "#cc0033" if self._pulse_state else "#ff1744"
        self.label.configure(text=f"🎙  Ouvindo  {elapsed:0.1f}s", bg=bg)
        self._timer_after = self.win.after(400, self._update_timer)

    def show_transcribing(self) -> None:
        if self._timer_after:
            self.win.after_cancel(self._timer_after)
            self._timer_after = None
        self.label.configure(text="✍  Transcrevendo…", bg="#cc8800")

    def hide(self) -> None:
        if self._timer_after:
            self.win.after_cancel(self._timer_after)
            self._timer_after = None
        self.win.withdraw()


class Dictation:
    def __init__(self):
        self.root = Tk()
        self.root.withdraw()
        self.overlay = Overlay(self.root)

        self.whisper = None
        self.whisper_lock = threading.Lock()

        self.ctrl_pressed = False
        self.ctrl_pressed_at: float | None = None
        self.other_keys_during_hold = False
        self.recording = False
        self.audio_chunks: list[np.ndarray] = []
        self.stream: sd.InputStream | None = None
        self.window_id: str | None = None

        self.ui_queue: queue.Queue = queue.Queue()
        self.root.after(50, self._drain_ui_queue)

        # Carrega Whisper em background (não bloqueia ativação)
        threading.Thread(target=self._load_whisper, daemon=True).start()

        self.listener = keyboard.Listener(
            on_press=self._on_press, on_release=self._on_release
        )
        self.listener.start()
        log(f"dictation pronto — hold Left Ctrl por {ARM_DURATION}s")

    def _load_whisper(self) -> None:
        with self.whisper_lock:
            if self.whisper is not None:
                return
            log(f"carregando faster-whisper {WHISPER_MODEL} em {WHISPER_DEVICE}…")
            from faster_whisper import WhisperModel
            try:
                self.whisper = WhisperModel(
                    WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE
                )
            except Exception as e:
                log(f"GPU falhou ({e}), caindo para CPU int8")
                self.whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
            # Warmup — primeira inferência da GPU compila kernels e demora 1-2s.
            # Fazer agora elimina latência da primeira ativação real.
            try:
                warm = np.zeros(SAMPLE_RATE, dtype=np.float32)
                segs, _ = self.whisper.transcribe(warm, language="pt", beam_size=1)
                list(segs)
            except Exception as e:
                log(f"warmup falhou (ignorando): {e}")
            log("whisper pronto e aquecido")

    def _enqueue(self, fn) -> None:
        self.ui_queue.put(fn)

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                fn = self.ui_queue.get_nowait()
                try:
                    fn()
                except Exception as e:
                    log(f"ui error: {e}")
        except queue.Empty:
            pass
        self.root.after(50, self._drain_ui_queue)

    def _on_press(self, key) -> None:
        if key == keyboard.Key.ctrl_l:
            if self.ctrl_pressed:
                return
            self.ctrl_pressed = True
            self.ctrl_pressed_at = time.time()
            self.other_keys_during_hold = False
            threading.Timer(ARM_DURATION, self._check_arm).start()
        else:
            if self.ctrl_pressed:
                self.other_keys_during_hold = True

    def _on_release(self, key) -> None:
        if key == keyboard.Key.ctrl_l:
            was_recording = self.recording
            self.ctrl_pressed = False
            self.ctrl_pressed_at = None
            if was_recording:
                self._stop_recording_and_transcribe()

    def _check_arm(self) -> None:
        if (
            self.ctrl_pressed
            and not self.other_keys_during_hold
            and not self.recording
        ):
            self._start_recording()

    def _start_recording(self) -> None:
        self.window_id = get_active_window_id()
        log(f"ativado — janela {self.window_id}")
        self.audio_chunks = []
        try:
            self.stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="float32",
                callback=self._audio_callback,
            )
            self.stream.start()
            self.recording = True
            self._enqueue(self.overlay.show_recording)
        except Exception as e:
            log(f"falha ao abrir stream: {e}")
            self.stream = None

    def _audio_callback(self, indata, frames, time_info, status) -> None:
        if status:
            log(f"stream status: {status}")
        self.audio_chunks.append(indata.copy())

    def _stop_recording_and_transcribe(self) -> None:
        self.recording = False
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        self._enqueue(self.overlay.show_transcribing)
        threading.Thread(target=self._transcribe_and_type, daemon=True).start()

    def _transcribe_and_type(self) -> None:
        try:
            chunks = self.audio_chunks
            self.audio_chunks = []
            if not chunks:
                log("nenhum áudio capturado")
                self._enqueue(self.overlay.hide)
                return
            audio = np.concatenate(chunks, axis=0).flatten()
            duration = len(audio) / SAMPLE_RATE
            if duration < 0.4:
                log(f"áudio curto ({duration:.2f}s), descartando")
                self._enqueue(self.overlay.hide)
                return
            self._load_whisper()
            t0 = time.time()
            segments, info = self.whisper.transcribe(
                audio, language="pt",
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500, "threshold": 0.5},
                beam_size=1,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                initial_prompt="Transcrição em português brasileiro de comando de voz para terminal de programação.",
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            t_stt = time.time() - t0
            log(f"STT {t_stt:.2f}s ({duration:.1f}s áudio): {text!r}")
            if is_hallucination(text):
                log(f"alucinação/vazio descartado: {text!r}")
                return
            t1 = time.time()
            restore_focus_and_type(self.window_id, text)
            log(f"digitação {time.time() - t1:.2f}s (xdotool)")
        except Exception as e:
            log(f"transcrição falhou: {e}")
        finally:
            self._enqueue(self.overlay.hide)

    def run(self) -> None:
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            pass
        finally:
            self.listener.stop()


if __name__ == "__main__":
    Dictation().run()
