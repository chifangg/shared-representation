//! `POST /api/connection-detail`: read-only, on-demand explanation of ONE
//! relationship (an arrow) between two blocks. Fired when the user clicks
//! an arrow-label pill.
//!
//! Returns three "lenses", each the kind of per-edge detail that the
//! block-level abstraction throws away:
//!   - realization: HOW the relationship is wired in code (one sentence).
//!   - uses:        the packages / APIs / shared components it relies on.
//!   - hidden:      seam details the two block captions do NOT mention.
//!
//! Reliability is designed in, not hoped for: every field is capped, and
//! the model is told to leave a field EMPTY rather than guess or restate
//! the captions. The frontend then simply omits empty lenses.
//!
//! Same one-shot direct-API shape as `function_detail.rs` (kept separate
//! rather than overloaded; the shared Anthropic-call helper is a future
//! cleanup).

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
pub struct ConnectionDetailRequest {
    from_label: String,
    to_label: String,
    /// The arrow's verb label, e.g. "launches", "renders into".
    verb: String,
    /// One-sentence captions of each block, so the model can tell what the
    /// block-level summary already said (and therefore what is "hidden").
    #[serde(default)]
    from_caption: String,
    #[serde(default)]
    to_caption: String,
    /// Source of both blocks' files (union), sent from the browser.
    #[serde(default)]
    files: Vec<FileBlob>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionDetailResult {
    /// One plain sentence on how the relationship is wired. May be empty
    /// for a purely inferred relationship with no code locus.
    #[serde(skip_serializing_if = "Option::is_none")]
    realization: Option<String>,
    /// Packages / APIs / shared components the connection relies on.
    #[serde(skip_serializing_if = "Option::is_none")]
    uses: Option<Vec<String>>,
    /// Seam details the captions do not mention. Empty when nothing is
    /// genuinely non-obvious.
    #[serde(skip_serializing_if = "Option::is_none")]
    hidden: Option<Vec<String>>,
}

const MAX_FILE_CHARS: usize = 14000;

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

pub async fn connection_detail(
    Json(req): Json<ConnectionDetailRequest>,
) -> Json<ApiResponse<ConnectionDetailResult>> {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => return Json(ApiResponse::error("ANTHROPIC_API_KEY not set".into())),
    };

    let source = build_source_block(&req.files);

    let prompt = format!(
        "Below is the source of the files behind two parts of a project, and \
ONE relationship between them.\n\n\
SOURCE:\n{source}\n\n\
RELATIONSHIP: \"{from}\" {verb} \"{to}\".\n\
What \"{from}\" is summarized as: {from_cap}\n\
What \"{to}\" is summarized as: {to_cap}\n\n\
Explain how this ONE relationship actually works in the code, in plain \
everyday language. Focus on the SEAM between the two parts. Do NOT \
re-describe what each part does on its own.\n\n\
Return ONLY valid JSON, no markdown fences, in exactly this shape:\n\
{{\"realization\": \"...\", \"uses\": [\"...\"], \"hidden\": [\"...\"]}}\n\
Rules (reliability matters, follow exactly):\n\
- realization: ONE short sentence, at most 20 words, on HOW the relationship \
is wired in the code (the concrete call or mechanism that makes \"{verb}\" \
happen). If you cannot find concrete code for it, say briefly that it is an \
inferred relationship and name the closest file. NEVER invent a mechanism.\n\
- uses: the packages, APIs, or shared components this connection relies on. \
AT MOST 4, each a short name. Empty list if there is nothing notable.\n\
- hidden: AT MOST 3 short points (each at most 12 words) that the two \
summaries above do NOT mention but matter at the seam (what is passed, \
lifecycle quirks, side effects, assumptions). Return an EMPTY list if there \
is nothing genuinely non-obvious. Do NOT restate the summaries.\n\
- Base everything on the real code. Leave a field empty rather than guess.",
        from = req.from_label,
        to = req.to_label,
        verb = req.verb,
        from_cap = req.from_caption,
        to_cap = req.to_caption,
    );

    let body = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": "You explain how two parts of a codebase are wired together, in plain non-technical language, grounded only in the source you are given. You never invent mechanisms and you output only the requested JSON.",
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

    let str_list = |key: &str, cap: usize| -> Option<Vec<String>> {
        parsed.get(key).and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .take(cap)
                .collect()
        })
    };

    let result = ConnectionDetailResult {
        realization: parsed
            .get("realization")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        uses: str_list("uses", 4),
        hidden: str_list("hidden", 3),
    };

    Json(ApiResponse::success(result))
}
