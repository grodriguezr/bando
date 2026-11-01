import { useEffect, useState } from "react";
import type { SummaryTarget } from "@bando/core/targets";
import type { AiSettings, JobStatus } from "../bando";

/** Starts and follows the background job that summarizes every file, folder and the guide. */
export function JobCard({ onSelect }: { onSelect(id: string): void }) {
  const [status, setStatus] = useState<JobStatus>({ running: false });
  const [settings, setSettings] = useState<AiSettings>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void window.bando.getJobStatus().then(setStatus);
    void window.bando.getAiSettings().then(setSettings);
    return window.bando.onJob(setStatus);
  }, []);

  // Tick for the elapsed/remaining time while running.
  useEffect(() => {
    if (!status.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.running]);

  const provider = settings?.provider === "local" ? "el modelo local" : "Claude";

  if (status.running) {
    const elapsed = now - status.startedAt;
    const remaining = status.done > 0 ? (elapsed / status.done) * (status.total - status.done) : undefined;
    return (
      <div className="job-card">
        <strong>Resumiendo todo el proyecto…</strong>
        <progress value={status.done} max={status.total || 1} />
        <span className="small">
          {status.done} de {status.total}
          {status.failed > 0 && <span className="error"> · {status.failed} con error</span>}
          {" · "}
          {formatDuration(elapsed)} transcurridos
          {remaining !== undefined && ` · ~${formatDuration(remaining)} restantes`}
        </span>
        {status.current && (
          <span className="small muted">
            Ahora: <TargetLink target={status.current} onSelect={onSelect} />
          </span>
        )}
        <button disabled={status.stopping} onClick={() => void window.bando.stopJob()}>
          {status.stopping ? "Deteniendo al terminar el actual…" : "Detener"}
        </button>
      </div>
    );
  }

  const last = status.last;
  return (
    <div className="job-card">
      <strong>Resumir todo el proyecto</strong>
      <span className="small muted">
        Archivos, luego carpetas y al final la guía, con {provider}. Se salta lo que ya está al día, así que puedes
        detenerlo y retomarlo cuando quieras.
        {settings?.provider === "local" && " Con un modelo local puede tardar bastante: calcula 1-2 min por archivo."}
      </span>
      {last && (
        <span className={`small ${last.failed ? "warn" : "muted"}`}>
          {last.total === 0
            ? "✓ Todo estaba al día."
            : `${last.stopped ? "Detenido" : "Terminado"}: ${last.done - last.failed} de ${last.total} resumidos` +
              (last.failed ? `, ${last.failed} con error` : "") +
              "."}
          {last.error && <span className="error pre"> {last.error}</span>}
        </span>
      )}
      <button
        onClick={async () => {
          setStatus(await window.bando.startJob());
        }}
      >
        {last?.stopped ? "Continuar" : "Resumir todo"}
      </button>
    </div>
  );
}

function TargetLink({ target, onSelect }: { target: SummaryTarget; onSelect(id: string): void }) {
  if (target.kind === "project") {
    return (
      <button className="link" onClick={() => onSelect("project")}>
        la guía
      </button>
    );
  }
  const id = target.kind === "folder" ? `dir:${target.id}` : target.id;
  return (
    <button className="link" onClick={() => onSelect(id)}>
      {target.id}
      {target.kind === "folder" ? "/" : ""}
    </button>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
