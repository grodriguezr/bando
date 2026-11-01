import { useEffect, useState } from "react";
import type { GraphIndex } from "@bando/core/query";
import type { CodeEdge, CodeNode } from "@bando/core/types";
import { NodeLink } from "./Sidebar";
import { SummaryPanel } from "./SummaryPanel";

/** Files longer than this are shown truncated in the code view. */
const MAX_CODE_LINES = 400;

interface Props {
  index: GraphIndex;
  node: CodeNode;
  onSelect(id: string): void;
}

export function Details({ index, node, onSelect }: Props) {
  const related = (edges: CodeEdge[], side: "from" | "to", withLines = false) =>
    edges.map((edge) => {
      const other = index.node(edge[side]);
      if (!other) return null;
      return (
        <li key={`${edge.kind}:${other.id}`}>
          <NodeLink node={other} onSelect={onSelect} showFile={other.file !== node.file} />
          <span className="count" title={withLines ? `Líneas ${edge.lines.join(", ")}` : undefined}>
            {edge.count > 1 ? `${edge.count}×` : ""}
          </span>
        </li>
      );
    });

  const heritage = [...index.outgoing(node.id, "extends"), ...index.outgoing(node.id, "implements")];
  const subtypes = [...index.incoming(node.id, "extends"), ...index.incoming(node.id, "implements")];

  return (
    <aside className="details">
      <header>
        <div className="title">
          <span className={`badge kind-${node.kind}`}>{node.kind}</span>
          {node.exported && node.kind !== "package" && node.kind !== "file" && <span className="badge">exportado</span>}
        </div>
        <h2>{node.kind === "file" || node.kind === "package" ? node.id.replace(/^pkg:/, "") : node.id.split("#")[1]}</h2>
        {node.file && node.kind !== "file" && (
          <p className="muted small">
            {node.file}:{node.line}–{node.endLine}
          </p>
        )}
        {node.signature && <pre className="signature">{node.signature}</pre>}
        {node.doc && <p className="doc">{node.doc}</p>}
      </header>

      {node.kind === "file" && <SummaryPanel fileId={node.id} />}

      <Group title="Lo llaman">{related(index.incoming(node.id, "calls"), "from", true)}</Group>
      <Group title="Llama a">{related(index.outgoing(node.id, "calls"), "to")}</Group>
      <Group title="Hereda de / implementa">{related(heritage, "to")}</Group>
      <Group title="Subtipos">{related(subtypes, "from")}</Group>
      <Group title="Contiene">{related(index.outgoing(node.id, "contains"), "to")}</Group>
      <Group title="Importa">{related(index.outgoing(node.id, "imports"), "to")}</Group>
      <Group title="Importado por">{related(index.incoming(node.id, "imports"), "from")}</Group>

      {node.file && <CodeView node={node} />}
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (!children.length) return null;
  return (
    <section>
      <h3>
        {title} <span className="muted">({children.length})</span>
      </h3>
      <ul className="list">{children}</ul>
    </section>
  );
}

function CodeView({ node }: { node: CodeNode }) {
  const [source, setSource] = useState<{ file: string; text: string } | { file: string; error: string }>();

  useEffect(() => {
    let cancelled = false;
    window.bando.readFile(node.file).then(
      (text) => !cancelled && setSource({ file: node.file, text }),
      (error: Error) => !cancelled && setSource({ file: node.file, error: error.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [node.file]);

  if (!source || source.file !== node.file) return <p className="muted pad">Cargando código…</p>;
  if ("error" in source) return <p className="error pad">{source.error}</p>;

  const all = source.text.split("\n");
  const start = node.kind === "file" ? 1 : node.line;
  const end = Math.min(node.kind === "file" ? all.length : node.endLine, start + MAX_CODE_LINES - 1);
  const lines = all.slice(start - 1, end);

  return (
    <section>
      <h3>Código</h3>
      <pre className="code">
        {lines.map((text, i) => (
          <div key={i} className="code-line">
            <span className="ln">{start + i}</span>
            <span>{text || " "}</span>
          </div>
        ))}
        {end < (node.kind === "file" ? all.length : node.endLine) && <div className="muted">… (truncado)</div>}
      </pre>
    </section>
  );
}
