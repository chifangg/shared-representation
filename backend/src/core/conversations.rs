//! SQLite-backed conversation persistence.
//!
//! Three tables:
//!
//! ```sql
//! conversations(id PK, session_cookie, created_at, last_active_at)
//! messages(id PK, conversation_id FK, ts, kind, content_json)
//! interaction_events(id PK, ts, server_ts, cookie, chat_session,
//!                    project_key, event, source, payload_json)
//! ```
//!
//! `interaction_events` is the user-study telemetry sink: the frontend
//! batches UI events to `POST /api/log` and analysis reads this table
//! straight out of the db file, joining transcripts via
//! `chat_session` = `conversations.id`. Both `ts` (client clock) and
//! `server_ts` (arrival) are unix MILLISECONDS; sequence analysis sorts
//! on client `ts` and uses `server_ts` only to sanity-check clock skew.
//!
//! A *conversation* is a single Claude subprocess lifetime keyed by the
//! client-generated `session_id` (same UUID we pass through to
//! `claude --session-id`). A *message* is either the user turn that
//! started a streaming run, or a stream-json event emitted by Claude.
//! We store stream events verbatim (raw JSON) so forks can evolve
//! rendering without needing a schema migration.
//!
//! The store is intentionally tiny — no SQL query builders, no ORM. Forks
//! that need richer persistence (per-user accounts, tool-call history
//! indexed separately, soft deletes) should extend this module or
//! replace it wholesale; the consumer surface is just a handful of `pub`
//! methods.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Resolve the SQLite path from the environment.
///
/// - `APP_DB_PATH` if set, verbatim.
/// - Else `$HOME/.claude-ui-app/app.db` (created on demand).
/// - Else `./claude-ui-app.db` relative to cwd as a last resort.
pub fn resolve_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("APP_DB_PATH") {
        return PathBuf::from(p);
    }
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".claude-ui-app");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("app.db");
    }
    PathBuf::from("./claude-ui-app.db")
}

#[derive(Clone)]
pub struct ConversationStore {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationRow {
    pub id: String,
    pub session_cookie: String,
    pub created_at: i64,
    pub last_active_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRow {
    pub id: i64,
    pub conversation_id: String,
    pub ts: i64,
    pub kind: String,
    pub content_json: serde_json::Value,
}

/// One interaction-log event as sent by the frontend's `interactionLog`
/// module. `payload` stays opaque JSON so new event kinds never need a
/// schema migration.
#[derive(Debug, Clone, Deserialize)]
pub struct InteractionEventIn {
    pub ts: i64,
    pub event: String,
    pub source: String,
    #[serde(default)]
    pub chat_session: Option<String>,
    #[serde(default)]
    pub project_key: Option<i64>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// One stored interaction-log row, as served to the /logs viewer.
/// `label` is a researcher-editable tag (the event name itself is never
/// rewritten, so analysis stays trustworthy).
#[derive(Debug, Clone, Serialize)]
pub struct InteractionEventRow {
    pub id: i64,
    pub ts: i64,
    pub server_ts: i64,
    pub cookie: String,
    pub chat_session: Option<String>,
    pub project_key: Option<i64>,
    pub event: String,
    pub source: String,
    pub payload: serde_json::Value,
    pub label: Option<String>,
    /// Researcher-assigned participant name, resolved through the
    /// session_participants mapping (one assignment covers every row of
    /// that chat session, past and future).
    pub participant: Option<String>,
}

/// One session group for the /logs viewer's folder view: every event
/// rolls up under its chat session, with the participant mapping applied.
#[derive(Debug, Clone, Serialize)]
pub struct InteractionSessionRow {
    pub chat_session: Option<String>,
    pub participant: Option<String>,
    pub events: i64,
    pub first_ts: i64,
    pub last_ts: i64,
}

impl ConversationStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("opening sqlite db at {path:?}"))?;
        ensure_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Idempotent upsert. Creates the conversation row if missing, bumps
    /// `last_active_at` if present. Guards against cookie swapping: if a
    /// row exists with a *different* `session_cookie`, returns an error
    /// rather than silently reassigning ownership.
    pub async fn ensure_conversation(
        &self,
        conversation_id: &str,
        session_cookie: &str,
    ) -> Result<()> {
        let now = now_secs();
        let conn = self.conn.lock().await;
        let existing: Option<String> = conn
            .query_row(
                "SELECT session_cookie FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .ok();
        match existing {
            Some(owner) if owner != session_cookie => {
                anyhow::bail!(
                    "conversation {} belongs to a different guest session",
                    conversation_id
                );
            }
            Some(_) => {
                conn.execute(
                    "UPDATE conversations SET last_active_at = ?1 WHERE id = ?2",
                    params![now, conversation_id],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO conversations (id, session_cookie, created_at, last_active_at) \
                     VALUES (?1, ?2, ?3, ?3)",
                    params![conversation_id, session_cookie, now],
                )?;
            }
        }
        Ok(())
    }

    /// Append one message. `kind` is free-form; we use `"user"` for user
    /// prompts and `"stream"` for Claude stream-json events, but forks
    /// can add their own categories (`"tool_ui_call"` etc.) without a
    /// migration since `content_json` is opaque.
    pub async fn append_message(
        &self,
        conversation_id: &str,
        kind: &str,
        content: &serde_json::Value,
    ) -> Result<i64> {
        let now = now_secs();
        let body = serde_json::to_string(content)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO messages (conversation_id, ts, kind, content_json) \
             VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, now, kind, body],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Conversations owned by `session_cookie`, newest-first.
    pub async fn list_for_cookie(&self, session_cookie: &str) -> Result<Vec<ConversationRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, session_cookie, created_at, last_active_at \
             FROM conversations WHERE session_cookie = ?1 ORDER BY last_active_at DESC",
        )?;
        let rows = stmt
            .query_map(params![session_cookie], |r| {
                Ok(ConversationRow {
                    id: r.get(0)?,
                    session_cookie: r.get(1)?,
                    created_at: r.get(2)?,
                    last_active_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Replay stored messages, oldest-first. `cookie_guard` enforces that
    /// the requesting guest owns the conversation — returns an empty list
    /// otherwise (not an error: we don't want to leak existence).
    pub async fn load_messages(
        &self,
        conversation_id: &str,
        cookie_guard: &str,
    ) -> Result<Vec<MessageRow>> {
        let conn = self.conn.lock().await;
        let owner: Option<String> = conn
            .query_row(
                "SELECT session_cookie FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .ok();
        if owner.as_deref() != Some(cookie_guard) {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, ts, kind, content_json \
             FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![conversation_id], |r| {
                let content_str: String = r.get(4)?;
                let content = serde_json::from_str::<serde_json::Value>(&content_str)
                    .unwrap_or(serde_json::Value::Null);
                Ok(MessageRow {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    ts: r.get(2)?,
                    kind: r.get(3)?,
                    content_json: content,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Admin-side message fetch for the research export. Deliberately NO
    /// cookie guard: the caller gates on the admin token instead, since
    /// the researcher exporting a participant's session is never that
    /// participant's browser.
    pub async fn messages_for_export(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<MessageRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, ts, kind, content_json \
             FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![conversation_id], |r| {
                let content_str: String = r.get(4)?;
                let content = serde_json::from_str::<serde_json::Value>(&content_str)
                    .unwrap_or(serde_json::Value::Null);
                Ok(MessageRow {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    ts: r.get(2)?,
                    kind: r.get(3)?,
                    content_json: content,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Resolve a session id that may be the 8-char prefix the viewer
    /// displays. Exact match wins over a prefix match.
    pub async fn resolve_conversation_id(&self, sid: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let full: Option<String> = conn
            .query_row(
                "SELECT id FROM conversations WHERE id = ?1 OR id LIKE ?2 \
                 ORDER BY (id = ?1) DESC LIMIT 1",
                params![sid, format!("{sid}%")],
                |r| r.get(0),
            )
            .ok();
        Ok(full)
    }

    /// Participant label assigned to a session, if any.
    pub async fn participant_for_session(&self, sid: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let p: Option<String> = conn
            .query_row(
                "SELECT participant FROM session_participants WHERE chat_session = ?1",
                params![sid],
                |r| r.get(0),
            )
            .ok();
        Ok(p)
    }

    /// Batch-insert interaction events for one guest cookie in a single
    /// transaction (the store shares one connection behind a mutex, so
    /// per-row inserts would hold the lock N times). Returns the count
    /// stored.
    pub async fn insert_interaction_events(
        &self,
        cookie: &str,
        events: &[InteractionEventIn],
    ) -> Result<usize> {
        // Milliseconds, matching the client `ts` in the same row. The rest
        // of this module keeps second precision; only this table mixes the
        // two clocks side by side, where mixed UNITS burned the analysis.
        let now = now_ms();
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO interaction_events \
                 (ts, server_ts, cookie, chat_session, project_key, event, source, payload_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for e in events {
                let body = serde_json::to_string(&e.payload)?;
                stmt.execute(params![
                    e.ts,
                    now,
                    cookie,
                    e.chat_session,
                    e.project_key,
                    e.event,
                    e.source,
                    body
                ])?;
            }
        }
        tx.commit()?;
        Ok(events.len())
    }

    /// Filtered page of interaction events, newest first, for the /logs
    /// viewer. `event_like` is a substring match; `source` / `session`
    /// are exact.
    pub async fn query_interaction_events(
        &self,
        event_like: Option<&str>,
        source: Option<&str>,
        session: Option<&str>,
        participant: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<InteractionEventRow>> {
        let conn = self.conn.lock().await;
        let mut sql = String::from(
            "SELECT e.id, e.ts, e.server_ts, e.cookie, e.chat_session, \
                    e.project_key, e.event, e.source, e.payload_json, \
                    e.label, sp.participant \
             FROM interaction_events e \
             LEFT JOIN session_participants sp \
                    ON sp.chat_session = e.chat_session \
             WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(ev) = event_like {
            sql.push_str(" AND e.event LIKE ?");
            args.push(Box::new(format!("%{ev}%")));
        }
        if let Some(s) = source {
            sql.push_str(" AND e.source = ?");
            args.push(Box::new(s.to_string()));
        }
        if let Some(s) = session {
            sql.push_str(" AND e.chat_session = ?");
            args.push(Box::new(s.to_string()));
        }
        if let Some(p) = participant {
            sql.push_str(" AND sp.participant = ?");
            args.push(Box::new(p.to_string()));
        }
        sql.push_str(" ORDER BY e.id DESC LIMIT ? OFFSET ?");
        args.push(Box::new(limit));
        args.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|b| &**b)),
                |r| {
                    let payload_str: String = r.get(8)?;
                    let payload = serde_json::from_str::<serde_json::Value>(&payload_str)
                        .unwrap_or(serde_json::Value::Null);
                    Ok(InteractionEventRow {
                        id: r.get(0)?,
                        ts: r.get(1)?,
                        server_ts: r.get(2)?,
                        cookie: r.get(3)?,
                        chat_session: r.get(4)?,
                        project_key: r.get(5)?,
                        event: r.get(6)?,
                        source: r.get(7)?,
                        payload,
                        label: r.get(9)?,
                        participant: r.get(10)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Delete one interaction event by id. Returns rows removed (0 or 1).
    pub async fn delete_interaction_event(&self, id: i64) -> Result<usize> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM interaction_events WHERE id = ?1",
            params![id],
        )?)
    }

    /// Assign a whole chat session to a participant (the /logs viewer's
    /// grouping). Upserts the mapping; None clears it. Every event row
    /// of that session, past and future, resolves to this name.
    pub async fn set_session_participant(
        &self,
        session: &str,
        participant: Option<&str>,
    ) -> Result<usize> {
        let conn = self.conn.lock().await;
        match participant {
            Some(p) => Ok(conn.execute(
                "INSERT INTO session_participants(chat_session, participant) \
                 VALUES(?1, ?2) \
                 ON CONFLICT(chat_session) \
                 DO UPDATE SET participant = excluded.participant",
                params![session, p],
            )?),
            None => Ok(conn.execute(
                "DELETE FROM session_participants WHERE chat_session = ?1",
                params![session],
            )?),
        }
    }

    /// Session-grouped rollup, most recently active first, for the
    /// viewer's default folder view.
    pub async fn list_interaction_sessions(
        &self,
    ) -> Result<Vec<InteractionSessionRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT e.chat_session, sp.participant, COUNT(*), \
                    MIN(e.ts), MAX(e.ts) \
             FROM interaction_events e \
             LEFT JOIN session_participants sp \
                    ON sp.chat_session = e.chat_session \
             GROUP BY e.chat_session, sp.participant \
             ORDER BY MAX(e.ts) DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(InteractionSessionRow {
                    chat_session: r.get(0)?,
                    participant: r.get(1)?,
                    events: r.get(2)?,
                    first_ts: r.get(3)?,
                    last_ts: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Permanently delete every event of one session (viewer bulk
    /// delete), plus its participant mapping. Returns events removed.
    pub async fn delete_session_events(&self, session: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM interaction_events WHERE chat_session = ?1",
            params![session],
        )?;
        let _ = conn.execute(
            "DELETE FROM session_participants WHERE chat_session = ?1",
            params![session],
        );
        Ok(n)
    }

    /// Set or clear the researcher label on one interaction event.
    pub async fn set_interaction_event_label(
        &self,
        id: i64,
        label: Option<&str>,
    ) -> Result<usize> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "UPDATE interaction_events SET label = ?1 WHERE id = ?2",
            params![label, id],
        )?)
    }
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversations (
             id              TEXT    PRIMARY KEY,
             session_cookie  TEXT    NOT NULL,
             created_at      INTEGER NOT NULL,
             last_active_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS conversations_by_cookie
             ON conversations(session_cookie, last_active_at DESC);

         CREATE TABLE IF NOT EXISTS messages (
             id              INTEGER PRIMARY KEY AUTOINCREMENT,
             conversation_id TEXT    NOT NULL,
             ts              INTEGER NOT NULL,
             kind            TEXT    NOT NULL,
             content_json    TEXT    NOT NULL,
             FOREIGN KEY(conversation_id) REFERENCES conversations(id)
         );
         CREATE INDEX IF NOT EXISTS messages_by_conv
             ON messages(conversation_id, id);

         CREATE TABLE IF NOT EXISTS interaction_events (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             ts           INTEGER NOT NULL,
             server_ts    INTEGER NOT NULL,
             cookie       TEXT    NOT NULL,
             chat_session TEXT,
             project_key  INTEGER,
             event        TEXT    NOT NULL,
             source       TEXT    NOT NULL,
             payload_json TEXT    NOT NULL,
             label        TEXT
         );
         CREATE INDEX IF NOT EXISTS interaction_by_cookie
             ON interaction_events(cookie, ts);
         CREATE INDEX IF NOT EXISTS interaction_by_session
             ON interaction_events(chat_session, id);
         CREATE TABLE IF NOT EXISTS session_participants (
             chat_session TEXT PRIMARY KEY,
             participant  TEXT NOT NULL
         );",
    )?;
    // Additive migration for dbs created before `label` existed: the
    // ALTER fails with "duplicate column name" once present; ignore it.
    let _ = conn.execute(
        "ALTER TABLE interaction_events ADD COLUMN label TEXT",
        [],
    );
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_store() -> ConversationStore {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        ConversationStore {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    #[tokio::test]
    async fn insert_and_list_roundtrip() {
        let s = mem_store().await;
        s.ensure_conversation("c1", "cookie-a").await.unwrap();
        s.append_message("c1", "user", &serde_json::json!({"text": "hello"}))
            .await
            .unwrap();
        s.append_message(
            "c1",
            "stream",
            &serde_json::json!({"type": "assistant", "content": "hi"}),
        )
        .await
        .unwrap();

        let msgs = s.load_messages("c1", "cookie-a").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].kind, "user");
        assert_eq!(msgs[1].kind, "stream");

        let convs = s.list_for_cookie("cookie-a").await.unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].id, "c1");
    }

    #[tokio::test]
    async fn load_messages_enforces_cookie_ownership() {
        let s = mem_store().await;
        s.ensure_conversation("c1", "cookie-a").await.unwrap();
        s.append_message("c1", "user", &serde_json::json!({"t": "x"}))
            .await
            .unwrap();

        // Different cookie → empty (not an error, don't leak existence).
        let msgs = s.load_messages("c1", "cookie-b").await.unwrap();
        assert!(msgs.is_empty());
    }

    #[tokio::test]
    async fn ensure_conversation_rejects_cross_cookie_reuse() {
        let s = mem_store().await;
        s.ensure_conversation("c1", "cookie-a").await.unwrap();
        let err = s
            .ensure_conversation("c1", "cookie-b")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("different guest session"));
    }
}
