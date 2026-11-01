import { useEffect, useState } from "react";
import type { GraphIndex } from "@bando/core/query";
import type { AiSettings } from "../bando";
import { Markdown, type LinkResolver } from "./Markdown";
import { NodeLink } from "./Sidebar";

export interface AskEntry {
  id: string;
  question: string;
  status: "running" | "done" | "error";
  text: string;
  model?: string;
  sources?: string[];
  error?: string;
}

interface Props {
  index: GraphIndex;
  entries: AskEntry[];
  onAsk(question: string): void;
  onSelect(id: string): void;
  resolveLink: LinkResolver;
}

const EXAMPLES = [
  "¿Dónde se valida el inicio de sesión?",
  "¿Qué pasa cuando se crea un cliente?",
  "¿Cómo se calcula el total?",
];

/** Questions about the project, answered with the most relevant parts of it as context. */
export function AskPanel({ index, entries, onAsk, onSelect, resolveLink }: Props) {
  const [question, setQuestion] = useState("");
  const [settings, setSettings] = useState<AiSettings>();
  const running = entries.some((e) => e.status === "running");

  useEffect(() => {
    void window.bando.getAiSettings().then(setSettings);
  }, []);

  const submit = () => {
    const text = question.trim();
    if (!text || running) return;
    onAsk(text);
    setQuestion("");
  };

  return (
    <aside className="details guide">
      <header>
        <div className="title">
          <span className="badge">proyecto</span>
        </div>
        <h2>Preguntar al proyecto</h2>
        <p className="muted small">
          Bando busca las partes del código relacionadas con tu pregunta y se las pasa a{" "}
          {settings?.provider === "local" ? "tu modelo local" : "Claude"} para responder. Funciona mejor con preguntas
          que usan palabras del dominio (cliente, factura, contrato…) y mejora mucho si antes resumes el proyecto.
        </p>
      </header>

      <div className="ask-form">
        <textarea
          value={question}
          placeholder="Escribe tu pregunta y presiona Enter"
          rows={3}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" disabled={running || !question.trim()} onClick={submit}>
          {running ? "Respondiendo…" : "Preguntar"}
        </button>
      </div>
      {!entries.length && (
        <p className="muted small">
          Por ejemplo:{" "}
          {EXAMPLES.map((example, i) => (
            <span key={example}>
              {i > 0 && " · "}
              <button className="link" onClick={() => setQuestion(example)}>
                {example}
              </button>
            </span>
          ))}
        </p>
      )}

      {[...entries].reverse().map((entry) => (
        <section key={entry.id} className="ask-entry">
          <h3 className="ask-question">{entry.question}</h3>
          {entry.status === "error" ? (
            <p className="error small pre">{entry.error}</p>
          ) : entry.text ? (
            <Markdown text={entry.text} resolveLink={resolveLink} />
          ) : (
            <p className="muted small">
              {settings?.provider === "local" ? "El modelo local está pensando (puede tardar un minuto)…" : "Pensando…"}
            </p>
          )}
          {entry.sources && (
            <details className="small">
              <summary className="muted">
                Basado en {entry.sources.length} partes del proyecto
                {entry.model && ` · ${entry.model.replace(/^(anthropic|local):/, "")}`}
              </summary>
              <ul className="list">
                {entry.sources.map((id) => {
                  const node = index.node(id);
                  return node ? (
                    <li key={id}>
                      <NodeLink node={node} onSelect={onSelect} showFile={node.kind !== "file"} />
                    </li>
                  ) : null;
                })}
              </ul>
            </details>
          )}
        </section>
      ))}
    </aside>
  );
}
