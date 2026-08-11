//! `execute` command path — start a brand-new Claude conversation.
//!
//! Spawns the `claude` subprocess with `-p <prompt>` + the optional
//! `--session-id` so the JSONL file matches the conversation UUID the
//! frontend tracks. Streams stdout line-by-line back through
//! `send_to_session`, drains stderr on a side task, and registers a
//! cancel channel so `/api/sessions/:id/cancel` can interrupt mid-run.

use serde_json::json;

use crate::web_server::AppState;

use super::args::{
    append_extra_args, resolve_default_tools, resolve_skip_permissions, ClaudeExtraArgs,
};
use super::binary::find_claude_binary_web;
use super::bridge::prepare_tool_bridge;
use super::session::{chat_sandbox_dir, send_to_session, spawn_stderr_drain};

pub(super) async fn execute_claude_command(
    project_path: String,
    prompt: String,
    model: String,
    session_id: String,
    client_session_id: Option<String>,
    extra: ClaudeExtraArgs,
    state: AppState,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    println!("[TRACE] execute_claude_command called:");
    println!("[TRACE]   project_path: {}", project_path);
    println!("[TRACE]   prompt length: {} chars", prompt.len());
    println!("[TRACE]   model: {}", model);
    println!("[TRACE]   session_id: {}", session_id);
    println!("[TRACE]   client_session_id: {:?}", client_session_id);

    // Send initial message
    println!("[TRACE] Sending initial start message");
    send_to_session(
        &state,
        &session_id,
        json!({
            "type": "start",
            "message": "Starting Claude execution..."
        })
        .to_string(),
    )
    .await;

    // Find Claude binary (simplified for web mode)
    println!("[TRACE] Finding Claude binary...");
    let claude_path = find_claude_binary_web().map_err(|e| {
        let error = format!("Claude binary not found: {}", e);
        println!("[TRACE] Error finding Claude binary: {}", error);
        error
    })?;
    println!("[TRACE] Found Claude binary: {}", claude_path);

    // Create Claude command
    println!("[TRACE] Creating Claude command...");
    let mut cmd = Command::new(&claude_path);
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.clone(),
        "--model".into(),
        model.clone(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    if resolve_skip_permissions(&extra) {
        args.push("--dangerously-skip-permissions".into());
    }
    if let Some(default_tools) = resolve_default_tools(&extra) {
        args.push("--tools".into());
        args.push(default_tools);
    }
    if let Some(ref cid) = client_session_id {
        args.push("--session-id".into());
        args.push(cid.clone());
    }
    // Wire the tool bridge so registered tools appear as MCP tools Claude
    // can call. The handle stays alive for the duration of this function
    // (RAII guard cleans up temp files + secret registration on drop).
    let bridge = prepare_tool_bridge(&state, &session_id).await?;
    if let Some(ref b) = bridge {
        args.push("--mcp-config".into());
        args.push(b.mcp_config_path.to_string_lossy().into_owned());
        if !b.allowed_tools.is_empty() {
            args.push("--allowed-tools".into());
            args.push(b.allowed_tools.join(","));
            // Keep Claude to the MCP tools only (no built-in Read/Bash on
            // the empty sandbox). Skipped in the dev skip-permissions flow.
            if !resolve_skip_permissions(&extra) {
                args.push("--disallowed-tools".into());
                args.push(super::args::BUILTIN_TOOL_DENYLIST.into());
            }
        }
    }
    append_extra_args(&mut args, &extra);
    cmd.args(&args);
    let effective_cwd = if !project_path.is_empty() {
        std::path::PathBuf::from(&project_path)
    } else {
        chat_sandbox_dir()
    };
    cmd.current_dir(&effective_cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Null stdin, not inherited. The prompt goes in via argv, so the CLI has
    // nothing to read here; inheriting the backend's stdin made it wait 3s
    // for input that never comes and then warn about it on every single
    // turn. Closing it says "there is no stdin" up front.
    cmd.stdin(std::process::Stdio::null());

    println!(
        "[TRACE] Command: {} {:?} (cwd: {})",
        claude_path,
        args,
        effective_cwd.display()
    );

    // Spawn Claude process
    println!("[TRACE] Spawning Claude process...");
    let mut child = cmd.spawn().map_err(|e| {
        let error = format!("Failed to spawn Claude: {}", e);
        println!("[TRACE] Spawn error: {}", error);
        error
    })?;
    println!("[TRACE] Claude process spawned successfully");

    // Get stdout and stderr. stderr is drained on a side task so error output
    // surfaces to the UI rather than piling up in the pipe and deadlocking
    // the child when the buffer fills.
    let stdout = child.stdout.take().ok_or_else(|| {
        println!("[TRACE] Failed to get stdout from child process");
        "Failed to get stdout".to_string()
    })?;
    let stdout_reader = BufReader::new(stdout);

    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_drain(state.clone(), session_id.clone(), stderr);
    }

    // Register a cancel channel so `/api/sessions/:id/cancel` can interrupt
    // this subprocess. The channel is deregistered when the loop exits.
    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::channel::<()>(1);
    state
        .cancel_channels
        .lock()
        .await
        .insert(session_id.clone(), cancel_tx);

    println!("[TRACE] Starting to read Claude output...");
    let mut lines = stdout_reader.lines();
    let mut line_count = 0;
    let mut cancelled = false;
    loop {
        tokio::select! {
            line_res = lines.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        line_count += 1;
                        let message = json!({
                            "type": "output",
                            "content": line,
                            "session_id": session_id,
                        })
                        .to_string();
                        send_to_session(&state, &session_id, message).await;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        println!("[TRACE] stdout read error: {}", e);
                        break;
                    }
                }
            }
            _ = cancel_rx.recv() => {
                println!("[TRACE] Cancel received for session {}", session_id);
                let _ = child.start_kill();
                cancelled = true;
                break;
            }
        }
    }

    // Drop the cancel registration before we wait on the child — the endpoint
    // should stop seeing this session as cancellable once we're past the read
    // loop.
    state.cancel_channels.lock().await.remove(&session_id);

    println!(
        "[TRACE] Finished reading Claude output ({} lines total, cancelled={})",
        line_count, cancelled
    );

    // Wait for process to complete (or die from our kill).
    let exit_status = child.wait().await.map_err(|e| {
        let error = format!("Failed to wait for Claude: {}", e);
        println!("[TRACE] Wait error: {}", error);
        error
    })?;

    if cancelled {
        send_to_session(
            &state,
            &session_id,
            json!({
                "type": "cancelled",
                "session_id": session_id,
            })
            .to_string(),
        )
        .await;
        return Ok(());
    }

    if !exit_status.success() {
        let error = format!(
            "Claude execution failed with exit code: {:?}",
            exit_status.code()
        );
        println!("[TRACE] Claude execution failed: {}", error);
        return Err(error);
    }

    println!("[TRACE] execute_claude_command completed successfully");
    Ok(())
}
