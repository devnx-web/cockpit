// =========================================================
// DITADO NATIVO (main process / Electron)
// Substitui o antigo dictation.py (venv externo) por um pipeline Node:
//   - gatilho global Ctrl+Espaço (toggle) via globalShortcut
//   - worker oculto captura o mic via AudioWorklet (lib /dictation/)
//   - transcrição no Groq (whisper-large-v3) — precisa/preciso e simples
//   - texto digitado na janela que estava focada, via xdotool
//
// É opt-in por config (dictation.enabled). Só Linux/X11 por enquanto (xdotool).
// =========================================================
import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import path from "path";
import url from "url";
import fs from "fs";
import { execFile } from "child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(ROOT, "dictation-preload.cjs");
const WAV_PATH = "/tmp/cockpit-dictation.wav";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const DEFAULTS = {
  enabled: true,
  hotkey: "Control+Space",
  provider: "groq",
  model: "whisper-large-v3",
  language: "pt",
};

// Frases que o Whisper inventa em silêncio/ruído (PT-BR) — descartadas.
const HALLUCINATIONS = new Set([
  "legendas pela comunidade amara.org",
  "amara.org",
  "obrigado",
  "obrigado.",
  "tchau",
  "tchau.",
  "obrigado por assistir",
  "obrigado por assistir.",
  "inscreva-se no canal",
  "...",
]);

let cfg = { ...DEFAULTS };
let cfgPath = null;
let serverUrl = "";
let workerWin = null;
let overlayWin = null;
let state = "idle"; // idle | recording | finalizing
let registeredHotkey = null;
let finalizeTimer = null;

function log(...a) { console.log("\x1b[36m▸ dictation\x1b[0m", ...a); }

// Espelha o console do worker no log do main (boot/erros do mic). Lida com as
// duas assinaturas de console-message (Electron antigo vs novo).
function forwardConsole(win, tag) {
  win.webContents.on("console-message", (e, level, message) => {
    const msg = (e && typeof e === "object" && typeof e.message === "string") ? e.message : message;
    if (msg) log(tag, msg);
  });
}

// ---------------------------------------------------------
// Config
// ---------------------------------------------------------
function loadConfig(p) {
  let fromFile = {};
  try {
    if (p && fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (json && typeof json.dictation === "object") fromFile = json.dictation;
    }
  } catch (e) {
    log("config inválida, usando defaults:", e.message);
  }
  return { ...DEFAULTS, ...fromFile };
}

function persistEnabled(enabled) {
  if (!cfgPath) return;
  try {
    let json = {};
    if (fs.existsSync(cfgPath)) json = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    json.dictation = { ...DEFAULTS, ...(json.dictation || {}), enabled };
    fs.writeFileSync(cfgPath, JSON.stringify(json, null, 2));
  } catch (e) {
    log("falha ao persistir config:", e.message);
  }
}

// ---------------------------------------------------------
// Janelas (worker oculto + overlay)
// ---------------------------------------------------------
function createWindows() {
  if (workerWin) return;

  workerWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // hidden → não throttlar timers/áudio
    },
  });
  workerWin.loadURL(`${serverUrl}/dictation/worker.html`);
  forwardConsole(workerWin, "[worker]");
  workerWin.on("closed", () => { workerWin = null; });

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const ow = 640, oh = 130;
  overlayWin = new BrowserWindow({
    width: ow, height: oh,
    x: Math.round((sw - ow) / 2), y: sh - oh - 30,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    hasShadow: false, show: false, fullscreenable: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadURL(`${serverUrl}/dictation/overlay.html`);
  overlayWin.on("closed", () => { overlayWin = null; });
}

function sendOverlay(payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send("dict:overlay", payload);
}
function sendWorker(cmd) {
  if (workerWin && !workerWin.isDestroyed()) workerWin.webContents.send("dict:cmd", cmd);
}
function showOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive(); // não rouba foco
}
function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ---------------------------------------------------------
// xdotool: captura a janela ativa e injeta o texto
// ---------------------------------------------------------
function xdo(args) {
  return new Promise((resolve) => {
    execFile("xdotool", args, { timeout: 8000 }, (err, stdout) => {
      if (err) { log("xdotool erro:", err.message); resolve(null); return; }
      resolve((stdout || "").trim());
    });
  });
}

function cleanText(text) {
  if (!text) return "";
  let t = text.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return ""; // só pontuação/silêncio → descarta
  const norm = t.toLowerCase().replace(/[!.…]+$/g, "").trim();
  if (HALLUCINATIONS.has(norm) || HALLUCINATIONS.has(t.toLowerCase())) return "";
  return t;
}

// Chave do Groq, em ordem de prioridade:
//   1. config dictation.api_key (voice-config; em produção fica no userData)
//   2. env GROQ_API_KEY
//   3. arquivo .groq-key (gitignored) — ao lado do config (userData) ou na raiz
// Assim funciona tanto rodando do código quanto empacotado no AppImage.
function getGroqKey() {
  if (cfg.api_key) return String(cfg.api_key).trim();
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  const files = [path.join(ROOT, ".groq-key")];
  if (cfgPath) files.push(path.join(path.dirname(cfgPath), ".groq-key"));
  for (const f of files) {
    try { if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim(); } catch {}
  }
  return "";
}

// Transcreve um WAV no Groq (whisper-large-v3). Usa fetch/FormData nativos.
async function groqTranscribe(wavPath) {
  const key = getGroqKey();
  if (!key) { log("sem GROQ key (.groq-key) — pulando"); return ""; }
  try {
    const data = fs.readFileSync(wavPath);
    const form = new FormData();
    form.append("file", new Blob([data], { type: "audio/wav" }), "audio.wav");
    form.append("model", cfg.model || DEFAULTS.model);
    form.append("language", cfg.language || "pt");
    form.append("response_format", "json");
    const t0 = Date.now();
    const res = await fetch(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    const j = await res.json().catch(() => ({}));
    if (res.ok && typeof j.text === "string") {
      log(`groq ${Date.now() - t0}ms: "${j.text.trim()}"`);
      return j.text.trim();
    }
    log(`groq erro ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return "";
  } catch (e) {
    log("groq falhou:", e.message);
    return "";
  }
}

async function injectText(rawText) {
  const text = cleanText(rawText);
  if (!text) { log("texto final vazio — nada a digitar"); return; }
  // O overlay não rouba foco, então a janela alvo continua focada: digita
  // direto, sem windowactivate --sync (que adicionava segundos de espera).
  log(`injetando: "${text}"`);
  const r = await xdo(["type", "--clearmodifiers", "--delay", "0", text]);
  log(`xdotool: ${r === null ? "ERRO" : "ok"}`);
}

// ---------------------------------------------------------
// Ciclo: toggle Ctrl+Espaço
// ---------------------------------------------------------
async function start() {
  if (state !== "idle") return;
  state = "recording";
  sendOverlay({ state: "recording", text: "" });
  showOverlay();
  sendWorker({ action: "start" });
}

function stop() {
  if (state !== "recording") return;
  state = "finalizing";
  sendOverlay({ state: "transcribing" });
  sendWorker({ action: "stop" });
  // Backstop: se o worker não devolver o final (download longo/erro), destrava
  // o overlay em vez de ficar preso em "Transcrevendo…".
  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    if (state !== "finalizing") return;
    log("timeout aguardando transcrição — destravando overlay");
    sendOverlay({ state: "error", detail: "Tempo esgotado (rede?)" });
    setTimeout(hideOverlay, 2500);
    state = "idle";
  }, 20000);
}

function resetAfterFinal() {
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  state = "idle";
}

function toggle() {
  if (state === "idle") start();
  else if (state === "recording") stop();
  // em "finalizing" ignora (já está fechando)
}

// Grava o PCM Float32 capturado num WAV 16-bit mono pra mandar ao Groq.
function writeWav(rawBuf, rate, outPath) {
  let ab = rawBuf;
  if (Buffer.isBuffer(ab)) ab = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
  const f32 = new Float32Array(ab);
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2); }
  fs.writeFileSync(outPath, buf);
  return n / rate;
}

// Recebeu o áudio do worker → transcreve no Groq → injeta.
async function handleFinalAudio(msg) {
  clearTimeout(finalizeTimer);
  let secs = 0;
  try { secs = writeWav(msg.buf, msg.rate || 16000, WAV_PATH); } catch (e) { log("writeWav falhou:", e.message); }
  if (secs < 0.3) { // nada falado
    sendOverlay({ state: "done", text: "—" });
    setTimeout(hideOverlay, 800);
    resetAfterFinal();
    return;
  }
  const text = await groqTranscribe(WAV_PATH);
  const clean = cleanText(text);
  if (clean) {
    hideOverlay();          // some na hora — sem flash verde segurando
    await injectText(text); // digita imediatamente
  } else {
    sendOverlay({ state: "error", detail: "(não entendi)" });
    setTimeout(hideOverlay, 1200);
  }
  resetAfterFinal();
}

// Eventos vindos do worker
function onWorkerEvent(_e, msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "final-audio") {
    handleFinalAudio(msg);
  } else if (msg.type === "status") {
    if (msg.status === "error") {
      sendOverlay({ state: "error", detail: msg.detail || "Erro no ditado" });
      setTimeout(hideOverlay, 2500);
      resetAfterFinal();
    } else if (msg.status === "capturing" && state === "finalizing") {
      sendOverlay({ state: "transcribing" });
    }
  }
}

// ---------------------------------------------------------
// Hotkey
// ---------------------------------------------------------
function registerHotkey() {
  unregisterHotkey();
  const accel = cfg.hotkey || DEFAULTS.hotkey;
  try {
    const ok = globalShortcut.register(accel, toggle);
    if (ok) { registeredHotkey = accel; log(`atalho registrado: ${accel}`); }
    else log(`falha ao registrar atalho: ${accel} (em uso?)`);
  } catch (e) {
    log("erro no globalShortcut:", e.message);
  }
}
function unregisterHotkey() {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch {}
    registeredHotkey = null;
  }
}

// ---------------------------------------------------------
// API pública
// ---------------------------------------------------------
export function initDictation({ serverUrl: srvUrl, configPath } = {}) {
  if (process.platform !== "linux") {
    log("ditado nativo só em Linux por enquanto (xdotool/X11) — pulando");
    return;
  }
  serverUrl = srvUrl;
  cfgPath = configPath || null;
  cfg = loadConfig(cfgPath);
  ipcMain.removeAllListeners("dict:event");
  ipcMain.on("dict:event", onWorkerEvent);
  if (!cfg.enabled) { log("desabilitado no config (dictation.enabled=false)"); return; }
  createWindows();
  registerHotkey();
}

export function getStatus() {
  return { enabled: !!cfg.enabled, hotkey: cfg.hotkey, model: cfg.model, state };
}

export function setEnabled(enabled) {
  cfg.enabled = !!enabled;
  persistEnabled(cfg.enabled);
  if (cfg.enabled) {
    createWindows();
    registerHotkey();
  } else {
    if (state === "recording") stop();
    unregisterHotkey();
    hideOverlay();
  }
  return getStatus();
}

export function disposeDictation() {
  unregisterHotkey();
  try { if (workerWin && !workerWin.isDestroyed()) workerWin.destroy(); } catch {}
  try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy(); } catch {}
  workerWin = overlayWin = null;
}
