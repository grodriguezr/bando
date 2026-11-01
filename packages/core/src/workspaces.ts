import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: PackageManifest;
}

interface PackageManifest {
  name?: string;
  main?: string;
  types?: string;
  typings?: string;
  source?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
}

const BUILD_DIRS = ["dist", "build", "lib", "out"];

/**
 * `paths` mappings that make imports between packages of a monorepo resolve to their source
 * (`@scope/pkg` → packages/pkg/src/index.ts) instead of to the built output in node_modules,
 * so they become internal dependencies and calls across packages can be resolved.
 */
export function workspacePaths(root: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of findWorkspacePackages(root)) {
    const { sourceDir, outDir } = sourceLayout(pkg.dir);
    const entry = entryPoint(pkg.manifest);
    const entrySource = entry && toSource(path.resolve(pkg.dir, entry), sourceDir, outDir);
    paths[pkg.name] = [entrySource ?? path.join(sourceDir, "index")];
    // Subpaths ("@scope/pkg/query") usually mirror file names under the source dir.
    paths[`${pkg.name}/*`] = [path.join(sourceDir, "*")];
  }
  return paths;
}

/** Packages declared by npm/yarn `workspaces` or by pnpm-workspace.yaml. */
export function findWorkspacePackages(root: string): WorkspacePackage[] {
  const manifest = readManifest(root);
  const declared = Array.isArray(manifest?.workspaces) ? manifest.workspaces : (manifest?.workspaces?.packages ?? []);
  const patterns = [...declared, ...pnpmPatterns(root)].filter((p) => !p.startsWith("!"));

  const packages: WorkspacePackage[] = [];
  for (const dir of new Set(patterns.flatMap((p) => expand(root, p)))) {
    const pkg = readManifest(dir);
    if (pkg?.name) packages.push({ name: pkg.name, dir, manifest: pkg });
  }
  return packages;
}

/** Where the package keeps its source and its build output, from its tsconfig or by convention. */
function sourceLayout(dir: string): { sourceDir: string; outDir?: string } {
  const configPath = path.join(dir, "tsconfig.json");
  if (fs.existsSync(configPath)) {
    const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const options = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)?.options;
    if (options?.rootDir) return { sourceDir: options.rootDir, outDir: options.outDir };
  }
  const src = path.join(dir, "src");
  return fs.existsSync(src) ? { sourceDir: src } : { sourceDir: dir };
}

/** The file the package's main entry points to, as written in package.json. */
function entryPoint(manifest: PackageManifest): string | undefined {
  if (manifest.source) return manifest.source;
  const dot = exportsEntry(manifest.exports);
  return dot ?? manifest.types ?? manifest.typings ?? manifest.main;
}

function exportsEntry(exports: unknown): string | undefined {
  if (typeof exports === "string") return exports;
  if (!exports || typeof exports !== "object") return undefined;
  const record = exports as Record<string, unknown>;
  // Either a conditions object ({ types, import, default }) or a subpath map ({ ".": … }).
  const target = "." in record ? record["."] : record;
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const conditions = target as Record<string, unknown>;
  for (const key of ["source", "types", "import", "default", "require"]) {
    const value = conditions[key];
    if (typeof value === "string") return value;
    const nested = exportsEntry(value);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Maps a built file to the source it came from: dist/index.d.ts → src/index.
 * Returns undefined when the entry already is source (or can't be mapped), leaving it to TypeScript.
 */
function toSource(file: string, sourceDir: string, outDir: string | undefined): string | undefined {
  const withoutExt = file.replace(/(\.d)?\.[mc]?[jt]sx?$/, "");
  if (outDir && !path.relative(outDir, file).startsWith("..")) {
    return path.join(sourceDir, path.relative(outDir, withoutExt));
  }
  const parts = path.relative(path.dirname(sourceDir), withoutExt).split(path.sep);
  if (BUILD_DIRS.includes(parts[0]!)) return path.join(sourceDir, ...parts.slice(1));
  // The entry is not in a build dir: it is already source.
  return fs.existsSync(file) && !file.endsWith(".d.ts") ? withoutExt : undefined;
}

/** Supports the common workspace globs: "packages/*", "apps/**" (one level) and exact paths. */
function expand(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  const wildcard = clean.search(/\*/);
  if (wildcard === -1) return [path.join(root, clean)];
  const base = path.join(root, clean.slice(0, wildcard).replace(/\/$/, ""));
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
    .map((entry) => path.join(base, entry.name));
}

/** Reads the `packages:` list of pnpm-workspace.yaml without a YAML dependency. */
function pnpmPatterns(root: string): string[] {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return [];
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
      if (item) patterns.push(item[1]!);
    }
  }
  return patterns;
}

function readManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}
