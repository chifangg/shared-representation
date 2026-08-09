import { useEffect, useState } from "react";
import type { ClaudeMessage } from "@/core/hooks/useClaudeSession";
import type { DiagramBlock } from "../types";
import { blocksForFiles } from "../util/editedBlocks";
import { touchedFilesInLatestTurn } from "../util/chatEdits";

/**
 * While a Claude turn is running, returns the ids of blocks whose files
 * the agent has TOUCHED (read or edited) SO FAR this turn, so the canvas
 * can pulse them blue ("working here"). Clears the instant the turn ends;
 * the settle effect then takes over with the persistent post-edit glow,
 * which stays edit-only (a block merely read this turn stops pulsing and
 * gets no lasting ring).
 *
 * Reading the file counts, not only editing it: a typed-chat turn spends
 * most of its time reading the modules around a hook point before it
 * writes, and often writes a brand-new file that maps to no block at all.
 * Tracking reads makes the pulse move across the diagram in real time
 * (the modules the agent is studying light up), instead of flashing once
 * at the final write or, for a new file, never. This matches the
 * immediate target highlight the visual-edit path already gives.
 *
 * Reads the streaming assistant message live (walking back to the last
 * user turn), so a block lights up the moment its file is touched rather
 * than only after the whole turn settles.
 */
export function useEditingBlocks({
  chatRunning,
  chatMessages,
  blocks,
}: {
  chatRunning: boolean;
  chatMessages: ClaudeMessage[];
  blocks: DiagramBlock[];
}): Set<string> {
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!chatRunning) {
      setEditingIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const files = touchedFilesInLatestTurn(chatMessages);
    const next = blocksForFiles(blocks, files);
    setEditingIds((prev) => (sameSet(prev, next) ? prev : next));
  }, [chatRunning, chatMessages, blocks]);

  return editingIds;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
