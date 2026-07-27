"""Painel Claude Voice — visual JARVIS / HUD Iron Man.

Tema escuro com acentos ciano (arc reactor) e laranja (alerta).
Layout em cards: status, voz, comportamento, ações, log.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, font, messagebox, scrolledtext

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
DAEMON_PATH = ROOT / "daemon.py"
SPEAK_PATH = ROOT / "speak.py"
DICTATION_PATH = ROOT / "dictation.py"
PYTHON_VENV = Path("/home/ftgk/Documents/omnivoice-test/.venv/bin/python")
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
HOOK_MARKER = "claude-voice"

# Paleta JARVIS
BG = "#0a0e14"
CARD = "#131820"
CARD_HI = "#1a212c"
BORDER = "#1f2937"
TXT = "#e6edf3"
TXT_DIM = "#8b96a8"
TXT_FAINT = "#5d6878"
CYAN = "#00d4ff"
CYAN_HI = "#5be8ff"
ORANGE = "#ff6b00"
GREEN = "#00ff88"
RED = "#ff4757"

MODES = [
    ("Resumo IA (recomendado)", "summary"),
    ("Resposta inteira", "full"),
    ("Só primeira frase", "first_sentence"),
    ("Duas primeiras frases", "first_n_sentences"),
]


# ───── helpers ─────

def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=4, ensure_ascii=False), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


def daemon_alive(socket_path: str) -> bool:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            s.connect(socket_path)
            s.sendall(b'{"cmd":"ping"}\n')
            return bool(s.recv(64))
    except Exception:
        return False


def daemon_send(socket_path: str, payload: dict) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(60.0)
        s.connect(socket_path)
        s.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
    return json.loads((data.decode("utf-8") or "{}"))


def start_daemon() -> None:
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    out = open(log_dir / "daemon.stdout.log", "ab")
    subprocess.Popen(
        [str(PYTHON_VENV), str(DAEMON_PATH)],
        stdout=out, stderr=subprocess.STDOUT,
        cwd=str(ROOT), start_new_session=True,
    )


def start_dictation() -> None:
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    out = open(log_dir / "dictation.stdout.log", "ab")
    subprocess.Popen(
        [str(PYTHON_VENV), str(DICTATION_PATH)],
        stdout=out, stderr=subprocess.STDOUT,
        cwd=str(ROOT), start_new_session=True,
    )


def stop_daemon(socket_path: str) -> None:
    try:
        daemon_send(socket_path, {"cmd": "shutdown"})
    except Exception:
        pass


def stop_dictation() -> None:
    subprocess.run(["pkill", "-f", "dictation.py"], check=False)


def dictation_alive() -> bool:
    r = subprocess.run(["pgrep", "-f", "dictation.py"], capture_output=True)
    return r.returncode == 0


def hook_command() -> str:
    return f"{PYTHON_VENV} {SPEAK_PATH}"


def install_hook() -> str:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    settings: dict = {}
    if SETTINGS_PATH.exists():
        try:
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return "settings.json inválido — abra manualmente"
    hooks = settings.setdefault("hooks", {})
    stop_hooks = hooks.setdefault("Stop", [])
    cmd = hook_command()
    for entry in stop_hooks:
        for h in entry.get("hooks", []):
            if HOOK_MARKER in h.get("command", ""):
                h["command"] = cmd
                SETTINGS_PATH.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
                return "hook atualizado"
    stop_hooks.append({"matcher": "", "hooks": [{"type": "command", "command": cmd, "timeout": 30}]})
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    return "hook instalado"


def uninstall_hook() -> str:
    if not SETTINGS_PATH.exists():
        return "settings.json não existe"
    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return "settings.json inválido"
    stop_hooks = settings.get("hooks", {}).get("Stop", [])
    new_stop = []
    removed = 0
    for entry in stop_hooks:
        kept = [h for h in entry.get("hooks", []) if HOOK_MARKER not in h.get("command", "")]
        removed += len(entry.get("hooks", [])) - len(kept)
        if kept:
            entry["hooks"] = kept
            new_stop.append(entry)
    settings.setdefault("hooks", {})["Stop"] = new_stop
    if not new_stop:
        settings["hooks"].pop("Stop", None)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    return f"removido {removed} hook(s)" if removed else "nada para remover"


def hook_installed() -> bool:
    if not SETTINGS_PATH.exists():
        return False
    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    for entry in settings.get("hooks", {}).get("Stop", []):
        for h in entry.get("hooks", []):
            if HOOK_MARKER in h.get("command", ""):
                return True
    return False


# ───── widgets customizados ─────

class Card(tk.Frame):
    def __init__(self, master, title: str, **kw):
        super().__init__(master, bg=CARD, highlightbackground=BORDER, highlightthickness=1, **kw)
        header = tk.Frame(self, bg=CARD)
        header.pack(fill="x", padx=18, pady=(14, 4))
        tk.Label(header, text=title, bg=CARD, fg=CYAN,
                 font=("Sans", 9, "bold")).pack(side="left")
        self.body = tk.Frame(self, bg=CARD)
        self.body.pack(fill="both", expand=True, padx=18, pady=(0, 14))


class HudButton(tk.Button):
    def __init__(self, master, text: str, command, accent: str = CYAN, **kw):
        super().__init__(
            master, text=text, command=command,
            bg=CARD_HI, fg=accent, activebackground=accent, activeforeground=BG,
            relief="flat", bd=0, padx=14, pady=8,
            font=("Sans", 9, "bold"), cursor="hand2",
            highlightbackground=accent, highlightthickness=1,
            **kw,
        )
        self._accent = accent
        self.bind("<Enter>", lambda e: self.config(bg=accent, fg=BG))
        self.bind("<Leave>", lambda e: self.config(bg=CARD_HI, fg=accent))


class StatusRow(tk.Frame):
    def __init__(self, master, label: str):
        super().__init__(master, bg=CARD)
        tk.Label(self, text=label, bg=CARD, fg=TXT_DIM,
                 font=("Sans", 10), width=14, anchor="w").pack(side="left")
        self.dot = tk.Label(self, text="●", bg=CARD, fg=TXT_FAINT, font=("Sans", 12))
        self.dot.pack(side="left")
        self.text = tk.Label(self, text="—", bg=CARD, fg=TXT, font=("Sans", 10))
        self.text.pack(side="left", padx=(6, 0))

    def set(self, text: str, color: str = TXT):
        self.dot.config(fg=color)
        self.text.config(text=text, fg=TXT)


# ───── app ─────

class App:
    def __init__(self) -> None:
        self.cfg = load_config()
        self.root = tk.Tk()
        self.root.title("J.A.R.V.I.S. — Ailiv Voice")
        self.root.geometry("900x940")
        self.root.configure(bg=BG)
        self.root.minsize(820, 880)

        self.enabled = tk.BooleanVar(value=self.cfg.get("enabled", True))
        self.voice_ref = tk.StringVar(value=self.cfg.get("voice_ref", ""))
        self.voice_ref_text = tk.StringVar(value=self.cfg.get("voice_ref_text", ""))
        self.mode = tk.StringVar(value=self.cfg.get("speech_mode", "summary"))
        self.max_chars = tk.IntVar(value=int(self.cfg.get("max_chars", 400)))
        self.speed = tk.DoubleVar(value=float(self.cfg.get("speed", 1.0)))
        self.volume = tk.DoubleVar(value=float(self.cfg.get("volume", 2.5)))

        self._build()
        self.refresh_status()
        self.root.after(2500, self._auto_refresh)

    # ───── layout ─────

    def _build(self) -> None:
        # Header
        header = tk.Frame(self.root, bg=BG)
        header.pack(fill="x", padx=24, pady=(20, 12))
        title = tk.Label(header, text="J.A.R.V.I.S.", bg=BG, fg=CYAN,
                         font=("Sans", 24, "bold"))
        title.pack(side="left")
        sub = tk.Label(header, text="  Ailiv Voice Interface", bg=BG, fg=TXT_DIM,
                       font=("Sans", 11))
        sub.pack(side="left", pady=(8, 0))

        self.global_dot = tk.Label(header, text="●", bg=BG, fg=TXT_FAINT, font=("Sans", 18))
        self.global_dot.pack(side="right", pady=(6, 0))
        self.global_status = tk.Label(header, text="VERIFICANDO", bg=BG, fg=TXT_DIM,
                                      font=("Sans", 9, "bold"))
        self.global_status.pack(side="right", padx=(0, 8), pady=(10, 0))

        # ── STATUS ──
        c_status = Card(self.root, "STATUS")
        c_status.pack(fill="x", padx=24, pady=(0, 12))
        self.row_daemon = StatusRow(c_status.body, "DAEMON TTS")
        self.row_daemon.pack(fill="x", pady=2)
        self.row_dictation = StatusRow(c_status.body, "DICTATION")
        self.row_dictation.pack(fill="x", pady=2)
        self.row_hook = StatusRow(c_status.body, "HOOK STOP")
        self.row_hook.pack(fill="x", pady=2)
        self.row_voice = StatusRow(c_status.body, "VOZ")
        self.row_voice.pack(fill="x", pady=2)

        # ── VOZ ──
        c_voice = Card(self.root, "VOZ")
        c_voice.pack(fill="x", padx=24, pady=(0, 12))

        en_row = tk.Frame(c_voice.body, bg=CARD)
        en_row.pack(fill="x", pady=4)
        tk.Checkbutton(en_row, text="Falar quando o Ailiv terminar",
                       variable=self.enabled, bg=CARD, fg=TXT, selectcolor=CARD_HI,
                       activebackground=CARD, activeforeground=CYAN,
                       font=("Sans", 10), bd=0, highlightthickness=0).pack(side="left")

        self._slider(c_voice.body, "Velocidade", self.speed, 0.7, 1.3, "{:.2f}x")
        self._slider(c_voice.body, "Volume", self.volume, 0.5, 4.0, "{:.2f}x")

        # ── COMPORTAMENTO ──
        c_beh = Card(self.root, "COMPORTAMENTO")
        c_beh.pack(fill="x", padx=24, pady=(0, 12))

        m_row = tk.Frame(c_beh.body, bg=CARD)
        m_row.pack(fill="x", pady=4)
        tk.Label(m_row, text="Modo de fala", bg=CARD, fg=TXT_DIM,
                 font=("Sans", 10), width=14, anchor="w").pack(side="left")
        opt = tk.OptionMenu(m_row, self.mode, *[v for _, v in MODES])
        opt.config(bg=CARD_HI, fg=CYAN, activebackground=CYAN, activeforeground=BG,
                   bd=0, relief="flat", highlightthickness=1, highlightbackground=BORDER,
                   font=("Sans", 10))
        opt["menu"].config(bg=CARD_HI, fg=TXT, activebackground=CYAN, activeforeground=BG)
        opt.pack(side="left", fill="x", expand=True)

        ch_row = tk.Frame(c_beh.body, bg=CARD)
        ch_row.pack(fill="x", pady=4)
        tk.Label(ch_row, text="Limite (chars)", bg=CARD, fg=TXT_DIM,
                 font=("Sans", 10), width=14, anchor="w").pack(side="left")
        sb = tk.Spinbox(ch_row, from_=80, to=2000, increment=20,
                        textvariable=self.max_chars, width=8,
                        bg=CARD_HI, fg=TXT, buttonbackground=CARD_HI,
                        bd=0, relief="flat", insertbackground=CYAN,
                        font=("Sans", 10), highlightthickness=1, highlightbackground=BORDER)
        sb.pack(side="left")

        ref_row = tk.Frame(c_beh.body, bg=CARD)
        ref_row.pack(fill="x", pady=(8, 4))
        tk.Label(ref_row, text="Voz (ref .wav)", bg=CARD, fg=TXT_DIM,
                 font=("Sans", 10), width=14, anchor="w").pack(side="left")
        tk.Entry(ref_row, textvariable=self.voice_ref, bg=CARD_HI, fg=TXT_DIM,
                 bd=0, relief="flat", insertbackground=CYAN,
                 highlightthickness=1, highlightbackground=BORDER,
                 font=("Sans", 9)).pack(side="left", fill="x", expand=True, padx=(0, 6))
        HudButton(ref_row, "Procurar", self._browse_ref, accent=TXT_DIM).pack(side="left")

        # ── AÇÕES ──
        c_act = Card(self.root, "AÇÕES")
        c_act.pack(fill="x", padx=24, pady=(0, 12))
        r1 = tk.Frame(c_act.body, bg=CARD); r1.pack(fill="x", pady=2)
        HudButton(r1, "▶  TESTAR VOZ", self.on_test, accent=CYAN).pack(side="left", padx=(0, 6))
        HudButton(r1, "💾  SALVAR", self.on_save, accent=GREEN).pack(side="left", padx=6)

        r2 = tk.Frame(c_act.body, bg=CARD); r2.pack(fill="x", pady=2)
        HudButton(r2, "INICIAR DAEMON", self.on_start_daemon, accent=CYAN).pack(side="left", padx=(0, 6))
        HudButton(r2, "PARAR DAEMON", self.on_stop_daemon, accent=ORANGE).pack(side="left", padx=6)
        HudButton(r2, "INICIAR DICTATION", self.on_start_dictation, accent=CYAN).pack(side="left", padx=6)
        HudButton(r2, "PARAR DICTATION", self.on_stop_dictation, accent=ORANGE).pack(side="left", padx=6)

        r3 = tk.Frame(c_act.body, bg=CARD); r3.pack(fill="x", pady=2)
        HudButton(r3, "INSTALAR HOOK", self.on_install_hook, accent=CYAN).pack(side="left", padx=(0, 6))
        HudButton(r3, "REMOVER HOOK", self.on_uninstall_hook, accent=ORANGE).pack(side="left", padx=6)

        # ── LOG ──
        c_log = Card(self.root, "LOG")
        c_log.pack(fill="both", expand=True, padx=24, pady=(0, 24))
        self.log = scrolledtext.ScrolledText(
            c_log.body, height=8, bg=CARD_HI, fg=TXT,
            insertbackground=CYAN, bd=0, relief="flat",
            font=("Mono", 9), state="disabled",
        )
        self.log.pack(fill="both", expand=True)

    def _slider(self, parent, label: str, var: tk.DoubleVar, lo: float, hi: float, fmt: str) -> None:
        row = tk.Frame(parent, bg=CARD)
        row.pack(fill="x", pady=4)
        tk.Label(row, text=label, bg=CARD, fg=TXT_DIM,
                 font=("Sans", 10), width=14, anchor="w").pack(side="left")
        s = tk.Scale(row, from_=lo, to=hi, resolution=0.05, variable=var,
                     orient="horizontal", bg=CARD, fg=CYAN, troughcolor=CARD_HI,
                     activebackground=CYAN_HI, highlightthickness=0, bd=0,
                     showvalue=False, length=300)
        s.pack(side="left", fill="x", expand=True)
        val = tk.Label(row, text=fmt.format(var.get()), bg=CARD, fg=CYAN,
                       font=("Mono", 10, "bold"), width=8)
        val.pack(side="left", padx=(8, 0))
        var.trace_add("write", lambda *_: val.config(text=fmt.format(var.get())))

    # ───── ações ─────

    def _browse_ref(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("WAV", "*.wav"), ("Todos", "*.*")])
        if path:
            self.voice_ref.set(path)

    def _log(self, msg: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", f"> {msg}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def refresh_status(self) -> None:
        d_alive = daemon_alive(self.cfg["socket_path"])
        di_alive = dictation_alive()
        h_inst = hook_installed()

        self.row_daemon.set(
            "ONLINE — modelo na GPU" if d_alive else "offline",
            GREEN if d_alive else RED,
        )
        self.row_dictation.set(
            "ATIVO — Left Ctrl 1s" if di_alive else "inativo",
            GREEN if di_alive else TXT_FAINT,
        )
        self.row_hook.set(
            "INSTALADO — global" if h_inst else "não instalado",
            GREEN if h_inst else TXT_FAINT,
        )
        ref = Path(self.cfg.get("voice_ref", "")).name or "—"
        self.row_voice.set(f"JARVIS — {ref}", CYAN)

        if d_alive and h_inst:
            self.global_dot.config(fg=GREEN)
            self.global_status.config(text="OPERACIONAL", fg=GREEN)
        elif d_alive or h_inst:
            self.global_dot.config(fg=ORANGE)
            self.global_status.config(text="PARCIAL", fg=ORANGE)
        else:
            self.global_dot.config(fg=RED)
            self.global_status.config(text="OFFLINE", fg=RED)

    def _auto_refresh(self) -> None:
        self.refresh_status()
        self.root.after(2500, self._auto_refresh)

    def on_save(self) -> None:
        self.cfg.update({
            "enabled": bool(self.enabled.get()),
            "voice_ref": self.voice_ref.get(),
            "voice_ref_text": self.voice_ref_text.get(),
            "speech_mode": self.mode.get(),
            "max_chars": int(self.max_chars.get()),
            "speed": round(float(self.speed.get()), 2),
            "volume": round(float(self.volume.get()), 2),
        })
        save_config(self.cfg)
        self._log("config salva (chmod 600)")
        if daemon_alive(self.cfg["socket_path"]):
            try:
                daemon_send(self.cfg["socket_path"], {"cmd": "reload"})
                self._log("daemon recarregou config")
            except Exception as e:
                self._log(f"falha ao recarregar daemon: {e}")

    def on_test(self) -> None:
        self.on_save()
        if not daemon_alive(self.cfg["socket_path"]):
            messagebox.showwarning("Daemon parado", "Inicie o daemon antes de testar.")
            return
        text = "Tarefa concluída, senhor. Sistema operando dentro dos parâmetros nominais."

        def go():
            try:
                resp = daemon_send(self.cfg["socket_path"], {"cmd": "speak", "text": text})
                self._log(f"teste: {resp}")
            except Exception as e:
                self._log(f"teste falhou: {e}")
        threading.Thread(target=go, daemon=True).start()
        self._log("testando voz…")

    def on_start_daemon(self) -> None:
        if daemon_alive(self.cfg["socket_path"]):
            self._log("daemon já rodando"); return
        start_daemon()
        self._log("iniciando daemon… (modelo carrega em ~2s)")
        self.root.after(1500, self.refresh_status)

    def on_stop_daemon(self) -> None:
        stop_daemon(self.cfg["socket_path"])
        self._log("daemon: shutdown enviado")
        self.root.after(800, self.refresh_status)

    def on_start_dictation(self) -> None:
        if dictation_alive():
            self._log("dictation já rodando"); return
        start_dictation()
        self._log("iniciando dictation…")
        self.root.after(1500, self.refresh_status)

    def on_stop_dictation(self) -> None:
        stop_dictation()
        self._log("dictation parado")
        self.root.after(500, self.refresh_status)

    def on_install_hook(self) -> None:
        try:
            self._log("hook: " + install_hook())
        except Exception as e:
            self._log(f"falha: {e}")
        self.refresh_status()

    def on_uninstall_hook(self) -> None:
        try:
            self._log("hook: " + uninstall_hook())
        except Exception as e:
            self._log(f"falha: {e}")
        self.refresh_status()

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    App().run()
