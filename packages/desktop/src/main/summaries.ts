import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CodeGraph } from "@bando/core/types";
import {
  DEFAULT_LOCAL_URL,
  describeSummaryError,
  type SummaryProvider,
  type SummaryTarget,
} from "@bando/core/summarize";
import { defaultConcurrency, SummaryStore, type SummarizeAllEvent } from "@bando/core/summary-store";
import { exportDocs, type ExportDocsResult } from "@bando/core/docs";

export type ProviderKind = SummaryProvider["kind"];

export interface AiSettings {
  provider: ProviderKind;
  /** OpenAI-compatible endpoint for the local provider. */
  localUrl: string;
  /** Empty: use the first chat model the server offers. */
  localModel: string;
}

export type SummaryResult = { text: string; model: string; stale?: boolean } | { error: string };

/** State of the "summarize everything" job, as shown in the UI. */
export type JobStatus =
  | { running: false; last?: { done: number; total: number; failed: number; stopped: boolean; error?: string } }
  | {
      running: true;
      done: number;
      total: number;
      failed: number;
      current?: SummaryTarget;
      startedAt: number;
      stopping: boolean;
    };

const DEFAULT_SETTINGS: AiSettings = { provider: "anthropic", localUrl: DEFAULT_LOCAL_URL, localModel: "" };

/**
 * The desktop side of summaries: user settings (which provider), the shared on-disk store
 * (also used by the CLI) and the background job that summarizes the whole project.
 */
export class SummaryService {
  private readonly store = new SummaryStore();
  private readonly settingsFile = path.join(app.getPath("userData"), "settings.json");
  private settingsCache: AiSettings | undefined;
  private job: JobStatus = { running: false };
  private stopRequested = false;

  constructor(
    private readonly events: {
      delta(target: SummaryTarget, text: string): void;
      job(status: JobStatus): void;
      summarized(target: SummaryTarget): void;
    },
  ) {}

  async settings(): Promise<AiSettings> {
    if (!this.settingsCache) {
      let saved: Partial<AiSettings> = {};
      try {
        saved = JSON.parse(await fs.readFile(this.settingsFile, "utf8")) as Partial<AiSettings>;
      } catch {
        // First run.
      }
      this.settingsCache = { ...DEFAULT_SETTINGS, ...saved };
    }
    return this.settingsCache;
  }

  async updateSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
    if (this.job.running && patch.provider) throw new Error("No se puede cambiar de proveedor mientras se resume todo");
    this.settingsCache = { ...(await this.settings()), ...patch };
    await fs.writeFile(this.settingsFile, JSON.stringify(this.settingsCache, null, 2));
    return this.settingsCache;
  }

  async cached(graph: CodeGraph, target: SummaryTarget): Promise<SummaryResult | undefined> {
    const { provider } = await this.settings();
    return this.store.cached(graph, target, provider);
  }

  async generate(graph: CodeGraph, target: SummaryTarget, onText: (delta: string) => void): Promise<SummaryResult> {
    try {
      const result = await this.store.generate(graph, target, { provider: await this.provider(), onText });
      this.events.summarized(target);
      return result;
    } catch (error) {
      return { error: describeSummaryError(error) };
    }
  }

  /** Writes the Markdown docs with every summary stored for the current provider. */
  async exportDocs(graph: CodeGraph, outDir: string): Promise<ExportDocsResult> {
    const { provider } = await this.settings();
    return exportDocs(graph, { outDir, summaries: this.store.known(graph.root, provider) });
  }

  jobStatus(): JobStatus {
    return this.job;
  }

  /** Starts summarizing every file, folder and the guide. Returns immediately; progress arrives as events. */
  async startJob(graph: CodeGraph): Promise<JobStatus> {
    if (this.job.running) return this.job;
    const provider = await this.provider();
    this.stopRequested = false;
    this.setJob({ running: true, done: 0, total: 0, failed: 0, startedAt: Date.now(), stopping: false });

    let lastError: string | undefined;
    const onEvent = (event: SummarizeAllEvent) => {
      if (!this.job.running) return;
      if (event.type === "start") this.setJob({ ...this.job, total: event.total });
      else if (event.type === "progress")
        this.setJob({ ...this.job, done: event.done, current: event.target, failed: event.failed });
      else if (event.type === "summarized") {
        if (event.error) lastError = event.error;
        else this.events.summarized(event.target);
      } else {
        this.setJob({ running: false, last: { ...event, error: lastError } });
      }
    };
    void this.store
      .summarizeAll(graph, {
        provider,
        concurrency: defaultConcurrency(provider),
        onEvent,
        onText: (target, text) => this.events.delta(target, text),
        shouldStop: () => this.stopRequested,
      })
      .catch((error: unknown) => {
        this.setJob({
          running: false,
          last: { done: 0, total: 0, failed: 1, stopped: true, error: describeSummaryError(error) },
        });
      });
    return this.job;
  }

  stopJob(): void {
    this.stopRequested = true;
    if (this.job.running) this.setJob({ ...this.job, stopping: true });
  }

  private setJob(status: JobStatus): void {
    this.job = status;
    this.events.job(status);
  }

  private async provider(): Promise<SummaryProvider> {
    const settings = await this.settings();
    return settings.provider === "local"
      ? { kind: "local", baseUrl: settings.localUrl, model: settings.localModel || undefined }
      : { kind: "anthropic" };
  }
}
