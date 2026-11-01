import { useCallback, useEffect, useMemo, useState } from "react";
import type { LayoutOptions } from "cytoscape";
import { GraphIndex } from "@bando/core/query";
import { FolderTree } from "@bando/core/folder-tree";
import { folderOf, listFolders } from "@bando/core/targets";
import type { CodeGraph } from "@bando/core/types";
import { Details } from "./components/Details";
import { FolderDetails } from "./components/FolderDetails";
import { ProjectGuide } from "./components/ProjectGuide";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { callElements, dependencyElements, isSymbol } from "./elements";

type View = "deps" | "calls";

const DEPS_LAYOUT = {
  name: "fcose",
  animate: false,
  quality: "proof",
  nodeRepulsion: 20000,
  idealEdgeLength: 150,
  edgeElasticity: 0.2,
  nodeSeparation: 90,
  packComponents: true,
  nodeDimensionsIncludeLabels: true,
  tilingPaddingVertical: 40,
  tilingPaddingHorizontal: 40,
} as LayoutOptions;
const CALLS_LAYOUT: LayoutOptions = { name: "preset" };

export function App() {
  const [graph, setGraph] = useState<CodeGraph>();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("deps");
  const [history, setHistory] = useState<string[]>([]);
  const [showPackages, setShowPackages] = useState(false);
  const [depth, setDepth] = useState(1);

  useEffect(() => window.bando.onProgress(setProgress), []);
  useEffect(() => {
    void window.bando.currentProject().then((current) => current && setGraph((g) => g ?? current));
  }, []);
  useEffect(
    () =>
      window.bando.onProjectEvent((event) => {
        setLoading(event.type === "loading");
        if (event.type === "loaded") setGraph(event.graph);
        if (event.type === "error") setError(event.message);
        if (event.type !== "loading") setProgress("");
      }),
    [],
  );

  const index = useMemo(() => (graph ? new GraphIndex(graph) : undefined), [graph]);
  const selectedId = history.at(-1);
  const selected = selectedId ? index?.node(selectedId) : undefined;

  const tree = useMemo(
    () => new FolderTree(graph?.nodes.filter((n) => n.kind === "file").map((n) => n.id) ?? []),
    [graph],
  );
  // Folders open in the dependency view; a new project starts at a readable level of detail.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setExpanded(tree.defaultExpanded()), [tree]);

  /** Opens the folders needed to see `path` (and `path` itself), keeping the same Set if nothing changes. */
  const reveal = (path: string, includeSelf: boolean) => {
    const needed = [...tree.ancestors(path), ...(includeSelf ? [path] : [])];
    setExpanded((prev) => (needed.every((p) => prev.has(p)) ? prev : new Set([...prev, ...needed])));
  };
  const collapse = (path: string) =>
    setExpanded((prev) => new Set([...prev].filter((p) => p !== path && !p.startsWith(`${path}/`))));

  const select = (id: string) => {
    const node = index?.node(id);
    if (id.startsWith("dir:")) reveal(id.slice(4), true);
    else if (node?.file) reveal(folderOf(node.file), true);
    if (id === selectedId) return;
    setHistory((h) => [...h, id]);
    if (node && isSymbol(node)) setView("calls");
    // Folders and the guide only exist in the dependency view.
    else if (!node) setView("deps");
  };

  const folders = useMemo(() => new Set(graph ? listFolders(graph) : []), [graph]);
  /** File basenames ("main.ts") and symbol names ("GraphIndex.search") that identify exactly one node. */
  const uniqueNames = useMemo(() => {
    const byName = new Map<string, string[]>();
    for (const node of graph?.nodes ?? []) {
      if (node.kind === "package") continue;
      const name = node.kind === "file" ? node.name : node.id.slice(node.id.indexOf("#") + 1);
      byName.set(name, [...(byName.get(name) ?? []), node.id]);
    }
    return new Map([...byName].filter(([, ids]) => ids.length === 1).map(([name, [id]]) => [name, id!]));
  }, [graph]);

  /** Makes paths, file names and symbols mentioned in AI summaries clickable. */
  const resolveLink = useCallback(
    (code: string) => {
      const text = code.trim().replace(/\(\)$/, "");
      const id = text.replace(/^\.\//, "").replace(/\/$/, "") || ".";
      const target = index?.node(id) ? id : folders.has(id) ? `dir:${id}` : uniqueNames.get(text);
      return target ? () => select(target) : undefined;
    },
    // The returned handlers call `select`, which reads `index` and `selectedId`.
    [index, folders, uniqueNames, selectedId],
  );

  const load = async (action: () => Promise<CodeGraph | undefined>, keepSelection: boolean) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await action();
      if (!result) return;
      setGraph(result);
      if (!keepSelection) {
        setHistory([]);
        setView("deps");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  const callFocus = selected && selected.kind !== "package" ? selected.id : undefined;
  // Kept separate so selecting a file in the dependency view doesn't rebuild (and re-layout) the graph.
  const depsData = useMemo(
    () =>
      index && {
        elements: dependencyElements(index, tree, expanded, showPackages),
        truncated: false,
        layout: DEPS_LAYOUT,
      },
    [index, tree, expanded, showPackages],
  );
  const callsData = useMemo(
    () => (index && callFocus ? { ...callElements(index, callFocus, depth), layout: CALLS_LAYOUT } : undefined),
    [index, callFocus, depth],
  );
  const graphData = view === "calls" && callsData ? callsData : depsData;

  if (!graph || !index || !graphData) {
    return (
      <div className="welcome">
        <h1>Bando</h1>
        <p className="muted">
          Explora la estructura de un proyecto JavaScript/TypeScript: archivos, dependencias y llamadas.
        </p>
        <button className="primary" disabled={loading} onClick={() => load(window.bando.openProject, false)}>
          {loading ? "Analizando…" : "Abrir proyecto"}
        </button>
        {progress && <p className="muted small">{progress}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className={`app ${selectedId === "project" ? "wide-details" : ""}`}>
      <header className="toolbar">
        <strong className="project" title={graph.root}>
          {graph.root.split(/[\\/]/).pop()}
        </strong>
        <button disabled={loading} onClick={() => load(window.bando.openProject, false)}>
          Abrir…
        </button>
        <button disabled={loading} onClick={() => load(window.bando.reanalyze, true)}>
          Reanalizar
        </button>
        <span className="sep" />
        <button disabled={history.length < 2} onClick={() => setHistory((h) => h.slice(0, -1))} title="Atrás">
          ←
        </button>
        <div className="segmented">
          <button className={view === "deps" ? "active" : ""} onClick={() => setView("deps")}>
            Dependencias
          </button>
          <button
            className={view === "calls" ? "active" : ""}
            disabled={!callFocus}
            title={callFocus ? undefined : "Selecciona un archivo o símbolo"}
            onClick={() => setView("calls")}
          >
            Llamadas
          </button>
        </div>
        {view === "deps" ? (
          <>
            <label>
              <input type="checkbox" checked={showPackages} onChange={(e) => setShowPackages(e.target.checked)} />
              Paquetes externos
            </label>
            <button onClick={() => setExpanded(tree.defaultExpanded())} title="Volver al nivel de detalle inicial">
              Contraer carpetas
            </button>
          </>
        ) : (
          <label>
            Profundidad
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        )}
        <span className="spacer" />
        {loading && <span className="muted small">{progress || "Analizando…"}</span>}
        {error && <span className="error small">{error}</span>}
      </header>

      <Sidebar index={index} selectedId={selectedId} onSelect={select} />

      <main className="canvas">
        <GraphView
          elements={graphData.elements}
          layout={graphData.layout}
          selectedId={selectedId}
          onSelect={select}
          onCollapse={(id) => collapse(id.slice(4))}
        />
        {view === "calls" ? (
          <div className="legend">← lo llaman · llama a →</div>
        ) : (
          tree.folders.size > 2 && (
            <div className="legend">Clic en una carpeta para abrirla · doble clic en un recuadro para cerrarlo</div>
          )
        )}
        {graphData.truncated && (
          <div className="legend warn">Hay demasiadas llamadas: se muestran las primeras 40 por nivel</div>
        )}
      </main>

      {selectedId === "project" ? (
        <ProjectGuide index={index} resolveLink={resolveLink} />
      ) : selectedId?.startsWith("dir:") ? (
        <FolderDetails
          key={selectedId}
          index={index}
          tree={tree}
          dir={selectedId.slice(4)}
          onSelect={select}
          resolveLink={resolveLink}
        />
      ) : selected ? (
        <Details key={selected.id} index={index} node={selected} onSelect={select} resolveLink={resolveLink} />
      ) : (
        <aside className="details muted pad">
          Selecciona un archivo, carpeta o símbolo para ver sus detalles, o abre la{" "}
          <button className="link" onClick={() => select("project")}>
            guía del proyecto
          </button>
          .
        </aside>
      )}
    </div>
  );
}
