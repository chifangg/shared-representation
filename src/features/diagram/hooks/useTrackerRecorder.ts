import { useMemo } from "react";
import { categoryStyle } from "../util/blockCategory";
import {
  linkKey,
  type TrackerChip,
  type TrackerEntry,
} from "./useInteractionTracker";
import type { DiagramDelta } from "./useRecentChanges";

/**
 * Row CONSTRUCTION for the interaction tracker.
 *
 * DiagramCanvas records agent-driven diagram changes at six change points
 * (the regen delta, the chat-driven diagram-op, the three card-execute
 * targets, arrows Claude reported mid-turn, promote / unpromote). Every row
 * uses the same small vocabulary: kind + verb + category-tinted block
 * chip(s) + trace-back block ids. This module owns assembling that shape
 * (chip building, the neutral accent fallback, the dedupe-key formats) so
 * the canvas makes one-line `record*` calls instead of hand-building rows
 * inline at each site.
 *
 * Row POLICY stays in the canvas: WHICH change points record (e.g. the
 * block_level-only gate on card arrows), how targets are resolved against
 * the schema, and the glow calls that surround a record (setRecentChanges,
 * dismissRecentEdit) are canvas concerns, not row construction.
 */

/** Neutral sand accent for a chip whose block has no (recognized)
 *  category, so chips never render un-tinted. The single source for a
 *  fallback that used to be repeated at every construction site. */
const ACCENT_FALLBACK = "#978B77";

/** The slice of a block the recorder needs: a chip label, an optional
 *  category to tint it, and the id to trace back to. Structural on purpose
 *  so DiagramBlock, delta blocks, and promoted blocks all fit. */
type BlockLike = { id: string; label: string; category?: string };

type AddEntry = (
  entry: Omit<TrackerEntry, "id" | "seq">,
  dedupeKey?: string,
) => void;

/** Chip from a known label + (possibly missing) category. */
export function blockChip(label: string, category?: string): TrackerChip {
  return { label, accent: categoryStyle(category)?.accent ?? ACCENT_FALLBACK };
}

/** Chip from a block id resolved against a schema's block list. Falls back
 *  to the raw id as the label when the block is unknown, so a row can still
 *  render for an endpoint that is no longer (or not yet) in the schema. */
export function makeBlockChip(
  blocks: ReadonlyArray<BlockLike>,
  id: string,
): TrackerChip {
  const b = blocks.find((x) => x.id === id);
  return blockChip(b?.label ?? id, b?.category);
}

export type TrackerRecorder = {
  /** One row per element of a regen's structural delta: blocks added /
   *  edited / removed, then arrows linked / unlinked, in that order. Delta
   *  rows carry NO dedupe keys (the delta itself fires once per regen). */
  recordDelta: (delta: DiagramDelta) => void;
  /** A chat-driven recolor. The chip tints to the NEW category (passed
   *  separately from the target, whose own category is the old one). */
  recordRecolor: (target: BlockLike, newCategory: string) => void;
  /** A block leaving the diagram (chat-driven delete, or un-promoting a
   *  detail block back off the canvas). */
  recordRemove: (target: BlockLike) => void;
  /** A card-driven NEW block, recorded at commit time and keyed by the
   *  pending placeholder that is about to become the real block. */
  recordNewBlockAdd: (
    placeholder: { id: string } | undefined,
    optionTitle: string,
  ) => void;
  /** A new arrow between two existing blocks, endpoints resolved against
   *  the given schema blocks. Deduped by direction (linkKey) so a re-report
   *  of the same arrow can never double-count. */
  recordLink: (
    blocks: ReadonlyArray<BlockLike>,
    from: string,
    to: string,
  ) => void;
  /** A card-driven edit of an existing block, recorded at commit time. */
  recordEdit: (block: BlockLike) => void;
  /** A detail block promoted onto the canvas. The category is passed
   *  separately because promoted blocks often inherit the parent's. */
  recordPromote: (
    target: { id: string; label: string },
    category?: string,
  ) => void;
};

/**
 * Recorder bound to one tracker's addEntry. `addEntry` is identity-stable
 * (useInteractionTracker memoizes it with no deps), so the recorder object
 * is too; the canvas can safely list it in useCallback / effect deps (the
 * regen-delta path feeds useRecentChanges' effect through it).
 */
export function useTrackerRecorder(addEntry: AddEntry): TrackerRecorder {
  return useMemo<TrackerRecorder>(
    () => ({
      recordDelta: (delta) => {
        for (const b of delta.addedBlocks) {
          addEntry({
            kind: "add",
            verb: "added",
            chips: [blockChip(b.label, b.category)],
            blockIds: [b.id],
          });
        }
        for (const b of delta.editedBlocks) {
          addEntry({
            kind: "edit",
            verb: "edited",
            chips: [blockChip(b.label, b.category)],
            blockIds: [b.id],
          });
        }
        for (const b of delta.removedBlocks) {
          addEntry({
            kind: "remove",
            verb: "removed",
            chips: [blockChip(b.label, b.category)],
            blockIds: [b.id],
          });
        }
        // Arrow endpoints use the labels/categories the delta already
        // resolved (a removed arrow's blocks may be gone from the schema).
        for (const a of delta.addedArrows) {
          addEntry({
            kind: "link",
            verb: "linked",
            chips: [
              blockChip(a.fromLabel, a.fromCategory),
              blockChip(a.toLabel, a.toCategory),
            ],
            blockIds: [a.from, a.to],
          });
        }
        for (const a of delta.removedArrows) {
          addEntry({
            kind: "unlink",
            verb: "unlinked",
            chips: [
              blockChip(a.fromLabel, a.fromCategory),
              blockChip(a.toLabel, a.toCategory),
            ],
            blockIds: [a.from, a.to],
          });
        }
      },
      recordRecolor: (target, newCategory) => {
        // Verb kept short ("recolored") so it fits the tracker's fixed
        // verb column; the chip is already re-tinted to the new colour.
        addEntry({
          kind: "recolor",
          verb: "recolored",
          chips: [blockChip(target.label, newCategory)],
          blockIds: [target.id],
        });
      },
      recordRemove: (target) => {
        addEntry({
          kind: "remove",
          verb: "removed",
          chips: [blockChip(target.label, target.category)],
          blockIds: [target.id],
        });
      },
      recordNewBlockAdd: (placeholder, optionTitle) => {
        // A brand-new block has no category yet, so the chip takes the
        // neutral accent directly. The dedupe-key format is load-bearing:
        // it is what stops StrictMode's double-fire from recording the
        // same commit twice, falling back to the label when no placeholder
        // was found.
        const label = optionTitle.slice(0, 40);
        addEntry(
          {
            kind: "add",
            verb: "added",
            chips: [{ label, accent: ACCENT_FALLBACK }],
            blockIds: placeholder ? [placeholder.id] : [],
          },
          `add-newblock:${placeholder?.id ?? label}`,
        );
      },
      recordLink: (blocks, from, to) => {
        addEntry(
          {
            kind: "link",
            verb: "linked",
            chips: [makeBlockChip(blocks, from), makeBlockChip(blocks, to)],
            blockIds: [from, to],
          },
          linkKey(from, to),
        );
      },
      recordEdit: (block) => {
        addEntry({
          kind: "edit",
          verb: "edited",
          chips: [blockChip(block.label, block.category)],
          blockIds: [block.id],
        });
      },
      recordPromote: (target, category) => {
        addEntry({
          kind: "promote",
          verb: "promoted",
          chips: [blockChip(target.label, category)],
          blockIds: [target.id],
        });
      },
    }),
    [addEntry],
  );
}
