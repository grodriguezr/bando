import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CodeGraph } from "@bando/core/types";
import {
  describeSummaryError,
  SUMMARY_MODEL,
  SUMMARY_PROMPT_VERSION,
  summarizeModule,
} from "@bando/core/summarize";

export type SummaryResult = { text: string; stale?: boolean } | { error: string };

interface Entry {
  /** Hash of the source + model + prompt version the summary was generated from. */
  hash: string;
  text: string;
  createdAt: string;
}

/**
 * Generates module summaries and caches them on disk, keyed by project + file and
 * invalidated by a hash of the source, so an unchanged file is never paid for twice.
 */
export class SummaryService {
  private readonly cacheFile = path.join(app.getPath("userData"), "summaries.json");
  private cache: Record<string, Entry> | undefined;
  private readonly inFlight = new Map<string, Promise<SummaryResult>>();

  /** The cached summary, flagged as stale if the file changed since it was generated. */
  async cached(root: string, fileId: string): Promise<SummaryResult | undefined> {
    const entry = (await this.load())[key(root, fileId)];
    if (!entry) return undefined;
    const source = await readSource(root, fileId);
    return { text: entry.text, stale: entry.hash !== hashOf(source) };
  }

  generate(graph: CodeGraph, fileId: string, onText: (delta: string) => void): Promise<SummaryResult> {
    const k = key(graph.root, fileId);
    // A second request for the same file (e.g. the user navigated away and back) joins the running one.
    const running = this.inFlight.get(k);
    if (running) return running;

    const task = (async (): Promise<SummaryResult> => {
      try {
        const source = await readSource(graph.root, fileId);
        const text = await summarizeModule(graph, fileId, source, { onText });
        const cache = await this.load();
        cache[k] = { hash: hashOf(source), text, createdAt: new Date().toISOString() };
        await fs.writeFile(this.cacheFile, JSON.stringify(cache));
        return { text };
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
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await fs.readFile(this.cacheFile, "utf8")) as Record<string, Entry>;
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }
}

function key(root: string, fileId: string): string {
  return `${root}::${fileId}`;
}

function hashOf(source: string): string {
  return createHash("sha256").update(`${SUMMARY_MODEL}\n${SUMMARY_PROMPT_VERSION}\n${source}`).digest("hex");
}

async function readSource(root: string, fileId: string): Promise<string> {
  const full = path.resolve(root, fileId);
  if (path.relative(root, full).startsWith("..")) throw new Error("Ruta fuera del proyecto");
  return fs.readFile(full, "utf8");
}
