import { folderOf } from "./targets.js";

/** The project root is the folder ".". */
export const ROOT = ".";

/** Below this many visible items, the default view keeps opening folders even past its budget. */
const MIN_VISIBLE = 8;

export interface FolderInfo {
  path: string;
  /** Last segment: "pages" for "src/pages". */
  name: string;
  parent?: string;
  folders: string[];
  /** Files directly inside, not in subfolders. */
  files: string[];
  /** Files anywhere below. */
  totalFiles: number;
}

/**
 * The project's folders as a tree, built from file paths. Unlike `listFolders`, it includes
 * folders that only contain other folders (like "src" in "src/pages/a.tsx").
 */
export class FolderTree {
  readonly folders = new Map<string, FolderInfo>();

  constructor(fileIds: Iterable<string>) {
    this.ensure(ROOT);
    for (const file of fileIds) {
      const folder = this.ensure(folderOf(file));
      folder.files.push(file);
      for (
        let f: FolderInfo | undefined = folder;
        f;
        f = f.parent === undefined ? undefined : this.folders.get(f.parent)
      ) {
        f.totalFiles++;
      }
    }
    for (const folder of this.folders.values()) {
      folder.folders.sort();
      folder.files.sort();
    }
  }

  get(path: string): FolderInfo | undefined {
    return this.folders.get(path);
  }

  /** ".", "src", "src/pages" for "src/pages/clientes". */
  ancestors(path: string): string[] {
    const chain: string[] = [];
    for (let f = this.folders.get(path); f?.parent !== undefined; f = this.folders.get(f.parent))
      chain.unshift(f.parent);
    return chain;
  }

  /**
   * What stands for a file when only the `expanded` folders are open: the file itself if all its
   * folders are open, otherwise the outermost closed folder containing it.
   */
  representative(fileId: string, expanded: ReadonlySet<string>): string {
    const folder = folderOf(fileId);
    for (const path of [...this.ancestors(folder), folder]) {
      if (!expanded.has(path)) return path;
    }
    return fileId;
  }

  /**
   * Opens folders from the root, shallowest first, while the number of visible items stays within
   * `budget`. Folders with a single item open for free, and a project never starts as a lone
   * "src/" node however big that folder is.
   */
  defaultExpanded(budget = 25): Set<string> {
    const expanded = new Set<string>([ROOT]);
    let visible = this.childCount(ROOT);
    const queue = this.bySize(this.get(ROOT)!.folders);
    while (queue.length) {
      const path = queue.shift()!;
      const cost = this.childCount(path) - 1; // the folder's node is replaced by its children
      // Over budget, unless almost nothing is visible yet: a lone "src/" node explains nothing.
      if (visible + cost > budget && visible >= Math.min(MIN_VISIBLE, budget)) continue;
      expanded.add(path);
      visible += cost;
      queue.push(...this.bySize(this.get(path)!.folders));
    }
    return expanded;
  }

  /** Bigger folders first: they're the ones worth looking into. */
  private bySize(paths: string[]): string[] {
    return [...paths].sort((a, b) => this.get(b)!.totalFiles - this.get(a)!.totalFiles);
  }

  private childCount(path: string): number {
    const folder = this.get(path)!;
    return folder.folders.length + folder.files.length;
  }

  private ensure(path: string): FolderInfo {
    const existing = this.folders.get(path);
    if (existing) return existing;
    const parentPath = path === ROOT ? undefined : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT;
    const folder: FolderInfo = {
      path,
      name: path === ROOT ? ROOT : path.slice(path.lastIndexOf("/") + 1),
      parent: parentPath,
      folders: [],
      files: [],
      totalFiles: 0,
    };
    this.folders.set(path, folder);
    if (parentPath !== undefined) this.ensure(parentPath).folders.push(path);
    return folder;
  }
}
