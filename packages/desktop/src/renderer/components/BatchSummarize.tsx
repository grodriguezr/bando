import { useEffect, useRef, useState } from "react";
import { summaryKey, type SummaryTarget } from "@bando/core/targets";

interface Props {
  /** The parts to summarize, in order. */
  targets: SummaryTarget[];
  /** "archivos", "carpetas"… */
  noun: string;
  /** Called after each part is summarized, so the parent summary can show it's out of date. */
  onProgress(): void;
}

type Status =
  | { kind: "checking" }
  | { kind: "ready"; pending: SummaryTarget[] }
  | { kind: "running"; done: number; total: number; current: string; stopping: boolean }
  | { kind: "error"; message: string; pending: SummaryTarget[] };

/** Summarizes, one at a time, the parts a folder or the project guide builds on. */
export function BatchSummarize({ targets, noun, onProgress }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const stop = useRef(false);
  const signature = targets.map(summaryKey).join("|");

  const pendingTargets = async () => {
    const pending: SummaryTarget[] = [];
    for (const target of targets) {
      const cached = await window.bando.cachedSummary(target);
      if (!cached || !("text" in cached) || cached.stale) pending.push(target);
    }
    return pending;
  };

  // Re-count when any of our targets is summarized elsewhere (e.g. by the background job).
  const [updated, setUpdated] = useState(0);
  useEffect(() => {
    const keys = new Set(signature.split("|"));
    return window.bando.onSummaryUpdated((event) => {
      if (keys.has(event.key)) setUpdated((n) => n + 1);
    });
  }, [signature]);

  useEffect(() => {
    let cancelled = false;
    void pendingTargets().then((pending) => {
      // Our own loop owns the status while it runs.
      if (!cancelled) setStatus((s) => (s.kind === "running" ? s : { kind: "ready", pending }));
    });
    return () => {
      cancelled = true;
    };
    // `targets` is identified by `signature`.
  }, [signature, updated]);

  const run = async (pending: SummaryTarget[]) => {
    stop.current = false;
    for (const [i, target] of pending.entries()) {
      if (stop.current) break;
      const name = target.kind === "project" ? "proyecto" : target.id;
      setStatus({ kind: "running", done: i, total: pending.length, current: name, stopping: false });
      const result = await window.bando.generateSummary(target);
      onProgress();
      if ("error" in result) {
        setStatus({ kind: "error", message: `${name}: ${result.error}`, pending: await pendingTargets() });
        return;
      }
    }
    setStatus({ kind: "ready", pending: await pendingTargets() });
  };

  if (status.kind === "checking") return null;
  if (status.kind === "running") {
    return (
      <div className="batch">
        <p className="small">
          Resumiendo {status.done + 1} de {status.total}: <code>{status.current}</code>
        </p>
        <progress value={status.done} max={status.total} />
        <button
          disabled={status.stopping}
          onClick={() => {
            stop.current = true;
            setStatus({ ...status, stopping: true });
          }}
        >
          {status.stopping ? "Deteniendo al terminar el actual…" : "Detener"}
        </button>
      </div>
    );
  }
  const { pending } = status;
  if (!pending.length) {
    return <p className="muted small">✓ Todos sus {noun} ({targets.length}) tienen un resumen al día.</p>;
  }
  return (
    <div className="batch">
      {status.kind === "error" && <p className="error small pre">{status.message}</p>}
      <p className="muted small">
        {pending.length} de {targets.length} {noun} sin resumen (o desactualizados). Resumirlos antes mejora este
        resumen.
      </p>
      <button onClick={() => run(pending)}>
        Resumir {pending.length} {noun}
      </button>
    </div>
  );
}
