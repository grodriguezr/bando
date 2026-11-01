import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { CodeGraph } from "@bando/core/types";

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let currentRoot: string | undefined;

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Bando",
    webPreferences: {
      preload: path.join(here, "../../preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(path.join(here, "../renderer/index.html"));

  // `electron . <dir>` opens that project straight away.
  const initial = projectFromArgv();
  if (initial) {
    window.webContents.once("did-finish-load", () => {
      currentRoot = initial;
      window?.webContents.send("project:loading");
      analyze(initial).then(
        (graph) => window?.webContents.send("project:loaded", graph),
        (error: Error) => window?.webContents.send("project:error", error.message),
      );
    });
  }
}

function projectFromArgv(): string | undefined {
  // argv is [electron, ".", ...args] when unpackaged and [app, ...args] when packaged.
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  const dir = args[0] && path.resolve(process.env.INIT_CWD ?? process.cwd(), args[0]);
  return dir && existsSync(dir) ? dir : undefined;
}

function analyze(root: string): Promise<CodeGraph> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(here, "analyze-worker.js"), { workerData: { root } });
    worker.on("message", (msg: { type: "progress"; message: string } | { type: "done"; graph: CodeGraph }) => {
      if (msg.type === "progress") window?.webContents.send("analyze:progress", msg.message);
      else resolve(msg.graph);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => code !== 0 && reject(new Error(`El análisis terminó con código ${code}`)));
  });
}

ipcMain.handle("project:open", async () => {
  const result = await dialog.showOpenDialog(window!, {
    title: "Abrir proyecto JavaScript/TypeScript",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  currentRoot = result.filePaths[0];
  return analyze(currentRoot);
});

ipcMain.handle("project:reanalyze", () => (currentRoot ? analyze(currentRoot) : undefined));

ipcMain.handle("file:read", async (_event, relativePath: string) => {
  if (!currentRoot) throw new Error("No hay proyecto abierto");
  const full = path.resolve(currentRoot, relativePath);
  // The renderer only gets to read files of the open project.
  if (path.relative(currentRoot, full).startsWith("..")) throw new Error("Ruta fuera del proyecto");
  return fs.readFile(full, "utf8");
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
