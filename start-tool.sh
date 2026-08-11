#!/usr/bin/env bash
# Study launcher for participants. Two modes:
#
#   ./start-tool.sh --check   verify the install and print the line to
#                             paste into the confirmation form
#   ./start-tool.sh           start the tool for a session
#
# Moderator escape hatch:
#   ./start-tool.sh --no-build   skip the frontend rebuild and run
#                                whatever is already in dist/
#
# The backend serves the frontend from dist/ on disk, NOT from src/, so a
# session runs whatever was last built. `cargo run` rebuilds the Rust, but
# nothing rebuilds the bundle, which meant a stale dist/ could silently
# serve a months-old UI from a current checkout. Both modes below now
# account for that: launching rebuilds first, and --check fails when the
# bundle is older than the sources it came from.
#
# See INSTALL.md for the one-time setup this assumes.
set -euo pipefail
cd "$(dirname "$0")"

# Everything the frontend bundle is built from. If any of these is newer
# than dist/index.html, the bundle on disk does not match the checkout.
frontend_sources() {
  local candidates=(src index.html vite.config.ts package.json tsconfig.json)
  local found=()
  local p
  for p in "${candidates[@]}"; do
    if [ -e "$p" ]; then found+=("$p"); fi
  done
  printf '%s\n' "${found[@]}"
}

# 0 (true) when dist/ is missing or older than any frontend source.
frontend_stale() {
  [ -f dist/index.html ] || return 0
  local newer
  # -quit stops at the first offender, so this stays fast on a big tree.
  newer=$(find $(frontend_sources) -newer dist/index.html -print -quit 2>/dev/null || true)
  [ -n "$newer" ]
}

if [ "${1:-}" = "--check" ]; then
  ok=1
  echo "commit: $(git rev-parse --short HEAD)"
  # Existing-but-stale is the dangerous case: the check would pass, the
  # confirmation form would look clean, and the session would still run an
  # old UI that does not match the commit printed above.
  if [ ! -f dist/index.html ]; then
    echo "frontend build: MISSING (run: bun run build)"
    ok=0
  elif frontend_stale; then
    echo "frontend build: STALE (run: bun run build)"
    ok=0
  else
    echo "frontend build: ok"
  fi
  if command -v bun >/dev/null 2>&1; then
    echo "bun: ok"
  else
    echo "bun: MISSING (needed to build the frontend, see INSTALL.md)"
    ok=0
  fi
  if [ -x backend/target/debug/claude-ui-app ]; then
    echo "backend build: ok"
  else
    echo "backend build: MISSING (run: cd backend && cargo build --bins)"
    ok=0
  fi
  if command -v claude >/dev/null 2>&1; then
    echo "claude cli: ok"
  else
    echo "claude cli: MISSING (install Claude Code and log in, see INSTALL.md)"
    ok=0
  fi
  if command -v python3 >/dev/null 2>&1; then
    echo "python3: ok"
  else
    echo "python3: MISSING (needed on session day; install per INSTALL.md)"
    ok=0
  fi
  if [ "$ok" = 1 ]; then
    echo "SETUP-OK $(git rev-parse --short HEAD)"
    echo
    echo "All good. Copy EVERY line above, from 'commit:' through"
    echo "'SETUP-OK', and paste them into the confirmation form."
  else
    echo "SETUP-INCOMPLETE"
    echo
    echo "Something is missing. Each MISSING line names the command that"
    echo "fixes it; run that, then run ./start-tool.sh --check again."
    echo "Stuck? Paste every line above into the confirmation form and"
    echo "we will help."
    exit 1
  fi
  exit 0
fi

# Rebuild the frontend unless explicitly told not to. `cargo run` below
# already keeps the backend current; this keeps the bundle current too, so
# "I pulled the changes but the tool looks the same" cannot happen.
if [ "${1:-}" = "--no-build" ]; then
  echo "Skipping the frontend build (--no-build)."
  if frontend_stale; then
    echo "WARNING: dist/ is older than src/. The tool will run an OLD interface."
  fi
elif ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed, so the frontend cannot be rebuilt."
  echo "See INSTALL.md. Continuing with whatever is already in dist/."
  if frontend_stale; then
    echo "WARNING: dist/ is older than src/. The tool will run an OLD interface."
  fi
elif frontend_stale; then
  echo "Building the interface (this takes a few seconds)..."
  bun run build
  echo "Interface built."
else
  echo "Interface is already up to date."
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # Prompted silently so the key never lands in the shell history. Not
  # every session gets a key, so an empty enter is a normal answer.
  echo "If the moderator sent you an API key, paste it now (typing stays hidden)."
  echo "If you did not get a key, just press enter."
  read -r -s -p "API key: " ANTHROPIC_API_KEY
  echo
  export ANTHROPIC_API_KEY
fi

echo "Starting the tool. Keep this window open."
echo "Now open, in Chrome, the exact link the moderator sends you."
cd backend && exec cargo run --bin claude-ui-app
