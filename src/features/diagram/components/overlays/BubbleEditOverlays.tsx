import type { DiagramBlock } from "../../types";
import type { FileEntry } from "@/core/project";
import type { BubbleDetailTarget } from "../../hooks/useBubbleEditOverlays";
import { CapabilityDetailCard } from "./CapabilityDetailCard";

/**
 * Renders the bubble-drill-in capability detail card when one is open.
 *
 * Pure presentation and wiring. The open/close state lives in
 * useBubbleEditOverlays; the code-write dispatch is handed back through
 * onConfirmDetail so this component stays free of the bus.
 */
export function BubbleEditOverlays({
  blocks,
  files,
  detail,
  settled,
  onCloseDetail,
  onConfirmDetail,
}: {
  blocks: DiagramBlock[];
  files: FileEntry[];
  detail: BubbleDetailTarget | null;
  /** True once the open zoom-out has finished, so the card may draw itself. */
  settled: boolean;
  onCloseDetail: () => void;
  onConfirmDetail: (
    blockId: string,
    instruction: string,
    summary: string,
  ) => void;
}) {
  if (!detail) return null;
  const block = blocks.find((b) => b.id === detail.blockId);
  if (!block) return null;
  const detailFiles = (block.provenance?.files ?? [])
    .map((p) => files.find((f) => f.path === p))
    .filter((f): f is NonNullable<typeof f> => !!f)
    .map((f) => ({ path: f.path, content: f.content }));
  return (
    <CapabilityDetailCard
      key={`${detail.blockId}:${detail.functionName}`}
      functionName={detail.functionName}
      displayLabel={detail.displayLabel}
      blockLabel={block.label}
      files={detailFiles}
      anchor={{
        fx: detail.fx,
        fy: detail.fy,
        r: detail.r,
        dirX: detail.dirX,
        dirY: detail.dirY,
      }}
      settled={settled}
      onClose={onCloseDetail}
      onConfirm={(instruction, summary) =>
        onConfirmDetail(detail.blockId, instruction, summary)
      }
    />
  );
}
