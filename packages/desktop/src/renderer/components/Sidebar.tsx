import { useMemo, useState } from "react";
import type { GraphIndex } from "@bando/core/query";
import type { CodeNode } from "@bando/core/types";
import { symbolName } from "../elements";
import { ExportDocs } from "./ExportDocs";
import { JobCard } from "./JobCard";

interface Props {
  index: GraphIndex;
  selectedId?: string;
  onSelect(id: string): void;
}

export function Sidebar({ index, selectedId, onSelect }: Props) {
  const [tab, setTab] = useState<"files" | "overview">("overview");
  const [query, setQuery] = useState("");

  return (
    <aside className="sidebar">
      <input
        className="search"
        placeholder="Buscar archivo, clase, función…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() ? (
        <SearchResults index={index} query={query.trim()} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <>
          <div className="tabs">
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
              Resumen
            </button>
            <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
              Archivos
            </button>
          </div>
          <div className="sidebar-body">
            {tab === "overview" ? (
              <Overview index={index} onSelect={onSelect} />
            ) : (
              <FileTree index={index} selectedId={selectedId} onSelect={onSelect} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SearchResults({ index, query, selectedId, onSelect }: Props & { query: string }) {
  const results = useMemo(() => index.search(query, 200), [index, query]);
  if (!results.length) return <p className="muted pad">Sin resultados</p>;
  return (
    <ul className="list sidebar-body">
      {results.map((node) => (
        <li key={node.id}>
          <NodeLink node={node} selected={node.id === selectedId} onSelect={onSelect} showFile />
        </li>
      ))}
    </ul>
  );
}

function Overview({ index, onSelect }: { index: GraphIndex; onSelect(id: string): void }) {
  const data = useMemo(() => {
    const files = index.graph.nodes.filter((n) => n.kind === "file");
    return {
      mostCalled: index.mostCalled(15),
      entryPoints: index.entryPoints().slice(0, 30),
      hubs: files
        .map((node) => ({ node, n: index.incoming(node.id, "imports").length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 10),
      packages: index.graph.nodes
        .filter((n) => n.kind === "package")
        .map((node) => ({ node, n: index.incoming(node.id, "imports").length }))
        .sort((a, b) => b.n - a.n),
    };
  }, [index]);

  const { stats } = index.graph;
  const totalCalls = stats.resolvedCalls + stats.externalCalls + stats.unresolvedCalls;
  const pct = (n: number) => (totalCalls ? Math.round((n / totalCalls) * 100) : 0);

  return (
    <div className="overview">
      <button className="guide-button" onClick={() => onSelect("project")}>
        <strong>Guía para empezar</strong>
        <span className="muted small">Arquitectura, flujos y qué leer primero, generada con IA</span>
      </button>
      <button className="guide-button" onClick={() => onSelect("ask")}>
        <strong>Preguntar al proyecto</strong>
        <span className="muted small">“¿Dónde se valida…?”, “¿Qué pasa cuando…?”</span>
      </button>
      <JobCard onSelect={onSelect} />
      <ExportDocs />
      <div className="stats">
        <Stat value={stats.files} label="archivos" />
        <Stat value={stats.symbols} label="símbolos" />
        <Stat
          value={`${pct(stats.resolvedCalls + stats.externalCalls)}%`}
          label="llamadas resueltas (propias o de librerías)"
        />
      </div>
      <p className="muted small">
        {stats.resolvedCalls} llamadas internas, {stats.externalCalls} a librerías y {stats.unresolvedCalls} sin
        resolver (callbacks, <code>any</code>, despacho dinámico). Análisis en {stats.durationMs} ms
        {index.graph.tsconfig ? ` con ${index.graph.tsconfig}` : " sin tsconfig"}.
      </p>

      <Section title="Lo más llamado" hint="Suele ser el núcleo del proyecto">
        {data.mostCalled.map(({ node, callers }) => (
          <li key={node.id}>
            <NodeLink node={node} onSelect={onSelect} showFile />
            <span className="count">{callers}</span>
          </li>
        ))}
      </Section>

      <Section title="Puntos de entrada" hint="Exportados y sin llamadores internos: API pública o arranque">
        {data.entryPoints.map((node) => (
          <li key={node.id}>
            <NodeLink node={node} onSelect={onSelect} showFile />
          </li>
        ))}
      </Section>

      <Section title="Archivos más importados">
        {data.hubs.map(({ node, n }) => (
          <li key={node.id}>
            <NodeLink node={node} onSelect={onSelect} />
            <span className="count">{n}</span>
          </li>
        ))}
      </Section>

      <Section title="Dependencias externas">
        {data.packages.map(({ node, n }) => (
          <li key={node.id}>
            <NodeLink node={node} onSelect={onSelect} />
            <span className="count">{n}</span>
          </li>
        ))}
      </Section>
    </div>
  );
}

function FileTree({ index, selectedId, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const byDir = useMemo(() => {
    const groups = new Map<string, CodeNode[]>();
    const files = index.graph.nodes.filter((n) => n.kind === "file").sort((a, b) => a.id.localeCompare(b.id));
    for (const file of files) {
      const dir = file.id.includes("/") ? file.id.slice(0, file.id.lastIndexOf("/")) : ".";
      groups.set(dir, [...(groups.get(dir) ?? []), file]);
    }
    return [...groups];
  }, [index]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderChildren = (id: string, depth: number) => (
    <ul className="list">
      {index.children(id).map((child) => (
        <li key={child.id} style={{ paddingLeft: depth * 12 }}>
          <NodeLink node={child} selected={child.id === selectedId} onSelect={onSelect} />
          {index.children(child.id).length > 0 && renderChildren(child.id, 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="tree">
      {byDir.map(([dir, files]) => (
        <div key={dir}>
          <button
            className={`dir ${selectedId === `dir:${dir}` ? "selected" : ""}`}
            onClick={() => onSelect(`dir:${dir}`)}
            title="Ver la carpeta y su resumen"
          >
            {dir}/
          </button>
          {files.map((file) => (
            <div key={file.id}>
              <div className="file-row">
                <button className="twisty" onClick={() => toggle(file.id)}>
                  {index.children(file.id).length ? (open.has(file.id) ? "▾" : "▸") : " "}
                </button>
                <NodeLink node={file} selected={file.id === selectedId} onSelect={onSelect} />
              </div>
              {open.has(file.id) && renderChildren(file.id, 1)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function NodeLink({
  node,
  selected,
  onSelect,
  showFile,
}: {
  node: CodeNode;
  selected?: boolean;
  onSelect(id: string): void;
  showFile?: boolean;
}) {
  return (
    <button className={`node-link ${selected ? "selected" : ""}`} onClick={() => onSelect(node.id)} title={node.id}>
      <span className={`kind kind-${node.kind}`}>{KIND_LABELS[node.kind]}</span>
      <span className="name">{symbolName(node)}</span>
      {showFile && node.file && <span className="file muted">{node.file}</span>}
    </button>
  );
}

const KIND_LABELS: Record<CodeNode["kind"], string> = {
  file: "F",
  package: "P",
  class: "C",
  interface: "I",
  function: "ƒ",
  method: "m",
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode[] }) {
  if (!children.length) return null;
  return (
    <section>
      <h3 title={hint}>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      <ul className="list">{children}</ul>
    </section>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
