import { useRef, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
} from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
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

export function AppShell() {
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [showFileCode, setShowFileCode] = useState(true);
  const [animating, setAnimating] = useState(false);

  // Default layout: diagram dominates but every other panel still has
  // enough width to show its native content (file-tree buttons, code
  // viewer header, chat input placeholder). Diagram lands at ~58%, chat
  // at 16% → 1 : 3.6, close to the requested 1:4 spirit without
  // amputating the supporting panels.
  const lastLayoutRef = useRef({
    files: 10,
    code: 16,
    chat: 16,
    diagram: 58,
  });

  const toggle = () => {
    logEvent("panels-toggle", { show: !showFileCode });
    setAnimating(true);
    if (showFileCode) {
      const layout = groupRef.current?.getLayout() ?? {};
      lastLayoutRef.current = {
        files: layout["files"] ?? 12,
        code: layout["code"] ?? 30,
        chat: layout["chat"] ?? 28,
        diagram: layout["diagram"] ?? 30,
      };
      const remaining =
        100 - 0 - 0;
      const chatRatio =
        lastLayoutRef.current.chat /
        (lastLayoutRef.current.chat + lastLayoutRef.current.diagram);
      groupRef.current?.setLayout({
        files: 0,
        code: 0,
        chat: remaining * chatRatio,
        diagram: remaining * (1 - chatRatio),
      });
    } else {
      groupRef.current?.setLayout({
        files: lastLayoutRef.current.files,
        code: lastLayoutRef.current.code,
        chat: lastLayoutRef.current.chat,
        diagram: lastLayoutRef.current.diagram,
      });
    }
    setShowFileCode((v) => !v);
    window.setTimeout(() => setAnimating(false), 320);
  };

  return (
    <div
      className={`relative flex h-screen flex-col text-[#484848] ${
        animating ? "panels-animating" : ""
      }`}
    >
      <UploadOverlay />
      <header className="border-b border-[#888787]/40 bg-[#D6CFC2] px-4 py-4 text-sm font-medium">
        Share Representative Tool Webpage
      </header>

      <Group
        groupRef={groupRef}
        orientation="horizontal"
        className="flex-1"
      >
        <Panel id="files" collapsible collapsedSize={0} defaultSize={10} minSize={8}>
          <FilesPanel />
        </Panel>
        <ResizeHandle />

        <Panel id="code" collapsible collapsedSize={0} defaultSize={16} minSize={12}>
          <CodePanel onHide={toggle} />
        </Panel>
        <ResizeHandle />

        <Panel id="chat" defaultSize={20} minSize={14}>
          <ChatView />
        </Panel>
        <ResizeHandle />

        <Panel id="diagram" defaultSize={54} minSize={30}>
          <DiagramPanel />
        </Panel>
      </Group>

      {!showFileCode && (
        <button
          type="button"
          onClick={toggle}
          className="absolute left-0 top-1/2 z-40 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-[#484848]/20 bg-white/90 text-[#484848] shadow-md hover:bg-white"
          title="Show files & code"
        >
          <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function ResizeHandle() {
  return (
    <Separator className="w-px bg-white transition-colors hover:w-1 hover:bg-white/70 data-[dragging=true]:w-1 data-[dragging=true]:bg-white/70" />
  );
}

const HEADER_BASE =
  "flex h-11 items-center border-b px-3 text-sm font-medium";
const LIGHT_HEADER = `${HEADER_BASE} bg-[#DFDEDE]/90 text-[#484848] border-[#484848]/30`;

function FilesPanel() {
  const { files } = useProject();
  return (
    <div className="flex h-full flex-col bg-[#565656] text-white">
      <div className="flex h-11 items-center border-b border-white/30 bg-[#888888]/90 px-3 text-sm font-medium">
        Files
      </div>
      <div className="min-h-0 flex-1">
        {files.length === 0 ? <UploadArea /> : <FileTree />}
      </div>
    </div>
  );
}

function CodePanel({ onHide }: { onHide: () => void }) {
  return (
    <div className="flex h-full flex-col bg-[#292929] text-white">
      <div className="flex h-11 items-center gap-2 border-b border-white/30 bg-[#888888] px-2 text-sm font-medium">
        <CodeTabs />
        <div className="ml-auto flex items-center gap-1">
          <HighlightToggle />
          <button
            type="button"
            onClick={onHide}
            className="flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 hover:text-white"
            title="Hide files & code"
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
  return (
    <div className="flex h-full flex-col bg-[#E6E6E6] text-[#484848]">
      <div className={`${LIGHT_HEADER} justify-between gap-3`}>
        <span className="shrink-0">Diagram Block</span>
        <div
          ref={setHeaderSlot}
          className="flex min-w-0 flex-1 items-center justify-center"
        />
      </div>
      <div className="min-h-0 flex-1">
        <DiagramCanvas
          view={view}
          onViewChange={setView}
          headerSlot={headerSlot}
        />
      </div>
    </div>
  );
}
