import Anthropic from "@anthropic-ai/sdk";

/** Claude model used for every summary. */
export const SUMMARY_MODEL = "claude-opus-5-5";

export const DEFAULT_LOCAL_URL = "http://localhost:1234/v1";

/**
 * Who writes the summary: Claude through the Anthropic API, or a local model behind an
 * OpenAI-compatible server (LM Studio, Ollama, llama.cpp…).
 */
export type SummaryProvider =
  { kind: "anthropic"; client?: Anthropic } | { kind: "local"; baseUrl?: string; model?: string };

export interface GenerateOptions {
  /** Defaults to Claude, resolving credentials from the environment (ANTHROPIC_API_KEY, `ant auth login`…). */
  provider?: SummaryProvider;
  /** Called with each chunk of text as it is generated. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface GeneratedText {
  text: string;
  /** "anthropic:claude-opus-5-5", "local:qwen/qwen2.5-coder-14b"… */
  model: string;
}

/** Errors from the local model server, with a message meant for the user. */
export class LocalModelError extends Error {}

/** Generates text with the chosen provider, streaming it through `onText`. */
export function generateText(system: string, prompt: string, options: GenerateOptions = {}): Promise<GeneratedText> {
  const provider = options.provider ?? { kind: "anthropic" };
  return provider.kind === "local"
    ? generateLocally(provider, system, prompt, options)
    : generateWithClaude(provider.client ?? new Anthropic(), system, prompt, options);
}

async function generateWithClaude(
  client: Anthropic,
  system: string,
  prompt: string,
  options: GenerateOptions,
): Promise<GeneratedText> {
  const stream = client.beta.messages.stream(
    {
      model: SUMMARY_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If a safety classifier declines the request, the API retries it on Anthropic's recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: options.signal },
  );
  if (options.onText) stream.on("text", options.onText);

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("El modelo declinó generar este resumen.");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const model = `anthropic:${message.model}`;
  if (message.stop_reason === "max_tokens") return { text: `${text}\n\n_(Resumen truncado por longitud)_`, model };
  return { text, model };
}

/** Streams a chat completion from an OpenAI-compatible server. */
async function generateLocally(
  provider: { baseUrl?: string; model?: string },
  system: string,
  prompt: string,
  options: GenerateOptions,
): Promise<GeneratedText> {
  const baseUrl = (provider.baseUrl ?? DEFAULT_LOCAL_URL).replace(/\/$/, "");
  const model = provider.model ?? (await pickLocalModel(baseUrl, options.signal));

  const response = await localFetch(baseUrl, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: options.signal,
  });

  let text = "";
  let finishReason: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        error?: { message?: string } | string;
      };
      if (event.error) throw new LocalModelError(errorText(event.error));
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        options.onText?.(delta);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  if (finishReason === "length") text += "\n\n_(Resumen truncado por longitud)_";
  return { text, model: `local:${model}` };
}

/** The first chat model the server offers (embedding models can't write summaries). */
async function pickLocalModel(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await localFetch(baseUrl, "/models", { signal });
  const { data } = (await response.json()) as { data: { id: string }[] };
  const model = data.find((m) => !/embed/i.test(m.id));
  if (!model) throw new LocalModelError(`El servidor en ${baseUrl} no tiene ningún modelo de chat disponible.`);
  return model.id;
}

async function localFetch(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(baseUrl + path, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new LocalModelError(
      `No se pudo conectar con el modelo local en ${baseUrl}.\n¿Está corriendo el servidor? En LM Studio: \`lms server start\`.`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = errorText((JSON.parse(body) as { error: { message?: string } | string }).error);
    } catch {
      // Not JSON: keep the raw body.
    }
    const hint = /context|token/i.test(message)
      ? "\nEl contenido no cabe en el contexto del modelo: auméntalo al cargarlo en LM Studio."
      : "";
    throw new LocalModelError(`El modelo local respondió ${response.status}: ${message}${hint}`);
  }
  return response;
}

function errorText(error: { message?: string } | string): string {
  return typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
}

/** Turns SDK and server errors into messages a user can act on. */
export function describeSummaryError(error: unknown): string {
  if (error instanceof LocalModelError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) {
    return "Credenciales de Anthropic inválidas. Revisa ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) return "Límite de uso de la API alcanzado; intenta en unos minutos.";
  if (error instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la API de Anthropic.";
  if (error instanceof Anthropic.APIError) return `Error de la API (${error.status}): ${error.message}`;
  if (error instanceof Anthropic.AnthropicError) {
    // Thrown by the client constructor when no credentials can be resolved.
    return `${error.message}\nDefine ANTHROPIC_API_KEY o ejecuta \`ant auth login\`.`;
  }
  return error instanceof Error ? error.message : String(error);
}
