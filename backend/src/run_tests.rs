//! Isolated pytest runner behind `POST /api/run-tests`.
//!
//! Why this exists: the chat agent has no shell (all CLI builtins are
//! denied), so it could not verify its edits and compensated with very
//! long "mentally simulate the test suite" thinking blocks, measured at
//! 5 to 9 minutes per study task. This endpoint gives the browser's
//! `run_project_tests` client tool a way to actually execute the suite:
//! the browser posts the CURRENT in-memory project, we materialize it
//! into a sandbox under the app data dir, build a private virtualenv
//! once, and run pytest there.
//!
//! Deliberately isolated: the sandbox never touches the participant's
//! working clone, and it knows nothing about the study runner's stage
//! state, so the agent cannot advance or corrupt study progress from
//! here. Worst case is a failed run whose error text goes back to the
//! model, which then falls back to reasoning as before.

use axum::Json;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

#[derive(Deserialize)]
pub struct RunTestsRequest {
    files: Vec<RunTestsFile>,
    /// Optional pytest target (a path, or path::test id). Defaults to
    /// `tests/study` when that directory exists, else `tests`.
    selector: Option<String>,
}

#[derive(Deserialize)]
pub struct RunTestsFile {
    path: String,
    content: String,
}

#[derive(Serialize)]
pub struct RunTestsResponse {
    ok: bool,
    exit_code: Option<i32>,
    output: String,
    duration_ms: u128,
}

/// One run at a time: concurrent materialization would interleave two
/// file sets in the same sandbox.
static RUN_LOCK: Mutex<()> = Mutex::const_new(());

/// Keep only the last part of a process's combined output. pytest -q
/// puts the counts and the failure summaries at the end, which is the
/// part the model needs; capping also keeps the tool_result well under
/// the CLI's ~50KB persist threshold.
const OUTPUT_TAIL: usize = 4000;

fn sandbox_root() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".claude-ui-app").join("test-sandbox")
}

fn venv_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("venv").join("Scripts").join("python.exe")
    } else {
        root.join("venv").join("bin").join("python")
    }
}

fn system_python() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

fn tail(s: &str) -> String {
    if s.len() <= OUTPUT_TAIL {
        return s.to_string();
    }
    // Byte-slice from a char boundary so multi-byte output can't panic.
    let mut start = s.len() - OUTPUT_TAIL;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[... earlier output omitted ...]\n{}", &s[start..])
}

fn fail(msg: String, started: std::time::Instant) -> Json<RunTestsResponse> {
    Json(RunTestsResponse {
        ok: false,
        exit_code: None,
        output: msg,
        duration_ms: started.elapsed().as_millis(),
    })
}

/// Path components must be plain names: no absolute paths, no `..`, no
/// empties. The browser sends project-relative paths, so anything else
/// is malformed or hostile.
fn sanitize(path: &str) -> Option<Vec<&str>> {
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return None;
    }
    Some(parts)
}

/// A pytest target like `tests/study/test_x.py::TestY::test_z`. Letters,
/// digits and a small punctuation set only, and never flag-shaped, so it
/// cannot smuggle extra arguments to pytest.
fn selector_ok(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:[]-".contains(c))
}

async fn run(
    mut cmd: Command,
    what: &str,
    secs: u64,
) -> Result<(Option<i32>, String), String> {
    cmd.kill_on_drop(true);
    let out = match timeout(Duration::from_secs(secs), cmd.output()).await {
        Err(_) => return Err(format!("{what} timed out after {secs}s")),
        Ok(Err(e)) => return Err(format!("{what} failed to start: {e}")),
        Ok(Ok(o)) => o,
    };
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push_str("\n");
        text.push_str(&err);
    }
    Ok((out.status.code(), text))
}

pub async fn run_tests(Json(req): Json<RunTestsRequest>) -> Json<RunTestsResponse> {
    let started = std::time::Instant::now();
    let _guard = RUN_LOCK.lock().await;

    let root = sandbox_root();
    let project = root.join("project");

    // Fresh project tree each run (the venv survives across runs). The
    // in-browser state is the source of truth, so a stale sandbox file
    // must never linger into the next run.
    if project.exists() {
        if let Err(e) = std::fs::remove_dir_all(&project) {
            return fail(format!("could not clear sandbox: {e}"), started);
        }
    }

    // Project paths carry the upload root's folder name as their first
    // segment; strip it when it is uniform so pyproject.toml lands at
    // the sandbox project root where pip expects it.
    let first_seg = |p: &str| p.split('/').next().unwrap_or("").to_string();
    let strip_root = {
        let mut segs = req.files.iter().map(|f| first_seg(&f.path));
        match segs.next() {
            Some(first) => segs.all(|s| s == first) && req.files.len() > 1,
            None => false,
        }
    };

    for f in &req.files {
        let Some(mut parts) = sanitize(&f.path) else {
            return fail(format!("malformed path: {}", f.path), started);
        };
        if strip_root {
            parts.remove(0);
        }
        if parts.is_empty() {
            continue;
        }
        let mut dest = project.clone();
        for p in &parts {
            dest.push(p);
        }
        if let Some(parent) = dest.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return fail(format!("mkdir failed for {}: {e}", f.path), started);
            }
        }
        if let Err(e) = std::fs::write(&dest, &f.content) {
            return fail(format!("write failed for {}: {e}", f.path), started);
        }
    }

    // Build the virtualenv once; reuse it afterwards. `pip install -e`
    // re-links the freshly materialized project each run and is a no-op
    // network-wise once pytest and pyyaml are cached.
    let py = venv_python(&root);
    if !py.exists() {
        let mut cmd = Command::new(system_python());
        cmd.arg("-m").arg("venv").arg(root.join("venv"));
        match run(cmd, "venv creation", 120).await {
            Err(e) => return fail(e, started),
            Ok((Some(0), _)) => {}
            Ok((code, out)) => {
                return fail(
                    format!("venv creation failed (exit {code:?}):\n{}", tail(&out)),
                    started,
                )
            }
        }
    }

    let mut pip = Command::new(&py);
    pip.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("-q")
        .arg("-e")
        .arg(&project)
        .arg("pytest")
        .arg("pyyaml");
    match run(pip, "pip install", 300).await {
        Err(e) => return fail(e, started),
        Ok((Some(0), _)) => {}
        Ok((code, out)) => {
            return fail(
                format!("dependency install failed (exit {code:?}):\n{}", tail(&out)),
                started,
            )
        }
    }

    let selector = match req.selector.as_deref() {
        Some(s) if selector_ok(s) => s.to_string(),
        Some(s) => return fail(format!("invalid selector: {s}"), started),
        None => {
            if project.join("tests").join("study").is_dir() {
                "tests/study".to_string()
            } else {
                "tests".to_string()
            }
        }
    };

    let mut pytest = Command::new(&py);
    pytest
        .arg("-m")
        .arg("pytest")
        .arg(&selector)
        .arg("-q")
        .arg("--color=no")
        .arg("-p")
        .arg("no:cacheprovider")
        .current_dir(&project);
    match run(pytest, "pytest", 300).await {
        Err(e) => fail(e, started),
        Ok((code, out)) => Json(RunTestsResponse {
            ok: code == Some(0),
            exit_code: code,
            output: tail(&out),
            duration_ms: started.elapsed().as_millis(),
        }),
    }
}
