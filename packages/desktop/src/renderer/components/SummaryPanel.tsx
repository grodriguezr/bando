import { useEffect, useState } from "react";
import { summaryKey, type SummaryTarget } from "@bando/core/targets";
import type { AiSettings } from "../bando";
import { Markdown, type LinkResolver } from "./Markdown";

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

const DESCRIPTIONS: Record<SummaryTarget["kind"], string> = {
  file: "Explica qué hace este archivo, cómo se usa y qué tener en cuenta.",
  folder: "Explica el papel de esta carpeta. Es mejor si antes se resumen sus archivos.",
  project: "Una guía para orientarse: arquitectura, flujos principales y en qué orden leer el código.",
};

interface Props {
  target: SummaryTarget;
  title?: string;
  /** Makes file and folder paths in the summary clickable. */
  resolveLink?: LinkResolver;
  /** Change it to re-check the cache, e.g. after the parts this summary builds on were summarized. */
  refreshKey?: number;
}

/** AI summary of a file, folder or the project: loads the cached one if any, otherwise offers to generate it. */
export function SummaryPanel({ target, title = "Resumen con IA", resolveLink, refreshKey }: Props) {
  const key = summaryKey(target);
  const [state, setState] = useState<State>({ status: "checking" });
  const [settings, setSettings] = useState<AiSettings>();
  /** Bumped when this summary is stored by someone else (e.g. the background job). */
  const [updated, setUpdated] = useState(0);

  useEffect(() => {
    void window.bando.getAiSettings().then(setSettings);
  }, []);

  // Re-check the cache whenever the target, the provider or the inputs change.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setState({ status: "checking" });
    window.bando.cachedSummary(target).then((cached) => {
      if (cancelled) return;
      if (cached && "text" in cached) setState({ status: "done", ...cached });
      else setState({ status: "idle" });
    });
    return () => {
      cancelled = true;
    };
    // `target` is identified by `key`: depending on the object itself would re-run on every render.
  }, [key, settings?.provider, refreshKey, updated]);

  // Text can also arrive from the background job, not only from our own request.
  useEffect(() => {
    const offDelta = window.bando.onSummaryDelta((delta) => {
      if (delta.key !== key) return;
      setState((s) => ({ status: "generating", text: (s.status === "generating" ? s.text : "") + delta.text }));
    });
    const offUpdated = window.bando.onSummaryUpdated((event) => {
      if (event.key === key) setUpdated((n) => n + 1);
    });
    return () => {
      offDelta();
      offUpdated();
    };
  }, [key]);

  const generate = async () => {
    setState({ status: "generating", text: "" });
    const result = await window.bando.generateSummary(target);
    setState("error" in result ? { status: "error", message: result.error } : { status: "done", ...result });
  };

  const changeProvider = async (provider: AiSettings["provider"]) => {
    setSettings(await window.bando.setAiSettings({ provider }));
  };

  const generating = state.status === "generating";

  return (
    <section className="summary">
      <h3>
        {title}
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
          <p className="muted small">
            {DESCRIPTIONS[target.kind]} {PROVIDER_HINTS[settings.provider]}
          </p>
          <button onClick={generate}>Resumir con {settings.provider === "local" ? "el modelo local" : "Claude"}</button>
        </div>
      )}
      {generating &&
        (state.text ? (
          <Markdown text={state.text} resolveLink={resolveLink} />
        ) : (
          <p className="muted small">
            {settings?.provider === "local" ? "El modelo local está trabajando (puede tardar un par de minutos)…" : "Pensando…"}
          </p>
        ))}
      {state.status === "done" && (
        <>
          {state.stale && (
            <p className="warn small">
              {target.kind === "file"
                ? "El archivo cambió desde que se generó este resumen."
                : "Hay información nueva (código o resúmenes de sus partes); puedes regenerarlo."}
            </p>
          )}
          <Markdown text={state.text} resolveLink={resolveLink} />
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
