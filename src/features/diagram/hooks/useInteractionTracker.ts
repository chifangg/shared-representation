import { useCallback, useEffect, useRef, useState } from "react";

/** The diagram-level shape of an agent change. Deliberately NOT file-level:
 *  the tracker speaks the diagram's language (blocks / arrows / bubbles).
 *  "remove" / "unlink" name things that no longer exist, so their rows are
 *  not trace-back targets (nothing on the canvas to highlight). */
export type TrackerKind =
  | "add"
  | "edit"
  | "remove"
  | "recolor"
  | "promote"
  | "link"
  | "unlink";

/** One block pill in a row, tinted to its category accent (same visual
 *  vocabulary as the chat's DiagramActionEntry chips). */
export type TrackerChip = { label: string; accent: string };

export type TrackerEntry = {
  id: string;
  /** 1-based step number shown in the tray. */
  seq: number;
  kind: TrackerKind;
  /** Short phrase for what happened, e.g. "edited", "recolored to Data". */
  verb: string;
  /** Block pill(s) shown in the row. Usually one; two for a relationship. */
  chips: TrackerChip[];
  /** Block ids to trace-highlight on the canvas when the row is clicked. */
  blockIds: string[];
  /** Present when the change was scoped to a single capability bubble, so a
   *  click can also open + ring that bubble (wired in a later phase). */
  bubble?: { blockId: string; capability: string };
};

/** What the canvas should currently trace-highlight, set from a clicked row.
 *  A camera + ring cue only; selecting a step never changes diagram state. */
export type TracedStep = {
  blockIds: string[];
  bubble?: { blockId: string; capability: string };
} | null;

/** Dedupe keys for relationship rows. Defined HERE so producers and the
 *  paired-release logic in addEntry agree on one format. */
export const linkKey = (from: string, to: string) => `link:${from}->${to}`;
export const unlinkKey = (from: string, to: string) => `unlink:${from}->${to}`;

/**
 * Session-scoped store for the interaction tracker: the ordered list of
 * agent-driven diagram changes plus which row is currently selected for
 * trace-back.
 *
 * Producers call `addEntry` at the existing change points (the settle
 * effect, the recolor / delete diagram-op, promote); the tray renders
 * `entries`. This is intra-diagram state, so it stays a local hook rather
 * than a bus topic (the bus is for chat <-> diagram coordination). Resets
 * on USER-initiated project change (projectKey).
 */
export function useInteractionTracker(projectKey: number): {
  entries: TrackerEntry[];
  selectedId: string | null;
  addEntry: (entry: Omit<TrackerEntry, "id" | "seq">, dedupeKey?: string) => void;
  select: (id: string | null) => void;
} {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const seqRef = useRef(0);
  const idRef = useRef(0);
  // Keys already recorded, so an effect that re-runs (e.g. StrictMode's
  // double-invoke) doesn't append the same change twice.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setEntries([]);
    setSelectedId(null);
    seqRef.current = 0;
    idRef.current = 0;
    seenRef.current = new Set();
  }, [projectKey]);

  const addEntry = useCallback(
    (entry: Omit<TrackerEntry, "id" | "seq">, dedupeKey?: string) => {
      if (dedupeKey) {
        if (seenRef.current.has(dedupeKey)) return;
        seenRef.current.add(dedupeKey);
      }
      // The guard exists to stop the SAME change registering twice (e.g.
      // StrictMode re-running an effect), not to stop a pair from genuinely
      // recurring: recording an unlink releases the matching link key (and
      // vice versa), so A->B re-linked after an unlink still records a row
      // instead of being eaten by a session-lifetime key.
      if (entry.blockIds.length === 2) {
        const [from, to] = entry.blockIds;
        if (entry.kind === "unlink") {
          seenRef.current.delete(linkKey(from, to));
        } else if (entry.kind === "link") {
          seenRef.current.delete(unlinkKey(from, to));
        }
      }
      seqRef.current += 1;
      idRef.current += 1;
      const seq = seqRef.current;
      const id = `trk-${idRef.current}`;
      setEntries((prev) => [...prev, { ...entry, id, seq }]);
    },
    [],
  );

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  return { entries, selectedId, addEntry, select };
}
