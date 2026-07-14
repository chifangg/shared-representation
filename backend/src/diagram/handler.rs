//! `POST /api/diagram` handler. Streams NDJSON back to the frontend by
//! looping Anthropic Messages-API turns until a `done` tool_use is
//! emitted or the model decides it's finished.
//!
//! One-turn shape:
//!   1. POST to `/v1/messages` with the cumulative conversation +
//!      this view's tool set.
//!   2. Walk the SSE stream, accumulating tool_use input JSON.
//!   3. On each `content_block_stop` translate the tool_use to an
//!      NDJSON line via `tool_use_to_ndjson` and yield it.
//!   4. Build an `assistant` reply + synthetic `tool_result`s; loop.
//!
//! The async-stream macro keeps the yields inline with the loop so we
//! can stream chunks to the client as they arrive without buffering
//! the whole response.

use axum::body::Body;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::prompts::{
    CAPABILITY_SCAN_SYSTEM, COLOR_SCHEME_SYSTEM, FOCUS_SYSTEM, STRUCTURE_SYSTEM,
};
use super::tools::{
    capability_scan_tools, color_scheme_tools, focus_tools, structure_tools,
    tool_use_to_ndjson,
};

#[derive(Debug, Deserialize)]
pub struct DiagramRequest {
    project_context: String,
    view: String,
    #[serde(default)]
    chat_context: Option<String>,
    #[serde(default)]
    base_schema: Option<String>,
    /// Free-text grouping request for the `color_scheme` view ("describe
    /// your own"). Absent / empty means "let the model pick the most
    /// insightful encoding". Ignored by the other views.
    #[serde(default)]
    instruction: Option<String>,
}

/// Build the initial user message for the diagram conversation. The
/// project context is in its own content block tagged with
/// `cache_control: ephemeral` so subsequent turns (within 5 min) hit
/// the prompt cache and only re-pay for the conversation tail. The
/// variable parts (chat snippet, existing overview blocks) live in a
/// second content block so they don't invalidate the cache on every
/// call.
fn build_initial_user_content(
    project_context: &str,
    chat_block: &str,
    base_block: &str,
    instruction_block: &str,
) -> Vec<serde_json::Value> {
    let variable_tail = format!("{}{}{}", base_block, chat_block, instruction_block);
    let mut user_content = vec![json!({
        "type": "text",
        "text": format!("PROJECT:\n{}", project_context),
        "cache_control": { "type": "ephemeral" }
    })];
    if !variable_tail.is_empty() {
        user_content.push(json!({ "type": "text", "text": variable_tail }));
    }
    user_content
}

/// Assemble one Anthropic API request body. The view picks system
/// prompt + tool set; `messages` is the growing conversation
/// (initial user message, then assistant+tool_result pairs).
fn build_diagram_body(
    view: &str,
    messages: &[serde_json::Value],
) -> Option<serde_json::Value> {
    let (system_text, tools) = match view {
        "structure" => (STRUCTURE_SYSTEM, structure_tools()),
        "focus" => (FOCUS_SYSTEM, focus_tools()),
        "capability_scan" => (CAPABILITY_SCAN_SYSTEM, capability_scan_tools()),
        "color_scheme" => (COLOR_SCHEME_SYSTEM, color_scheme_tools()),
        _ => return None,
    };

    Some(json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 16000,
        "stream": true,
        "system": [
            { "type": "text", "text": system_text, "cache_control": { "type": "ephemeral" } }
        ],
        "messages": messages,
        "tools": tools,
        // `disable_parallel_tool_use: false` is the API default, but
        // make it explicit — the agentic loop only pays off if the
        // model is actually willing to emit many tool_use blocks in a
        // single response.
        "tool_choice": { "type": "any", "disable_parallel_tool_use": false }
    }))
}

/// Max conversation turns before we give up. Each turn = one round-trip
/// to Anthropic. Cache makes the per-turn token cost negligible after
/// the first one, so the real budget here is wall-clock time (~3-4s per
/// turn). 30 is enough to cover Sonnet 4.6 in its most serial mood
/// (one tool_use per turn) without burning forever on a broken loop.
const MAX_DIAGRAM_TURNS: usize = 30;

pub async fn generate_diagram(Json(req): Json<DiagramRequest>) -> Response {
    let started = std::time::Instant::now();
    eprintln!(
        "📐 /api/diagram view={} context_bytes={}",
        req.view,
        req.project_context.len()
    );

    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("📐 ❌ ANTHROPIC_API_KEY not set");
            return ndjson_error("ANTHROPIC_API_KEY not set".into());
        }
    };

    let chat_block = req
        .chat_context
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\nRECENT CHAT (most recent last):\n{}\n", s))
        .unwrap_or_default();

    let base_block = req
        .base_schema
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\nEXISTING OVERVIEW BLOCKS:\n{}\n", s))
        .unwrap_or_default();

    let instruction_block = req
        .instruction
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\n<encoding_request>\n{}\n</encoding_request>\n", s))
        .unwrap_or_default();

    // Validate view up front so we don't enter the stream with garbage.
    if build_diagram_body(&req.view, &[]).is_none() {
        return ndjson_error(format!("unknown view: {}", req.view));
    }

    let initial_user_content = build_initial_user_content(
        &req.project_context,
        &chat_block,
        &base_block,
        &instruction_block,
    );
    let view = req.view.clone();

    let body_stream = async_stream::stream! {
        use futures_util::StreamExt;

        // Conversation state. Grows by 2 entries per turn after the first
        // (assistant response + user tool_results).
        let mut messages: Vec<serde_json::Value> = vec![json!({
            "role": "user",
            "content": initial_user_content,
        })];

        let mut total_emitted = 0usize;
        let mut total_output_tokens: u64 = 0;
        let mut total_cache_read: u64 = 0;
        let mut total_cache_write: u64 = 0;
        let mut final_stop_reason = String::from("(none)");
        let mut done_called = false;
        let mut turn_idx = 0usize;

        'outer: while turn_idx < MAX_DIAGRAM_TURNS {
            let body = match build_diagram_body(&view, &messages) {
                Some(b) => b,
                None => {
                    let err = format!("{}\n", json!({ "kind": "error", "message": "unknown view" }));
                    yield Ok::<_, std::io::Error>(axum::body::Bytes::from(err));
                    break 'outer;
                }
            };

            let resp = match crate::core::anthropic::post_messages(&api_key, &body).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("📐 ❌ anthropic request failed (turn {turn_idx}): {e}");
                    let err = format!(
                        "{}\n",
                        json!({ "kind": "error", "message": format!("anthropic request failed: {e}") })
                    );
                    yield Ok::<_, std::io::Error>(axum::body::Bytes::from(err));
                    break 'outer;
                }
            };

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                eprintln!("📐 ❌ anthropic returned {status} (turn {turn_idx}): {text}");
                let err = format!(
                    "{}\n",
                    json!({ "kind": "error", "message": format!("anthropic returned {status}: {text}") })
                );
                yield Ok::<_, std::io::Error>(axum::body::Bytes::from(err));
                break 'outer;
            }

            let mut bytes_stream = resp.bytes_stream();
            let mut byte_buf: Vec<u8> = Vec::new();
            // content-block index -> (tool id, tool name, partial JSON)
            let mut pending: std::collections::HashMap<u64, (String, String, String)> =
                Default::default();
            // tool_uses fully assembled this turn, in emission order, for
            // building the assistant reply we'll send back on next turn.
            let mut turn_tool_uses: Vec<(String, String, serde_json::Value)> = Vec::new();
            let mut turn_stop_reason = String::from("(none)");
            let mut turn_output_tokens: u64 = 0;

            while let Some(chunk_res) = bytes_stream.next().await {
                let chunk = match chunk_res {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("📐 ❌ stream chunk error (turn {turn_idx}): {e}");
                        break;
                    }
                };
                byte_buf.extend_from_slice(&chunk);

                while let Some(nl_pos) = byte_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = byte_buf.drain(..=nl_pos).collect();
                    let line_str =
                        String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                    let line = line_str.trim_end_matches('\r');

                    let Some(data) = line.strip_prefix("data: ") else { continue };
                    let event: serde_json::Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let Some(ty) = event.get("type").and_then(|v| v.as_str()) else { continue };

                    match ty {
                        "message_start" => {
                            if let Some(u) = event.pointer("/message/usage") {
                                total_cache_read += u.get("cache_read_input_tokens")
                                    .and_then(|v| v.as_u64()).unwrap_or(0);
                                total_cache_write += u.get("cache_creation_input_tokens")
                                    .and_then(|v| v.as_u64()).unwrap_or(0);
                            }
                        }
                        "content_block_start" => {
                            let Some(idx) = event.get("index").and_then(|v| v.as_u64()) else { continue };
                            let cb = event.get("content_block");
                            let block_type = cb
                                .and_then(|v| v.get("type"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            if block_type != "tool_use" {
                                eprintln!("📐 · non-tool content block: type={block_type}");
                                continue;
                            }
                            let id = cb
                                .and_then(|v| v.get("id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = cb
                                .and_then(|v| v.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            pending.insert(idx, (id, name, String::new()));
                        }
                        "content_block_delta" => {
                            let Some(idx) = event.get("index").and_then(|v| v.as_u64()) else { continue };
                            let Some(delta) = event.get("delta") else { continue };
                            if delta.get("type").and_then(|v| v.as_str()) != Some("input_json_delta") {
                                continue;
                            }
                            let Some(partial) = delta.get("partial_json").and_then(|v| v.as_str()) else { continue };
                            if let Some(entry) = pending.get_mut(&idx) {
                                entry.2.push_str(partial);
                            }
                        }
                        "content_block_stop" => {
                            let Some(idx) = event.get("index").and_then(|v| v.as_u64()) else { continue };
                            let Some((id, name, json_buf)) = pending.remove(&idx) else { continue };
                            let input: serde_json::Value = if json_buf.trim().is_empty() {
                                json!({})
                            } else {
                                match serde_json::from_str(&json_buf) {
                                    Ok(v) => v,
                                    Err(e) => {
                                        eprintln!("📐 ⚠ bad tool input for {name}: {e} :: {json_buf}");
                                        continue;
                                    }
                                }
                            };
                            if name == "done" {
                                done_called = true;
                            }
                            let line_obj = tool_use_to_ndjson(&name, input.clone());
                            total_emitted += 1;
                            let chunk = format!("{}\n", line_obj);
                            yield Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk));
                            turn_tool_uses.push((id, name, input));
                        }
                        "message_delta" => {
                            if let Some(sr) = event.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                                turn_stop_reason = sr.to_string();
                            }
                            if let Some(ot) = event.pointer("/usage/output_tokens").and_then(|v| v.as_u64()) {
                                turn_output_tokens = ot;
                            }
                        }
                        _ => {}
                    }
                }
            }

            total_output_tokens += turn_output_tokens;
            final_stop_reason = turn_stop_reason.clone();
            // Per-turn tool-name breakdown: diagnoses whether detail_block
            // events stream in turn 0 or get deferred to a later turn
            // (the "empty canvas for ~1.5min then a burst" symptom in the
            // focus view is the model splitting blocks across turns).
            let mut by_name: std::collections::BTreeMap<&str, usize> =
                std::collections::BTreeMap::new();
            for (_id, name, _input) in &turn_tool_uses {
                *by_name.entry(name.as_str()).or_insert(0) += 1;
            }
            eprintln!(
                "📐 · turn {turn_idx}: {} tool_uses {:?}, stop_reason={turn_stop_reason}, output_tokens={turn_output_tokens}",
                turn_tool_uses.len(),
                by_name
            );

            // Terminate when the model is finished. `done` is the
            // schema-level signal; `end_turn` means the model decided
            // there's nothing left even without calling done.
            if done_called || turn_stop_reason == "end_turn" {
                break 'outer;
            }
            // Unexpected stop_reason (max_tokens, refusal, etc) — log and
            // stop so we don't loop forever on a malformed response.
            if turn_stop_reason != "tool_use" {
                eprintln!("📐 ⚠ unexpected stop_reason '{turn_stop_reason}', breaking loop");
                break 'outer;
            }
            // If the turn emitted zero tool_uses but claimed tool_use,
            // continuing would resend the same prompt and burn tokens.
            if turn_tool_uses.is_empty() {
                eprintln!("📐 ⚠ turn ended with no tool_uses, breaking loop");
                break 'outer;
            }

            // Build the assistant reply (echo back the exact tool_uses
            // we just received — required by the API) and synthetic
            // tool_results so the next turn can keep going.
            let assistant_content: Vec<serde_json::Value> = turn_tool_uses
                .iter()
                .map(|(id, name, input)| {
                    json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input,
                    })
                })
                .collect();
            messages.push(json!({ "role": "assistant", "content": assistant_content }));

            let tool_results: Vec<serde_json::Value> = turn_tool_uses
                .iter()
                .map(|(id, _name, _input)| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": "ok",
                    })
                })
                .collect();
            messages.push(json!({ "role": "user", "content": tool_results }));

            turn_idx += 1;
        }

        eprintln!(
            "📐 ✅ stream done: {total_emitted} events across {} turns, stop_reason={final_stop_reason}, done_called={done_called}, output_tokens={total_output_tokens}, cache read={total_cache_read} write={total_cache_write} in {:?}",
            turn_idx + 1,
            started.elapsed()
        );
    };

    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body_stream))
        .unwrap()
        .into_response()
}

/// Single-line error fallback, served as NDJSON so the streaming client
/// reads it the same way as success chunks.
fn ndjson_error(message: String) -> Response {
    let body = format!(
        "{}\n",
        serde_json::json!({ "kind": "error", "message": message })
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .unwrap()
        .into_response()
}
