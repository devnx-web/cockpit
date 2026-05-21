// =========================================================
// MÓDULO STT (Speech-to-Text)
// Gerencia o daemon Python que mantém o faster-whisper residente e
// expõe um Unix socket pra transcrição. Substitui o dictation.py
// global (pynput + xdotool) — agora o áudio vem do mic do navegador
// (Electron) e o texto vai pro PTY do terminal ativo via WS.
//
// O daemon vive em modules/voice/stt-daemon.py. Esse módulo:
//   - detecta se já tem daemon vivo (ping no socket)
//   - spawna o daemon como child process se necessário
//   - encerra o daemon junto com o cockpit
//   - expõe transcribe(buffer, ext) que salva blob em /tmp, manda o
//     path pro daemon, devolve texto, e remove o arquivo
// =========================================================
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const VOICE_DIR = (() => {
  const raw = path.resolve(new URL(".", import.meta.url).pathname, "../modules/voice");
  return raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
})();

const SCRIPT = path.join(VOICE_DIR, "stt-daemon.py");
const SOCKET_PATH = "/tmp/cockpit-stt.sock";

// Reusa o mesmo venv do daemon-xtts (que já tem faster-whisper, numpy, etc).
// Pode ser sobrescrito via env COCKPIT_STT_PYTHON.
const DEFAULT_PYTHON = process.env.COCKPIT_STT_PYTHON
  || "/home/ftgk/Documents/omnivoice-test/.venv/bin/python";

let daemonProcess = null;
let logsDir = path.join(VOICE_DIR, "logs");

export function init({ logsDir: ld } = {}) {
  if (ld) logsDir = ld;
}

function sendCmd(req, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: SOCKET_PATH });
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(result);
    };
    const t = setTimeout(() => finish({ ok: false, error: "timeout" }), timeout);
    sock.on("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        try { finish(JSON.parse(buf.slice(0, nl))); }
        catch (e) { finish({ ok: false, error: "bad response: " + e.message }); }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(t);
      finish({ ok: false, error: err.code || err.message });
    });
    sock.on("end", () => {
      clearTimeout(t);
      if (!done) finish({ ok: false, error: "no response" });
    });
  });
}

async function ping({ timeout = 800 } = {}) {
  const r = await sendCmd({ cmd: "ping" }, { timeout });
  return r.ok === true ? r : null;
}

function spawnDaemon() {
  if (!fs.existsSync(VOICE_DIR)) {
    console.log(`\x1b[33m▸ stt\x1b[0m modules/voice não encontrado em ${VOICE_DIR}`);
    return null;
  }
  if (!fs.existsSync(DEFAULT_PYTHON)) {
    console.log(`\x1b[33m▸ stt\x1b[0m venv não encontrado em ${DEFAULT_PYTHON} — daemon não foi iniciado`);
    return null;
  }
  if (!fs.existsSync(SCRIPT)) {
    console.log(`\x1b[33m▸ stt\x1b[0m script não encontrado em ${SCRIPT}`);
    return null;
  }
  // socket zumbi bloqueia o bind do novo daemon
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (e) {
    console.log(`\x1b[33m▸ stt\x1b[0m falha ao criar logsDir ${logsDir}: ${e.message}`);
    return null;
  }
  const stdoutLog = fs.openSync(path.join(logsDir, "stt-daemon.stdout.log"), "a");

  const proc = spawn(DEFAULT_PYTHON, ["stt-daemon.py"], {
    cwd: VOICE_DIR,
    stdio: ["ignore", stdoutLog, stdoutLog],
    detached: false,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      STT_SOCKET_PATH: SOCKET_PATH,
      STT_LOG_FILE: path.join(logsDir, "stt-daemon.log"),
    },
  });

  proc.on("exit", (code, signal) => {
    console.log(`\x1b[33m▸ stt\x1b[0m daemon encerrado (code=${code} signal=${signal})`);
    if (daemonProcess === proc) daemonProcess = null;
  });
  proc.on("error", (err) => {
    console.log(`\x1b[31m▸ stt\x1b[0m falha ao spawnar daemon: ${err.message}`);
  });
  return proc;
}

async function waitForDaemon(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await ping({ timeout: 500 });
    if (p) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

export async function start() {
  // já tá vivo? respeita.
  if (await ping()) {
    console.log(`\x1b[36m▸ stt\x1b[0m daemon já em execução em ${SOCKET_PATH}`);
    return { managed: false, alive: true };
  }
  console.log(`\x1b[36m▸ stt\x1b[0m iniciando daemon…`);
  const proc = spawnDaemon();
  if (!proc) return { managed: false, alive: false };
  daemonProcess = proc;
  const ready = await waitForDaemon();
  if (ready) {
    console.log(`\x1b[36m▸ stt\x1b[0m daemon pronto (pid ${proc.pid})`);
    return { managed: true, alive: true, pid: proc.pid };
  }
  console.log(`\x1b[31m▸ stt\x1b[0m daemon não respondeu em 30s — ver logs/stt-daemon.stdout.log`);
  return { managed: true, alive: false, pid: proc.pid };
}

export async function stop() {
  try {
    await sendCmd({ cmd: "shutdown" }, { timeout: 1500 });
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
  if (daemonProcess) {
    try {
      if (!daemonProcess.killed) daemonProcess.kill("SIGTERM");
    } catch {}
    daemonProcess = null;
  }
}

export async function status() {
  const p = await ping({ timeout: 500 });
  return {
    alive: !!p,
    ready: p?.ready === true,
    device: p?.device ?? null,
    managed: !!daemonProcess,
    pid: daemonProcess?.pid ?? null,
    socketPath: SOCKET_PATH,
  };
}

// Recebe buffer de áudio (qualquer container que ffmpeg leia — webm/opus,
// wav, ogg, mp4…) e retorna {ok, text}.
export async function transcribe(audioBuffer, ext = "webm") {
  if (!audioBuffer || !audioBuffer.length) {
    return { ok: false, error: "audio vazio" };
  }
  // Cria arquivo tmp em /tmp pra o daemon poder ler
  const tmpDir = os.tmpdir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = path.join(tmpDir, `cockpit-stt-${id}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, audioBuffer);
  } catch (e) {
    return { ok: false, error: "falha ao salvar áudio: " + e.message };
  }
  try {
    // timeout maior pra transcrição (whisper pode levar uns segs em frase longa)
    const r = await sendCmd({ cmd: "transcribe", path: tmpPath }, { timeout: 30000 });
    return r;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
