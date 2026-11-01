import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CodeGraph } from "@bando/core/types";
import {
  buildSummaryPrompt,
  DEFAULT_LOCAL_URL,
  describeSummaryError,
  SUMMARY_PROMPT_VERSION,
  summarize,
  summaryKey,
  type SummaryProvider,
  type SummaryTarget,
} from "@bando/core/summarize";

export type ProviderKind = SummaryProvider["kind"];

export interface AiSettings {
  provider: ProviderKind;
  /** OpenAI-compatible endpoint for the local provider. */
  localUrl: string;
  /** Empty: use the first chat model the server offers. */
  localModel: string;
}

export type SummaryResult = { text: string; model: string; stale?: boolean } | { error: string };

interface Entry {
  /** Hash of the exact request the summary was generated from. */
  hash: string;
  text: string;
  model: string;
  createdAt: string;
}

const DEFAULT_SETTINGS: AiSettings = { provider: "anthropic", localUrl: DEFAULT_LOCAL_URL, localModel: "" };

/**
 * Generates summaries of files, folders and the whole project, and caches them on disk per
 * project and provider. A summary is flagged as stale when the request it would be generated
 * from changes: the file's code, or the summaries of the parts a folder or the guide build on.
 */
export class SummaryService {
  private readonly dir = app.getPath("userData");
  private cache: Record<string, Entry> | undefined;
  private settingsCache: AiSettings | undefined;
  private readonly inFlight = new Map<string, Promise<SummaryResult>>();

  async settings(): Promise<AiSettings> {
    this.settingsCache ??= { ...DEFAULT_SETTINGS, ...(await readJson<Partial<AiSettings>>(this.file("settings"))) };
    return this.settingsCache;
  }

  async updateSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
    this.settingsCache = { ...(await this.settings()), ...patch };
    await fs.writeFile(this.file("settings"), JSON.stringify(this.settingsCache, null, 2));
    return this.settingsCache;
  }

  async cached(graph: CodeGraph, target: SummaryTarget): Promise<SummaryResult | undefined> {
    const { provider } = await this.settings();
    const cache = await this.load();
    const entry = cache[cacheKey(provider, graph.root, target)];
    if (!entry) return undefined;
    let stale = true;
    try {
      stale = entry.hash !== hashOf(buildSummaryPrompt(graph, target, { summaries: this.known(cache, provider, graph.root) }));
    } catch {
      // The file was deleted or can't be read: keep showing the old summary, flagged as stale.
    }
    return { text: entry.text, model: entry.model, stale };
  }

  async generate(graph: CodeGraph, target: SummaryTarget, onText: (delta: string) => void): Promise<SummaryResult> {
    const settings = await this.settings();
    const k = cacheKey(settings.provider, graph.root, target);
    // A second request for the same target (e.g. the user navigated away and back) joins the running one.
    const running = this.inFlight.get(k);
    if (running) return running;

    const provider: SummaryProvider =
      settings.provider === "local"
        ? { kind: "local", baseUrl: settings.localUrl, model: settings.localModel || undefined }
        : { kind: "anthropic" };

    const task = (async (): Promise<SummaryResult> => {
      try {
        const cache = await this.load();
        const summaries = this.known(cache, settings.provider, graph.root);
        const request = buildSummaryPrompt(graph, target, { summaries });
        const { text, model } = await summarize(graph, target, { provider, summaries, onText });
        cache[k] = { hash: hashOf(request), text, model, createdAt: new Date().toISOString() };
        await fs.writeFile(this.file("summaries"), JSON.stringify(cache));
        return { text, model };
      } catch (error) {
        return { error: describeSummaryError(error) };
      } finally {
        this.inFlight.delete(k);
      }
    })();
    this.inFlight.set(k, task);
    return task;
  }

  /** Every summary of this project and provider, keyed by `summaryKey`. */
  private known(cache: Record<string, Entry>, provider: ProviderKind, root: string): Map<string, string> {
    const prefix = `${provider}::${root}::`;
    return new Map(
      Object.entries(cache)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, entry]) => [k.slice(prefix.length), entry.text]),
    );
  }

  private async load(): Promise<Record<string, Entry>> {
    this.cache ??= (await readJson<Record<string, Entry>>(this.file("summaries"))) ?? {};
    return this.cache;
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }
}

function cacheKey(provider: ProviderKind, root: string, target: SummaryTarget): string {
  return `${provider}::${root}::${summaryKey(target)}`;
}

function hashOf(request: { system: string; prompt: string }): string {
  return createHash("sha256")
    .update(`${SUMMARY_PROMPT_VERSION}\n${request.system}\n${request.prompt}`)
    .digest("hex");
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
