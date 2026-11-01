import type { CodeGraph } from "@bando/core/types";

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
      onProgress(callback: (message: string) => void): () => void;
    };
  }
}

export {};
