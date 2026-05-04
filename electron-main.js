// Cockpit — Electron main process
// Sobe o server.js in-process e abre uma janela frameless apontando pra ele.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import fs from "fs";
import url from "url";
import { startServer } from "./server.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

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
    const seed = path.join(__dirname, "modules", "voice", "config.json");
    try {
      if (fs.existsSync(seed)) fs.copyFileSync(seed, target);
    } catch (e) {
      console.warn("voice config seed falhou:", e.message);
    }
  }
  return target;
}

let mainWindow = null;
let serverInstance = null;

async function bootServer() {
  const projectsPath = ensureProjectsFile();
  const voiceConfigPath = ensureVoiceConfigFile();
  serverInstance = await startServer({
    port: 0, // OS escolhe
    rootDir: __dirname,
    publicDir: path.join(__dirname, "public"),
    projectsPath,
    voiceConfigPath,
    voiceEnabled: process.platform === "linux",
    dictationEnabled: process.platform === "linux",
  });
  return serverInstance;
}

function createWindow(serverUrl) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 600,
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

  mainWindow.loadURL(serverUrl);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // links externos abrem no browser do sistema
    if (/^https?:\/\//.test(url) && !url.startsWith(serverUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("maximize", () => {
    mainWindow.webContents.send("window:state", { maximized: true });
  });
  mainWindow.on("unmaximize", () => {
    mainWindow.webContents.send("window:state", { maximized: false });
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// IPC: controles da janela (renderer chama via window.cockpitDesktop)
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:is-maximized", () => !!mainWindow?.isMaximized());
ipcMain.handle("app:platform", () => process.platform);

app.whenReady().then(async () => {
  try {
    const inst = await bootServer();
    createWindow(inst.url);
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
    try { await serverInstance.shutdown({ exit: false }); } catch {}
    serverInstance = null;
    app.exit(0);
  }
});
