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
- **Claude Code CLI**: `curl -fsSL https://claude.ai/install.sh | bash`
  (on Windows, in PowerShell: `irm https://claude.ai/install.ps1 | iex`).
  Then run `claude` once. It will ask you to select a login method
  (subscription, Console account, or a 3rd-party platform). Seeing this
  screen is normal and expected:
  - If you already have a Claude subscription (Pro or Max), pick
    option 1 and complete the login.
  - If you do not, exit this screen (press Esc or Ctrl+C) and continue
    with the rest of this guide; everything below works without logging
    in. You do not need to buy anything, and you will not be asked to
    pay: as the study's compensation, we gift you one month of Claude
    Pro at the start of the session, and you will log in then.

**For Windows users:** run everything below from Git Bash or WSL,
not PowerShell or cmd.

**After installing the tools above, close this terminal and open a
fresh one.** The installers only update your shell's configuration;
the terminal you ran them in does not see the new commands yet. In
the new terminal, confirm each one answers:

```
bun --version
cargo --version
claude --version
```

If one still says "command not found" even in the fresh terminal:
for cargo, run `source "$HOME/.cargo/env"` and check again. For bun
or claude, re-run its install command from the list above, then check
again. If it still will not answer, note it in the confirmation form
and we will sort it out with you before the session.

### 2. Clone and build

Build the frontend FIRST: the backend bakes it in when it compiles.

The `cd ~/Desktop` line matters: it anchors you in a fixed place, so
if you ever re-run this section you will not clone the project into
itself by accident. If `~/Desktop/shared-rep-tool` already exists,
skip the clone line (or delete that folder first and clone fresh).
On WSL there is no `~/Desktop`; use `cd ~` there instead, and
remember your folder is `~/shared-rep-tool` wherever a path below
says `~/Desktop/shared-rep-tool`.

```
cd ~/Desktop
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

It prints a short report. A good one looks like this (your commit id
will differ):

```
commit: 6efe94e
frontend build: ok
backend build: ok
claude cli: ok
python3: ok
SETUP-OK 6efe94e
```

Copy that whole report, every line from `commit:` through `SETUP-OK`,
and paste it into the confirmation form we sent you. If any line says
MISSING, run the command that line names, then check again.

## On session day

Nothing to prepare. On the call, the moderator sends you an API key
and a link. Then, in a terminal:

```
cd ~/Desktop/shared-rep-tool
./start-tool.sh
```

Paste the key when asked (typing is hidden, and the key stays out of
your shell history). Keep the window open, and open the moderator's
link in Chrome. That is the whole start.
