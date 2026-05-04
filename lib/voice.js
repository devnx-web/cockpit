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

// Caminho real do diretório modules/voice. Em produção, import.meta.url resolve
// pra dentro do app.asar — mas asar é um arquivo, não diretório, então spawn com
// cwd lá dá ENOTDIR. Substituímos por app.asar.unpacked/, onde o electron-builder
// (via asarUnpack no package.json) extrai os arquivos como diretório real.
const VOICE_DIR = (() => {
  const raw = path.resolve(new URL(".", import.meta.url).pathname, "../modules/voice");
  return raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
})();
const VOICE_DIR_DEFAULT_CONFIG = path.join(VOICE_DIR, "config.json");

// Pythons + scripts por engine TTS. O cockpit suporta três daemons:
//   - openai     → daemon-openai.py (cloud, sem GPU, voz idêntica sempre)
//   - xtts       → daemon-xtts.py   (XTTS-v2 local, GPU/CPU, clona voz)
//   - omnivoice  → daemon.py        (legado, GPU-only)
// O engine ativo vem do config (cfg.tts_engine, default "openai").
const ENGINE_DEFAULTS = {
  openai: {
    script: "daemon-openai.py",
    // só precisa de numpy + sounddevice + urllib — Python do sistema serve.
    // Em dev, reutilizamos qualquer venv existente que já tenha deps. Em
    // produção, o instalador cria um venv pequeno (ou usa pip --user).
    python: process.env.COCKPIT_OPENAI_PYTHON
      || "/home/ftgk/.local/share/cockpit/venv-xtts/bin/python",
  },
  xtts: {
    script: "daemon-xtts.py",
    python: process.env.COCKPIT_XTTS_PYTHON
      || "/home/ftgk/.local/share/cockpit/venv-xtts/bin/python",
  },
  omnivoice: {
    script: "daemon.py",
    python: process.env.COCKPIT_VOICE_PYTHON
      || "/home/ftgk/Documents/omnivoice-test/.venv/bin/python",
  },
};

let daemonProcess = null;     // null se o cockpit não spawnou (já tava rodando, ou módulo desativado)
let cachedConfig = null;
let socketPath = "/tmp/claude-voice.sock";
// Caminho efetivo do config.json. Em produção (Electron empacotado) o asar é
// read-only; o electron-main copia o seed pra userData e passa o caminho aqui
// via init(). Se nada for setado, caímos no path ao lado do daemon (modo dev).
let configPath = VOICE_DIR_DEFAULT_CONFIG;
// Diretório de logs do daemon Python. Em produção precisa ser gravável — o
// electron-main passa userData/voice-logs. Em dev fica ao lado do daemon.
let logsDir = path.join(VOICE_DIR, "logs");

export function init({ configPath: cp, logsDir: ld } = {}) {
  if (cp) configPath = cp;
  if (ld) logsDir = ld;
}

function loadConfig() {
  try {
    cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
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
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 4) + "\n", "utf8");
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
  if (!fs.existsSync(VOICE_DIR)) {
    console.log(`\x1b[33m▸ voice\x1b[0m modules/voice não encontrado em ${VOICE_DIR} — empacotamento incompleto?`);
    return null;
  }
  // Escolhe engine baseado no config (default: xtts). O config é a fonte da
  // verdade; se o usuário quiser voltar pro omnivoice, basta mudar lá.
  const engineName = (cachedConfig && cachedConfig.tts_engine) || "xtts";
  const engine = ENGINE_DEFAULTS[engineName];
  if (!engine) {
    console.log(`\x1b[31m▸ voice\x1b[0m tts_engine desconhecido: ${engineName}`);
    return null;
  }
  if (!fs.existsSync(engine.python)) {
    console.log(`\x1b[33m▸ voice\x1b[0m venv (${engineName}) não encontrado em ${engine.python} — daemon não foi iniciado`);
    return null;
  }
  if (!fs.existsSync(path.join(VOICE_DIR, engine.script))) {
    console.log(`\x1b[33m▸ voice\x1b[0m script (${engineName}) não encontrado em ${path.join(VOICE_DIR, engine.script)}`);
    return null;
  }
  // socket zumbi (de daemon morto) bloqueia o spawn do novo — Python tenta criar
  // e dá "Address already in use". Limpamos antes.
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {}

  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (e) {
    console.log(`\x1b[33m▸ voice\x1b[0m falha ao criar logsDir ${logsDir}: ${e.message}`);
    return null;
  }
  const stdoutLog = fs.openSync(path.join(logsDir, "daemon.stdout.log"), "a");
  console.log(`\x1b[36m▸ voice\x1b[0m engine=${engineName} script=${engine.script}`);

  const proc = spawn(engine.python, [engine.script], {
    cwd: VOICE_DIR,
    stdio: ["ignore", stdoutLog, stdoutLog],
    detached: false,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // dá pro daemon o mesmo config que o cockpit Node está lendo —
      // crítico em produção, onde o asar é read-only e o config real
      // mora no userData
      VOICE_CONFIG_PATH: configPath,
      // override do log_file do config (que tem path hardcoded inutilizável
      // fora da máquina do dev). userData/voice-logs/ é sempre gravável.
      VOICE_LOG_FILE: path.join(logsDir, "daemon.log"),
    },
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
    console.log(`\x1b[33m▸ voice\x1b[0m config.json não encontrado em ${configPath}, módulo desativado`);
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
