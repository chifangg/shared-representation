# Working on this repo

Short orientation for Claude Code when it's invoked to edit this
codebase. Read this before touching anything substantive.

## What this is

A research prototype + reusable template. Frontend: Vite + React 18 +
TS. Backend: Rust/Axum that spawns the `claude` CLI per session and
mediates tool calls via an MCP bridge. The headline feature is a live
architectural diagram of an uploaded project that drives Claude Code
visually.

For the high-level picture see
[ARCHITECTURE.md](ARCHITECTURE.md). For the diagram protocol see
[docs/diagram.md](docs/diagram.md).

## Layout

- `src/core/` — stable plumbing: apiAdapter, useClaudeSession,
  ChatView, the tool registry, project upload. **Don't put feature-
  specific code here.**
- `src/features/diagram/` — the diagramming feature. All
  React-Flow / dagre / diagram-protocol code lives here.
- `src/main.tsx` — registers the client tools the app actually uses:
  `read_project_file`, `write_project_file`, `edit_project_file`,
  `search_project_files` (in-browser regex grep), `run_project_tests`
  (posts the in-memory project to the backend's pytest sandbox at
  `/api/run-tests`), plus the diagram ops.
- `backend/src/` — Rust server. `main.rs` declares server / client
  tools; `web_server.rs` has the HTTP + WebSocket handlers; the
  `tool-bridge` binary in `bin/tool_bridge.rs` is the MCP shim.

Path alias: `@/*` → `src/*`.

## How to run

```bash
bun install
bun run dev                     # frontend on :1420
cd backend && cargo run --bin claude-ui-app   # backend on :8080
```

Vite proxies `/api/*` + `/ws/*` to the backend, so dev mode works
end-to-end without a separate build.

## Style conventions

- **Avoid em-dashes.** Do not use em-dashes (or en-dashes used as
  em-dashes) in anything you author: code comments, doc strings,
  prompt text, and especially user-facing UI copy. Rewrite with a
  period, comma, colon, or parentheses instead. This applies to new
  lines you write; leave pre-existing em-dashes alone unless you are
  already editing that line for another reason.

## How to verify a change

There's no automated test suite. Use the manual smoke checklist:

1. `bun run check` — typecheck + `cargo check`. Must pass before any
   commit.
2. Upload a small project (folder or `.zip`).
3. Exercise the relevant path. The high-leverage ones:
   - Chat reply (no edit) — diagram does NOT regen.
   - Chat edit (`edit_project_file` tool_use) — diagram regens with a
     glow on what changed.
   - Visual edit: draw arrow → intent gate → describe-yourself OR
     ask-suggestions → cards → execute → glow.
   - Adaptive focus: switch view, send a chat message, watch the side
     panel populate via the 1.2s-debounced delta fetch.

See [docs/diagram.md](docs/diagram.md) "Smoke test" for the full list.

## Gotchas

- **projectKey vs filesKey.** The diagram's reset effect is keyed on
  `projectKey` (USER upload/reset only), NOT on `files` (mutates every
  time Claude writes). If you change the reset key, a `write_project_file`
  mid-turn will wipe the diagram and trigger a re-fetch, ruining the
  user's spatial memory of where blocks sit.

- **Backend rebuild dance.** After editing any Rust file, you MUST:
  `cd backend && cargo build --bins`, restart `cargo run --bin
  claude-ui-app`, AND click "New chat" in the UI. The running binary
  is mmapped and won't pick up the rebuild; the previous Claude
  context caches tool results and masks the change.

- **Diagram debug logs are off by default.** Set
  `VITE_DIAGRAM_DEBUG=recent-debug` (or `*` for all scopes) before
  `bun run dev` to see the settle-effect / streaming-event logs.
  Production builds strip these entirely via Vite tree-shaking.

- **Don't bypass the bus.** Chat ↔ diagram coordination goes through
  `DiagramBusProvider` in [src/features/diagram/protocol/bus.tsx](src/features/diagram/protocol/bus.tsx).
  Don't add a new `window.dispatchEvent` for diagram coordination —
  add a new topic to `DiagramBusMessageMap` instead.

## What NOT to touch (without thinking)

- The `/api/diagram` request body / response shapes. They're the
  contract with the Rust backend; changes need to land in both
  trees simultaneously.
- The sentinel grammar in `protocol/sentinels.ts` (`<<diagram-edit ...>>`,
  `<<arrow ...>>`, etc.). The chat-side parser AND Claude's
  understanding of the prompt depend on the exact strings.
- The `useChatSettleEffect` ordering (synchronous compute before any
  setState — see comments inside). Subtle and load-bearing.

## What's safe to refactor

- Split a hook further if it gets unwieldy.
- Move a component into its own file.
- Reorganize the `components/{overlays,panel,nodes}` subfolders.
- Add unit tests for `protocol/*` (pure functions, currently
  manually tested only).
