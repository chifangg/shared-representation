//! Tool-input JSON schemas + tool builders for the three diagram views,
//! plus the `tool_use → NDJSON line` translation the handler streams
//! back to the frontend.
//!
//! Each view exposes a different tool set:
//!   - structure: `block`, `arrow`, `done`
//!   - focus: `focus`, `detail_block`, `detail_arrow`, `done`
//!   - capability_scan: `capability`, `done`
//!
//! Common atoms (`block_input_schema`, `arrow_input_schema`,
//! `empty_input_schema`) are re-used across views — keep them module-
//! private so the seams between views stay legible.

use serde_json::json;

/// The six block categories. Single source for the tool schemas here and in
/// `main.rs`, and for `block_refresh` validation. Must match the frontend
/// BlockCategory union in `src/features/diagram/types.ts`.
pub const BLOCK_CATEGORIES: [&str; 6] = [
    "interface",
    "logic",
    "data",
    "state",
    "integration",
    "config",
];

fn block_input_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "minLength": 1, "description": "Stable readable id derived from the label, e.g. \"backend_api\"." },
            "label": { "type": "string", "minLength": 1, "description": "Short display name." },
            "caption": { "type": "string", "description": "One-sentence description of what the block does." },
            "parent": { "type": ["string", "null"], "description": "Parent block id, or null for top-level blocks." },
            "category": {
                "type": "string",
                "enum": BLOCK_CATEGORIES,
                "description": "Exactly one role for this block, judged on two axes. BOUNDARY: interface = the inbound edge, where the outside reaches in (UI screens/panels, API endpoints, CLI commands); integration = the outbound edge, external services this project calls out to (network clients, third-party SDKs). INTERNAL (what it manages): logic = processing that keeps no state across calls (engines, rules, transforms, business logic); state = runtime state held across calls but NOT persisted (stores, session, in-memory caches, context); data = persistent or shared data (datasets, models, schemas, databases, files). config = off the runtime request path (setup, build, theming, infra, environment, tooling). Tie-break, pick the SINGLE role that dominates why the block exists: inbound vs outbound = who initiates (outside calls in = interface, this project calls out = integration); state vs data = transient runtime memory (state) vs persisted or shared across runs (data); config only when it is not on the runtime path."
            },
            "capabilities": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 1,
                "maxItems": 6,
                "description": "The FEWEST distinct sub-capabilities that a user would want to inspect or edit SEPARATELY, each a terse plain-language verb phrase in user terms, about 4 words (e.g. \"Store chat turns\", \"Track image paths\"). Prefer the SMALLEST honest set: most blocks need 3 to 5; a simple block may have 1 or 2. Do NOT pad toward the limit, do NOT split one responsibility into finer steps just to add entries, and do NOT force unrelated things together. Only list something if it is a genuinely separate thing the user could act on. These surface as drill-in bubbles on the canvas, so keep them few and legible. Decompose what the block does; do NOT restate the caption and do NOT overlap entries. Derive from the real code, never invent. Never a raw function name like \"main\" or \"init\"."
            },
            "provenance": {
                "type": "object",
                "properties": {
                    "files": { "type": "array", "items": { "type": "string" } },
                    "functions": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["files", "functions"]
            }
        },
        "required": ["id", "label", "caption", "category", "capabilities", "provenance"]
    })
}

fn arrow_input_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "from": { "type": "string", "minLength": 1, "description": "Source block id." },
            "to": { "type": "string", "minLength": 1, "description": "Destination block id." },
            "label": { "type": "string", "minLength": 1, "description": "1–2 word verb describing the actual relationship (e.g. \"imports\", \"calls\", \"renders\")." }
        },
        "required": ["from", "to", "label"]
    })
}

fn empty_input_schema() -> serde_json::Value {
    json!({ "type": "object", "properties": {} })
}

fn capability_input_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "minLength": 1, "description": "Stable readable id derived from the label, e.g. \"content_sections\"." },
            "label": { "type": "string", "minLength": 1, "description": "Short user-facing capability name." },
            "caption": { "type": "string", "description": "One-sentence description of what this capability does for the user." },
            "icon": {
                "type": "string",
                "enum": ["structure", "dataflow", "ui", "logic", "integration", "config", "data", "content", "conversation", "compare", "view", "people", "browse", "annotation", "other"],
                "description": "One keyword from the list whose meaning best matches this capability. Pick distinct icons across capabilities so the picklist looks varied. Use \"other\" only if none genuinely fit."
            }
        },
        "required": ["id", "label", "caption", "icon"]
    })
}

pub(super) fn structure_tools() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "block",
            "description": "Emit one architecture block in the diagram.",
            "input_schema": block_input_schema(),
        }),
        json!({
            "name": "arrow",
            "description": "Emit one arrow between two blocks.",
            "input_schema": arrow_input_schema(),
        }),
        json!({
            "name": "done",
            "description": "Signal that all blocks and arrows have been emitted.",
            "input_schema": empty_input_schema(),
        }),
    ]
}

/// Same shape as a structure block, but `parent` is REQUIRED and must be an
/// existing overview block id. It is a detail block's only tie back to the
/// canvas (detail arrows stay detail-to-detail by design), so a missing or
/// label-valued parent left the detail chain floating disconnected in the
/// focus panel and islanded if the user promoted it onto the canvas.
fn detail_block_input_schema() -> serde_json::Value {
    let mut schema = block_input_schema();
    schema["properties"]["parent"] = json!({
        "type": "string",
        "minLength": 1,
        "description": "REQUIRED. The id of the existing overview block this detail belongs to. Always the id from EXISTING OVERVIEW BLOCKS, never the label, never null, never a detail_ id."
    });
    schema["required"]
        .as_array_mut()
        .expect("block_input_schema required is an array")
        .push(json!("parent"));
    schema
}

pub(super) fn focus_tools() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "focus",
            "description": "Identify which existing overview block ids the conversation is about.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["ids"]
            },
        }),
        json!({
            "name": "detail_block",
            "description": "Emit one detail sub-block under an existing overview block.",
            "input_schema": detail_block_input_schema(),
        }),
        json!({
            "name": "detail_arrow",
            "description": "Emit one arrow between two detail blocks.",
            "input_schema": arrow_input_schema(),
        }),
        json!({
            "name": "done",
            "description": "Signal that focus, detail_block, and detail_arrow tool calls are complete.",
            "input_schema": empty_input_schema(),
        }),
    ]
}

pub(super) fn capability_scan_tools() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "capability",
            "description": "Emit one capability candidate (label + caption only, no provenance).",
            "input_schema": capability_input_schema(),
        }),
        json!({
            "name": "done",
            "description": "Signal that all capabilities have been emitted.",
            "input_schema": empty_input_schema(),
        }),
    ]
}

fn scheme_input_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "minLength": 1, "description": "Short title for the whole encoding (2-4 words), e.g. \"Data flow stage\"." },
            "description": { "type": "string", "description": "One sentence stating what the colors mean, shown under the name in the legend." },
            "groups": {
                "type": "array",
                "minItems": 2,
                "maxItems": 6,
                "description": "The named color groups, in a sensible order. The UI paints each from a fixed palette by this order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "minLength": 1, "description": "Short snake_case slug, e.g. \"ingest\"." },
                        "label": { "type": "string", "minLength": 1, "description": "Short human title, 1-3 words." },
                        "blurb": { "type": "string", "description": "One short sentence on what blocks in this group share." }
                    },
                    "required": ["key", "label"]
                }
            },
            "assignments": {
                "type": "array",
                "minItems": 1,
                "description": "One entry per block, mapping the block id to one group key. Every block id must appear exactly once.",
                "items": {
                    "type": "object",
                    "properties": {
                        "block_id": { "type": "string", "minLength": 1, "description": "A block id from the user message." },
                        "group_key": { "type": "string", "minLength": 1, "description": "The key of one of the groups above." }
                    },
                    "required": ["block_id", "group_key"]
                }
            }
        },
        "required": ["name", "groups", "assignments"]
    })
}

pub(super) fn color_scheme_tools() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "scheme",
            "description": "Emit the color encoding: its name, description, groups, and per-block assignments. Call exactly once.",
            "input_schema": scheme_input_schema(),
        }),
        json!({
            "name": "done",
            "description": "Signal that the scheme has been emitted.",
            "input_schema": empty_input_schema(),
        }),
    ]
}

/// Translate a streamed tool_use call into the NDJSON line shape the
/// frontend already consumes (`{kind, data}` for most tools, `{kind:
/// "focus", ids: [...]}` for the focus tool, and `{kind: "done"}` for
/// the terminator).
pub(super) fn tool_use_to_ndjson(
    name: &str,
    input: serde_json::Value,
) -> serde_json::Value {
    match name {
        "focus" => json!({
            "kind": "focus",
            "ids": input.get("ids").cloned().unwrap_or_else(|| json!([]))
        }),
        "done" => json!({ "kind": "done" }),
        other => json!({ "kind": other, "data": input }),
    }
}
