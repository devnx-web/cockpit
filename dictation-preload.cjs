// Preload das janelas de ditado (worker oculto + overlay).
// Expõe uma ponte IPC mínima — o renderer não toca ipcRenderer direto.
//
// Canais:
//   main → worker  : "dict:cmd"      ({ action: "start" | "stop" })
//   worker → main  : "dict:event"    ({ type, ... })
//   main → overlay : "dict:overlay"  ({ state, text, detail })
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictation", {
  // worker
  onCmd: (cb) => ipcRenderer.on("dict:cmd", (_e, data) => cb(data)),
  emit: (data) => ipcRenderer.send("dict:event", data),
  // overlay
  onOverlay: (cb) => ipcRenderer.on("dict:overlay", (_e, data) => cb(data)),
});
