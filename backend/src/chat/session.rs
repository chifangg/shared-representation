//! WebSocket session lookup + the `/api/sessions/:id/cancel` route.
//!
//! `send_to_session` is the one place the chat code writes back to the
//! browser: it persists the outbound JSON as a stream event (so reloads
//! can replay) and then forwards via the per-session mpsc the WebSocket
//! handler set up.

use axum::extract::{Path, State as AxumState};
use axum::Json;

use crate::web_server::{ApiResponse, AppState};

/// Empty, non-git directory used as the cwd for spawned Claude Code
/// chat subprocesses when no explicit `project_path` is supplied.
///
/// Without this, the subprocess inherits the backend's cwd (usually
/// `backend/` inside the harness repo). Claude Code then auto-injects
/// the parent repo's gitStatus + file listing into the inner Claude's
/// system context, which leaks harness internals into the user-facing
/// chat (e.g. the model starts guessing at `../src/styles.css`).
/// Pointing cwd at an empty, non-git dir blocks that auto-introspection.
///
/// Idempotent: `create_dir_all` is a no-op if it already exists.
pub(super) fn chat_sandbox_dir() -> std::path::PathBuf {
    let base = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join(".claude-ui-app").join("chat-sandbox");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Drop ANSI SGR / CSI escape sequences from a subprocess line.
///
/// The `claude` CLI colours its stderr, and those raw `\x1b[33m` codes
/// were reaching the chat panel verbatim (the UI renders the text, not a
/// terminal). Stripping here keeps the escape handling in one place
/// rather than in every consumer of the message.
pub(super) fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // ESC [ ... <final byte in @..~> is the CSI form the CLI uses;
        // for any other ESC sequence, skipping the next char is enough
        // to keep a stray escape out of the UI.
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Forward a spawned Claude subprocess' stderr to the browser, one line
/// per message, on a side task.
///
/// Draining matters for more than visibility: an unread stderr pipe fills
/// and deadlocks the child. Shared by all three spawn paths (execute /
/// continue / resume) so their behaviour cannot drift apart.
pub(super) fn spawn_stderr_drain(
    state: AppState,
    session_id: String,
    stderr: tokio::process::ChildStderr,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = strip_ansi(&line);
            if line.trim().is_empty() {
                continue;
            }
            eprintln!("[CLAUDE STDERR] {}", line);
            send_to_session(
                &state,
                &session_id,
                serde_json::json!({
                    "type": "error",
                    "message": line,
                    "session_id": session_id,
                })
                .to_string(),
            )
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strips_the_cli_stdin_warning_colours() {
        let raw = "\u{1b}[33mWarning: no stdin data received in 3s.\u{1b}[39m";
        assert_eq!(strip_ansi(raw), "Warning: no stdin data received in 3s.");
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(strip_ansi("plain error"), "plain error");
    }

    #[test]
    fn handles_multi_parameter_and_trailing_escapes() {
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m tail"), "red tail");
        assert_eq!(strip_ansi("done\u{1b}["), "done");
    }
}

pub async fn send_to_session(state: &AppState, session_id: &str, message: String) {
    // Persist the outbound message as a stream event so reloads can replay
    // the conversation. Best-effort: failures log but don't block delivery.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&message) {
        if let Err(e) = state
            .store
            .append_message(session_id, "stream", &v)
            .await
        {
            log::warn!("failed to persist stream event for {session_id}: {e}");
        }
    }

    let sessions = state.active_sessions.lock().await;
    if let Some(sender) = sessions.get(session_id) {
        if let Err(e) = sender.send(message).await {
            println!("[TRACE] Failed to send message: {}", e);
        }
    } else {
        println!("[TRACE] Session {} not found in active sessions", session_id);
    }
}

/// Cancel a running Claude subprocess by session ID. Looks up the mpsc
/// cancel channel registered by the spawn function and sends on it; the
/// spawn task picks the signal up via `tokio::select!`, calls `start_kill()`
/// on the child, and emits a `cancelled` event to the WebSocket.
pub async fn cancel_claude_execution(
    Path(session_id): Path<String>,
    AxumState(state): AxumState<AppState>,
) -> Json<ApiResponse<()>> {
    let tx_opt = state
        .cancel_channels
        .lock()
        .await
        .get(&session_id)
        .cloned();
    match tx_opt {
        Some(tx) => {
            // `send` returns Err only if the receiver is gone, which means
            // the process already exited — treat as success either way.
            let _ = tx.send(()).await;
            Json(ApiResponse::success(()))
        }
        None => Json(ApiResponse::error(format!(
            "No active session to cancel: {}",
            session_id
        ))),
    }
}

