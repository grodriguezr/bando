import type { CodeGraph } from "@bando/core/types";

import type { SummaryTarget } from "@bando/core/targets";
import type { ExportDocsResult } from "@bando/core/docs";

export type SummaryResult = { text: string; model: string; stale?: boolean } | { error: string };

export type AskResult = { text: string; model: string; sources: string[] } | { error: string };

/** State of the "summarize everything" job. */
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

export interface AiSettings {
  provider: "anthropic" | "local";
  localUrl: string;
  localModel: string;
}

/** API exposed by preload.cjs. */
declare global {
  interface Window {
    bando: {
      openProject(): Promise<CodeGraph | undefined>;
      reanalyze(): Promise<CodeGraph | undefined>;
      /** The project already open in the main process, if any (e.g. after reloading the window). */
      currentProject(): Promise<CodeGraph | undefined>;
      readFile(relativePath: string): Promise<string>;
      /** Fired when the app was launched with a project path. */
      onProjectEvent(
        callback: (
          event: { type: "loading" } | { type: "loaded"; graph: CodeGraph } | { type: "error"; message: string },
        ) => void,
      ): () => void;
      getAiSettings(): Promise<AiSettings>;
      setAiSettings(patch: Partial<AiSettings>): Promise<AiSettings>;
      /** Summary previously generated for the target, if any; `stale` if what it was based on changed. */
      cachedSummary(target: SummaryTarget): Promise<SummaryResult | undefined>;
      /** Generates a summary with the configured provider, streaming text through onSummaryDelta. */
      generateSummary(target: SummaryTarget): Promise<SummaryResult>;
      /** `key` is the target's summaryKey: "file:<id>", "folder:<dir>" or "project". */
      /** Asks for a folder and writes the Markdown docs there; undefined if cancelled. */
      exportDocs(): Promise<ExportDocsResult | undefined>;
      /** Answers a question about the open project; the text streams through onAskDelta with the same id. */
      ask(id: string, question: string): Promise<AskResult>;
      onAskDelta(callback: (delta: { id: string; text: string }) => void): () => void;
      getJobStatus(): Promise<JobStatus>;
      /** Summarizes every file, then every folder, then the guide, in the background. */
      startJob(): Promise<JobStatus>;
      /** Stops after the summary in progress. */
      stopJob(): Promise<void>;
      onJob(callback: (status: JobStatus) => void): () => void;
      /** A summary was stored (by a manual request or by the job). */
      onSummaryUpdated(callback: (event: { key: string }) => void): () => void;
      onSummaryDelta(callback: (delta: { key: string; text: string }) => void): () => void;
      onProgress(callback: (message: string) => void): () => void;
    };
  }
}

export {};
