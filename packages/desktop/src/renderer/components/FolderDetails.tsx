import { useMemo, useState } from "react";
import type { GraphIndex } from "@bando/core/query";
import type { FolderTree } from "@bando/core/folder-tree";
import { folderOf } from "@bando/core/targets";
import { BatchSummarize } from "./BatchSummarize";
import type { LinkResolver } from "./Markdown";
import { NodeLink } from "./Sidebar";
import { SummaryPanel } from "./SummaryPanel";

interface Props {
  index: GraphIndex;
  tree: FolderTree;
  dir: string;
  onSelect(id: string): void;
  resolveLink: LinkResolver;
}

export function FolderDetails({ index, tree, dir, onSelect, resolveLink }: Props) {
  const [refresh, setRefresh] = useState(0);

  const data = useMemo(() => {
    const files = index.graph.nodes.filter((n) => n.kind === "file" && folderOf(n.id) === dir);
    const inFolder = new Set(files.map((f) => f.id));
    const uses = new Map<string, number>();
    const usedBy = new Map<string, number>();
    for (const edge of index.graph.edges) {
      if (edge.kind !== "imports" || edge.to.startsWith("pkg:")) continue;
      if (inFolder.has(edge.from) && !inFolder.has(edge.to)) bump(uses, folderOf(edge.to));
      if (!inFolder.has(edge.from) && inFolder.has(edge.to)) bump(usedBy, folderOf(edge.from));
    }
    const info = tree.get(dir);
    const subfolders: [string, number][] = (info?.folders ?? []).map((f) => [f, tree.get(f)!.totalFiles]);
    return { files, uses: sorted(uses), usedBy: sorted(usedBy), subfolders, totalFiles: info?.totalFiles ?? 0 };
  }, [index, tree, dir]);

  const targets = useMemo(() => data.files.map((f) => ({ kind: "file" as const, id: f.id })), [data]);

  return (
    <aside className="details">
      <header>
        <div className="title">
          <span className="badge">carpeta</span>
        </div>
        <h2>{dir === "." ? "(raíz del proyecto)" : `${dir}/`}</h2>
        <p className="muted small">
          {data.files.length} archivos directos
          {data.totalFiles > data.files.length && ` · ${data.totalFiles} en total con sus subcarpetas`}
        </p>
      </header>

      {data.files.length > 0 ? (
        <>
          <SummaryPanel target={{ kind: "folder", id: dir }} resolveLink={resolveLink} refreshKey={refresh} />
          <BatchSummarize targets={targets} noun="archivos" onProgress={() => setRefresh((n) => n + 1)} />
        </>
      ) : (
        <p className="muted small">Esta carpeta solo agrupa subcarpetas: abre una de ellas para ver su resumen.</p>
      )}

      {data.files.length > 0 && (
        <section>
          <h3>
            Archivos <span className="muted">({data.files.length})</span>
          </h3>
          <ul className="list">
            {data.files.map((file) => (
              <li key={file.id}>
                <NodeLink node={file} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <FolderGroup title="Subcarpetas" folders={data.subfolders} onSelect={onSelect} unit="archivos" />
      <FolderGroup title="Importa de" folders={data.uses} onSelect={onSelect} />
      <FolderGroup title="La importan" folders={data.usedBy} onSelect={onSelect} />
    </aside>
  );
}

export function FolderLink({ dir, onSelect }: { dir: string; onSelect(id: string): void }) {
  return (
    <button className="node-link" onClick={() => onSelect(`dir:${dir}`)} title={dir}>
      <span className="kind kind-folder">D</span>
      <span className="name">{dir === "." ? "(raíz)" : `${dir}/`}</span>
    </button>
  );
}

function FolderGroup({
  title,
  folders,
  onSelect,
  unit = "importaciones",
}: {
  title: string;
  folders: [string, number][];
  onSelect(id: string): void;
  unit?: string;
}) {
  if (!folders.length) return null;
  return (
    <section>
      <h3>
        {title} <span className="muted">({folders.length})</span>
      </h3>
      <ul className="list">
        {folders.map(([dir, count]) => (
          <li key={dir}>
            <FolderLink dir={dir} onSelect={onSelect} />
            {count > 0 && (
              <span className="count" title={unit}>
                {count}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sorted(map: Map<string, number>): [string, number][] {
  return [...map].sort((a, b) => b[1] - a[1]);
}
