import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeSummaryError, type GeneratedText, type GenerateOptions, type SummaryProvider } from "./llm.js";
import { buildSummaryPrompt, summarize, SUMMARY_PROMPT_VERSION } from "./summarize.js";
import { folderOf, listFolders, summaryKey, type SummaryTarget } from "./targets.js";
import type { CodeGraph } from "./types.js";

export interface CachedSummary {
  text: string;
  model: string;
  /** The code, or the summaries this one builds on, changed since it was generated. */
  stale: boolean;
}

interface Entry {
  /** Hash of the exact request the summary was generated from. */
  hash: string;
  text: string;
  model: string;
  createdAt: string;
}

export type SummarizeAllEvent =
  | { type: "start"; total: number }
  | { type: "progress"; done: number; total: number; target: SummaryTarget; failed: number }
  | { type: "summarized"; target: SummaryTarget; error?: string }
  | { type: "finished"; done: number; total: number; failed: number; stopped: boolean };

export interface SummarizeAllOptions {
  provider: SummaryProvider;
  onEvent?: (event: SummarizeAllEvent) => void;
  onText?: (target: SummaryTarget, delta: string) => void;
  /** Checked between summaries: the ones in progress always finish. */
  shouldStop?: () => boolean;
  /**
   * Summaries generated at the same time. Local servers that accept parallel requests (LM Studio,
   * Ollama with OLLAMA_NUM_PARALLEL) finish sooner; default 1.
   */
  concurrency?: number;
}

/**
 * Measured on a Mac mini M4 (16 GB) with Qwen2.5-Coder 14B in LM Studio (4 parallel slots), same 6
 * files: 1 at a time 77 s/file, 2 → 52 s, 4 → 41 s. Free memory bottomed out at ~5% with both 2 and 4.
 */
const LOCAL_CONCURRENCY = 4;

/** Characters of code in a flow explanation for local models, which usually run with an 8K-token context. */
const LOCAL_SOURCE_BUDGET = 12_000;

/** Gives up after this many failures in a row (e.g. the local server went down). */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Summaries generated at once by default. The Anthropic API handles parallel requests easily; a
 * local server shares one GPU and its memory, so it gains less and risks running out of memory.
 */
export function defaultConcurrency(provider: SummaryProvider): number {
  return provider.kind === "local" ? LOCAL_CONCURRENCY : 4;
}

/** Where Bando keeps data shared by the CLI and the desktop app, outside of any project. */
export function defaultDataDir(): string {
  if (process.env.BANDO_DATA_DIR) return process.env.BANDO_DATA_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Bando");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Bando");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "bando");
}

/**
 * Persistent cache of summaries, per project and provider, shared by every Bando process.
 * A summary is stale when the request it would be generated from changes: the file's code,
 * or the summaries of the parts a folder or the guide build on.
 */
export class SummaryStore {
  private cache: Record<string, Entry> = {};
  private loadedMtime = -1;
  private readonly inFlight = new Map<string, Promise<GeneratedText>>();

  constructor(
    readonly file = path.join(defaultDataDir(), "summaries.json"),
    /** Replaceable in tests. */
    private readonly generator: typeof summarize = summarize,
  ) {}

  /** What a request is built from: the summaries it builds on and how much code fits the provider. */
  private context(root: string, provider: SummaryProvider["kind"]) {
    return {
      summaries: this.known(root, provider),
      sourceBudget: provider === "local" ? LOCAL_SOURCE_BUDGET : undefined,
    };
  }

  /** Every summary of this project and provider, keyed by `summaryKey`. */
  known(root: string, provider: SummaryProvider["kind"]): Map<string, string> {
    const prefix = keyPrefix(provider, root);
    return new Map(
      Object.entries(this.load())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, entry]) => [k.slice(prefix.length), entry.text]),
    );
  }

  cached(graph: CodeGraph, target: SummaryTarget, provider: SummaryProvider["kind"]): CachedSummary | undefined {
    const entry = this.load()[cacheKey(provider, graph.root, target)];
    if (!entry) return undefined;
    let stale = true;
    try {
      stale = entry.hash !== hashOf(buildSummaryPrompt(graph, target, this.context(graph.root, provider)));
    } catch {
      // The file was deleted or can't be read: keep the old summary, flagged as stale.
    }
    return { text: entry.text, model: entry.model, stale };
  }

  /** Targets with no summary, or a stale one. */
  pending(graph: CodeGraph, targets: SummaryTarget[], provider: SummaryProvider["kind"]): SummaryTarget[] {
    return targets.filter((t) => this.cached(graph, t, provider)?.stale !== false);
  }

  /** Generates a summary and stores it. Concurrent requests for the same target share one generation. */
  generate(
    graph: CodeGraph,
    target: SummaryTarget,
    options: Omit<GenerateOptions, "provider"> & { provider: SummaryProvider },
  ): Promise<GeneratedText> {
    const k = cacheKey(options.provider.kind, graph.root, target);
    const running = this.inFlight.get(k);
    if (running) return running;

    const task = (async () => {
      const context = this.context(graph.root, options.provider.kind);
      const request = buildSummaryPrompt(graph, target, context);
      const result = await this.generator(graph, target, { ...options, ...context });
      this.save(k, {
        hash: hashOf(request),
        text: result.text,
        model: result.model,
        createdAt: new Date().toISOString(),
      });
      return result;
    })().finally(() => this.inFlight.delete(k));
    this.inFlight.set(k, task);
    return task;
  }

  /**
   * Brings every summary of the project up to date, bottom-up: files, then folders (which
   * build on their files), then the guide. Up-to-date summaries are skipped, so running it
   * again after an interruption continues where it left off.
   */
  async summarizeAll(graph: CodeGraph, options: SummarizeAllOptions): Promise<void> {
    const kind = options.provider.kind;
    const emit = options.onEvent ?? (() => {});
    const files: SummaryTarget[] = graph.nodes
      .filter((n) => n.kind === "file")
      .map((n) => n.id)
      .sort()
      .map((id) => ({ kind: "file", id }));
    const pendingFiles = this.pending(graph, files, kind);
    // A folder must be regenerated if any of its files will be.
    const touched = new Set(pendingFiles.map((f) => (f.kind === "file" ? folderOf(f.id) : "")));
    const folders: SummaryTarget[] = listFolders(graph).map((id) => ({ kind: "folder", id }));
    const pendingFolders = folders.filter(
      (f) => (f.kind === "folder" && touched.has(f.id)) || this.pending(graph, [f], kind).length > 0,
    );
    const project: SummaryTarget = { kind: "project" };
    const needsGuide =
      pendingFiles.length > 0 || pendingFolders.length > 0 || this.pending(graph, [project], kind).length > 0;
    // Each phase only needs the previous one: files are independent of each other, and so are folders.
    const phases = [pendingFiles, pendingFolders, needsGuide ? [project] : []];
    const total = phases.reduce((n, phase) => n + phase.length, 0);
    const concurrency = Math.max(1, options.concurrency ?? 1);

    emit({ type: "start", total });
    let done = 0;
    let failed = 0;
    let failuresInARow = 0;
    let stopped = false;
    const halt = () => stopped || (options.shouldStop?.() ?? false);

    const summarizeOne = async (target: SummaryTarget) => {
      emit({ type: "progress", done, total, target, failed });
      try {
        await this.generate(graph, target, {
          provider: options.provider,
          onText: (delta) => options.onText?.(target, delta),
        });
        failuresInARow = 0;
        emit({ type: "summarized", target });
      } catch (error) {
        failed++;
        failuresInARow++;
        emit({ type: "summarized", target, error: describeSummaryError(error) });
      }
      done++;
      if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) stopped = true;
    };

    for (const phase of phases) {
      let next = 0;
      const worker = async () => {
        while (next < phase.length && !halt()) await summarizeOne(phase[next++]!);
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, phase.length) }, worker));
      if (halt()) {
        stopped = true;
        break;
      }
    }
    emit({ type: "finished", done, total, failed, stopped });
  }

  /** Reloads from disk when another process (the CLI, another window) changed the file. */
  private load(): Record<string, Entry> {
    let mtime: number;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      return this.cache;
    }
    if (mtime !== this.loadedMtime) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Entry>;
      } catch {
        // Corrupt or half-written: keep what we have in memory.
      }
      this.loadedMtime = mtime;
    }
    return this.cache;
  }

  private save(key: string, entry: Entry): void {
    // Merge with whatever is on disk now, so concurrent writers don't drop each other's summaries.
    const current = this.load();
    current[key] = entry;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current));
    fs.renameSync(tmp, this.file);
    this.loadedMtime = fs.statSync(this.file).mtimeMs;
  }
}

function keyPrefix(provider: SummaryProvider["kind"], root: string): string {
  return `${provider}::${root}::`;
}

function cacheKey(provider: SummaryProvider["kind"], root: string, target: SummaryTarget): string {
  return keyPrefix(provider, root) + summaryKey(target);
}

function hashOf(request: { system: string; prompt: string }): string {
  return createHash("sha256").update(`${SUMMARY_PROMPT_VERSION}\n${request.system}\n${request.prompt}`).digest("hex");
}
