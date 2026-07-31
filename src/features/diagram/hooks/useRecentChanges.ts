import {
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { BlockCategory, FetchState } from "../types";
import { blocksForFiles } from "../util/editedBlocks";
import { dlog } from "../util/debug";

export type RecentChanges = {
  blockIds: Set<string>;
  arrowKeys: Set<string>;
};

export type PreRegenSnapshot = {
  blockIds: Set<string>;
  arrowKeys: Set<string>;
  /** Ids of blocks whose FILES Claude edited this turn (even though the
   *  block itself already existed). The post-regen diff only finds NEW
   *  blocks, so these are carried separately and unioned in, so an
   *  edit-in-place still glows the block that changed. */
  editedBlockIds: Set<string>;
  /** Pre-regen block id -> label/category/files. Lets the delta NAME a block
   *  that disappears in the regen (its label is gone from the new schema),
   *  and recognise a re-keyed-but-same block (same category + overlapping
   *  files) so an LLM relabel doesn't read as a real remove + add. */
  blockMeta: Map<
    string,
    { label: string; category?: BlockCategory; files: string[] }
  >;
  /** Files Claude edited this turn. Re-mapped against the POST-regen schema
   *  (whose provenance is freshly derived) to find which existing block was
   *  edited, since the pre-regen provenance often doesn't list the shared
   *  file that was touched. */
  editedFiles: string[];
};

export type DeltaBlock = { id: string; label: string; category?: BlockCategory };
export type DeltaArrow = {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  fromCategory?: BlockCategory;
  toCategory?: BlockCategory;
};

/** The structural change one agent regen made to the diagram, in diagram
 *  terms. `editedBlocks` are existing blocks whose files Claude touched,
 *  detected against the POST-regen provenance (reliable even when the
 *  pre-regen provenance didn't list the shared file). The interaction tracker
 *  consumes this via `onDelta`. For a NO-regen card edit there's no delta, so
 *  those "edited" rows come from the settle effect's editSummary instead. */
export type DiagramDelta = {
  addedBlocks: DeltaBlock[];
  removedBlocks: DeltaBlock[];
  editedBlocks: DeltaBlock[];
  addedArrows: DeltaArrow[];
  removedArrows: DeltaArrow[];
};

/**
 * Owns the `recentChanges` state — the set of block ids / arrow keys
 * that should glow on the canvas to highlight what Claude added in
 * the most recent turn.
 *
 * Watches `state.kind === "ready"` transitions. When the prior auto-
 * regen left a snapshot in `preRegenSnapshotRef`, diff it against the
 * fresh schema and flag whatever's new.
 *
 * The settle-effect also writes via `setRecentChanges` when card-
 * driven flows commit (no regen) — both writers share the state, but
 * only this hook owns the diff-on-ready effect.
 *
 * `recentChanges` is cleared by the caller (via setRecentChanges(null)
 * in dismissRecentEdit) on the next user action; per UX feedback the
 * glow persists until the user looks away.
 */
export function useRecentChanges({
  state,
  preRegenSnapshotRef,
  onDelta,
}: {
  state: FetchState;
  preRegenSnapshotRef: MutableRefObject<PreRegenSnapshot | null>;
  /** Called once per regen with the structural delta (added / removed
   *  blocks + arrows), so the interaction tracker can record each change.
   *  Fires even when only removals happened (which the glow ignores). */
  onDelta?: (delta: DiagramDelta) => void;
}): {
  recentChanges: RecentChanges | null;
  setRecentChanges: Dispatch<SetStateAction<RecentChanges | null>>;
} {
  const [recentChanges, setRecentChanges] = useState<RecentChanges | null>(
    null,
  );

  useEffect(() => {
    if (state.kind !== "ready") return;
    if (!preRegenSnapshotRef.current) return;
    const snap = preRegenSnapshotRef.current;
    preRegenSnapshotRef.current = null;
    const newBlockIds = new Set<string>();
    for (const b of state.schema.blocks) {
      if (b.pending) continue;
      if (!snap.blockIds.has(b.id)) newBlockIds.add(b.id);
    }
    // Carry over blocks Claude edited in place (same id, existed before):
    // the diff above can't see them, but the user still wants the block
    // that changed to glow.
    for (const id of snap.editedBlockIds) {
      if (state.schema.blocks.some((b) => b.id === id && !b.pending)) {
        newBlockIds.add(id);
      }
    }
    const newArrowKeys = new Set<string>();
    for (const a of state.schema.arrows) {
      if (a.pending) continue;
      const key = `${a.from}->${a.to}`;
      if (!snap.arrowKeys.has(key)) newArrowKeys.add(key);
    }

    // Structural delta for the interaction tracker: added / removed blocks +
    // arrows, in diagram terms. Edited blocks are intentionally excluded here
    // (the settle effect's editSummary records those, and also catches
    // no-regen edits), so we never double-count an edit.
    if (onDelta) {
      const currentById = new Map(
        state.schema.blocks.filter((b) => !b.pending).map((b) => [b.id, b]),
      );
      const nameOf = (id: string) =>
        currentById.get(id)?.label ?? snap.blockMeta.get(id)?.label ?? id;
      const catOf = (id: string) =>
        currentById.get(id)?.category ?? snap.blockMeta.get(id)?.category;
      // Raw added / removed carry files so a re-keyed-but-same block (the LLM
      // gave the same capability a fresh id across the regen) can be spotted.
      type Raw = DeltaBlock & { files: string[] };
      const addedRaw: Raw[] = [];
      for (const b of currentById.values()) {
        if (!snap.blockIds.has(b.id) && !snap.editedBlockIds.has(b.id)) {
          addedRaw.push({
            id: b.id,
            label: b.label,
            category: b.category,
            files: b.provenance?.files ?? [],
          });
        }
      }
      const removedRaw: Raw[] = [];
      for (const id of snap.blockIds) {
        if (!currentById.has(id)) {
          const m = snap.blockMeta.get(id);
          removedRaw.push({
            id,
            label: m?.label ?? id,
            category: m?.category,
            files: m?.files ?? [],
          });
        }
      }
      // Coalesce: a removed + added pair sharing a category AND at least one
      // provenance file is almost certainly the SAME capability whose id
      // churned across the regen (ids are label-derived and the structure view
      // isn't anchored to the old schema). Drop both so an LLM relabel doesn't
      // surface as a spurious remove + add. (A genuine rename is suppressed
      // too; surfacing those needs the backend to preserve ids.)
      const matchedAdded = new Set<string>();
      const matchedRemoved = new Set<string>();
      for (const r of removedRaw) {
        const rf = new Set(r.files);
        const a = addedRaw.find(
          (x) =>
            !matchedAdded.has(x.id) &&
            x.category === r.category &&
            x.files.some((f) => rf.has(f)),
        );
        if (a) {
          matchedAdded.add(a.id);
          matchedRemoved.add(r.id);
        }
      }
      const strip = (b: Raw): DeltaBlock => ({
        id: b.id,
        label: b.label,
        category: b.category,
      });
      const addedBlocks: DeltaBlock[] = addedRaw
        .filter((b) => !matchedAdded.has(b.id))
        .map(strip);
      const removedBlocks: DeltaBlock[] = removedRaw
        .filter((b) => !matchedRemoved.has(b.id))
        .map(strip);
      const currentArrowKeys = new Set(
        state.schema.arrows
          .filter((a) => !a.pending)
          .map((a) => `${a.from}->${a.to}`),
      );
      const addedArrows: DeltaArrow[] = [];
      for (const a of state.schema.arrows) {
        if (a.pending) continue;
        if (snap.arrowKeys.has(`${a.from}->${a.to}`)) continue;
        addedArrows.push({
          from: a.from,
          to: a.to,
          fromLabel: nameOf(a.from),
          toLabel: nameOf(a.to),
          fromCategory: catOf(a.from),
          toCategory: catOf(a.to),
        });
      }
      const removedArrows: DeltaArrow[] = [];
      for (const key of snap.arrowKeys) {
        if (currentArrowKeys.has(key)) continue;
        const [from, to] = key.split("->");
        removedArrows.push({
          from,
          to,
          fromLabel: nameOf(from),
          toLabel: nameOf(to),
          fromCategory: catOf(from),
          toCategory: catOf(to),
        });
      }
      // Edited existing blocks. Three sources, unioned + de-duped by id, so a
      // real edit shows exactly one "edited" row even when block ids churn
      // across the regen (ids are label-derived) or provenance is spotty:
      //   1. POST-regen file mapping for blocks that existed before (non-churn).
      //   2. Re-keyed edits: a COALESCED added block (its id churned) that also
      //      owns an edited file. Without this a churned edit-in-place records
      //      nothing (coalescing drops it from added/removed; #1 misses it
      //      because the new id isn't in the snapshot).
      //   3. PRE-regen fallback: blocks the settle effect already mapped,
      //      still present by the same id, in case the post-regen provenance
      //      dropped a file the pre-regen one had.
      const editedIds = new Set<string>();
      if (snap.editedFiles.length > 0) {
        const hitIds = blocksForFiles(
          state.schema.blocks.filter((b) => !b.pending),
          snap.editedFiles,
        );
        for (const id of hitIds) {
          if (snap.blockIds.has(id) || matchedAdded.has(id)) editedIds.add(id);
        }
      }
      for (const id of snap.editedBlockIds) {
        if (currentById.has(id)) editedIds.add(id);
      }
      const editedBlocks: DeltaBlock[] = [];
      for (const id of editedIds) {
        const b = currentById.get(id);
        if (b) {
          editedBlocks.push({ id: b.id, label: b.label, category: b.category });
        }
      }
      if (
        addedBlocks.length ||
        removedBlocks.length ||
        editedBlocks.length ||
        addedArrows.length ||
        removedArrows.length
      ) {
        onDelta({
          addedBlocks,
          removedBlocks,
          editedBlocks,
          addedArrows,
          removedArrows,
        });
      }
    }

    dlog("recent-debug:diff effect fired", {
      snapBlockIds: Array.from(snap.blockIds),
      snapArrowKeys: Array.from(snap.arrowKeys),
      currentBlockIds: state.schema.blocks
        .filter((b) => !b.pending)
        .map((b) => b.id),
      currentArrowKeys: state.schema.arrows
        .filter((a) => !a.pending)
        .map((a) => `${a.from}->${a.to}`),
      newBlockIds: Array.from(newBlockIds),
      newArrowKeys: Array.from(newArrowKeys),
    });
    if (newBlockIds.size === 0 && newArrowKeys.size === 0) return;
    setRecentChanges({ blockIds: newBlockIds, arrowKeys: newArrowKeys });
    // No auto-dismiss. Per user feedback the "just edited" highlight
    // should persist until they take the NEXT action — that way they
    // can scan the diagram at leisure and see exactly what Claude
    // changed. dismissRecentEdit (in DiagramCanvasInner) wipes it on
    // any user mutation handler.
  }, [state, preRegenSnapshotRef, onDelta]);

  return { recentChanges, setRecentChanges };
}
