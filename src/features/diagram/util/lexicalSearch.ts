/**
 * Tier 0 of diagram search: an instant, purely client-side substring
 * match over the schema the canvas already holds.
 *
 * This exists for one reason: the semantic pass (tier 1) costs a network
 * round trip, and the moment people search is precisely while they are
 * waiting on the agent, so an empty panel for a second reads as broken.
 * Tier 0 paints on the first keystroke and is replaced by the semantic
 * result when it lands.
 *
 * It is deliberately dumb. No stemming, no fuzzy distance, no ranking
 * model: it matches whole query tokens against the text the user can
 * already see (name, summary, capabilities) plus file paths, and scores
 * by where the hit landed. Anything cleverer belongs in tier 1, which has
 * an actual model behind it.
 *
 * Pure function, no React, no side effects.
 */

import type { DiagramBlock } from "../types";

export type LexicalHit = {
  blockId: string;
  /** Higher is better. Only meaningful relative to hits from the same query. */
  score: number;
  /** Which field carried the strongest match, for the "matched on" hint. */
  field: "name" | "summary" | "capability" | "file";
};

/** Never flood the tray from a one-letter query. */
const MAX_LEXICAL_HITS = 12;
/** Below this length a query matches nearly everything, so match nothing. */
const MIN_QUERY_LEN = 2;

/** Field weights. A name match is worth far more than a file-path match:
 *  paths contain a lot of incidental words ("src", "index", "utils"). */
const WEIGHT = { name: 10, summary: 4, capability: 5, file: 2 } as const;

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_QUERY_LEN);
}

/** Count of query tokens present in `text`, plus a bonus when the text
 *  starts with one (a prefix hit usually means the token IS the subject). */
function hitScore(text: string | undefined, tokens: string[]): number {
  if (!text) return 0;
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) continue;
    n += 1;
    if (hay.startsWith(t)) n += 0.5;
  }
  return n;
}

export function lexicalSearch(
  blocks: DiagramBlock[],
  query: string,
): LexicalHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: LexicalHit[] = [];
  for (const b of blocks) {
    const perField = {
      name: hitScore(b.label, tokens) * WEIGHT.name,
      summary: hitScore(b.caption, tokens) * WEIGHT.summary,
      capability:
        hitScore((b.capabilities ?? []).join(" "), tokens) * WEIGHT.capability,
      file: hitScore((b.provenance?.files ?? []).join(" "), tokens) * WEIGHT.file,
    };
    const score =
      perField.name + perField.summary + perField.capability + perField.file;
    if (score <= 0) continue;
    // Report the strongest field so the row can say what it matched on.
    const field = (Object.keys(perField) as (keyof typeof perField)[]).reduce(
      (best, k) => (perField[k] > perField[best] ? k : best),
      "name" as keyof typeof perField,
    );
    hits.push({ blockId: b.id, score, field });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_LEXICAL_HITS);
}
