/**
 * Past diagram searches, so a question asked ten minutes ago can be
 * reopened instead of retyped and re-paid for.
 *
 * Deliberately IN MEMORY ONLY. History lives in React state and dies with
 * the page: a reload is a clean slate. Persisting it would leak one
 * participant's questions into the next session on the same machine, and
 * a study run should not silently inherit the previous run's trail.
 *
 * Entries are keyed by BLOCK LABEL, never by block id. Ids are regenerated
 * every time the diagram rebuilds, so an entry saved before a regen would
 * point at nothing afterwards; labels survive renames of everything except
 * the block itself. An entry whose blocks have since disappeared is still
 * KEPT: the question and the answer it got are a record of what the person
 * was trying to understand, which stays interesting even once the diagram
 * has moved on. It is marked unresolvable and offered a regenerate.
 */

import type { DiagramBlock } from "../types";

/** One past search, in the durable label-keyed form. */
export type SearchHistoryEntry = {
  /** The question as typed. Also the de-dupe key, normalized. */
  query: string;
  /** Epoch ms, for ordering and the relative timestamp on the row. */
  at: number;
  answer: string;
  missing: boolean;
  hits: { label: string; why: string; order: number }[];
  path: { fromLabel: string; toLabel: string }[];
};

/** How many searches to keep. Long enough to cover a task, short enough
 *  that the list stays scannable without its own search. */
const CAP = 10;

const norm = (q: string) => q.trim().toLowerCase();

/**
 * Prepend `entry`, drop any earlier entry with the same question, and cap.
 * Re-asking a question moves it to the top rather than adding a duplicate:
 * people re-run the same search as the code changes, and a list of eight
 * copies of one question is not a history.
 */
export function pushHistory(
  existing: SearchHistoryEntry[],
  entry: SearchHistoryEntry,
): SearchHistoryEntry[] {
  return [
    entry,
    ...existing.filter((e) => norm(e.query) !== norm(entry.query)),
  ].slice(0, CAP);
}

/**
 * How much of a stored entry still exists in the current diagram.
 *
 * Drives the row's state in the history list: `kept === total` reopens
 * cleanly, anything less is shown as partially or wholly outdated with a
 * regenerate button, and the entry itself is never removed.
 */
export function historyEntryStatus(
  entry: SearchHistoryEntry,
  blocks: DiagramBlock[],
): { kept: number; total: number; outdated: boolean } {
  const labels = new Set(blocks.map((b) => b.label));
  const total = entry.hits.length;
  const kept = entry.hits.filter((h) => labels.has(h.label)).length;
  return { kept, total, outdated: kept < total };
}

/**
 * Re-resolve a stored entry against the CURRENT schema.
 *
 * Returns ids for the blocks that still exist under the same label, the
 * path edges whose both ends survived, and how many hits were lost. A
 * non-zero `dropped` is what flips the tray's outdated banner, so the user
 * can tell a partially-recovered answer from a fresh one and regenerate if
 * they want the current truth.
 */
export function resolveHistoryEntry(
  entry: SearchHistoryEntry,
  blocks: DiagramBlock[],
): {
  hits: { blockId: string; label: string; why: string; order: number }[];
  path: { from: string; to: string }[];
  dropped: number;
} {
  const idByLabel = new Map(blocks.map((b) => [b.label, b.id]));

  const hits = entry.hits
    .map((h) => {
      const id = idByLabel.get(h.label);
      return id ? { blockId: id, label: h.label, why: h.why, order: h.order } : null;
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)
    // Renumber so a recovered path reads 1..n with no gaps where a block
    // was dropped.
    .map((h, i) => ({ ...h, order: i + 1 }));

  const alive = new Set(hits.map((h) => h.blockId));
  const path = entry.path
    .map((e) => ({
      from: idByLabel.get(e.fromLabel),
      to: idByLabel.get(e.toLabel),
    }))
    .filter((e): e is { from: string; to: string } =>
      Boolean(e.from && e.to && alive.has(e.from!) && alive.has(e.to!)),
    );

  return { hits, path, dropped: entry.hits.length - hits.length };
}

/** "just now" / "4m ago" / "2h ago" for the row's timestamp. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
