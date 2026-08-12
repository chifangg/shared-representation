//! One-shot meta query: given the project context, produce a chat-theme
//! title + 3 contextual starter prompts in a single Claude round-trip.
//!
//! Why a separate endpoint vs. the chat WebSocket: this is a meta query
//! (we don't want it appearing in the conversation history or being
//! remembered by Claude in subsequent turns). Spawning Claude one-shot
//! here keeps it cleanly isolated.

use axum::Json;
use serde::{Deserialize, Serialize};

use crate::chat::find_claude_binary_web;
use crate::web_server::ApiResponse;

#[derive(Debug, Deserialize)]
pub struct SuggestionsRequest {
    /// Pre-built project-context blob (project tree + file contents +
    /// optional goal) — see `buildProjectContext` in the frontend.
    project_context: String,
}

#[derive(Debug, Serialize)]
pub struct SuggestionsResult {
    /// 2–5 word distillation of the goal — shown in the chat-theme
    /// header strip.
    title: String,
    /// 3 contextual starter prompts referencing the uploaded project.
    suggestions: Vec<String>,
}

pub async fn generate_suggestions(
    Json(req): Json<SuggestionsRequest>,
) -> Json<ApiResponse<SuggestionsResult>> {
    let claude_path = match find_claude_binary_web() {
        Ok(p) => p,
        Err(e) => return Json(ApiResponse::error(format!("claude binary not found: {e}"))),
    };

    let prompt = format!(
        "Given the project below and the user's stated goal, produce two things:\n\n\
1. `title`: a 2–5 word distillation of the goal that captures its core \
intent (NOT a verbatim truncation). Used as a header label, must read \
naturally as a noun phrase. e.g. \"dark-mode toggle\", \"stock data \
preprocessing\", \"checkout flow refactor\".\n\n\
2. `suggestions`: 3 short, specific starter prompts the user could open \
the conversation with. Each suggestion should:\n\
- Reference specific files, modules, or concepts from the project\n\
- Be concrete and actionable, not abstract\n\
- Be no more than 20 words\n\n\
Output ONLY valid JSON in exactly this format, with no markdown fences, \
no prose, no explanation:\n\
{{\"title\": \"...\", \"suggestions\": [\"...\", \"...\", \"...\"]}}\n\n{}",
        req.project_context
    );

    let output_future = async {
        use tokio::io::AsyncWriteExt;
        let mut child = tokio::process::Command::new(&claude_path)
            .env_remove("ANTHROPIC_API_KEY")
            .arg("-p")
            .arg("--model")
            .arg("sonnet")
            .arg("--output-format")
            .arg("text")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await?;
        }
        child.wait_with_output().await
    };

    let output = match output_future.await {
        Ok(o) => o,
        Err(e) => return Json(ApiResponse::error(format!("spawn failed: {e}"))),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Json(ApiResponse::error(format!(
            "claude exited non-zero: {stderr}"
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_slice = match (stdout.find('{'), stdout.rfind('}')) {
        (Some(start), Some(end)) if end > start => &stdout[start..=end],
        _ => return Json(ApiResponse::error(format!("no JSON found in output: {stdout}"))),
    };

    let parsed: serde_json::Value = match serde_json::from_str(json_slice) {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(format!("JSON parse: {e}"))),
    };

    let title = parsed
        .get("title")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let suggestions: Vec<String> = parsed
        .get("suggestions")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if suggestions.is_empty() {
        return Json(ApiResponse::error("no suggestions in response".into()));
    }

    Json(ApiResponse::success(SuggestionsResult {
        title,
        suggestions,
    }))
}
