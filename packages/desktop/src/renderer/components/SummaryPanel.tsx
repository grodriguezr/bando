import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";

type State =
  | { status: "checking" }
  | { status: "idle" }
  | { status: "generating"; text: string }
  | { status: "done"; text: string; stale?: boolean }
  | { status: "error"; message: string };

/** AI summary of one module (file): loads the cached one if any, otherwise offers to generate it. */
export function SummaryPanel({ fileId }: { fileId: string }) {
  const [state, setState] = useState<State>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    window.bando.cachedSummary(fileId).then((cached) => {
      if (cancelled) return;
      if (cached && "text" in cached) setState({ status: "done", text: cached.text, stale: cached.stale });
      else setState({ status: "idle" });
    });
    const unsubscribe = window.bando.onSummaryDelta((delta) => {
      if (delta.fileId !== fileId) return;
      setState((s) => (s.status === "generating" ? { ...s, text: s.text + delta.text } : s));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [fileId]);

  const generate = async () => {
    setState({ status: "generating", text: "" });
    const result = await window.bando.generateSummary(fileId);
    setState("error" in result ? { status: "error", message: result.error } : { status: "done", text: result.text });
  };

  return (
    <section className="summary">
      <h3>
        Resumen con IA
        {state.status === "done" && (
          <button className="link" onClick={generate} title="Volver a generar el resumen">
            regenerar
          </button>
        )}
      </h3>
      {state.status === "checking" && null}
      {state.status === "idle" && (
        <div>
          <p className="muted small">Explica en lenguaje natural qué hace este módulo, cómo se usa y qué tener en cuenta.</p>
          <button onClick={generate}>Resumir con Claude</button>
        </div>
      )}
      {state.status === "generating" &&
        (state.text ? <Markdown text={state.text} /> : <p className="muted small">Leyendo el módulo…</p>)}
      {state.status === "done" && (
        <>
          {state.stale && <p className="warn small">El archivo cambió desde que se generó este resumen.</p>}
          <Markdown text={state.text} />
        </>
      )}
      {state.status === "error" && (
        <div>
          <p className="error small pre">{state.message}</p>
          <button onClick={generate}>Reintentar</button>
        </div>
      )}
    </section>
  );
}
