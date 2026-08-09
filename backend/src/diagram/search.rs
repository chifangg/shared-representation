//! `POST /api/diagram-search`: natural-language search over the DIAGRAM,
//! not the codebase.
//!
//! The user asks "where is auth handled" or "how does an upload reach
//! storage" and gets back an ordered reading path: which blocks to read,
//! in what order, and which arrows connect them.
//!
//! Three properties make this safe to run while the agent is writing code:
//!
//!   1. It is a stateless one-shot Anthropic call (same shape as
//!      connection_detail.rs), NOT the `claude` CLI session. Nothing here
//!      touches the chat lock, so a search never waits on, or interferes
//!      with, a streaming turn.
//!   2. It receives the diagram schema ONLY (labels, captions,
//!      capabilities, file paths, arrow verbs). No file contents. That
//!      keeps the payload small and, more importantly, keeps the answer
//!      stable while the agent mutates files underneath.
//!   3. The model returns block IDS and rationale, nothing else. Labels
//!      and file paths are re-derived browser-side from the schema the
//!      caller already holds, so a hallucinated path is impossible. Any
//!      id the model invents anyway is dropped here (see `validate`).
//!
//! Reliability comes from structured outputs (`output_config.format`)
//! rather than "return ONLY valid JSON" prompting: the response is
//! schema-constrained at the API level, so there is no brace-slicing
//! fallback to get wrong.

use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::web_server::ApiResponse;

/// One block as the browser sees it. Everything here is cheap text; the
/// whole schema for a typical project is a few KB.
#[derive(Debug, Deserialize)]
pub struct SearchBlock {
    id: String,
    label: String,
    #[serde(default)]
    caption: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    /// `provenance.files`. Sent so the model can match a query that names
    /// a filename, never so it can quote one back (the browser owns that).
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchArrow {
    from: String,
    to: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Deserialize)]
pub struct DiagramSearchRequest {
    query: String,
    #[serde(default)]
    blocks: Vec<SearchBlock>,
    #[serde(default)]
    arrows: Vec<SearchArrow>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    /// Must be one of the ids the caller sent. Anything else is dropped.
    block_id: String,
    /// One short line on why this block is on the reading path.
    why: String,
    /// 1-based position in the reading order.
    order: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchPathEdge {
    from: String,
    to: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiagramSearchResult {
    /// One sentence answering the question at the diagram's altitude.
    answer: String,
    hits: Vec<SearchHit>,
    /// Arrows worth following between hits, in reading order. May be empty
    /// for a pure "locate" query whose hits are not connected.
    path: Vec<SearchPathEdge>,
    /// True when nothing in the diagram answers the question. Load-bearing:
    /// without it the model invents a plausible path for a query the
    /// diagram genuinely cannot answer, which is the worst possible
    /// outcome for someone building a mental model of the project.
    missing: bool,
}

/// Hard cap on returned hits. A reading path longer than this is not a
/// reading path, it is the whole diagram.
const MAX_HITS: usize = 8;

const SYSTEM: &str = "You help a developer navigate an unfamiliar project \
through its architecture diagram. You are given the diagram only (block \
labels, one-line captions, capabilities, file paths, and labelled arrows \
between blocks), never the source. You select which blocks the person \
should read, in what order, and which arrows connect them. You never \
invent blocks, and you say plainly when the diagram does not answer the \
question.";

fn build_schema_block(req: &DiagramSearchRequest) -> String {
    let mut out = String::from("BLOCKS:\n");
    for b in &req.blocks {
        out.push_str(&format!("- id: {}\n  name: {}\n", b.id, b.label));
        if !b.caption.is_empty() {
            out.push_str(&format!("  summary: {}\n", b.caption));
        }
        if let Some(cat) = &b.category {
            out.push_str(&format!("  kind: {cat}\n"));
        }
        if !b.capabilities.is_empty() {
            out.push_str(&format!("  does: {}\n", b.capabilities.join("; ")));
        }
        if !b.files.is_empty() {
            out.push_str(&format!("  files: {}\n", b.files.join(", ")));
        }
    }
    out.push_str("\nARROWS:\n");
    if req.arrows.is_empty() {
        out.push_str("(none)\n");
    }
    for a in &req.arrows {
        let verb = if a.label.is_empty() { "connects to" } else { &a.label };
        out.push_str(&format!("- {} {} {}\n", a.from, verb, a.to));
    }
    out
}

/// The response schema handed to `output_config.format`. Every object sets
/// `additionalProperties: false` and lists `required`, which structured
/// outputs requires.
fn output_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["answer", "hits", "path", "missing"],
        "properties": {
            "answer": {
                "type": "string",
                "description": "One sentence answering the question at the level of the diagram. If missing is true, say briefly what the diagram does not cover."
            },
            "missing": {
                "type": "boolean",
                "description": "True when no block in the diagram answers the question. Prefer this over a weak guess."
            },
            "hits": {
                "type": "array",
                "description": "Blocks to read, in reading order. Empty when missing is true.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["block_id", "why", "order"],
                    "properties": {
                        "block_id": { "type": "string", "description": "An id copied EXACTLY from the BLOCKS list." },
                        "why": { "type": "string", "description": "At most 14 words on why this block is on the path. Do not restate its summary." },
                        "order": { "type": "integer", "description": "1-based reading position." }
                    }
                }
            },
            "path": {
                "type": "array",
                "description": "Arrows to follow between the hits, in reading order. Only arrows present in the ARROWS list. Empty if the hits are not connected.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["from", "to"],
                    "properties": {
                        "from": { "type": "string" },
                        "to": { "type": "string" }
                    }
                }
            }
        }
    })
}

/// Drop anything the model made up, then renumber.
///
/// Structured outputs guarantees the SHAPE of the response, not its
/// truthfulness: the model can still emit a well-formed id that does not
/// exist. Everything the user eventually sees (labels, captions, file
/// paths) is derived browser-side from these ids, so an unknown id would
/// surface as a silently missing row. Dropping here keeps that invariant
/// enforced on the server too.
fn validate(mut result: DiagramSearchResult, req: &DiagramSearchRequest) -> DiagramSearchResult {
    let known: std::collections::HashSet<&str> =
        req.blocks.iter().map(|b| b.id.as_str()).collect();

    result.hits.retain(|h| known.contains(h.block_id.as_str()));
    result.hits.sort_by_key(|h| h.order);
    result.hits.truncate(MAX_HITS);
    for (i, h) in result.hits.iter_mut().enumerate() {
        h.order = (i + 1) as u32;
    }

    // A path edge is only useful if both ends survived, and only honest if
    // the arrow actually exists in the schema.
    let real_arrows: std::collections::HashSet<(&str, &str)> = req
        .arrows
        .iter()
        .map(|a| (a.from.as_str(), a.to.as_str()))
        .collect();
    let hit_ids: std::collections::HashSet<&str> =
        result.hits.iter().map(|h| h.block_id.as_str()).collect();
    result.path.retain(|e| {
        hit_ids.contains(e.from.as_str())
            && hit_ids.contains(e.to.as_str())
            && (real_arrows.contains(&(e.from.as_str(), e.to.as_str()))
                || real_arrows.contains(&(e.to.as_str(), e.from.as_str())))
    });

    // No surviving hits means nothing was found, whatever the model said.
    if result.hits.is_empty() {
        result.missing = true;
        result.path.clear();
    }
    result
}

pub async fn diagram_search(
    Json(req): Json<DiagramSearchRequest>,
) -> Json<ApiResponse<DiagramSearchResult>> {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => return Json(ApiResponse::error("ANTHROPIC_API_KEY not set".into())),
    };

    if req.query.trim().is_empty() {
        return Json(ApiResponse::error("empty query".into()));
    }
    if req.blocks.is_empty() {
        return Json(ApiResponse::error("no diagram to search".into()));
    }

    let schema_text = build_schema_block(&req);
    let question = format!(
        "QUESTION: {}\n\n\
Pick the blocks this person needs to READ to answer it, and order them so \
that reading them in sequence builds understanding: start where the flow \
starts, or where the concept is defined, and follow the arrows from there. \
At most {MAX_HITS} blocks, and prefer three or four over eight. Include an \
arrow in `path` only when it is in the ARROWS list above and both of its \
blocks are among your hits. If the diagram does not cover the question, set \
missing to true and return no hits rather than guessing.",
        req.query.trim()
    );

    // The schema block is identical for every search in a session while the
    // question changes each time, so it goes first and carries the cache
    // breakpoint. Render order is tools then system then messages, so this
    // one breakpoint caches the system prompt with it. Repeat searches (the
    // normal case, since people search while waiting on the agent) then bill
    // the bulk of the request at cache-read rates.
    let body = json!({
        "model": "claude-opus-5",
        "max_tokens": 2048,
        "output_config": {
            "effort": "low",
            "format": { "type": "json_schema", "schema": output_schema() }
        },
        "system": SYSTEM,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": schema_text,
                    "cache_control": { "type": "ephemeral" }
                },
                { "type": "text", "text": question }
            ]
        }]
    });

    let resp = match crate::core::anthropic::post_messages(&api_key, &body).await {
        Ok(r) => r,
        Err(e) => return Json(ApiResponse::error(format!("anthropic request failed: {e}"))),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Json(ApiResponse::error(format!(
            "anthropic returned {status}: {text}"
        )));
    }

    let payload: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(format!("bad anthropic json: {e}"))),
    };

    // A refusal comes back as a normal 200 with an empty content array, so
    // check stop_reason before reading content.
    if payload.get("stop_reason").and_then(|v| v.as_str()) == Some("refusal") {
        return Json(ApiResponse::error("search request was declined".into()));
    }

    let text = payload
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    // Structured outputs constrains the response to the schema above, so
    // this parses directly. No brace-slicing.
    let parsed: DiagramSearchResult = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(format!("search JSON parse: {e}: {text}"))),
    };

    Json(ApiResponse::success(validate(parsed, &req)))
}
