import { useState } from "react";
import type { ExportDocsResult } from "@bando/core/docs";

/** Exports the project's documentation as Markdown, with whatever summaries exist. */
export function ExportDocs() {
  const [state, setState] = useState<{ result?: ExportDocsResult; error?: string; busy?: boolean }>({});

  const run = async () => {
    setState({ busy: true });
    try {
      const result = await window.bando.exportDocs();
      setState({ result });
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  const s = state.result?.summarized;
  return (
    <div className="job-card">
      <strong>Documentación</strong>
      <span className="small muted">
        Exporta el proyecto en Markdown: índice con la guía y la arquitectura, una página por carpeta y por archivo, con
        diagramas y enlaces al código. Se ve directamente en GitHub o GitLab.
      </span>
      {state.result && s && (
        <span className="small">
          ✓ {state.result.pages} páginas en <code>{state.result.outDir}</code>. Con resumen de IA: {s.files}/
          {s.totalFiles} archivos, {s.folders}/{s.totalFolders} carpetas{s.guide ? " y la guía" : ", sin guía"}.
        </span>
      )}
      {state.error && <span className="small error pre">{state.error}</span>}
      <button disabled={state.busy} onClick={run}>
        {state.busy ? "Exportando…" : "Exportar documentación…"}
      </button>
    </div>
  );
}
