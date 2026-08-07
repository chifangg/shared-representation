# Shared Representation

An in-browser code-exploration and code-editing tool that pairs a
Claude Code chat session with a live architectural diagram of an
uploaded project. The chat and the diagram drive each other:

- **Type into chat**, Claude edits files (`read_project_file`,
  `edit_project_file`, `write_project_file` client tools), and the
  diagram regenerates itself with a glow on whatever changed.
- **Draw an arrow** between two blocks, click a block's "⋯", or
  double-click empty canvas — the diagram dispatches a structured
  prompt and Claude either suggests options to pick from or executes
  the change directly.
- **Open a folder in Chrome** and edits write back to the real files
  on disk live, so an external test runner sees every change.

It's a research prototype for **shared representations** between human
and model: the chat is the model's surface, the diagram is the human's
surface, and they stay in sync.

> **Study participants:** you only need [INSTALL.md](INSTALL.md), the
> one-time setup plus the session-day start command.

```
┌────────┬──────────┬────────────┬──────────────────┐
│ Files  │   Code   │    Chat    │     Diagram      │
│ panel  │  panel   │    panel   │      panel       │
│        │          │            │                  │
│ upload │  syntax  │ stream-json│   React Flow +   │
│ + tree │ +editor  │   bubbles  │   dagre layout   │
└────────┴──────────┴────────────┴──────────────────┘
```

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.3+, Rust 1.70+ with cargo, and
the [Claude Code CLI](https://claude.ai/code) on `PATH`.

```bash
# Frontend
bun install
bun run dev         # http://localhost:1420 (proxies API + WS to :8080)

# Backend (separate shell)
cd backend
cargo run --bin claude-ui-app   # http://localhost:8080
```

Open `http://localhost:1420`. Upload a folder or a `.zip`, then start
chatting — Claude reads files on demand, the diagram streams in, and
visual edits trigger Claude turns.

For a production build: `bun run build && cd backend && cargo build --release`
(the Rust binary serves `dist/` on port 8080 with no need for the dev
proxy).

## Repository layout

```
src/
  App.tsx                   ProjectProvider → DiagramBusProvider → AppShell
  main.tsx                  registers read/write/edit_project_file client tools
  core/                     stable plumbing — see src/core/README.md
    apiAdapter.ts           WebSocket + REST seam to the backend
    hooks/useClaudeSession  stream-json → state, pending-tool queue
    components/             AppShell, ChatView, PromptInput, …
    tools/                  client-tool registry + the 3 project-file tools
    project.tsx             ProjectContext, file upload, code editor
  features/
    diagram/                the diagramming feature — see src/features/diagram/README.md
      types.ts              all diagram types
      protocol/             chat ↔ diagram contract (events, sentinels, parsers, bus)
      layout/               dagre layout pass + constants
      api/                  /api/diagram streaming fetchers
      hooks/                useDiagramStructureFetch, useChatSettleEffect, …
      components/           DiagramCanvas + overlays + panel + nodes
backend/                    Rust/Axum server, MCP tool-bridge, /api/diagram
docs/                       narrative documentation
```

## Study instrumentation

The prototype doubles as the apparatus for a between-subjects user
study. Everything below is built in and stays on the host machine:

- `?mode=tool` / `?mode=baseline` selects the condition per browser
  (baseline hides the diagram entirely); the active mode is logged
  with every project upload.
- Every user interaction (chat, files, diagram) lands as a typed,
  timestamped event in a local SQLite table, alongside the full
  conversation transcripts.
- `/logs?token=…` is the researcher view: live event stream, per-session
  timeline visualization, participant assignment, and one-click JSON
  export of a session's events plus transcript.

## Configuration

| Env var                     | Default | Purpose                                             |
| --------------------------- | ------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | —       | Claude API key for `claude-ui-app`                  |
| `VITE_DIAGRAM_DEBUG`        | empty   | Dev-only logger scopes (`*` for all). See below.    |
| `APP_CLIENT_TOOL_TIMEOUT_SECS` | 120  | How long Claude waits for a client tool response    |
| `APP_DB_PATH`               | `~/.claude-ui-app/app.db` | SQLite location (conversations + interaction log) |
| `APP_LOG_ADMIN_TOKEN`       | unset (open) | Gates the `/logs` viewer and its API when set  |
| `APP_SESSION_KEY`           | ephemeral | Signing key for guest-session cookies; set for persistence across restarts |

Diagram debug scopes:

```bash
VITE_DIAGRAM_DEBUG=recent-debug,diagram/structure,diagram/focus bun run dev
VITE_DIAGRAM_DEBUG=* bun run dev
```

Production builds strip all debug logs via Vite tree-shaking.

## Where to read next

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — layered model, dependency
  rule, data flow, state ownership.
- **[docs/diagram.md](docs/diagram.md)** — the diagramming protocol:
  bus topics, sentinels, JSON tails, sequence diagrams.
- **[docs/README.md](docs/README.md)** — hands-on walkthrough: upload a
  project, watch the diagram render, drive Claude through visual edits.
- **[docs/tools.md](docs/tools.md)** — adding new client / server tools.
- **[CLAUDE.md](CLAUDE.md)** — orientation for Claude Code when working
  on this repo.
- **[src/core/README.md](src/core/README.md)** — the stable surface
  every fork builds on.
- **[src/features/diagram/README.md](src/features/diagram/README.md)** —
  the diagram feature's internal map.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — workflow, coding standards,
  testing expectations.
