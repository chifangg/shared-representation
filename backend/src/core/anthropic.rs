//! Shared HTTP path to the Anthropic Messages API.
//!
//! One process-wide client with keep-alive pooling disabled: NAT boxes
//! and the API's own idle timeouts intermittently kill pooled
//! connections, and reqwest surfaces reusing such a corpse as "error
//! sending request" on the NEXT call (POSTs are never auto-retried).
//! A fresh connection per request costs one TLS handshake, noise next
//! to multi-second model calls. On top of that, a single transport
//! failure is retried once so one flaky socket never bubbles up to
//! the UI as a scan/diagram error.

use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            // Fail a stuck CONNECT fast so the retry below can re-dial,
            // instead of the whole scan/diagram hanging forever on a
            // half-open socket (the flaky-network "Almost ready…" hang).
            // No overall/read timeout: the Messages call is a long-lived
            // SSE stream and must not be cut off mid-response.
            .connect_timeout(Duration::from_secs(12))
            .build()
            .expect("reqwest client construction cannot fail")
    })
}

/// POST a Messages-API body, retrying once on a transport-level send
/// failure. HTTP-level errors (4xx/5xx) come back as Ok(resp) and stay
/// the caller's business.
pub async fn post_messages(
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let send = || {
        client()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(body)
            .send()
    };
    // Retry a transport-level failure up to twice with a short backoff.
    // This flaky network throws "error sending request" / connect stalls
    // intermittently; one clean re-dial almost always succeeds.
    let mut last: Option<reqwest::Error> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            let backoff = 250 * attempt as u64;
            eprintln!(
                "⚠️ anthropic send failed (attempt {attempt}), retrying in {backoff}ms: {}",
                last.as_ref().map(|e| e.to_string()).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        match send().await {
            Ok(r) => return Ok(r),
            Err(e) => last = Some(e),
        }
    }
    Err(last.expect("loop runs at least once"))
}
