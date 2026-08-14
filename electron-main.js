// Cockpit — Electron main process
// Sobe o server.js in-process e abre uma janela frameless apontando pra ele.

import { app, BrowserWindow, ipcMain, shell, nativeImage, session } from "electron";
import path from "path";
import fs from "fs";
import url from "url";
import { startServer } from "./server.js";
import { initDictation, disposeDictation, getStatus as dictationStatus, setEnabled as dictationSetEnabled } from "./lib/dictation-native.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Porta de loopback fixa (origem estável pro worker de ditado). Cai pra
// aleatória se estiver ocupada.
const FIXED_PORT = 47817;

// Instância única — evita dois Cockpits disputando o atalho global Ctrl+Espaço.
// Sai na hora: app.quit() só agenda o encerramento, então o módulo seguiria
// carregando, subiria um segundo servidor e sobrescreveria o control.json da
// instância que já está rodando — deixando-a viva porém inalcançável pela
// Control API (e portanto pelo MCP).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// projects.json fica em userData (gravável em produção, fora do asar)
function ensureProjectsFile() {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "projects.json");
  if (!fs.existsSync(target)) {
    const seedCandidates = [
      isDev ? path.join(__dirname, "projects.json") : null,
      isDev ? path.join(__dirname, "projects.example.json") : null,
      !isDev ? path.join(process.resourcesPath, "projects.example.json") : null,
    ].filter(Boolean);
    let seeded = false;
    for (const c of seedCandidates) {
      if (fs.existsSync(c)) {
        fs.copyFileSync(c, target);
        seeded = true;
        break;
      }
    }
    if (!seeded) {
      fs.writeFileSync(target, "[]\n", "utf8");
    }
  }
  return target;
}

// voice-config.json fica em userData. Em produção o config dentro do asar é
// read-only — sem este seed, o switch "ativar Járvis" no popover falhava
// silenciosamente e o daemon nunca subia. No dev, fica ao lado de modules/voice/
// como antes pra facilitar edição manual.
function ensureVoiceConfigFile() {
  if (isDev) {
    return path.join(__dirname, "modules", "voice", "config.json");
  }
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "voice-config.json");
  if (!fs.existsSync(target)) {
    // o asar é read-only, mas readable — copiamos o seed embutido
    const seed = path.join(__dirname, "modules", "voice", "config.example.json");
    try {
      if (fs.existsSync(seed)) fs.copyFileSync(seed, target);
    } catch (e) {
      console.warn("voice config seed falhou:", e.message);
    }
  }
  return target;
}

// Logs do daemon Python — em produção o asar.unpacked também não é gravável
// (instalado como root pelo .deb), então jogamos em userData/voice-logs/.
// Em dev fica ao lado do módulo, facilita inspeção.
function ensureVoiceLogsDir() {
  if (isDev) {
    return path.join(__dirname, "modules", "voice", "logs");
  }
  const dir = path.join(app.getPath("userData"), "voice-logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

let mainWindow = null;
let serverInstance = null;
let voiceConfigPathRef = null;

async function bootServer() {
  const projectsPath = ensureProjectsFile();
  const voiceConfigPath = ensureVoiceConfigFile();
  voiceConfigPathRef = voiceConfigPath;
  const voiceLogsDir = ensureVoiceLogsDir();
  const common = {
    rootDir: __dirname,
    publicDir: path.join(__dirname, "public"),
    projectsPath,
    voiceConfigPath,
    voiceLogsDir,
    voiceEnabled: process.platform === "linux",
    dictationEnabled: process.platform === "linux",
  };
  // Tenta a porta fixa (origem estável p/ cache do modelo); cai pra aleatória.
  try {
    serverInstance = await startServer({ port: FIXED_PORT, ...common });
  } catch (e) {
    console.warn(`porta ${FIXED_PORT} indisponível (${e?.code || e?.message}); usando aleatória`);
    serverInstance = await startServer({ port: 0, ...common });
  }
  return serverInstance;
}

// URL do servidor local, guardada pra abrir janelas desacopladas depois do boot.
let serverUrlRef = null;
// Janelas desacopladas vivas: projId -> BrowserWindow (uma por projeto).
const detachedWindows = new Map();

function makeWindow(serverUrl, { width, height, minWidth, minHeight, query = "" } = {}) {
  const win = new BrowserWindow({
    width: width || 1500,
    height: height || 950,
    minWidth: minWidth || 700,
    minHeight: minHeight || 480,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0a0b0d",
    icon: path.join(__dirname, "public", "icon.svg"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadURL(serverUrl + query);
  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    // links externos abrem no browser do sistema
    if (/^https?:\/\//.test(url) && !url.startsWith(serverUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.on("maximize", () => win.webContents.send("window:state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("window:state", { maximized: false }));
  return win;
}

function createWindow(serverUrl) {
  serverUrlRef = serverUrl;
  mainWindow = makeWindow(serverUrl, { minWidth: 980, minHeight: 600 });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// IPC: controles da janela (renderer chama via window.cockpitDesktop).
// Resolvem a janela pelo sender — com janela desacoplada aberta, mirar em
// mainWindow faria o "fechar" da desacoplada derrubar a janela principal.
const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle("window:minimize", (e) => senderWindow(e)?.minimize());
ipcMain.handle("window:toggle-maximize", (e) => {
  const win = senderWindow(e);
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
});
ipcMain.handle("window:close", (e) => senderWindow(e)?.close());
ipcMain.handle("window:is-maximized", (e) => !!senderWindow(e)?.isMaximized());
ipcMain.handle("app:platform", () => process.platform);

// Desacoplar: abre o projeto numa janela própria (?detach=<projId>). Os PTYs
// vivem no servidor e o buffer volta no hello, então a janela nova reconstrói
// o terminal sozinha — nada é movido nem reiniciado. Desacoplar é só de ida: a
// janela vive até ser fechada, e fechar encerra o projeto (veja abaixo).
ipcMain.handle("window:detach", (e, projId) => {
  if (!serverUrlRef || !projId) return false;
  const existing = detachedWindows.get(projId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }
  const win = makeWindow(serverUrlRef, {
    width: 1000,
    height: 700,
    query: `?detach=${encodeURIComponent(projId)}`,
  });
  detachedWindows.set(projId, win);

  // Fechar a janela encerra os terminais do projeto. Quem confirma e mata é o
  // renderer (é lá que estão o status dos terminais e o WebSocket), então a
  // primeira passada é barrada e devolvida pra ele; o segundo close() já vem
  // com o flag e passa direto.
  //
  // O gancho é o "close" da janela, não o pagehide do renderer: pagehide também
  // dispara em reload, e um F5 mataria os terminais sem ninguém pedir.
  win.on("close", (ev) => {
    if (win.__cockpitClosing) return;
    ev.preventDefault();
    win.webContents.send("window:confirm-close");
  });
  win.on("closed", () => {
    if (detachedWindows.get(projId) === win) detachedWindows.delete(projId);
  });
  return true;
});

// O renderer terminou de encerrar o projeto (ou o usuário confirmou): agora o
// close passa. Se ele cancelar, simplesmente não chama isto e a janela fica.
ipcMain.handle("window:close-confirmed", (e) => {
  const win = senderWindow(e);
  if (!win || win.isDestroyed()) return false;
  win.__cockpitClosing = true;
  win.close();
  return true;
});

// Ditado por voz nativo — status e liga/desliga (painel de voz)
ipcMain.handle("dictation:get-status", () => dictationStatus());
ipcMain.handle("dictation:set-enabled", (_e, enabled) => dictationSetEnabled(enabled));

// shell.showItemInFolder revela o arquivo no gerenciador de arquivos do SO
// (Nautilus/Files no Linux, Finder no macOS, Explorer no Windows). Se for
// pasta, abre a pasta-pai com a pasta destacada.
ipcMain.handle("shell:show-item-in-folder", (_e, fullPath) => {
  if (typeof fullPath !== "string" || !fullPath) return false;
  try {
    shell.showItemInFolder(fullPath);
    return true;
  } catch (err) {
    console.warn("showItemInFolder falhou:", err.message);
    return false;
  }
});

// Drag nativo de arquivo pra fora da janela (pra Files/Nautilus, anexar em
// e-mail, etc). Sem isto, o dragstart do navegador só carrega texto/uri-list,
// que outros apps não reconhecem como arquivo. webContents.startDrag faz o
// SO tratar como um drag de arquivo de verdade.
const DRAG_ICON_CACHE = new Map();
function getDragIcon() {
  if (DRAG_ICON_CACHE.has("default")) return DRAG_ICON_CACHE.get("default");
  // Tenta usar o ícone do app; cai pra empty se não existir.
  const candidates = [
    path.join(__dirname, "public", "icon.svg"),
  ];
  for (const c of candidates) {
    try {
      const img = nativeImage.createFromPath(c);
      if (!img.isEmpty()) {
        const sized = img.resize({ width: 32, height: 32 });
        DRAG_ICON_CACHE.set("default", sized);
        return sized;
      }
    } catch {}
  }
  // nativeImage.createEmpty() não funciona como ícone em startDrag — gera erro.
  // Criamos 1x1 PNG transparente como mínimo.
  const onePx = nativeImage.createFromBuffer(Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
    "hex"
  ));
  DRAG_ICON_CACHE.set("default", onePx);
  return onePx;
}
ipcMain.on("shell:start-drag", (event, filePath) => {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    event.sender.startDrag({ file: filePath, icon: getDragIcon() });
  } catch (err) {
    console.warn("startDrag falhou:", err.message);
  }
});

app.whenReady().then(async () => {
  // Libera permissão de mic/áudio sem prompt — o cockpit é local e o usuário
  // explicitamente clicou no botão 🎙 / Ctrl+Espaço. Sem isso, alguns builds
  // do Chromium negam getUserMedia silenciosamente.
  try {
    const ALLOWED_PERMS = new Set([
      "media", "microphone", "audioCapture",
      // colar/copiar no terminal usa navigator.clipboard.read/readText/writeText,
      // que exigem estas permissões. Sem elas o paste falha silenciosamente.
      "clipboard-read", "clipboard-sanitized-write",
    ]);
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(ALLOWED_PERMS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return ALLOWED_PERMS.has(permission);
    });
  } catch (e) {
    console.warn("setPermissionHandler falhou:", e?.message);
  }

  try {
    const inst = await bootServer();
    createWindow(inst.url);
    // Ditado nativo (Ctrl+Espaço global). Opt-in por config; só Linux/X11.
    initDictation({ serverUrl: inst.url, configPath: voiceConfigPathRef });
  } catch (e) {
    console.error("falha ao subir servidor:", e);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverInstance) {
      createWindow(serverInstance.url);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shuttingDown = false;
app.on("before-quit", async (e) => {
  if (shuttingDown) return;
  if (serverInstance) {
    e.preventDefault();
    shuttingDown = true;
    try { disposeDictation(); } catch {}
    try { await serverInstance.shutdown({ exit: false }); } catch {}
    serverInstance = null;
    app.exit(0);
  }
});
