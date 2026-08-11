//! `resume <session-id>` command path — pick up a specific past
//! conversation by its prior session UUID. `--resume <id>` plus the new
//! prompt goes to Claude Code; everything else mirrors execute/continue.

use serde_json::json;

use crate::web_server::AppState;

use super::args::{
    append_extra_args, resolve_default_tools, resolve_skip_permissions, ClaudeExtraArgs,
};
use super::binary::find_claude_binary_web;
use super::bridge::prepare_tool_bridge;
use super::session::{chat_sandbox_dir, send_to_session, spawn_stderr_drain};

pub(super) async fn resume_claude_command(
    project_path: String,
    claude_session_id: String,
    prompt: String,
    model: String,
    session_id: String,
    extra: ClaudeExtraArgs,
    state: AppState,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    send_to_session(
        &state,
        &session_id,
        json!({
            "type": "start",
            "message": "Resuming Claude session..."
        })
        .to_string(),
    )
    .await;

    let claude_path =
        find_claude_binary_web().map_err(|e| format!("Claude binary not found: {}", e))?;

    let mut cmd = Command::new(&claude_path);
    let mut args: Vec<String> = vec![
        "--resume".into(),
        claude_session_id.clone(),
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
    // See execute.rs: inherited stdin makes the CLI stall 3s and warn.
    cmd.stdin(std::process::Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stdout_reader = BufReader::new(stdout);

    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_drain(state.clone(), session_id.clone(), stderr);
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::channel::<()>(1);
    state
        .cancel_channels
        .lock()
        .await
        .insert(session_id.clone(), cancel_tx);

    let mut lines = stdout_reader.lines();
    let mut cancelled = false;
    loop {
        tokio::select! {
            line_res = lines.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        send_to_session(
                            &state,
                            &session_id,
                            json!({
                                "type": "output",
                                "content": line,
                                "session_id": session_id,
                            })
                            .to_string(),
                        )
                        .await;
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            _ = cancel_rx.recv() => {
                let _ = child.start_kill();
                cancelled = true;
                break;
            }
        }
    }

    state.cancel_channels.lock().await.remove(&session_id);

    let exit_status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for Claude: {}", e))?;

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
        return Err(format!(
            "Claude execution failed with exit code: {:?}",
            exit_status.code()
        ));
    }

    Ok(())
}
