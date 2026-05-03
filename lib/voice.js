// =========================================================
// MÓDULO DE VOZ (Járvis)
// Gerencia o ciclo de vida do daemon Python que mantém o OmniVoice
// residente na GPU e expõe um Unix socket pra síntese de fala.
//
// O daemon vive em modules/voice/daemon.py. Esse módulo:
//   - detecta se já tem daemon vivo (ping no socket)
//   - spawna o daemon como child process se necessário
//   - encerra o daemon junto com o cockpit
//   - expõe send(cmd, args) pra o resto do servidor falar com ele
// =========================================================
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";

const VOICE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../modules/voice");
const CONFIG_PATH = path.join(VOICE_DIR, "config.json");
const VENV_PYTHON = "/home/ftgk/Documents/omnivoice-test/.venv/bin/python";

let daemonProcess = null;     // null se o cockpit não spawnou (já tava rodando, ou módulo desativado)
let cachedConfig = null;
let socketPath = "/tmp/claude-voice.sock";

function loadConfig() {
  try {
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cachedConfig.socket_path) socketPath = cachedConfig.socket_path;
    return cachedConfig;
  } catch (e) {
    cachedConfig = null;
    return null;
  }
}

function getConfig() {
  return cachedConfig;
}

// Mescla patch no config.json em disco e atualiza o cache.
// Patch é shallow — chaves no topo sobrescrevem inteiras (ex: passar
// {summarize: {...}} substitui o objeto summarize).
function patchConfig(patch) {
  const current = loadConfig();
  if (!current) return { ok: false, error: "config não carregada" };
  const merged = { ...current, ...patch };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 4) + "\n", "utf8");
    cachedConfig = merged;
    if (merged.socket_path) socketPath = merged.socket_path;
    return { ok: true, config: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Manda comando JSON pelo socket. Retorna parsed response ou {ok:false,error}.
function send(cmd, extra = {}, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: socketPath });
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
      sock.write(JSON.stringify({ cmd, ...extra }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        try {
          finish(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          finish({ ok: false, error: "bad response: " + e.message });
        }
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
  const r = await send("ping", {}, { timeout });
  return r.ok === true;
}

function spawnDaemon() {
  if (!fs.existsSync(VENV_PYTHON)) {
    console.log(`\x1b[33m▸ voice\x1b[0m venv não encontrado em ${VENV_PYTHON} — daemon não foi iniciado`);
    return null;
  }
  const logsDir = path.join(VOICE_DIR, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutLog = fs.openSync(path.join(logsDir, "daemon.stdout.log"), "a");

  const proc = spawn(VENV_PYTHON, ["daemon.py"], {
    cwd: VOICE_DIR,
    stdio: ["ignore", stdoutLog, stdoutLog],
    detached: false,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  proc.on("exit", (code, signal) => {
    console.log(`\x1b[33m▸ voice\x1b[0m daemon encerrado (code=${code} signal=${signal})`);
    if (daemonProcess === proc) daemonProcess = null;
  });

  proc.on("error", (err) => {
    console.log(`\x1b[31m▸ voice\x1b[0m falha ao spawnar daemon: ${err.message}`);
  });

  return proc;
}

// Espera o socket ficar pronto (até timeoutMs). Resolve true se OK.
async function waitForDaemon(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping({ timeout: 500 })) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

export async function start() {
  const cfg = loadConfig();
  if (!cfg) {
    console.log(`\x1b[33m▸ voice\x1b[0m config.json não encontrado em ${CONFIG_PATH}, módulo desativado`);
    return { managed: false, alive: false };
  }
  if (cfg.enabled === false) {
    console.log(`\x1b[33m▸ voice\x1b[0m desativado em config.json (enabled=false) — daemon não será iniciado`);
    return { managed: false, alive: false, disabled: true };
  }
  // já tá vivo? respeita.
  if (await ping()) {
    console.log(`\x1b[36m▸ voice\x1b[0m daemon já em execução em ${socketPath}`);
    return { managed: false, alive: true };
  }
  console.log(`\x1b[36m▸ voice\x1b[0m iniciando daemon…`);
  const proc = spawnDaemon();
  if (!proc) return { managed: false, alive: false };
  daemonProcess = proc;
  const ready = await waitForDaemon();
  if (ready) {
    console.log(`\x1b[36m▸ voice\x1b[0m daemon pronto (pid ${proc.pid})`);
    return { managed: true, alive: true, pid: proc.pid };
  } else {
    console.log(`\x1b[31m▸ voice\x1b[0m daemon não respondeu em 30s — verifique logs/daemon.stdout.log`);
    return { managed: true, alive: false, pid: proc.pid };
  }
}

export async function stop() {
  // tenta shutdown limpo via socket (vale pra daemon spawnado por nós OU externo)
  try {
    await send("shutdown", {}, { timeout: 1500 });
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
  const alive = await ping({ timeout: 500 });
  return {
    alive,
    managed: !!daemonProcess,
    pid: daemonProcess?.pid ?? null,
    socketPath,
    configLoaded: !!cachedConfig,
  };
}

export { send, ping, getConfig, loadConfig, patchConfig };
