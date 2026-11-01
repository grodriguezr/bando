// Starts the Vite dev server (hot reload for the UI) and launches Electron pointing at it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const server = await createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname });
await server.listen();
const url = server.resolvedUrls.local[0];

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
