---
id: 169
title: Executor Session Survivability Dispatch
group: v1.33 Features
---

**Config:** `workflow.session_outlives_turn: false`

**Purpose:** Lets an integration that cannot keep its parent turn alive run
`execute-phase` executor and verifier agents in the foreground without changing
runtime selection or worktree ownership.

**Requirements:**
- REQ-3159-01: The absent/default setting preserves background dispatch in `execute-phase`.
- REQ-3159-02: An explicit `false` dispatches each executor and the phase verifier synchronously in the foreground.
- REQ-3159-03: A malformed or unavailable session-survivability setting fails
  closed to foreground dispatch; the registered absent-key default remains true.

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.session_outlives_turn` | boolean | `true` | Set `false` when the parent session does not survive the active turn. |
