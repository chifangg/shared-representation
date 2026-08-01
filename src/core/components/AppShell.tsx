import { useCallback, useEffect, useRef, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
} from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen, FolderTree } from "lucide-react";
import { logEvent } from "@/core/interactionLog";
import { ChatView } from "@/core/components/ChatView";
import {
  CodeTabs,
  CodeViewer,
  FileTree,
  HighlightToggle,
  UploadArea,
  UploadOverlay,
  useProject,
} from "@/core/project";
import { DiagramCanvas, type DiagramView } from "@/features/diagram";

/**
 * LAYOUT NOTE, learned the hard way: dragging a separator used to lag the
 * pointer by roughly half a second. It was narrowed by bisection against a
 * known-smooth build to TWO causes, both of which are avoided below:
 *
 *   1. Conditionally rendering a <Panel>. Mounting and unmounting a panel
 *      makes the group register/unregister it and re-normalise every size
 *      (the defaultSizes no longer summed to 100 either). Collapse a panel to
 *      `collapsedSize={0}` instead of removing it from the tree.
 *   2. Calling useProject() HERE. It makes the shell a context consumer, so
 *      any project state change re-renders it, which rebuilds the <ChatView />
 *      and <DiagramPanel /> elements and re-renders both subtrees. Each panel
 *      subscribes to what it needs itself.
 *
 * Things that were WRONGLY blamed first and are provably fine: the Files rail
 * living outside the group, absolute positioning, event frequency, and CSS
 * containment. Restructuring is fine; just keep 1 and 2 in mind.
 */
export function AppShell() {
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [animating, setAnimating] = useState(false);
  // Mirrors whether the code column currently exists. Set ONLY on the
  // open/shut transition (by CodeColumnAutoSize), not on every project change,
  // so this stays a rare re-render rather than a per-message one.
  const [codeOpen, setCodeOpen] = useState(false);

  // Deliberately NO useProject() here. Subscribing the shell to the project
  // context makes it a consumer, so any project state change re-renders it and
  // rebuilds the <ChatView /> and <DiagramPanel /> elements, re-rendering both
  // whole subtrees. Panels that need project state subscribe themselves.

  // Briefly enable the width transition so the code column glides open and
  // shut. Fires only on that transition, never during a drag.
  const handleCodeTransition = useCallback((open: boolean) => {
    setCodeOpen(open);
    setAnimating(true);
    window.setTimeout(() => setAnimating(false), 320);
  }, []);

  const railW = filesExpanded ? RAIL_W_OPEN : RAIL_W;
  const codeW = codeOpen ? CODE_W : 0;

  return (
    <div
      className={`relative flex h-screen flex-col text-[#484848] ${
        animating ? "panels-animating" : ""
      }`}
    >
      <UploadOverlay />
      <CodeColumnAutoSize onTransition={handleCodeTransition} />

      <div className="relative min-h-0 flex-1">
        {/* Rail and code column are BOTH positioned absolutely, outside the
         *  resizable group. The code column is not a Panel at all: as a Panel
         *  it always kept a separator that could be dragged, and every attempt
         *  to neutralise that (collapsedSize, minSize 0, a dead handle) still
         *  let it be pulled open. Out of the group there is simply nothing to
         *  grab, so "no file open" really means "not there". */}
        <FilesRail
          expanded={filesExpanded}
          onToggle={() => setFilesExpanded((v) => !v)}
        />

        <div
          className="absolute inset-y-0 z-10 overflow-hidden transition-[left,width] duration-200 ease-out"
          style={{ left: railW, width: codeW }}
        >
          <CodePanel />
        </div>

        <div
          className="h-full transition-[margin] duration-200 ease-out"
          style={{ marginLeft: railW + codeW }}
        >
          <Group
            groupRef={groupRef}
            orientation="horizontal"
            className="h-full"
          >
            <Panel id="chat" defaultSize={38} minSize={14}>
              <ChatView />
            </Panel>
            <ResizeHandle />

            <Panel id="diagram" defaultSize={62} minSize={30}>
              <DiagramPanel />
            </Panel>
          </Group>
        </div>
      </div>
    </div>
  );
}

/**
 * Files as a slim icon rail. Collapsed it is just the two upload actions (or a
 * browse affordance once a project is loaded); expanding slides it out to the
 * full tree. It subscribes to the project context ITSELF rather than taking
 * the data as a prop from AppShell, so a file change re-renders only this rail.
 */
function FilesRail({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { files } = useProject();
  return (
    <div
      className={`absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden border-r border-[#C9C8C3] bg-[#F2F1EF] text-[#2B2B29] transition-[width] duration-200 ease-out ${
        expanded ? "w-60" : "w-12"
      }`}
    >
      <div
        className={`flex h-11 shrink-0 items-center border-b border-[#C9C8C3] bg-[#DCDBD6] text-sm font-medium text-[#33322F] ${
          expanded ? "justify-between px-3" : "justify-center"
        }`}
      >
        {expanded && <span className="truncate">Files</span>}
        <button
          type="button"
          onClick={onToggle}
          title={expanded ? "Collapse files" : "Expand files"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#6E6D68] transition-colors hover:bg-black/[0.06] hover:text-[#33322F]"
        >
          {expanded ? (
            <PanelLeftClose className="h-4 w-4" strokeWidth={2} />
          ) : (
            <PanelLeftOpen className="h-4 w-4" strokeWidth={2} />
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {files.length === 0 ? (
          <UploadArea compact={!expanded} />
        ) : expanded ? (
          <FileTree />
        ) : (
          <button
            type="button"
            onClick={onToggle}
            title={`${files.length} files loaded. Expand to browse.`}
            className="mx-auto mt-2 flex h-9 w-9 items-center justify-center rounded-md text-[#3A3A38] transition-colors hover:bg-black/[0.06]"
          >
            <FolderTree className="h-4 w-4" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Rail widths in px. MUST match the w-12 / w-60 classes on FilesRail. */
const RAIL_W = 48;
const RAIL_W_OPEN = 240;
/** Width of the code column while a file is open. */
const CODE_W = 380;

/**
 * Drives the code column open when a file is opened and shut again when the
 * last one is closed. Renders NOTHING: it exists so that the subscription to
 * the project context lives in a component whose re-render is free, instead
 * of in AppShell, where it would rebuild the chat and diagram subtrees on
 * every project state change (including every chat message).
 */
function CodeColumnAutoSize({
  onTransition,
}: {
  onTransition: (open: boolean) => void;
}) {
  const { openPaths } = useProject();
  const open = openPaths.length > 0;
  const prevRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevRef.current === open) return;
    const isFirstRun = prevRef.current === null;
    prevRef.current = open;
    // Only real transitions get logged, and as "system": this is the code
    // column auto-sizing after a file open/close (both logged as user
    // events themselves). Logging the first run made every REMOUNT of this
    // helper stamp a phantom show:false, which flooded the event log in
    // same-second bursts.
    if (!isFirstRun) {
      logEvent("panels-toggle", { show: open }, "system");
    }
    onTransition(open);
  }, [open, onTransition]);
  return null;
}

/**
 * The element is 4px wide for a comfortable grab target, but the line you SEE
 * is a 1px pseudo-element centred inside it. Hover changes only that line's
 * colour: growing the separator itself on hover would relayout the whole group
 * every time the pointer crossed it.
 */
function ResizeHandle() {
  return (
    <Separator className="relative w-1 bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[#DEDCD7] before:transition-colors before:content-[''] hover:before:bg-[#B9B7B1]" />
  );
}

const HEADER_BASE =
  "flex h-11 items-center border-b px-3 text-sm font-medium";
// One near-white surface + a header band a step deeper, shared by all four
// columns, so the shell reads as calm and uncoloured. Content supplies colour.
const PANEL = "flex h-full flex-col bg-[#F2F1EF] text-[#2B2B29]";
const PANEL_HEADER = `${HEADER_BASE} bg-[#DCDBD6] text-[#33322F] border-[#C9C8C3]`;

function CodePanel() {
  // Subscribes itself rather than taking these from AppShell, so closing a
  // file re-renders only this panel. Closing every open file is what shuts
  // the column: CodeColumnAutoSize notices and collapses it.
  const { openPaths, closeFile } = useProject();
  return (
    <div className={PANEL}>
      <div className={`${PANEL_HEADER} gap-2 px-2`}>
        <CodeTabs />
        <div className="ml-auto flex items-center gap-1">
          <HighlightToggle />
          <button
            type="button"
            onClick={() => {
              for (const p of [...openPaths]) closeFile(p);
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-[#6E6D68] transition-colors hover:bg-black/[0.06] hover:text-[#33322F]"
            title="Close code panel"
          >
            <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <CodeViewer />
      </div>
    </div>
  );
}

function DiagramPanel() {
  const [view, setView] = useState<DiagramView>("overview");
  // Mount point for the diagram feature's intent chip. The chip lives in
  // the feature (it owns the state) and portals itself here so it sits in
  // the header chrome instead of floating over the canvas. Callback ref so
  // a re-render fires once the slot element exists.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  // Right-aligned slot the diagram feature portals its interaction-tracker
  // button into, so it sits in the header chrome (above the canvas + panel).
  const [headerRightSlot, setHeaderRightSlot] = useState<HTMLElement | null>(
    null,
  );
  return (
    <div className={PANEL}>
      {/* relative z-30 so the intent chip's popover can hang below the header
       *  and still paint over the canvas (a later sibling in the flow). */}
      <div className={`${PANEL_HEADER} relative z-30 justify-between gap-3`}>
        <span className="shrink-0">Diagram Block</span>
        <div
          ref={setHeaderSlot}
          className="flex min-w-0 flex-1 items-center justify-start"
        />
        <div ref={setHeaderRightSlot} className="flex shrink-0 items-center" />
      </div>
      <div className="min-h-0 flex-1">
        <DiagramCanvas
          view={view}
          onViewChange={setView}
          headerSlot={headerSlot}
          headerRightSlot={headerRightSlot}
        />
      </div>
    </div>
  );
}
