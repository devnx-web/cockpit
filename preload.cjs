// Bridge entre renderer e main — expõe controles da janela e info do SO
// via contextBridge (não dá acesso direto ao node/ipcRenderer pro renderer).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("cockpitDesktop", {
  isElectron: true,
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  platform: () => ipcRenderer.invoke("app:platform"),
  onWindowState: (cb) => {
    ipcRenderer.on("window:state", (_e, state) => cb(state));
  },
  // Revela um arquivo/pasta no gerenciador de arquivos do SO.
  showItemInFolder: (fullPath) => ipcRenderer.invoke("shell:show-item-in-folder", fullPath),
  // Inicia um drag nativo do SO para arrastar o arquivo pra fora da janela.
  // Deve ser chamado dentro do handler dragstart.
  startDrag: (fullPath) => ipcRenderer.send("shell:start-drag", fullPath),
  // Resolve o caminho absoluto de um File arrastado pra dentro da janela.
  // A partir do Electron 32 o antigo File.path foi removido — webUtils.getPathForFile
  // é a forma suportada de obter o caminho completo (não só o nome).
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ""; }
  },
});
