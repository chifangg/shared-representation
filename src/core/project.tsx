import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import JSZip from "jszip";
import {
  ChevronRight,
  FolderOpen,
  FileArchive,
  FileText,
  Loader2,
  X,
  Palette,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import Editor from "react-simple-code-editor";
import { logEvent, setLogContext } from "@/core/interactionLog";
import { Markdown } from "@/core/components/Markdown";
import {
  clearSyncHandle,
  isFolderSyncSupported,
  pickAndReadFolder,
  syncWrite,
} from "@/core/folderSync";
import { shouldIgnorePath } from "@/core/projectIgnore";
import { getStudyMode } from "@/core/studyMode";

/**
 * Client-side project upload + display, used by the Files and Code
 * panels. The Files panel shows a VSCode-style tree of the uploaded
 * project; clicking a file selects it, which the Code panel renders.
 *
 * Two upload modes:
 *  - folder via `<input webkitdirectory>`
 *  - .zip via JSZip (extracted in the browser, no server round-trip)
 *
 * Files are kept entirely in memory as text — fine for the prototype's
 * target scenario (small research-participant projects). Binary files
 * still load but render as garbled text in the code viewer.
 */

export type FileEntry = {
  /** Path relative to the upload root, e.g. "my-project/src/index.html" */
  path: string;
  name: string;
  content: string;
  size: number;
};

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "folder";
  children: TreeNode[];
};

type ProjectContextValue = {
  files: FileEntry[];
  /** Files currently open as tabs in the Code panel, in tab order. */
  openPaths: string[];
  /** Path of the file whose content is showing in the Code panel. */
  activePath: string | null;
  activeFile: FileEntry | null;
  highlightEnabled: boolean;
  loadFiles: (entries: FileEntry[]) => void;
  /** Open a file (tree click): adds to openPaths if absent + activates. */
  openFile: (path: string) => void;
  /** Switch focus to a file already in openPaths (tab click). */
  setActive: (path: string) => void;
  /** Close a tab. If it was active, the neighbor tab becomes active. */
  closeFile: (path: string) => void;
  /** Replace a file's text content (used by the editable Code panel). */
  updateFileContent: (path: string, content: string) => void;
  /** The user's stated primary goal for this project, verbatim. Used
   *  for prompt context + suggestion generation. */
  goal: string | null;
  setGoal: (text: string | null) => void;
  /** Claude-generated 2–5 word distillation of the goal, shown in the
   *  chat-theme header. Falls back to a truncated goal until the
   *  /api/suggestions response arrives. */
  chatTheme: string | null;
  setChatTheme: (text: string | null) => void;
  toggleHighlight: () => void;
  reset: () => void;
  uploading: boolean;
  setUploading: (v: boolean) => void;
  uploadProgress: number;
  setUploadProgress: (v: number) => void;
  chatMessages: import("@/core/hooks/useClaudeSession").ClaudeMessage[];
  setChatMessages: (
    msgs: import("@/core/hooks/useClaudeSession").ClaudeMessage[],
  ) => void;
  /** True while Claude is mid-turn (between send and stop_reason). Used
   *  by sibling components (diagram) to know when to clear "pending"
   *  visual states on user edits. ChatView is the writer. */
  chatRunning: boolean;
  setChatRunning: (v: boolean) => void;
  /** True while the diagram feature is mid-generation. The chat gates on
   *  it: a turn sent while the structure stream is still landing races
   *  the generation's state machine and wedges the canvas. The diagram
   *  feature is the writer; stays false when the feature never mounts
   *  (baseline condition), so chat is not gated there. */
  diagramBusy: boolean;
  setDiagramBusy: (v: boolean) => void;
  /** Bumps only on USER-initiated project changes (upload, reset). Does
   *  NOT change when Claude edits / writes individual files. Sibling
   *  components (diagram) depend on this to decide when to wipe + reload
   *  their own state, so Claude adding files mid-turn no longer
   *  triggers a full diagram reset. */
  projectKey: number;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Expanded-folder paths for the file tree, kept at MODULE level so
 *  collapsing the Files rail (which unmounts the whole tree) does not
 *  reset what the user opened or closed. Reseeded per upload by
 *  `loadFiles`: root folders start expanded, everything deeper starts
 *  collapsed, so a 400-file repo opens as a short top-level listing
 *  instead of a fully unrolled tree. */
let expandedFolders = new Set<string>();

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [highlightEnabled, setHighlightEnabled] = useState(true);
  const [goal, setGoalState] = useState<string | null>(null);
  const [chatTheme, setChatThemeState] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [chatMessages, setChatMessages] = useState<
    import("@/core/hooks/useClaudeSession").ClaudeMessage[]
  >([]);
  const [chatRunning, setChatRunning] = useState(false);
  const [diagramBusy, setDiagramBusy] = useState(false);
  const [projectKey, setProjectKey] = useState(0);

  // Stamp interaction-log rows with the project boundary (bumps only
  // on user upload/reset, never on Claude's mid-turn writes).
  useEffect(() => {
    setLogContext({ projectKey });
  }, [projectKey]);

  const activeFile = useMemo(
    () => files.find((f) => f.path === activePath) ?? null,
    [files, activePath],
  );

  const loadFiles = useCallback((entries: FileEntry[]) => {
    // The study condition rides with the upload: an upload is the real
    // start of a run, so every run's data is self-describing, and idle
    // page loads leave no trace at all.
    logEvent("study-mode", { mode: getStudyMode() }, "system");
    logEvent("project-upload", {
      fileCount: entries.length,
      totalBytes: entries.reduce((n, f) => n + f.size, 0),
    });
    // Fresh tree state per project: only the root folder(s) open.
    expandedFolders = new Set(entries.map((f) => f.path.split("/")[0]));
    setFiles(entries);
    setOpenPaths([]);
    setActivePath(null);
    setGoalState(null);
    setChatThemeState(null);
    setProjectKey((k) => k + 1);
  }, []);

  const setGoal = useCallback((text: string | null) => {
    setGoalState(text);
    // A new goal needs a new chat-theme; clear any stale title.
    setChatThemeState(null);
  }, []);

  const setChatTheme = useCallback((text: string | null) => {
    setChatThemeState(text);
  }, []);

  const openFile = useCallback((path: string) => {
    logEvent("file-open", { path });
    setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActivePath(path);
  }, []);

  const setActive = useCallback((path: string) => {
    logEvent("code-tab-activate", { path });
    setActivePath(path);
  }, []);

  const closeFile = useCallback((path: string) => {
    logEvent("code-tab-close", { path });
    setOpenPaths((prev) => {
      const idx = prev.indexOf(path);
      if (idx === -1) return prev;
      const next = prev.filter((p) => p !== path);
      // If the closed tab was active, fall back to the same index (next
      // neighbor) or the previous one if that was the last tab.
      setActivePath((curActive) => {
        if (curActive !== path) return curActive;
        return next[idx] ?? next[idx - 1] ?? null;
      });
      return next;
    });
  }, []);

  const updateFileContent = useCallback((path: string, content: string) => {
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      if (idx >= 0) {
        return prev.map((f, i) =>
          i === idx ? { ...f, content, size: content.length } : f,
        );
      }
      // Path doesn't exist yet — let Claude (via write_project_file) or
      // the code editor create new files by writing to a fresh path.
      const name = path.split("/").pop() ?? path;
      return [...prev, { path, name, content, size: content.length }];
    });
    // Mirror to disk when the project was opened with folder sync. This
    // is the single choke point every file mutation flows through
    // (Claude's write/edit tools and the code viewer alike), so syncing
    // here keeps the on-disk clone current for the study's test runner.
    syncWrite(path, content);
  }, []);

  const toggleHighlight = useCallback(() => {
    logEvent("highlight-toggle");
    setHighlightEnabled((v) => !v);
  }, []);

  const reset = useCallback(() => {
    logEvent("project-reset");
    clearSyncHandle();
    setFiles([]);
    setOpenPaths([]);
    setActivePath(null);
    setGoalState(null);
    setChatThemeState(null);
    setProjectKey((k) => k + 1);
  }, []);

  // Memoized: an inline object literal here is a NEW value on every provider
  // render, which invalidates every consumer of this context (the canvas, the
  // chat, the shell) even when nothing they read actually changed.
  const value = useMemo(
    () => ({
      files,
      openPaths,
      activePath,
      activeFile,
      highlightEnabled,
      loadFiles,
      openFile,
      setActive,
      closeFile,
      updateFileContent,
      goal,
      setGoal,
      chatTheme,
      setChatTheme,
      toggleHighlight,
      reset,
      uploading,
      setUploading,
      uploadProgress,
      setUploadProgress,
      chatMessages,
      setChatMessages,
      chatRunning,
      setChatRunning,
      diagramBusy,
      setDiagramBusy,
      projectKey,
    }),
    [
      files,
      openPaths,
      activePath,
      activeFile,
      highlightEnabled,
      loadFiles,
      openFile,
      setActive,
      closeFile,
      updateFileContent,
      goal,
      setGoal,
      chatTheme,
      setChatTheme,
      toggleHighlight,
      reset,
      uploading,
      uploadProgress,
      chatMessages,
      chatRunning,
      diagramBusy,
      projectKey,
    ],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be inside <ProjectProvider>");
  return ctx;
}

// --- upload helpers --------------------------------------------------------

// Ignore rules live in projectIgnore.ts, shared with the folder-sync
// picker without creating a project <-> folderSync import cycle.

async function readFolderInput(
  files: FileList,
  onProgress?: (pct: number) => void,
): Promise<FileEntry[]> {
  const list = Array.from(files).filter((f) => {
    const path =
      (f as File & { webkitRelativePath: string }).webkitRelativePath ||
      f.name;
    return !shouldIgnorePath(path);
  });
  const out: FileEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const text = await f.text().catch(() => "");
    out.push({
      path:
        (f as File & { webkitRelativePath: string }).webkitRelativePath ||
        f.name,
      name: f.name,
      content: text,
      size: f.size,
    });
    onProgress?.(Math.round(((i + 1) / list.length) * 100));
  }
  return out;
}

async function readZipFile(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<FileEntry[]> {
  const zip = await JSZip.loadAsync(file);
  const entries: { path: string; fileObj: JSZip.JSZipObject }[] = [];
  zip.forEach((path, fileObj) => {
    if (fileObj.dir) return;
    if (shouldIgnorePath(path)) return;
    entries.push({ path, fileObj });
  });

  const out: FileEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { path, fileObj } = entries[i];
    const content = await fileObj.async("string");
    out.push({
      path,
      name: path.split("/").pop() || path,
      content,
      size: content.length,
    });
    onProgress?.(Math.round(((i + 1) / entries.length) * 100));
  }
  return out;
}

// --- tree building --------------------------------------------------------

export function buildTree(files: FileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let currentPath = "";
    let parentChildren = roots;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (isLast) {
        parentChildren.push({
          name: part,
          path: currentPath,
          type: "file",
          children: [],
        });
      } else {
        let folder = folderMap.get(currentPath);
        if (!folder) {
          folder = {
            name: part,
            path: currentPath,
            type: "folder",
            children: [],
          };
          folderMap.set(currentPath, folder);
          parentChildren.push(folder);
        }
        parentChildren = folder.children;
      }
    }
  }

  const sortRecursive = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(roots);
  return roots;
}

// --- components ------------------------------------------------------------

export function UploadArea({ compact = false }: { compact?: boolean } = {}) {
  const { loadFiles, uploading, setUploading, setUploadProgress } =
    useProject();

  const onFolder = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    clearSyncHandle();
    // This path has NO write-back handle. Record why the picker path was
    // not available, so a "not synced" session is diagnosable from the
    // log alone (missing API vs insecure origin vs unusual browser).
    logEvent(
      "folder-open-fallback",
      {
        pickerSupported: isFolderSyncSupported(),
        secureContext: window.isSecureContext,
        ua: navigator.userAgent.slice(0, 120),
      },
      "system",
    );
    setUploading(true);
    setUploadProgress(0);
    try {
      const entries = await readFolderInput(e.target.files, setUploadProgress);
      loadFiles(entries);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      e.target.value = "";
    }
  };

  // Folder open through the File System Access picker: same read-in,
  // plus a retained readwrite handle so every subsequent edit mirrors
  // back to disk (see folderSync.ts). Chromium only; the hidden-input
  // path below stays as the fallback for other browsers.
  const onSyncFolder = async () => {
    clearSyncHandle();
    setUploading(true);
    setUploadProgress(0);
    try {
      const entries = await pickAndReadFolder(setUploadProgress);
      if (entries && entries.length > 0) {
        loadFiles(entries);
      } else if (entries === null) {
        // Cancelled or permission denied: no project change, but leave a
        // trace so an aborted arm-sync attempt is visible in the log.
        logEvent("folder-pick-cancelled", {}, "system");
      }
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const onZip = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    clearSyncHandle();
    setUploading(true);
    setUploadProgress(0);
    try {
      const entries = await readZipFile(f, setUploadProgress);
      loadFiles(entries);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      e.target.value = "";
    }
  };

  return (
    <div
      className={
        compact ? "flex flex-col items-center gap-1 pt-2" : "flex flex-col text-xs"
      }
    >
      {isFolderSyncSupported() ? (
        // Picker path: the folder stays connected, and every edit the
        // agent or the user makes is written back to it on disk.
        <UploadButton
          compact={compact}
          icon={<FolderOpen size={compact ? 16 : 14} />}
          label={uploading ? "Loading…" : "open folder"}
          onClick={uploading ? undefined : onSyncFolder}
        >
          {null}
        </UploadButton>
      ) : (
        <UploadButton
          compact={compact}
          icon={<FolderOpen size={compact ? 16 : 14} />}
          label={uploading ? "Loading…" : "open folder"}
        >
          <input
            type="file"
            // @ts-expect-error webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            onChange={onFolder}
            disabled={uploading}
          />
        </UploadButton>
      )}
      {/* Hairline separates the two actions now that neither carries a
          border of its own. Inset so it reads as a rule inside the list,
          not an edge of the panel. Not needed in the rail, where they are
          two spaced icons. */}
      {!compact && <div className="mx-3 h-px bg-[#E4E3DF]" />}
      <UploadButton
        compact={compact}
        icon={<FileArchive size={compact ? 16 : 14} />}
        label={uploading ? "Loading…" : "open .zip"}
      >
        <input
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="hidden"
          onChange={onZip}
          disabled={uploading}
        />
      </UploadButton>
      {/* Loud, up-front browser warning. Without the File System Access
       *  API every edit stays in the browser, which silently breaks the
       *  study's on-disk test runner; a participant must see this BEFORE
       *  uploading, not discover it from a stale test run. */}
      {!isFolderSyncSupported() && !compact && (
        <div className="mx-3 mt-2 rounded-md bg-[#F4E7C8] px-2 py-1.5 text-[11px] leading-snug text-[#6B4E14]">
          This browser cannot write edits back to your folder. Use Google
          Chrome for live file sync.
        </div>
      )}
    </div>
  );
}

export function UploadOverlay() {
  const { uploading, uploadProgress } = useProject();
  if (!uploading) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex w-64 flex-col items-center gap-3 rounded-lg bg-white px-6 py-5 text-[#484848] shadow-xl">
        <Loader2 className="h-8 w-8 animate-spin text-[#484848]" strokeWidth={2} />
        <div className="flex w-full items-baseline justify-between text-sm">
          <span className="font-medium">Loading project…</span>
          <span className="tabular-nums text-[#484848]/70">
            {uploadProgress}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#EAEAEA]">
          <div
            className="h-full bg-[#484848] transition-all duration-150"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Shared pill-button style used by upload + clear-and-reupload buttons
 * in the Files panel.
 *
 * Three layers give a tactile "physical button" feel on the dark panel:
 *  1. Top-to-bottom gradient — the button looks lit from above.
 *  2. Inset top highlight — a 1px white line at the very top edge,
 *     mimicking light catching a raised surface.
 *  3. Soft outer drop shadow — anchors the button to the panel.
 *
 * Hover brightens the gradient; press inverts the shadow + nudges
 * down 1px so it feels mechanical.
 */
// Quiet by default: no fill, no border, no shadow, so it sits flush with the
// panel and only the label reads. The affordance appears on hover as a soft
// darkening of the surface. Uses a black alpha rather than a fixed hex so it
// stays correct whatever the panel colour becomes.
const PILL_BUTTON =
  "px-3 py-2 text-[12px] font-medium leading-none text-[#3A3A38] " +
  "transition-colors duration-150 " +
  "hover:bg-black/[0.06] " +
  "active:bg-black/[0.10]";

function UploadButton({
  icon,
  label,
  children,
  compact = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  /** Rail mode: icon only, label moves to the tooltip. */
  compact?: boolean;
  /** Picker-style actions have no hidden input; the label itself is the
   *  clickable control. */
  onClick?: () => void;
}) {
  if (compact) {
    return (
      <label
        title={label}
        onClick={onClick}
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-[#3A3A38] transition-colors hover:bg-black/[0.06]"
      >
        {icon}
        {children}
      </label>
    );
  }
  return (
    <label
      onClick={onClick}
      className={`${PILL_BUTTON} flex w-full cursor-pointer items-center justify-start gap-2 whitespace-nowrap`}
    >
      {/* Icon sits a step back from the label so the pair reads as one
          designed unit rather than two equal-weight marks. */}
      <span className="flex shrink-0 items-center text-[#9A9993]">{icon}</span>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FileTree() {
  const { files, activePath, openFile, reset } = useProject();
  const tree = useMemo(() => buildTree(files), [files]);

  if (files.length === 0) return null;

  return (
    <div className="flex h-full flex-col text-sm text-[#3A352E]">
      <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
        {tree.map((node) => (
          <TreeNodeView
            key={node.path}
            node={node}
            selectedPath={activePath}
            onSelect={openFile}
            depth={0}
          />
        ))}
      </div>
      <div className="border-t border-[#DEDCD7] p-2">
        <button onClick={reset} className={`${PILL_BUTTON} w-full text-left`}>
          clear files and re-upload
        </button>
      </div>
    </div>
  );
}

function TreeNodeView({
  node,
  selectedPath,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  // Expansion lives in the module-level set (survives the rail closing);
  // the counter only forces this node to re-render after a toggle.
  const [, bump] = useState(0);
  const expanded = expandedFolders.has(node.path);

  if (node.type === "folder") {
    return (
      <div>
        <button
          onClick={() => {
            logEvent("file-tree-folder-toggle", {
              path: node.path,
              expanded: !expanded,
            });
            if (expanded) expandedFolders.delete(node.path);
            else expandedFolders.add(node.path);
            bump((n) => n + 1);
          }}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-black/[0.05]"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && (
          <div>
            {node.children.map((child) => (
              <TreeNodeView
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = node.path === selectedPath;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left ${
        isSelected ? "bg-[#E4E3DF]" : "hover:bg-black/[0.05]"
      }`}
      style={{ paddingLeft: depth * 12 + 17 }}
    >
      <FileText size={12} className="shrink-0 opacity-70" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/**
 * Map a file extension → Prism language name. Anything not in the map
 * falls through to `markup` (close enough for unknown text formats; the
 * highlighter just won't tokenize anything).
 */
const LANGUAGE_BY_EXT: Record<string, Language> = {
  ts: "tsx",
  tsx: "tsx",
  js: "jsx",
  jsx: "jsx",
  mjs: "jsx",
  cjs: "jsx",
  json: "json",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

function languageFromPath(path: string): Language {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "markup";
}

// buildProjectContext moved to @/features/diagram/api/buildProjectContext —
// the diagram is its only caller, and the per-file/total caps are diagram-
// specific. buildChatSystemPrompt below stays in core because it ships the
// core read/write/edit_project_file tool instructions every chat session.

/**
 * Lighter project context for the chat path. Instead of dumping every
 * file's contents up-front (which hits per-file and total caps for
 * realistic-size repos), we hand Claude the file tree only and rely on
 * the `read_project_file` client tool to fetch bodies on demand. This
 * keeps the input small + accurate even for large uploads, and stops
 * the model from confabulating about files it never actually saw.
 */
export function buildChatSystemPrompt(
  files: FileEntry[],
  goal: string | null,
): string {
  const tree = files
    .map((f) => `${f.path}  (${f.size} bytes)`)
    .sort()
    .join("\n");
  const goalBlock = goal
    ? `\n\n<user_goal>\n${goal}\n</user_goal>`
    : "";

  return [
    "You are a code-explanation and code-editing assistant for a project the user uploaded into the browser.",
    "",
    "Below is the full file tree of the uploaded project. You have these file tools:",
    "  • `read_project_file(path)` — fetch a file's full contents.",
    "  • `edit_project_file(path, old_string, new_string, replace_all?)` — replace one substring with another in place. PREFERRED for small edits — much faster than rewriting the whole file.",
    "  • `write_project_file(path, content)` — overwrite a file (or create a new one) with the given full body. Use only for new files or when changing most of a file.",
    "",
    "Rules:",
    "  1. To inspect a file, call `read_project_file` with one of the listed paths exactly. Do NOT guess at file contents.",
    "  2. Every path you read or write MUST begin with one of the top-level folders listed in <project_tree>. Never use `../`, absolute paths, or paths outside that tree. The only files that exist are the ones in <project_tree> — anything else (your harness source, this assistant's own UI, etc.) is unreachable and irrelevant.",
    "  3. Only edit after the user has clearly asked for a change. Never edit speculatively.",
    "  4. Always `read_project_file` an existing file before editing it. For `edit_project_file`, `old_string` must match the file exactly (including indentation) and must be unique — include a few surrounding lines as context if needed.",
    "  5. PREFER `edit_project_file` whenever the change touches less than roughly half the file. Reserve `write_project_file` for creating new files or full rewrites — re-emitting a 30KB body for a 1-line change wastes ~15 seconds per edit.",
    "  6. AVOID `replace_all=true` unless old_string is long and unambiguous (a full identifier of 20+ chars, a multi-word phrase, or a unique snippet). Short common strings (e.g. `server.`, `name`, `this.`, `client.`) will hit unrelated log strings, comments, and other identifiers and silently corrupt the file. The safe default is multiple targeted edit_project_file calls, each with surrounding context to be unique. The tool will refuse short+broad replace_all to prevent this footgun.",
    "  7. After a successful change, summarize what changed in 1–2 sentences. Do not paste the new file back in chat.",
    "  8. Do NOT call any other tool. There are no shell, search, weather, or flight tools — ignore memories of those from other sessions.",
    "",
    "Be concise. Read only the files you actually need. Ground explanations in concrete function names from what you read.",
    "",
    `<project_tree count="${files.length}">`,
    tree,
    "</project_tree>",
    goalBlock,
  ]
    .filter((s) => s !== "")
    .join("\n");
}


/**
 * Editable code area. Uses react-simple-code-editor to overlay a
 * transparent textarea on top of a prism-react-renderer highlighted
 * `<pre>`, so the user gets syntax-highlighted text + a real text
 * cursor. Edits are written back to the project state via
 * updateFileContent so switching tabs preserves changes.
 */
export function CodeViewer() {
  const { activeFile, highlightEnabled, updateFileContent } = useProject();
  // One code-edit log per typing burst; raw keystrokes are noise.
  const codeEditLogTimer = useRef<number | null>(null);
  const code = activeFile?.content ?? "";
  const lang = languageFromPath(activeFile?.path ?? "");
  const isMd = (activeFile?.path ?? "").toLowerCase().endsWith(".md");
  // Rendered-vs-source for markdown files; back to rendered whenever the
  // active file changes, so each .md opens readable first.
  const [mdSource, setMdSource] = useState(false);
  useEffect(() => {
    setMdSource(false);
  }, [activeFile?.path]);

  // Tokenizing a whole file is expensive, and `Editor` calls `highlight` on
  // EVERY render, including every frame of a panel drag. Memoize the rendered
  // tokens against the content so a resize reuses them instead of
  // re-highlighting the file. These hooks also have to sit above the early
  // return below, which they previously did not.
  const highlighted = useMemo(() => {
    if (!highlightEnabled) return code;
    return (
      <Highlight code={code} language={lang} theme={themes.github}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </>
        )}
      </Highlight>
    );
  }, [code, lang, highlightEnabled]);
  const highlight = useCallback(() => highlighted, [highlighted]);

  if (!activeFile) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[#8A8175]">
        Select a file from the Files panel
      </div>
    );
  }

  // Markdown files open in a RENDERED reading view by default: task
  // briefs, READMEs and docs are what participants actually read here,
  // and raw markdown source was hard enough to read that people fell
  // back to the terminal. The toggle drops to the plain editor for the
  // rare case of actually editing one.
  if (isMd && !mdSource) {
    return (
      <div className="relative h-full overflow-y-auto bg-white">
        <button
          type="button"
          onClick={() => setMdSource(true)}
          className="absolute right-3 top-2 z-10 rounded-md border border-[#DDD9D0] bg-white/90 px-2 py-0.5 text-[11px] text-[#6E6353] shadow-sm transition-colors hover:bg-[#F5F2EC]"
        >
          view source
        </button>
        <Markdown className="px-6 py-5">{activeFile.content}</Markdown>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-auto bg-[#FAFAF9]">
      {isMd && (
        <button
          type="button"
          onClick={() => setMdSource(false)}
          className="sticky left-[calc(100%-7rem)] top-2 z-10 rounded-md border border-[#DDD9D0] bg-white/90 px-2 py-0.5 text-[11px] text-[#6E6353] shadow-sm transition-colors hover:bg-[#F5F2EC]"
        >
          view rendered
        </button>
      )}
      <Editor
        value={activeFile.content}
        onValueChange={(value) => {
          updateFileContent(activeFile.path, value);
          if (codeEditLogTimer.current !== null) {
            window.clearTimeout(codeEditLogTimer.current);
          }
          const path = activeFile.path;
          codeEditLogTimer.current = window.setTimeout(() => {
            logEvent("code-edit", { path });
          }, 1500);
        }}
        highlight={highlight}
        padding={12}
        tabSize={2}
        insertSpaces
        textareaClassName="outline-none"
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.65,
          minHeight: "100%",
          color: "#3A352E",
          caretColor: "#3A352E",
        }}
      />
    </div>
  );
}

/**
 * Tabs for files currently open in the Code panel. Active tab matches
 * the panel-body color so it visually merges with the code area below
 * (VSCode metaphor: "this tab is the body").
 */
export function CodeTabs() {
  const { openPaths, activePath, setActive, closeFile, files } = useProject();

  if (openPaths.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center px-3 text-sm text-[#8A8175]">
        no file open
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-end gap-px overflow-x-auto">
      {openPaths.map((path) => {
        const file = files.find((f) => f.path === path);
        const name = file?.name ?? path.split("/").pop() ?? path;
        const isActive = path === activePath;
        const onClose = (e: MouseEvent) => {
          e.stopPropagation();
          closeFile(path);
        };
        return (
          <button
            key={path}
            onClick={() => setActive(path)}
            title={path}
            className={`group flex h-9 max-w-44 shrink-0 items-center gap-2 rounded-t-md px-4 text-sm ${
              isActive
                ? "bg-[#FAFAF9] text-[#2B2B29]"
                : "bg-[#E0DFDB] text-[#6E6D68] hover:bg-[#EAE9E6] hover:text-[#2B2B29]"
            }`}
          >
            <span className="truncate">{name}</span>
            <span
              role="button"
              onClick={onClose}
              className="-mr-1.5 flex h-5 w-5 items-center justify-center rounded text-[#8A8175] hover:bg-black/[0.08] hover:text-[#3A352E]"
            >
              <X size={13} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HighlightToggle() {
  const { highlightEnabled, toggleHighlight } = useProject();
  return (
    <button
      onClick={toggleHighlight}
      title={
        highlightEnabled
          ? "Disable syntax highlighting"
          : "Enable syntax highlighting"
      }
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors ${
        highlightEnabled
          ? "bg-black/[0.06] text-[#3A352E]"
          : "text-[#8A8175] hover:bg-black/[0.05] hover:text-[#3A352E]"
      }`}
    >
      <Palette size={14} />
    </button>
  );
}
