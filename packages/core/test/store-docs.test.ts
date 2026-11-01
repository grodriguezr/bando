import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { analyzeProject } from "../dist/index.js";
import { exportDocs } from "../dist/docs.js";
import { SummaryStore, type SummarizeAllEvent } from "../dist/summary-store.js";
import { findUnknownReferences, type SummaryTarget } from "../dist/targets.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bando-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const local = { kind: "local" as const };
const label = (t: SummaryTarget) => (t.kind === "project" ? "project" : `${t.kind}:${t.id}`);

/** A fake model: records what it was asked and answers with a predictable summary. */
function fakeGenerator(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const generate = async (_graph: unknown, target: SummaryTarget, opts: { onText?: (t: string) => void }) => {
    calls.push(label(target));
    if (options.failOn === label(target)) throw new Error("servidor caído");
    const text = `## Propósito\nResumen de ${label(target)}.`;
    opts.onText?.(text);
    return { text, model: "local:fake" };
  };
  return { calls, generate: generate as never };
}

describe("SummaryStore", () => {
  test("guarda, recupera y detecta resúmenes desactualizados", async () => {
    const root = path.join(tmp, "stale");
    fs.cpSync(fixture("basic"), root, { recursive: true });
    const graph = analyzeProject(root);
    const fake = fakeGenerator();
    const store = new SummaryStore(path.join(tmp, "stale.json"), fake.generate);
    const file: SummaryTarget = { kind: "file", id: "src/util.js" };

    assert.equal(store.cached(graph, file, "local"), undefined);
    await store.generate(graph, file, { provider: local });
    assert.deepEqual(store.cached(graph, file, "local"), { text: "## Propósito\nResumen de file:src/util.js.", model: "local:fake", stale: false });
    assert.equal(store.cached(graph, file, "anthropic"), undefined, "cada proveedor tiene su caché");

    fs.appendFileSync(path.join(root, "src/util.js"), "\n// cambio\n");
    assert.equal(store.cached(graph, file, "local")?.stale, true, "cambiar el código lo desactualiza");
  });

  test("otro proceso ve lo que se guardó (caché compartida en disco)", async () => {
    const graph = analyzeProject(fixture("basic"));
    const cacheFile = path.join(tmp, "shared.json");
    await new SummaryStore(cacheFile, fakeGenerator().generate).generate(graph, { kind: "project" }, { provider: local });
    const other = new SummaryStore(cacheFile);
    assert.equal(other.known(graph.root, "local").get("project"), "## Propósito\nResumen de project.");
  });

  test("resume todo de abajo hacia arriba y retoma sin repetir", async () => {
    const graph = analyzeProject(fixture("monorepo"));
    const fake = fakeGenerator();
    const store = new SummaryStore(path.join(tmp, "all.json"), fake.generate);
    const events: SummarizeAllEvent[] = [];

    await store.summarizeAll(graph, { provider: local, onEvent: (e) => events.push(e) });
    assert.deepEqual(fake.calls, [
      "file:packages/app/src/main.ts",
      "file:packages/lib/src/index.ts",
      "file:packages/lib/src/math.ts",
      "folder:packages/app/src",
      "folder:packages/lib/src",
      "project",
    ]);
    assert.deepEqual(events.at(-1), { type: "finished", done: 6, total: 6, failed: 0, stopped: false });

    fake.calls.length = 0;
    await store.summarizeAll(graph, { provider: local });
    assert.deepEqual(fake.calls, [], "todo estaba al día");
  });

  test("se detiene cuando se le pide y continúa después", async () => {
    const graph = analyzeProject(fixture("monorepo"));
    const fake = fakeGenerator();
    const store = new SummaryStore(path.join(tmp, "stop.json"), fake.generate);
    await store.summarizeAll(graph, { provider: local, shouldStop: () => fake.calls.length >= 2 });
    assert.equal(fake.calls.length, 2);

    fake.calls.length = 0;
    await store.summarizeAll(graph, { provider: local });
    assert.equal(fake.calls[0], "file:packages/lib/src/math.ts", "retoma por el siguiente pendiente");
    assert.equal(fake.calls.length, 4);
  });

  test("registra errores y abandona tras varios seguidos", async () => {
    const graph = analyzeProject(fixture("monorepo"));
    const failing = fakeGenerator({ failOn: "file:packages/lib/src/index.ts" });
    const events: SummarizeAllEvent[] = [];
    await new SummaryStore(path.join(tmp, "fail.json"), failing.generate).summarizeAll(graph, {
      provider: local,
      onEvent: (e) => events.push(e),
    });
    const errors = events.filter((e) => e.type === "summarized" && e.error);
    assert.equal(errors.length, 1);
    assert.match((errors[0] as { error: string }).error, /servidor caído/);
    assert.deepEqual(events.at(-1), { type: "finished", done: 6, total: 6, failed: 1, stopped: false });

    const broken = { calls: [] as string[], generate: (async () => Promise.reject(new Error("sin conexión"))) as never };
    const events2: SummarizeAllEvent[] = [];
    await new SummaryStore(path.join(tmp, "broken.json"), broken.generate).summarizeAll(graph, {
      provider: local,
      onEvent: (e) => events2.push(e),
    });
    assert.deepEqual(events2.at(-1), { type: "finished", done: 3, total: 6, failed: 3, stopped: true });
  });
});

describe("referencias inventadas", () => {
  test("detecta archivos mencionados que no existen", () => {
    const graph = analyzeProject(fixture("basic"));
    const text = "Lee `src/main.ts`, `shapes.ts`, `src/index.ts` y `app/server.js`; usa `npm test` y `package.json`.";
    assert.deepEqual(findUnknownReferences(graph, text), ["src/index.ts", "app/server.js"]);
  });
});

describe("exportDocs", () => {
  const graph = analyzeProject(fixture("monorepo"));
  const out = path.join(tmp, "docs");
  const summaries = new Map([
    ["project", "# Guía de demo\n\n## De qué se trata\nUna app que suma. Empieza por `packages/app/src/main.ts` y `math.ts`; ignora `src/fake.ts`."],
    ["folder:packages/lib/src", "## Propósito\nBiblioteca de matemáticas. Más detalle aquí."],
    ["file:packages/lib/src/math.ts", "## Propósito\nSuma números."],
  ]);
  const result = exportDocs(graph, { outDir: out, summaries });
  const read = (page: string) => fs.readFileSync(path.join(out, page), "utf8");

  test("escribe índice, una página por carpeta y otra por archivo", () => {
    assert.equal(result.pages, 1 + 2 + 3);
    assert.deepEqual(result.summarized, { files: 1, totalFiles: 3, folders: 1, totalFolders: 2, guide: true });
    for (const page of ["README.md", "code/packages/lib/src/README.md", "code/packages/lib/src/math.ts.md"]) {
      assert.ok(fs.existsSync(path.join(out, page)), page);
    }
  });

  test("el índice incluye la guía con enlaces, el diagrama y la tabla de carpetas", () => {
    const index = read("README.md");
    assert.match(index, /### De qué se trata/, "los títulos de la guía bajan un nivel");
    assert.doesNotMatch(index, /Guía de demo/, "se descarta el título propio del modelo");
    assert.match(index, /\[`packages\/app\/src\/main\.ts`\]\(code\/packages\/app\/src\/main\.ts\.md\)/);
    assert.match(index, /\[`math\.ts`\]\(code\/packages\/lib\/src\/math\.ts\.md\)/, "nombres únicos también enlazan");
    assert.match(index, /⚠️ .*`src\/fake\.ts`/, "advierte de archivos inventados");
    assert.match(index, /```mermaid\nflowchart LR[\s\S]*-->\|2\|/);
    assert.match(index, /\| \[`packages\/lib\/src\/`\]\(code\/packages\/lib\/src\/README\.md\) \| 2 \| Biblioteca de matemáticas\. \|/);
  });

  test("la página de archivo enlaza al código, a los llamadores y a su carpeta", () => {
    const page = read("code/packages/lib/src/math.ts.md");
    assert.match(page, /\[Ver código\]\([^)]*packages\/lib\/src\/math\.ts\)/);
    assert.match(page, /<a id="sym-add"><\/a>\n\n### `add`/);
    assert.match(page, /```ts\nadd\(a: number, b: number\): number\n```/);
    assert.match(page, /\*\*Lo llaman:\*\* \[`run`\]\(\.\.\/\.\.\/app\/src\/main\.ts\.md#sym-run\)/);
    assert.match(page, /\[`packages\/lib\/src\/`\]\(README\.md\)/);
  });

  test("los enlaces al código son correctos desde la carpeta de salida", () => {
    const page = read("code/packages/lib/src/math.ts.md");
    const link = /\[Ver código\]\(([^)]+)\)/.exec(page)![1]!;
    const target = path.resolve(path.join(out, "code/packages/lib/src"), decodeURI(link));
    assert.equal(target, path.join(graph.root, "packages/lib/src/math.ts"));
  });
});
