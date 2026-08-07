#!/usr/bin/env bash
# Study launcher for participants. Two modes:
#
#   ./start-tool.sh --check   verify the install and print the line to
#                             paste into the confirmation form
#   ./start-tool.sh           start the tool for a session
#
# See INSTALL.md for the one-time setup this assumes.
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--check" ]; then
  ok=1
  echo "commit: $(git rev-parse --short HEAD)"
  if [ -f dist/index.html ]; then
    echo "frontend build: ok"
  else
    echo "frontend build: MISSING (run: bun run build)"
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
  if [ "$ok" = 1 ]; then
    echo "SETUP-OK $(git rev-parse --short HEAD)"
  else
    echo "SETUP-INCOMPLETE"
    exit 1
  fi
  exit 0
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # Prompted silently so the key never lands in the shell history.
  read -r -s -p "Paste the study API key (input stays hidden), then press enter: " ANTHROPIC_API_KEY
  echo
  export ANTHROPIC_API_KEY
fi

echo "Starting the tool. Keep this window open."
echo "Open the link the moderator gives you in Chrome, e.g. http://localhost:8080/?mode=tool"
cd backend && exec cargo run --bin claude-ui-app
