/**
 * Client for `POST /api/diagram-search` (read-only, tier 1).
 *
 * Sends the diagram schema and a natural-language question, gets back an
 * ordered reading path. Deliberately sends NO file contents: the answer
 * lives at the diagram's altitude, which keeps the request small and keeps
 * the result stable while the agent rewrites files underneath.
 *
 * The response carries block IDS only. Labels, captions and file paths are
 * resolved by the caller from the schema it already holds, so the model has
 * no channel through which to invent a file path.
 */

import type { ApiResponse } from "@/core/apiAdapter";
import type { DiagramSchema } from "../types";

export type SearchHit = {
  block_id: string;
  why: string;
  order: number;
};

export type SearchPathEdge = { from: string; to: string };

export type DiagramSearchResult = {
  answer: string;
  hits: SearchHit[];
  path: SearchPathEdge[];
  /** Nothing in the diagram answers the question. Render the answer as an
   *  explanation rather than showing an empty result list. */
  missing: boolean;
};

export async function searchDiagram({
  query,
  schema,
  signal,
}: {
  query: string;
  schema: DiagramSchema;
  signal?: AbortSignal;
}): Promise<DiagramSearchResult> {
  const resp = await fetch("/api/diagram-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      query,
      blocks: schema.blocks.map((b) => ({
        id: b.id,
        label: b.label,
        caption: b.caption,
        category: b.category,
        capabilities: b.capabilities ?? [],
        files: b.provenance?.files ?? [],
      })),
      arrows: schema.arrows.map((a) => ({
        from: a.from,
        to: a.to,
        label: a.label,
      })),
    }),
  });
  const json = (await resp.json()) as ApiResponse<DiagramSearchResult>;
  if (!json.success || !json.data) {
    throw new Error(json.error || "diagram-search request failed");
  }
  return json.data;
}
