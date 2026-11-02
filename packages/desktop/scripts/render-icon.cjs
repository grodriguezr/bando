// Renders build/icon.svg to build/icon.png (1024×1024), the source electron-builder turns into the app icon.
// Run with: npx electron scripts/render-icon.cjs
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.dock?.hide();
app.whenReady().then(async () => {
  const dir = path.join(__dirname, "..", "build");
  const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(dir, "icon.png"), image.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
