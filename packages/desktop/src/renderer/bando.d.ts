import type { CodeGraph } from "@bando/core/types";

import type { SummaryTarget } from "@bando/core/targets";

export type SummaryResult = { text: string; model: string; stale?: boolean } | { error: string };

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
      onSummaryDelta(callback: (delta: { key: string; text: string }) => void): () => void;
      onProgress(callback: (message: string) => void): () => void;
    };
  }
}

export {};
