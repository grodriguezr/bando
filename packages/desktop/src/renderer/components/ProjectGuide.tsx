import { useMemo, useState } from "react";
import type { GraphIndex } from "@bando/core/query";
import { listFolders } from "@bando/core/targets";
import { BatchSummarize } from "./BatchSummarize";
import type { LinkResolver } from "./Markdown";
import { SummaryPanel } from "./SummaryPanel";

interface Props {
  index: GraphIndex;
  resolveLink: LinkResolver;
}

/** The "where to start" guide for the whole project. */
export function ProjectGuide({ index, resolveLink }: Props) {
  const [refresh, setRefresh] = useState(0);
  const folders = useMemo(
    () => listFolders(index.graph).map((dir) => ({ kind: "folder" as const, id: dir })),
    [index],
  );
  const name = index.graph.root.split(/[\\/]/).pop();

  return (
    <aside className="details guide">
      <header>
        <div className="title">
          <span className="badge">proyecto</span>
        </div>
        <h2>Guía para empezar con {name}</h2>
        <p className="muted small">
          Cada enlace en el texto lleva al archivo o carpeta correspondiente.
        </p>
      </header>
      <SummaryPanel target={{ kind: "project" }} title="Guía" resolveLink={resolveLink} refreshKey={refresh} />
      <BatchSummarize targets={folders} noun="carpetas" onProgress={() => setRefresh((n) => n + 1)} />
      <p className="muted small">
        La guía se basa en los resúmenes de carpetas que existan, y cada carpeta en los de sus archivos. Para la mejor
        guía: resume los archivos desde cada carpeta, luego las carpetas aquí, y regenera la guía.
      </p>
    </aside>
  );
}

