// Plain CommonJS: Electron's sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("bando", {
  openProject: () => ipcRenderer.invoke("project:open"),
  currentProject: () => ipcRenderer.invoke("project:current"),
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
  getAiSettings: () => ipcRenderer.invoke("settings:get"),
  setAiSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  cachedSummary: (target) => ipcRenderer.invoke("summary:cached", target),
  generateSummary: (target) => ipcRenderer.invoke("summary:generate", target),
  exportDocs: () => ipcRenderer.invoke("docs:export"),
  ask: (id, question) => ipcRenderer.invoke("ask:question", id, question),
  onAskDelta: (callback) => subscribe("ask:delta", callback),
  getJobStatus: () => ipcRenderer.invoke("job:status"),
  startJob: () => ipcRenderer.invoke("job:start"),
  stopJob: () => ipcRenderer.invoke("job:stop"),
  onJob: (callback) => subscribe("summary:job", callback),
  onSummaryUpdated: (callback) => subscribe("summary:updated", callback),
  onSummaryDelta: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on("summary:delta", listener);
    return () => ipcRenderer.removeListener("summary:delta", listener);
  },
  onProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("analyze:progress", listener);
    return () => ipcRenderer.removeListener("analyze:progress", listener);
  },
});
