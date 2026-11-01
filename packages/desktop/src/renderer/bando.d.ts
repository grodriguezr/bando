import type { CodeGraph } from "@bando/core/types";

export type SummaryResult = { text: string; stale?: boolean } | { error: string };

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
      /** Summary previously generated for the file, if any; `stale` if the file changed since. */
      cachedSummary(fileId: string): Promise<SummaryResult | undefined>;
      /** Generates a module summary with Claude, streaming text through onSummaryDelta. */
      generateSummary(fileId: string): Promise<SummaryResult>;
      onSummaryDelta(callback: (delta: { fileId: string; text: string }) => void): () => void;
      onProgress(callback: (message: string) => void): () => void;
    };
  }
}

export {};
