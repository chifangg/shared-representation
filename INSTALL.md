# Participant setup

Two parts: an install you do once before the session (about 20
minutes, mostly waiting for builds), and a one-command start on
session day.

## Before the session (once)

### 1. Prerequisites

- **Google Chrome.** Required. The tool writes the coding agent's
  edits back to your project folder through a browser API that only
  Chrome ships. Safari, Firefox, Arc and Brave will not work.
- **git**
- **Python 3.10 or newer**: `python3 --version` to check. Comes with
  macOS; on Windows install from python.org. The study's task project
  needs it on session day.
- **bun**: `curl -fsSL https://bun.sh/install | bash`
- **Rust toolchain**: `curl https://sh.rustup.rs -sSf | sh` then
  follow its prompts. On Windows this pulls Visual Studio Build
  Tools, which is a large download and may need administrator rights.
- **Claude Code CLI**, installed and logged in with your own
  subscription: `curl -fsSL https://claude.ai/install.sh | bash`
  (on Windows, in PowerShell: `irm https://claude.ai/install.ps1 | iex`),
  then run `claude` once and complete the login.

**For Windows users:** run everything below from Git Bash or WSL,
not PowerShell or cmd.

### 2. Clone and build

Build the frontend FIRST: the backend bakes it in when it compiles.

```
git clone https://github.com/chifangg/shared-representation.git shared-rep-tool
cd shared-rep-tool
bun install
bun run build
cd backend && cargo build --bins && cd ..
```

The Rust build takes several minutes the first time. That is normal.

### 3. Verify

```
./start-tool.sh --check
```

Every line should say ok. Copy the final `SETUP-OK ...` line into the
confirmation form we sent you. If anything says MISSING, run the
command it names and check again.

## On session day

Nothing to prepare. On the call, the moderator sends you an API key
and a link. Then:

```
./start-tool.sh
```

Paste the key when asked (typing is hidden, and the key stays out of
your shell history). Keep the window open, and open the moderator's
link in Chrome. That is the whole start.
