// Builds the installable app (a .dmg on macOS) in release/. Run `npm run package` from packages/desktop,
// which builds everything first.
//
// The workspace's node_modules are hoisted and symlinked, so instead of packaging them the script stages
// a standalone app: the compiled main process and UI, plus a production install of @bando/core and its
// dependencies (the UI's libraries are already bundled by Vite).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "electron-builder";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = path.join(desktop, "..", "core");
const release = path.join(desktop, "release");
const stage = path.join(release, "app");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const electronVersion = createRequire(import.meta.url)("electron/package.json").version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of ["dist", "preload.cjs"]) {
  fs.cpSync(path.join(desktop, item), path.join(stage, item), { recursive: true });
}

const tarball = execFileSync(npm, ["pack", core, "--pack-destination", release], { encoding: "utf8" })
  .trim()
  .split("\n")
  .at(-1);
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "bando",
      productName: pkg.productName,
      version: pkg.version,
      description: "Entiende rápido un proyecto de código que no conoces",
      type: "module",
      main: pkg.main,
      dependencies: { "@bando/core": `file:../${tarball}` },
    },
    null,
    2,
  ),
);
execFileSync(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], {
  cwd: stage,
  stdio: "inherit",
});
prune(path.join(stage, "node_modules"));

await build({
  projectDir: stage,
  config: {
    appId: "io.github.grodriguezr.bando",
    productName: pkg.productName,
    electronVersion,
    directories: { output: path.join(release, "dist") },
    files: ["**/*"],
    // Bando's analysis runs in a worker thread that loads Tree-sitter grammars from disk.
    asar: false,
    // Bando loads the grammars as WebAssembly; their native builds are never used.
    npmRebuild: false,
    mac: {
      target: [{ target: "dmg", arch: [process.arch === "arm64" ? "arm64" : "x64"] }],
      icon: path.join(desktop, "build", "icon.png"),
      category: "public.app-category.developer-tools",
      // Without an Apple Developer ID the app is signed ad hoc: it runs, but macOS asks before the first launch.
      identity: "-",
      hardenedRuntime: false,
    },
    dmg: { title: "${productName} ${version}" },
    win: { target: "nsis", icon: path.join(desktop, "build", "icon.png") },
    linux: { target: "AppImage", category: "Development", icon: path.join(desktop, "build", "icon.png") },
    publish: null,
  },
});

// Only the installers are left in release/dist; the staged app would show up when analyzing this repository.
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(path.join(release, tarball), { force: true });

/** Drops what the app never loads: grammar sources and native builds (Bando uses the .wasm) and TypeScript's server. */
function prune(modules) {
  for (const grammar of ["tree-sitter-python", "tree-sitter-java"]) {
    const dir = path.join(modules, grammar);
    for (const entry of fs.readdirSync(dir)) {
      if (entry !== "package.json" && !entry.endsWith(".wasm") && !/^LICENSE/i.test(entry)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }
  const tsLib = path.join(modules, "typescript", "lib");
  for (const entry of fs.readdirSync(tsLib)) {
    const full = path.join(tsLib, entry);
    if (/^(tsserver|tsserverlibrary|typingsInstaller|_tsserver|_typingsInstaller|watchGuard)/.test(entry)) {
      fs.rmSync(full, { force: true });
    } else if (fs.statSync(full).isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true }); // translated compiler messages
    }
  }
}
