/**
 * Builds the question the post-turn search nudge asks on the user's behalf.
 *
 * After a code-editing turn the diagram knows exactly which blocks changed,
 * but the user still has to invent a question before search can help them.
 * This turns the former into the latter, so understanding the change is one
 * click instead of one blank input.
 *
 * It is built from the edited block LABELS, not from the agent's closing
 * prose (`editSummary.text`). That prose is long, unstructured and often
 * about the mechanics of the edit rather than the architecture, which makes
 * a poor search query; the labels are the exact vocabulary the diagram and
 * the search backend already share.
 *
 * Pure function, no React, no side effects.
 */

/** More than this many named blocks and the query stops being a question
 *  and starts being a list. The rest are folded into a count. */
const MAX_NAMED = 2;

/** Guard against a pathological label (a whole sentence as a block name)
 *  blowing up the query. Matches nothing in practice. */
const MAX_LABEL = 60;

function clean(label: string): string {
  const t = label.trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL).trimEnd()}...` : t;
}

/**
 * @param labels Block labels touched by the just-finished turn, in the
 *   order `editSummary.blocks` reports them.
 * @returns A natural-language question, or "" when there is nothing worth
 *   asking about. Callers treat "" as "show no nudge".
 */
export function buildNudgeQuery(labels: string[]): string {
  const named = labels
    .map(clean)
    .filter((l) => l.length > 0)
    .filter((l, i, all) => all.indexOf(l) === i);

  if (named.length === 0) return "";
  if (named.length === 1) {
    return `How does ${named[0]} work, and what does it connect to?`;
  }
  if (named.length === 2) {
    return `How do ${named[0]} and ${named[1]} fit together after this change?`;
  }

  const rest = named.length - MAX_NAMED;
  const others = rest === 1 ? "1 other block" : `${rest} other blocks`;
  return `How do ${named[0]}, ${named[1]} and ${others} fit together after this change?`;
}
