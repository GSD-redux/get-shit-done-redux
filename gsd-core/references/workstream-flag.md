# Workstream Flag (`--ws`)

## Overview

The `--ws <name>` flag scopes GSD operations to a specific workstream, enabling
parallel milestone work by multiple Claude Code instances on the same codebase.

## Resolution Priority

1. `--ws <name>` flag (explicit, highest priority)
2. `GSD_WORKSTREAM` environment variable (per-instance)
3. Session-scoped active workstream pointer in temp storage (per runtime session / terminal),
   when that pointer exists and is non-blank
4. `.planning/active-workstream` file — consulted whenever step 3 has nothing to say: either
   there is no session identity at all, or there is one but it has never pointed at a
   workstream. A session that already has its own pointer (step 3) is never overridden by
   this step, even if that pointer is stale.
5. `null` — flat mode (no workstreams)

## Why session-scoped pointers exist

The shared `.planning/active-workstream` file is fundamentally unsafe when multiple
Claude/Codex instances are active on the same repo at the same time. One session can
silently repoint another session's `STATE.md`, `ROADMAP.md`, and phase paths.

GSD now prefers a session-scoped pointer keyed by runtime/session identity
(`GSD_SESSION_KEY`, `CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_SSE_PORT`, terminal session IDs,
or the controlling TTY). This keeps concurrent sessions isolated while preserving
legacy compatibility for runtimes that do not expose a stable session key.

A session that has never set its own pointer inherits `.planning/active-workstream`
(step 4) rather than silently falling back to flat mode — this does not weaken the
isolation guarantee above: inheritance only fires when a session's own pointer is
absent, and a session that has ever set one is never repointed by the shared file.

## Session Identity Resolution

When GSD resolves the session-scoped pointer in step 3 above, it uses this order:

1. Explicit runtime/session env vars such as `GSD_SESSION_KEY`, `CODEX_THREAD_ID`,
   `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SSE_PORT`, `OPENCODE_SESSION_ID`,
   `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID`,
   `TERM_SESSION_ID`, `WT_SESSION`, `TMUX_PANE`, and `ZELLIJ_SESSION_NAME`
2. `TTY` or `SSH_TTY` if the shell/runtime already exposes the terminal path
3. A single best-effort `tty` probe, but only when stdin is interactive

If none of those produce a stable identity, GSD does not keep probing. It falls
back directly to the legacy shared `.planning/active-workstream` file.

This matters in headless or stripped environments: when stdin is already
non-interactive, GSD intentionally skips shelling out to `tty` because that path
cannot discover a stable session identity and only adds avoidable failures on the
routing hot path.

## Pointer Lifecycle

Session-scoped pointers are intentionally lightweight and best-effort:

- Clearing a workstream for one session removes only that session's pointer file.
  This returns that session to step 4 of Resolution Priority above — it goes back
  to **inheriting** `.planning/active-workstream` (if a marker exists there), not
  to flat mode. A cleared session with no marker present resolves to `null`; a
  cleared session with a marker present resolves to whatever that marker names.
  To force flat mode for a cleared session, remove the shared marker file, or use
  an explicit override such as `--ws` / `GSD_WORKSTREAM` on the command in question.
- If that was the last pointer for the repo, GSD also removes the now-empty
  per-project temp directory
- If sibling session pointers still exist, the temp directory is left in place
- When a pointer refers to a workstream directory that no longer exists, GSD
  treats it as stale state: it removes that pointer file and resolves to `null`
  until the session explicitly sets a new active workstream again

GSD does not currently run a background garbage collector for historical temp
directories. Cleanup is opportunistic at the pointer being cleared or self-healed,
and broader temp hygiene is left to OS temp cleanup or future maintenance work.

## Routing Propagation

All workflow routing commands include `${GSD_WS}` which:
- Expands to `--ws <name>` when a workstream is active
- Expands to empty string in flat mode (backward compatible)

This ensures workstream scope chains automatically through the workflow:
`new-milestone → discuss-phase → plan-phase → execute-phase → transition`

## Directory Structure

```
.planning/
├── PROJECT.md          # Shared
├── config.json         # Shared
├── milestones/         # Shared
├── codebase/           # Shared
├── active-workstream   # Shared marker; inherited when a session has no pointer of its own
└── workstreams/
    ├── feature-a/      # Workstream A
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── feature-b/      # Workstream B
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

## CLI Usage

```bash
# All gsd_run query commands accept --ws
gsd_run query state.json --ws feature-a
gsd_run query find-phase 3 --ws feature-b

# Session-local switching without --ws on every command
GSD_SESSION_KEY=my-terminal-a gsd_run query workstream.set feature-a
GSD_SESSION_KEY=my-terminal-a gsd_run query state.json
GSD_SESSION_KEY=my-terminal-b gsd_run query workstream.set feature-b
GSD_SESSION_KEY=my-terminal-b gsd_run query state.json

# Workstream CRUD
gsd_run query workstream.create <name>
gsd_run query workstream.list
gsd_run query workstream.status <name>
gsd_run query workstream.complete <name>
```
