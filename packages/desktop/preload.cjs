// Plain CommonJS: Electron's sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bando", {
  openProject: () => ipcRenderer.invoke("project:open"),
  reanalyze: () => ipcRenderer.invoke("project:reanalyze"),
  readFile: (relativePath) => ipcRenderer.invoke("file:read", relativePath),
  onProjectEvent: (callback) => {
    const listeners = {
      "project:loading": () => callback({ type: "loading" }),
      "project:loaded": (_event, graph) => callback({ type: "loaded", graph }),
      "project:error": (_event, message) => callback({ type: "error", message }),
    };
    for (const [channel, listener] of Object.entries(listeners)) ipcRenderer.on(channel, listener);
    return () => {
      for (const [channel, listener] of Object.entries(listeners)) ipcRenderer.removeListener(channel, listener);
    };
  },
  onProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("analyze:progress", listener);
    return () => ipcRenderer.removeListener("analyze:progress", listener);
  },
});
