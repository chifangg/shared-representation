//! HTTP/WebSocket server entry point. Owns [`AppState`] (the per-server
//! shared lookup tables), [`ApiResponse`] (the wire shape for JSON
//! endpoints), the route registration table, and the bootstrap helpers
//! `create_web_server` / `start_web_mode`.
//!
//! All request-handler bodies live in dedicated modules — `chat::*` for
//! Claude execution, `diagram::*` for the capability diagram pipeline,
//! `suggestions` / `conversations` / `tool_dispatch` for the small
//! standalone endpoints. This file should stay focused on wiring only.

use axum::http::Method;
use axum::{
    response::Html,
    routing::get,
    Router,
};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

#[derive(Clone)]
pub struct AppState {
    // Track active WebSocket sessions for Claude execution.
    pub active_sessions:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<String>>>>,
    // For each running Claude subprocess, a one-shot channel the cancel
    // endpoint sends on to request termination. Keyed by the session ID
    // that owns the subprocess (client-supplied where available, else the
    // WebSocket connection UUID).
    pub cancel_channels:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<()>>>>,
    // Conversation + message persistence keyed by guest-cookie session ID.
    pub store: crate::core::conversations::ConversationStore,
    // Per-cookie message-rate and concurrent-conversation budgets.
    pub rate_limiter: crate::core::ratelimit::RateLimiter,
    // The tool registry — dispatched via /__tools/dispatch from the
    // MCP bridge that runs next to each Claude subprocess.
    pub tools: crate::core::tools::ToolRegistry,
    // Per-spawn bridge secret → owning client session ID. Populated when a
    // tool-bridge is spawned, removed when the Claude subprocess exits.
    // /__tools/dispatch looks up the secret here to authorize and to know
    // which conversation a client-tool call belongs to so we can route
    // the `tool_call_for_ui` message to the right WebSocket.
    pub active_bridge_secrets:
        Arc<Mutex<std::collections::HashMap<String, String>>>,
    // In-flight client tool calls awaiting a `tool_result_from_ui` reply
    // from the frontend. Keyed by the server-generated `tool_call_id`
    // (not the MCP tool_use_id, which we don't see at dispatch time).
    pub pending_client_tools: Arc<
        Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>,
        >,
    >,
    // The loopback URL the tool-bridge should POST to. Derived from the
    // `host:port` passed to `create_web_server`.
    pub self_url: String,
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(error: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error),
        }
    }
}

/// Serve the React frontend.
///
/// Read from disk at request time, matching how `/assets` is served:
/// the compile-time `include_str!` copy references asset hashes from
/// whenever the backend was last built, so after a `bun run build` it
/// points at deleted files and the page loads blank. The embedded copy
/// stays only as a fallback for when the dist file is unreadable.
async fn serve_frontend() -> Html<String> {
    match tokio::fs::read_to_string("../dist/index.html").await {
        Ok(page) => Html(page),
        Err(_) => Html(include_str!("../../dist/index.html").to_string()),
    }
}

/// Create the web server.
///
/// `host` and `port` bind the listener; `cookies` supplies the HMAC signing
/// key for the guest-session cookie, which is the default identity layer
/// for customer-facing deployments. Forks that need admin-grade auth
/// (shared-secret or OAuth) should add their own layer on top of the
/// routes that need it — the guest cookie is the baseline, not the ceiling.
pub async fn create_web_server(
    host: std::net::IpAddr,
    port: u16,
    cookies: crate::core::cookies::CookieConfig,
    store: crate::core::conversations::ConversationStore,
    tools: crate::core::tools::ToolRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    // When binding 0.0.0.0 we still tell the bridge to call the server at
    // 127.0.0.1 — loopback-only dispatch is what makes the per-spawn secret
    // sufficient security.
    let loopback_host = if host.is_unspecified() {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    };
    let self_url = format!("http://{loopback_host}:{port}/__tools/dispatch");

    let state = AppState {
        active_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        cancel_channels: Arc::new(Mutex::new(std::collections::HashMap::new())),
        store,
        rate_limiter: crate::core::ratelimit::RateLimiter::from_env(),
        tools,
        active_bridge_secrets: Arc::new(Mutex::new(std::collections::HashMap::new())),
        pending_client_tools: Arc::new(Mutex::new(std::collections::HashMap::new())),
        self_url,
    };

    // CORS policy: browser credentials (cookies) must travel with every
    // request, so we can't use `Any` origin + allow_credentials. Same-origin
    // is the right default for a single-binary deployment that serves both
    // the UI and the API. Forks behind a CDN or with a separate frontend
    // origin should override this (add an env-driven allowlist).
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any);

    // Router surface the template actually uses. Everything else is the
    // fork's to add. Kept deliberately narrow: customer-facing apps don't
    // want to expose project pickers, session history APIs, or anything
    // else that leaks host state.
    let app = Router::new()
        // Serve the Vite build.
        .route("/", get(serve_frontend))
        .route("/index.html", get(serve_frontend))
        // Guest-scoped conversation history (persisted under the signed
        // cookie; not yet consumed by the frontend — kept for forks that
        // want to wire history-replay in `useClaudeSession`).
        .route(
            "/api/conversations",
            get(crate::conversations::list_conversations),
        )
        .route(
            "/api/conversations/{conversation_id}/messages",
            get(crate::conversations::load_conversation_messages),
        )
        // One-shot meta query: given goal + project context, ask Claude
        // for 3 contextual starter prompts. Returns JSON; not streamed.
        .route(
            "/api/suggestions",
            axum::routing::post(crate::suggestions::generate_suggestions),
        )
        .route(
            "/api/diagram",
            axum::routing::post(crate::diagram::generate_diagram),
        )
        // Read-only plain-language detail + change preview for a single
        // function (the bubble drill-in edit flow). One-shot JSON, not
        // streamed.
        .route(
            "/api/function-detail",
            axum::routing::post(crate::diagram::function_detail),
        )
        // Read-only plain-language explanation of one arrow (relationship)
        // between two blocks, for the pill drill-in lenses.
        .route(
            "/api/connection-detail",
            axum::routing::post(crate::diagram::connection_detail),
        )
        // Re-derive one block's caption + capabilities from its current
        // source, after a block-level edit (no full regen).
        .route(
            "/api/block-refresh",
            axum::routing::post(crate::diagram::block_refresh),
        )
        // Batch ingest for the interaction log (user-study telemetry).
        // Fire-and-forget from the frontend; rows keyed by guest cookie.
        .route(
            "/api/log",
            axum::routing::post(crate::logging::ingest_interaction_log),
        )
        // Isolated pytest sandbox for the run_project_tests client tool
        // (see run_tests.rs for why the agent needs it).
        .route(
            "/api/run-tests",
            axum::routing::post(crate::run_tests::run_tests),
        )
        // Researcher-facing log viewer + its admin endpoints (filter,
        // delete, label). Gated by APP_LOG_ADMIN_TOKEN when set.
        .route("/logs", get(crate::logging::logs_page))
        .route(
            "/api/log/query",
            get(crate::logging::query_interaction_log),
        )
        .route(
            "/api/log/{id}",
            axum::routing::delete(crate::logging::delete_interaction_log_row),
        )
        .route(
            "/api/log/{id}/label",
            axum::routing::post(crate::logging::label_interaction_log_row),
        )
        .route(
            "/api/log/session/{sid}/participant",
            axum::routing::post(crate::logging::assign_session_participant),
        )
        .route(
            "/api/log/session/{sid}/export",
            get(crate::logging::export_session_log),
        )
        .route(
            "/api/log/sessions",
            get(crate::logging::list_log_sessions),
        )
        .route(
            "/api/log/session/{sid}",
            axum::routing::delete(crate::logging::delete_log_session),
        )
        // Internal: called by the tool-bridge subprocess via loopback only.
        // Protected by the per-spawn X-Tool-Bridge-Secret header.
        .route(
            "/__tools/dispatch",
            axum::routing::post(crate::tool_dispatch::tools_dispatch),
        )
        // Cancel a running turn from the browser (used by
        // `useClaudeSession.cancel` + `reset`).
        .route(
            "/api/sessions/{sessionId}/cancel",
            get(crate::chat::cancel_claude_execution),
        )
        // WebSocket endpoint for real-time Claude execution.
        .route("/ws/claude", get(crate::chat::claude_websocket))
        // Serve static assets.
        .nest_service("/assets", ServeDir::new("../dist/assets"))
        .nest_service("/vite.svg", ServeDir::new("../dist/vite.svg"))
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn_with_state(
            cookies.clone(),
            crate::core::cookies::guest_cookie_layer,
        ))
        .with_state(state);

    let addr = SocketAddr::from((host, port));
    println!(
        "🌐 Listening on http://{}:{} (guest-cookie sessions)",
        host, port
    );

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Convenience entrypoint used by `main.rs`. Resolves the cookie signing
/// key + db path from the environment and hands off to
/// [`create_web_server`]. `tools` is the fork-supplied registry.
pub async fn start_web_mode(
    host: std::net::IpAddr,
    port: u16,
    tools: crate::core::tools::ToolRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    let cookies = crate::core::cookies::CookieConfig::from_env();
    let db_path = crate::core::conversations::resolve_db_path();
    println!("💾 Conversation store at {}", db_path.display());
    let store = crate::core::conversations::ConversationStore::open(&db_path)
        .map_err(|e| -> Box<dyn std::error::Error> { format!("db open: {e}").into() })?;
    create_web_server(host, port, cookies, store, tools).await
}
