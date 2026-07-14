//! `POST /api/function-detail`: read-only capability detail and change
//! preview for the bubble (function) edit flow.
//!
//! Two modes, both one-shot (non-streaming) calls to the Anthropic
//! Messages API:
//!   - "describe": given the real source of a function, return a plain
//!     language account of what it does plus a few sub-behaviors.
//!   - "preview": given the source plus a requested change, restate in
//!     plain language what the behavior WILL become. Never names files,
//!     paths, or identifiers. The user confirms the capability change,
//!     not the code location.
//!
//! Why a dedicated endpoint instead of the chat session: these are meta
//! queries that must not pollute the conversation history, and they
//! benefit from low latency. Mirrors the direct-API approach in
//! `handler.rs` but without the streaming agentic loop.

use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::web_server::ApiResponse;

#[derive(Debug, Deserialize)]
pub struct FileBlob {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
pub struct FunctionDetailRequest {
    /// Raw identifier of the function/method the bubble represents.
    function_name: String,
    /// Source of the block's files, sent from the browser (the project
    /// lives in the React ProjectContext, not on the backend disk).
    #[serde(default)]
    files: Vec<FileBlob>,
    /// "describe" or "preview".
    mode: String,
    /// Required for "preview": the change the user wants.
    #[serde(default)]
    instruction: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FunctionDetailResult {
    /// describe mode: one or two plain sentences.
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// describe mode: 2 to 4 short plain-language sub-behaviors.
    #[serde(skip_serializing_if = "Option::is_none")]
    behaviors: Option<Vec<String>>,
    /// preview mode: one or two plain sentences on what will change.
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// Per-file cap so a giant module doesn't blow the request size. The
/// function we care about almost always sits in the first chunk.
const MAX_FILE_CHARS: usize = 16000;

fn build_source_block(files: &[FileBlob]) -> String {
    if files.is_empty() {
        return "(no source provided)".to_string();
    }
    let mut out = String::new();
    for f in files {
        let body = if f.content.chars().count() > MAX_FILE_CHARS {
            let truncated: String = f.content.chars().take(MAX_FILE_CHARS).collect();
            format!("{truncated}\n... (truncated)")
        } else {
            f.content.clone()
        };
        out.push_str(&format!("=== {} ===\n{}\n\n", f.path, body));
    }
    out
}

pub async fn function_detail(
    Json(req): Json<FunctionDetailRequest>,
) -> Json<ApiResponse<FunctionDetailResult>> {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => return Json(ApiResponse::error("ANTHROPIC_API_KEY not set".into())),
    };

    let source = build_source_block(&req.files);

    let prompt = match req.mode.as_str() {
        "describe" => format!(
            "Below is the source of one or more files from a project, then one \
capability of that code (it may be a plain-language capability or a function \
name).\n\n\
SOURCE:\n{source}\n\n\
CAPABILITY: {fn_name}\n\n\
Say, in plain everyday language a non-programmer can follow, what this \
capability does and (briefly) how the code does it. Do not mention file \
names, paths, or code identifiers.\n\n\
Be brief. This shows on a visual canvas, so every word counts.\n\
Return ONLY valid JSON, no markdown fences, in exactly this shape:\n\
{{\"description\": \"ONE short sentence, 14 words max\", \"behaviors\": [\"3 word phrase\"]}}\n\
Rules: description is ONE sentence, at most 14 words. Give AT MOST 3 \
behaviors, each at most 5 words, only if they add something the sentence \
does not. Fewer is better; an empty list is fine. If you cannot find it in \
the code, give a one-line best guess and an empty behaviors list.",
            fn_name = req.function_name,
        ),
        "preview" => {
            let instruction = req.instruction.clone().unwrap_or_default();
            format!(
                "Below is the source of one or more files, the name of one function \
or method, and a change the user wants to make to it.\n\n\
SOURCE:\n{source}\n\n\
FUNCTION: {fn_name}\n\n\
REQUESTED CHANGE:\n\"{instruction}\"\n\n\
In plain everyday language, restate what this piece of the product WILL do \
differently after the change: what it will now do, stop doing, or do better. \
Do NOT mention file names, paths, line numbers, function names, or any code \
identifiers. The user is confirming the behavior change, not the code \
location. Keep it to one or two sentences.\n\n\
Return ONLY valid JSON, no markdown fences, in exactly this shape:\n\
{{\"summary\": \"one or two plain sentences describing the change\"}}",
                fn_name = req.function_name,
                instruction = instruction,
            )
        }
        other => return Json(ApiResponse::error(format!("unknown mode: {other}"))),
    };

    let body = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": "You translate code into plain, non-technical language. You never invent behavior that is not in the source. You output only the requested JSON.",
        "messages": [ { "role": "user", "content": prompt } ]
    });

    let resp = match crate::core::anthropic::post_messages(&api_key, &body).await {
        Ok(r) => r,
        Err(e) => {
            return Json(ApiResponse::error(format!("anthropic request failed: {e}")))
        }
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

    // `content` is an array of blocks; concatenate the text blocks.
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

    let json_slice = match (text.find('{'), text.rfind('}')) {
        (Some(s), Some(e)) if e > s => &text[s..=e],
        _ => return Json(ApiResponse::error(format!("no JSON in response: {text}"))),
    };

    let parsed: serde_json::Value = match serde_json::from_str(json_slice) {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(format!("JSON parse: {e}"))),
    };

    let result = FunctionDetailResult {
        description: parsed
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string()),
        behaviors: parsed.get("behaviors").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        }),
        summary: parsed
            .get("summary")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string()),
    };

    Json(ApiResponse::success(result))
}
