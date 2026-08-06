//! Batch ingest for the interaction log (user-study telemetry). The
//! frontend's `interactionLog` module buffers UI events and POSTs them
//! here; rows land in the `interaction_events` table keyed by the guest
//! cookie, so analysis can join conversation transcripts via
//! `chat_session` = conversation id. Read-path is deliberately absent:
//! analysis reads the sqlite file directly.

use axum::extract::{Path, Query, State as AxumState};
use axum::response::Html;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::core::conversations::{
    InteractionEventIn, InteractionEventRow, InteractionSessionRow, MessageRow,
};
use crate::web_server::{ApiResponse, AppState};

/// Admin gate for the viewer endpoints (query / delete / label). Local
/// single-user runs need no setup: with APP_LOG_ADMIN_TOKEN unset,
/// everything is allowed. Set it when exposing the server on a LAN for
/// a study, and open /logs?token=THETOKEN.
fn admin_ok(token: Option<&str>) -> bool {
    match std::env::var("APP_LOG_ADMIN_TOKEN") {
        Ok(expected) if !expected.is_empty() => token == Some(expected.as_str()),
        _ => true,
    }
}

/// Hard cap per request. The client flushes every ~5s or 25 events, so
/// anything near this size is a bug or abuse, not a real batch.
const MAX_BATCH: usize = 500;

#[derive(Deserialize)]
pub struct LogBatch {
    pub events: Vec<InteractionEventIn>,
}

pub async fn ingest_interaction_log(
    AxumState(state): AxumState<AppState>,
    axum::Extension(guest): axum::Extension<crate::core::cookies::GuestSession>,
    Json(batch): Json<LogBatch>,
) -> Json<ApiResponse<usize>> {
    if batch.events.is_empty() {
        return Json(ApiResponse::success(0));
    }
    if batch.events.len() > MAX_BATCH {
        return Json(ApiResponse::error(format!(
            "batch too large ({} > {MAX_BATCH})",
            batch.events.len()
        )));
    }
    match state
        .store
        .insert_interaction_events(&guest.id, &batch.events)
        .await
    {
        Ok(n) => Json(ApiResponse::success(n)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// The researcher-facing log viewer (filter, inspect, label, delete).
pub async fn logs_page() -> Html<&'static str> {
    Html(include_str!("logs.html"))
}

#[derive(Deserialize)]
pub struct LogQuery {
    pub event: Option<String>,
    pub source: Option<String>,
    pub session: Option<String>,
    pub participant: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub token: Option<String>,
}

/// Filtered page of events, newest first, for the viewer.
pub async fn query_interaction_log(
    AxumState(state): AxumState<AppState>,
    Query(q): Query<LogQuery>,
) -> Json<ApiResponse<Vec<InteractionEventRow>>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let offset = q.offset.unwrap_or(0).max(0);
    fn non_empty(s: &Option<String>) -> Option<&str> {
        s.as_deref().map(str::trim).filter(|t| !t.is_empty())
    }
    match state
        .store
        .query_interaction_events(
            non_empty(&q.event),
            non_empty(&q.source),
            non_empty(&q.session),
            non_empty(&q.participant),
            limit,
            offset,
        )
        .await
    {
        Ok(rows) => Json(ApiResponse::success(rows)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct TokenOnly {
    pub token: Option<String>,
}

/// Delete one row by id (viewer's per-row delete button).
pub async fn delete_interaction_log_row(
    AxumState(state): AxumState<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<TokenOnly>,
) -> Json<ApiResponse<usize>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    match state.store.delete_interaction_event(id).await {
        Ok(n) => Json(ApiResponse::success(n)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct ParticipantBody {
    pub participant: Option<String>,
}

/// Assign (or clear) the participant for a whole chat session. One
/// assignment groups every row of that session, past and future.
pub async fn assign_session_participant(
    AxumState(state): AxumState<AppState>,
    Path(sid): Path<String>,
    Query(q): Query<TokenOnly>,
    Json(body): Json<ParticipantBody>,
) -> Json<ApiResponse<usize>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    let participant = body
        .participant
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    match state.store.set_session_participant(&sid, participant).await {
        Ok(n) => Json(ApiResponse::success(n)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// Session rollup for the viewer's default folder view.
pub async fn list_log_sessions(
    AxumState(state): AxumState<AppState>,
    Query(q): Query<TokenOnly>,
) -> Json<ApiResponse<Vec<InteractionSessionRow>>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    match state.store.list_interaction_sessions().await {
        Ok(rows) => Json(ApiResponse::success(rows)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// Permanently delete a whole session's events (viewer bulk delete;
/// the page requires typing the session prefix before calling this).
pub async fn delete_log_session(
    AxumState(state): AxumState<AppState>,
    Path(sid): Path<String>,
    Query(q): Query<TokenOnly>,
) -> Json<ApiResponse<usize>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    match state.store.delete_session_events(&sid).await {
        Ok(n) => Json(ApiResponse::success(n)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct LabelBody {
    pub label: Option<String>,
}

/// Set or clear the researcher label on one row. The event name itself
/// is never rewritten, so analysis keys stay trustworthy.
pub async fn label_interaction_log_row(
    AxumState(state): AxumState<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<TokenOnly>,
    Json(body): Json<LabelBody>,
) -> Json<ApiResponse<usize>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    match state.store.set_interaction_event_label(id, label).await {
        Ok(n) => Json(ApiResponse::success(n)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// One-file research export for a session: the interaction-event
/// sequence plus a distilled transcript, with participant + study mode
/// attached. This is the input to the analysis / figure scripts, so the
/// shape favors flat chronological arrays over the raw storage forms.
#[derive(Serialize)]
pub struct SessionExport {
    pub session: String,
    pub participant: Option<String>,
    pub mode: Option<String>,
    pub exported_at_ms: i64,
    pub events: Vec<InteractionEventRow>,
    pub transcript: Vec<Value>,
}

/// Flatten stored chat rows into readable turns.
///
/// `user` rows carry the prompt verbatim. `stream` rows wrap Claude
/// Code's stream-json events; only three inner shapes matter here:
/// assistant messages (text + tool_use blocks), and result marks (turn
/// boundary + success). The CLI may re-emit the SAME assistant message
/// id as its content grows, so assistant entries are deduped by message
/// id keeping the LAST version, in first-seen order.
fn distill_transcript(rows: &[MessageRow]) -> Vec<Value> {
    // (key, value) pairs in first-seen order; re-seen keys update in place.
    let mut order: Vec<String> = Vec::new();
    let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut anon = 0usize;

    let mut push = |order: &mut Vec<String>, by_key: &mut std::collections::HashMap<String, Value>, key: Option<String>, v: Value| {
        let k = key.unwrap_or_else(|| {
            anon += 1;
            format!("__anon_{anon}")
        });
        if !by_key.contains_key(&k) {
            order.push(k.clone());
        }
        by_key.insert(k, v);
    };

    for m in rows {
        match m.kind.as_str() {
            "user" => {
                let text = m
                    .content_json
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                push(
                    &mut order,
                    &mut by_key,
                    None,
                    json!({ "ts": m.ts, "role": "user", "text": text }),
                );
            }
            "stream" => {
                let Some(inner) = m
                    .content_json
                    .get("content")
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                else {
                    continue;
                };
                match inner.get("type").and_then(|v| v.as_str()) {
                    Some("assistant") => {
                        let Some(blocks) =
                            inner.pointer("/message/content").and_then(|v| v.as_array())
                        else {
                            continue;
                        };
                        let mut text = String::new();
                        let mut tools: Vec<Value> = Vec::new();
                        for b in blocks {
                            match b.get("type").and_then(|v| v.as_str()) {
                                Some("text") => {
                                    if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                                        if !text.is_empty() {
                                            text.push('\n');
                                        }
                                        text.push_str(t);
                                    }
                                }
                                Some("tool_use") => {
                                    let name =
                                        b.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                                    let path = b
                                        .pointer("/input/path")
                                        .and_then(|v| v.as_str());
                                    tools.push(json!({ "name": name, "path": path }));
                                }
                                _ => {}
                            }
                        }
                        if text.is_empty() && tools.is_empty() {
                            continue;
                        }
                        let id = inner
                            .pointer("/message/id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        push(
                            &mut order,
                            &mut by_key,
                            id,
                            json!({ "ts": m.ts, "role": "assistant", "text": text, "tools": tools }),
                        );
                    }
                    Some("result") => {
                        let success = !inner
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        push(
                            &mut order,
                            &mut by_key,
                            None,
                            json!({
                                "ts": m.ts,
                                "role": "result",
                                "success": success,
                                "duration_ms": inner.get("duration_ms"),
                            }),
                        );
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// GET /api/log/session/{sid}/export: the one-click research bundle.
/// Accepts the full conversation id or the 8-char prefix the viewer
/// shows. Admin-gated like every other read endpoint here.
pub async fn export_session_log(
    AxumState(state): AxumState<AppState>,
    Path(sid): Path<String>,
    Query(q): Query<TokenOnly>,
) -> Json<ApiResponse<SessionExport>> {
    if !admin_ok(q.token.as_deref()) {
        return Json(ApiResponse::error("bad admin token".to_string()));
    }
    let full = match state.store.resolve_conversation_id(sid.trim()).await {
        Ok(Some(id)) => id,
        Ok(None) => {
            return Json(ApiResponse::error(format!("no session matches {sid}")))
        }
        Err(e) => return Json(ApiResponse::error(e.to_string())),
    };

    let participant = state
        .store
        .participant_for_session(&full)
        .await
        .unwrap_or(None);
    // Newest-first from the store; the export wants chronological.
    let mut events = match state
        .store
        .query_interaction_events(None, None, Some(&full), None, 100_000, 0)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return Json(ApiResponse::error(e.to_string())),
    };
    events.reverse();
    // The study condition rides in as a logged event; surface it as a
    // top-level field so analysis never has to dig for it.
    let mode = events
        .iter()
        .filter(|e| e.event == "study-mode")
        .filter_map(|e| {
            e.payload
                .get("mode")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .next_back();

    let transcript = match state.store.messages_for_export(&full).await {
        Ok(rows) => distill_transcript(&rows),
        Err(e) => return Json(ApiResponse::error(e.to_string())),
    };

    Json(ApiResponse::success(SessionExport {
        session: full,
        participant,
        mode,
        exported_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        events,
        transcript,
    }))
}
