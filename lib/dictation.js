// =========================================================
// MÓDULO DE DITADO (dictation)
// Gerencia o processo Python que captura teclado global e
// converte fala em texto. Roda em modules/voice/dictation.py.
//
// Hold Left Ctrl por 0.5s ativa gravação; solta Ctrl pra
// transcrever (faster-whisper PT-BR) e digitar na janela ativa
// via xdotool.
//
// É opt-in: o cockpit NÃO inicia automaticamente — só quando o
// usuário liga pelo painel. Isso evita rodar um listener global
// de teclado o tempo todo.
// =========================================================
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const VOICE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../modules/voice");
const SCRIPT = path.join(VOICE_DIR, "dictation.py");
const VENV_PYTHON = "/home/ftgk/Documents/omnivoice-test/.venv/bin/python";

let proc = null;

export function isRunning() {
  return !!(proc && !proc.killed && proc.exitCode === null);
}

export function start() {
  if (isRunning()) return { ok: true, alreadyRunning: true, pid: proc.pid };
  if (!fs.existsSync(VENV_PYTHON)) {
    return { ok: false, error: `venv não encontrado: ${VENV_PYTHON}` };
  }
  if (!fs.existsSync(SCRIPT)) {
    return { ok: false, error: `dictation.py não encontrado em ${SCRIPT}` };
  }
  // dictation precisa de DISPLAY (X11) pra xdotool/tkinter/pynput.
  if (!process.env.DISPLAY) {
    return { ok: false, error: "DISPLAY não definido — dictation precisa de X11" };
  }
  const logsDir = path.join(VOICE_DIR, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutLog = fs.openSync(path.join(logsDir, "dictation.stdout.log"), "a");

  proc = spawn(VENV_PYTHON, ["dictation.py"], {
    cwd: VOICE_DIR,
    stdio: ["ignore", stdoutLog, stdoutLog],
    detached: false,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  proc.on("exit", (code, signal) => {
    console.log(`\x1b[33m▸ dictation\x1b[0m encerrado (code=${code} signal=${signal})`);
    proc = null;
  });
  proc.on("error", (err) => {
    console.log(`\x1b[31m▸ dictation\x1b[0m falha ao spawnar: ${err.message}`);
  });

  console.log(`\x1b[36m▸ dictation\x1b[0m iniciado (pid ${proc.pid})`);
  return { ok: true, pid: proc.pid };
}

export function stop() {
  if (!isRunning()) return { ok: true, alreadyStopped: true };
  try {
    proc.kill("SIGTERM");
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

export function status() {
  return {
    running: isRunning(),
    pid: isRunning() ? proc.pid : null,
    hasDisplay: !!process.env.DISPLAY,
  };
}
