//! `POST /api/block-refresh`: re-derive ONE block's caption + capabilities
//! from its (possibly just-edited) source.
//!
//! Block-level edits (the "..." cards flow) do NOT regenerate the whole
//! diagram, so the block's drill-in bubbles + caption would otherwise go
//! stale after the user adds a feature to it. This endpoint re-reads the
//! block's files and returns a fresh caption + capability list, which the
//! frontend folds back into that one block in place (layout preserved).
//!
//! One-shot (non-streaming) call, mirroring `function_detail.rs`.

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
pub struct BlockRefreshRequest {
    /// Block display name (helps the model frame the capability set).
    label: String,
    /// Current caption, so the model can keep it if nothing changed.
    #[serde(default)]
    caption: String,
    /// Source of the block's files, sent from the browser.
    #[serde(default)]
    files: Vec<FileBlob>,
}

#[derive(Debug, Serialize)]
pub struct BlockRefreshResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<String>>,
}

const MAX_FILE_CHARS: usize = 16000;
const MAX_CAPABILITIES: usize = 6;

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

pub async fn block_refresh(
    Json(req): Json<BlockRefreshRequest>,
) -> Json<ApiResponse<BlockRefreshResult>> {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => return Json(ApiResponse::error("ANTHROPIC_API_KEY not set".into())),
    };

    let source = build_source_block(&req.files);

    let prompt = format!(
        "Below is the CURRENT source of the files behind one capability block \
in a software project, plus the block's name and its current caption. The \
code may have just been edited.\n\n\
SOURCE:\n{source}\n\n\
BLOCK: {label}\n\
CURRENT CAPTION: {caption}\n\n\
Re-derive, FROM THE CURRENT CODE:\n\
- caption: ONE short sentence in plain user language, what this block does \
AS A WHOLE. Do NOT enumerate the individual functions or steps.\n\
- capabilities: the FEWEST distinct sub-capabilities a user would inspect or \
edit SEPARATELY, each a terse plain-language verb phrase, about 4 words \
(e.g. \"Store chat turns\", \"Navigate between turns\"). Prefer 3 to 5, never \
more than {max_caps}. Do NOT pad to a number, do NOT restate the caption, do \
NOT overlap entries, and never a raw function name like \"main\" or \"init\". \
If the code clearly added a new capability, it MUST appear in the list.\n\n\
Return ONLY valid JSON, no markdown fences, in exactly this shape:\n\
{{\"caption\": \"one sentence\", \"capabilities\": [\"verb phrase\", \"...\"]}}",
        source = source,
        label = req.label,
        caption = req.caption,
        max_caps = MAX_CAPABILITIES,
    );

    let body = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": "You read code and describe it in plain, non-technical user language. You never invent behavior that is not in the source. You output only the requested JSON.",
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

    let capabilities = parsed.get("capabilities").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .take(MAX_CAPABILITIES)
            .collect::<Vec<_>>()
    });

    let result = BlockRefreshResult {
        caption: parsed
            .get("caption")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        capabilities,
    };

    Json(ApiResponse::success(result))
}
