import { useEffect, useMemo, useState } from "react";
import type { LayoutOptions } from "cytoscape";
import { GraphIndex } from "@bando/core/query";
import type { CodeGraph } from "@bando/core/types";
import { Details } from "./components/Details";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { callElements, dependencyElements, isSymbol } from "./elements";

type View = "deps" | "calls";

const DEPS_LAYOUT = {
  name: "fcose",
  animate: false,
  quality: "proof",
  nodeRepulsion: 6000,
  idealEdgeLength: 90,
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

  const select = (id: string) => {
    if (id === selectedId) return;
    setHistory((h) => [...h, id]);
    const node = index?.node(id);
    if (node && isSymbol(node)) setView("calls");
  };

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
    () => index && { elements: dependencyElements(index, showPackages), truncated: false, layout: DEPS_LAYOUT },
    [index, showPackages],
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
        <p className="muted">Explora la estructura de un proyecto JavaScript/TypeScript: archivos, dependencias y llamadas.</p>
        <button className="primary" disabled={loading} onClick={() => load(window.bando.openProject, false)}>
          {loading ? "Analizando…" : "Abrir proyecto"}
        </button>
        {progress && <p className="muted small">{progress}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app">
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
          <label>
            <input type="checkbox" checked={showPackages} onChange={(e) => setShowPackages(e.target.checked)} />
            Paquetes externos
          </label>
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
        <GraphView elements={graphData.elements} layout={graphData.layout} selectedId={selectedId} onSelect={select} />
        {view === "calls" && <div className="legend">← lo llaman · llama a →</div>}
        {graphData.truncated && <div className="legend warn">Hay demasiadas llamadas: se muestran las primeras 40 por nivel</div>}
      </main>

      {selected ? (
        <Details key={selected.id} index={index} node={selected} onSelect={select} />
      ) : (
        <aside className="details muted pad">Selecciona un archivo o símbolo para ver sus detalles.</aside>
      )}
    </div>
  );
}
