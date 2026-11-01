import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CodeGraph } from "@bando/core/types";
import {
  DEFAULT_LOCAL_URL,
  describeSummaryError,
  SUMMARY_PROMPT_VERSION,
  summarizeModule,
  type SummaryProvider,
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
  /** Hash of the source + prompt version the summary was generated from. */
  hash: string;
  text: string;
  model: string;
  createdAt: string;
}

const DEFAULT_SETTINGS: AiSettings = { provider: "anthropic", localUrl: DEFAULT_LOCAL_URL, localModel: "" };

/**
 * Generates module summaries and caches them on disk, keyed by project + file + provider and
 * invalidated by a hash of the source, so an unchanged file is never paid for twice.
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

  /** The cached summary from the current provider, flagged as stale if the file changed since. */
  async cached(root: string, fileId: string): Promise<SummaryResult | undefined> {
    const { provider } = await this.settings();
    const entry = (await this.load())[key(root, fileId, provider)];
    if (!entry) return undefined;
    const source = await readSource(root, fileId);
    return { text: entry.text, model: entry.model, stale: entry.hash !== hashOf(source) };
  }

  async generate(graph: CodeGraph, fileId: string, onText: (delta: string) => void): Promise<SummaryResult> {
    const settings = await this.settings();
    const k = key(graph.root, fileId, settings.provider);
    // A second request for the same file (e.g. the user navigated away and back) joins the running one.
    const running = this.inFlight.get(k);
    if (running) return running;

    const provider: SummaryProvider =
      settings.provider === "local"
        ? { kind: "local", baseUrl: settings.localUrl, model: settings.localModel || undefined }
        : { kind: "anthropic" };

    const task = (async (): Promise<SummaryResult> => {
      try {
        const source = await readSource(graph.root, fileId);
        const { text, model } = await summarizeModule(graph, fileId, source, { provider, onText });
        const cache = await this.load();
        cache[k] = { hash: hashOf(source), text, model, createdAt: new Date().toISOString() };
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

  private async load(): Promise<Record<string, Entry>> {
    this.cache ??= (await readJson<Record<string, Entry>>(this.file("summaries"))) ?? {};
    return this.cache;
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }
}

function key(root: string, fileId: string, provider: ProviderKind): string {
  return `${provider}::${root}::${fileId}`;
}

function hashOf(source: string): string {
  return createHash("sha256").update(`${SUMMARY_PROMPT_VERSION}\n${source}`).digest("hex");
}

async function readSource(root: string, fileId: string): Promise<string> {
  const full = path.resolve(root, fileId);
  if (path.relative(root, full).startsWith("..")) throw new Error("Ruta fuera del proyecto");
  return fs.readFile(full, "utf8");
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
