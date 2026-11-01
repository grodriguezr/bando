import { useEffect, useState } from "react";
import type { AiSettings } from "../bando";
import { Markdown } from "./Markdown";

type State =
  | { status: "checking" }
  | { status: "idle" }
  | { status: "generating"; text: string }
  | { status: "done"; text: string; model: string; stale?: boolean }
  | { status: "error"; message: string };

const PROVIDER_HINTS: Record<AiSettings["provider"], string> = {
  anthropic: "Claude: mejor calidad, unos centavos por archivo.",
  local: "Modelo local (LM Studio, Ollama…): gratis y privado, más lento y menos preciso.",
};

/** AI summary of one module (file): loads the cached one if any, otherwise offers to generate it. */
export function SummaryPanel({ fileId }: { fileId: string }) {
  const [state, setState] = useState<State>({ status: "checking" });
  const [settings, setSettings] = useState<AiSettings>();

  useEffect(() => {
    void window.bando.getAiSettings().then(setSettings);
  }, []);

  // Re-check the cache whenever the file or the provider changes.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setState({ status: "checking" });
    window.bando.cachedSummary(fileId).then((cached) => {
      if (cancelled) return;
      if (cached && "text" in cached) setState({ status: "done", ...cached });
      else setState({ status: "idle" });
    });
    return () => {
      cancelled = true;
    };
  }, [fileId, settings?.provider]);

  useEffect(
    () =>
      window.bando.onSummaryDelta((delta) => {
        if (delta.fileId !== fileId) return;
        setState((s) => (s.status === "generating" ? { ...s, text: s.text + delta.text } : s));
      }),
    [fileId],
  );

  const generate = async () => {
    setState({ status: "generating", text: "" });
    const result = await window.bando.generateSummary(fileId);
    setState("error" in result ? { status: "error", message: result.error } : { status: "done", ...result });
  };

  const changeProvider = async (provider: AiSettings["provider"]) => {
    setSettings(await window.bando.setAiSettings({ provider }));
  };

  const generating = state.status === "generating";

  return (
    <section className="summary">
      <h3>
        Resumen con IA
        {settings && (
          <select
            value={settings.provider}
            disabled={generating}
            onChange={(e) => changeProvider(e.target.value as AiSettings["provider"])}
            title={PROVIDER_HINTS[settings.provider]}
          >
            <option value="anthropic">Claude</option>
            <option value="local">Modelo local</option>
          </select>
        )}
        {state.status === "done" && (
          <button className="link" onClick={generate} title="Volver a generar el resumen">
            regenerar
          </button>
        )}
      </h3>
      {state.status === "idle" && settings && (
        <div>
          <p className="muted small">{PROVIDER_HINTS[settings.provider]}</p>
          <button onClick={generate}>Resumir con {settings.provider === "local" ? "el modelo local" : "Claude"}</button>
        </div>
      )}
      {generating &&
        (state.text ? (
          <Markdown text={state.text} />
        ) : (
          <p className="muted small">
            {settings?.provider === "local" ? "El modelo local está leyendo el módulo (puede tardar un par de minutos)…" : "Leyendo el módulo…"}
          </p>
        ))}
      {state.status === "done" && (
        <>
          {state.stale && <p className="warn small">El archivo cambió desde que se generó este resumen.</p>}
          <Markdown text={state.text} />
          <p className="muted small">Generado con {state.model.replace(/^(anthropic|local):/, "")}</p>
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
