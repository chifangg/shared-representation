//! Batch ingest for the interaction log (user-study telemetry). The
//! frontend's `interactionLog` module buffers UI events and POSTs them
//! here; rows land in the `interaction_events` table keyed by the guest
//! cookie, so analysis can join conversation transcripts via
//! `chat_session` = conversation id. Read-path is deliberately absent:
//! analysis reads the sqlite file directly.

use axum::extract::{Path, Query, State as AxumState};
use axum::response::Html;
use axum::Json;
use serde::Deserialize;

use crate::core::conversations::{
    InteractionEventIn, InteractionEventRow, InteractionSessionRow,
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
