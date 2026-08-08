/**
 * Live write-back from the in-browser project to the folder it was
 * opened from, via the File System Access API (Chromium browsers).
 *
 * Why this exists: the project lives in browser memory, so Claude's
 * edits (and the user's own code-viewer edits) never touched the real
 * files on disk. For the user study that is fatal: the task runner
 * executes each task's test suite against the participant's local
 * clone, which must therefore always hold the latest edits.
 *
 * Shape: opening a folder through `pickAndReadFolder` both reads the
 * project in (same FileEntry shape as the older `<input
 * webkitdirectory>` path) and RETAINS the directory handle with
 * readwrite permission. From then on every `updateFileContent` call
 * (the single choke point all file mutations flow through) mirrors the
 * new content to disk. Writes are debounced per path (the code viewer
 * fires per keystroke) and serialized on one promise chain so two
 * writers can never interleave on the same file.
 *
 * The handle is page-lifetime state: it cannot be serialized, so a
 * reload drops sync until the user re-opens the folder. Zip uploads
 * and non-Chromium browsers simply never get a handle; everything then
 * behaves exactly as before this module existed.
 *
 * The reverse direction exists too, as a pull rather than a watch:
 * `readFolderDelta` re-enumerates the connected folder and reports how
 * disk differs from the in-browser project. The study's task runner
 * rewrites files on disk at every stage transition (next brief and
 * test suite decrypted in place, old ones removed), and without a pull
 * the participant would have to re-upload the whole project each time.
 */

import type { FileEntry } from "@/core/project";
import { shouldIgnorePath } from "@/core/projectIgnore";
import { logEvent } from "@/core/interactionLog";

// Minimal ambient surface for the File System Access API pieces used
// here. TypeScript's lib.dom does not yet ship all of them.
type FSWritable = {
  write(data: string): Promise<void>;
  close(): Promise<void>;
};
type FSFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FSWritable>;
};
type FSDirHandle = {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, FSDirHandle | FSFileHandle]>;
  getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FSDirHandle>;
  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FSFileHandle>;
};

let rootHandle: FSDirHandle | null = null;
/** All disk writes ride one chain, so writes to the same file can never
 *  interleave (two open writables on one file corrupt it). */
let writeChain: Promise<void> = Promise.resolve();
/** Per-path debounce timers: last content within the window wins. */
const pendingTimers = new Map<string, number>();
const DEBOUNCE_MS = 300;

export function isFolderSyncSupported(): boolean {
  return (
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
    "function"
  );
}

/** Whether a connected folder is currently receiving writes. */
export function hasSyncHandle(): boolean {
  return rootHandle !== null;
}

/** Drop the handle (project reset, or a non-sync upload replacing the
 *  project). Pending debounced writes for the old project are cancelled. */
export function clearSyncHandle(): void {
  rootHandle = null;
  for (const t of pendingTimers.values()) window.clearTimeout(t);
  pendingTimers.clear();
}

async function collectFiles(
  dir: FSDirHandle,
  prefix: string,
  out: { path: string; handle: FSFileHandle }[],
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (shouldIgnorePath(path)) continue;
    if (handle.kind === "directory") {
      await collectFiles(handle, path, out);
    } else {
      out.push({ path, handle });
    }
  }
}

/**
 * Open the OS folder picker with readwrite permission, read the project
 * in, and retain the handle for write-back. Returns null when the API
 * is unsupported or the user cancels the picker; the caller falls back
 * to the plain upload paths.
 */
export async function pickAndReadFolder(
  onProgress?: (pct: number) => void,
): Promise<FileEntry[] | null> {
  if (!isFolderSyncSupported()) return null;
  let dir: FSDirHandle;
  try {
    dir = await (
      window as unknown as {
        showDirectoryPicker(opts: { mode: string }): Promise<FSDirHandle>;
      }
    ).showDirectoryPicker({ mode: "readwrite" });
  } catch {
    // Cancelled or permission denied: not an error, just no sync.
    return null;
  }

  // Two passes: enumerate first (fast), then read with real progress.
  const handles: { path: string; handle: FSFileHandle }[] = [];
  await collectFiles(dir, dir.name, handles);
  const out: FileEntry[] = [];
  for (let i = 0; i < handles.length; i++) {
    const { path, handle } = handles[i];
    let text = "";
    try {
      text = await (await handle.getFile()).text();
    } catch {
      // Unreadable (binary, locked): keep an empty body like the old path.
    }
    out.push({
      path,
      name: path.split("/").pop() ?? path,
      content: text,
      size: text.length,
    });
    onProgress?.(Math.round(((i + 1) / handles.length) * 100));
  }

  rootHandle = dir;
  writeChain = Promise.resolve();
  logEvent("folder-sync-connected", { fileCount: out.length });
  return out;
}

/** How the connected folder differs from the in-browser project.
 *  `changed` carries the new disk content for paths whose browser copy
 *  differs; the caller re-checks content at apply time so a concurrent
 *  agent write is never clobbered by a stale read. */
export type DiskDelta = {
  added: FileEntry[];
  changed: FileEntry[];
  removedPaths: string[];
};

/**
 * Re-read the connected folder and diff it against the in-browser
 * project. Returns null when no folder is connected or the read fails.
 * Paths with a pending (debounced, not yet flushed) write are skipped
 * in both directions: for those, the browser is ahead of disk, so the
 * disk copy is stale by construction.
 */
export async function readFolderDelta(
  current: FileEntry[],
): Promise<DiskDelta | null> {
  const root = rootHandle;
  if (!root) return null;
  const handles: { path: string; handle: FSFileHandle }[] = [];
  try {
    await collectFiles(root, root.name, handles);
  } catch (e) {
    logEvent(
      "folder-refresh-failed",
      { error: String(e).slice(0, 120) },
      "system",
    );
    return null;
  }
  const browser = new Map(current.map((f) => [f.path, f]));
  const diskPaths = new Set<string>();
  const added: FileEntry[] = [];
  const changed: FileEntry[] = [];
  for (const { path, handle } of handles) {
    diskPaths.add(path);
    if (pendingTimers.has(path)) continue;
    let text: string;
    try {
      text = await (await handle.getFile()).text();
    } catch {
      // Unreadable right now (binary, locked): leave the browser copy.
      continue;
    }
    const existing = browser.get(path);
    if (!existing) {
      added.push({
        path,
        name: path.split("/").pop() ?? path,
        content: text,
        size: text.length,
      });
    } else if (existing.content !== text) {
      changed.push({ ...existing, content: text, size: text.length });
    }
  }
  const removedPaths = current
    .filter((f) => !diskPaths.has(f.path) && !pendingTimers.has(f.path))
    .map((f) => f.path);
  return { added, changed, removedPaths };
}

async function writeToDisk(path: string, content: string): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  try {
    const parts = path.split("/").filter(Boolean);
    // Project paths carry the root folder name as their first segment
    // (matching the webkitRelativePath convention); the handle IS that
    // root, so strip it. Defensively keep paths that lack the prefix.
    if (parts[0] === root.name) parts.shift();
    if (parts.length === 0) return;
    let dir = root;
    for (const seg of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], {
      create: true,
    });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  } catch (e) {
    logEvent(
      "sync-write-failed",
      { path, error: String(e).slice(0, 120) },
      "system",
    );
    console.warn("folder sync write failed:", path, e);
  }
}

/**
 * Mirror one file's new content to disk. Fire-and-forget: failures log
 * and never block the UI. No-op when no folder is connected.
 */
export function syncWrite(path: string, content: string): void {
  if (rootHandle === null) return;
  const prev = pendingTimers.get(path);
  if (prev !== undefined) window.clearTimeout(prev);
  pendingTimers.set(
    path,
    window.setTimeout(() => {
      pendingTimers.delete(path);
      writeChain = writeChain.then(() => writeToDisk(path, content));
    }, DEBOUNCE_MS),
  );
}
