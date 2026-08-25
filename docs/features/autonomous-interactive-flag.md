---
id: 86
title: Autonomous `--interactive` Flag
group: v1.32 Features
---

**Flag:** `/gsd-autonomous --interactive`

**Purpose:** Lean-context autonomous mode that keeps discuss-phase interactive (user answers questions) while dispatching plan and execute as background agents on runtimes that support nested background dispatch; on Claude Code, plan and execute run inline to preserve worktree isolation and independent verification.

**Requirements:**
- REQ-INTERACT-01: `--interactive` MUST run discuss-phase inline with interactive questions (not auto-answered)
- REQ-INTERACT-02: `--interactive` MUST dispatch plan-phase and execute-phase as background agents for context isolation on runtimes where a backgrounded agent can spawn subagents; on Claude Code, plan and execute run inline
- REQ-INTERACT-03: `--interactive` MUST enable pipeline parallelism — discuss Phase N+1 while Phase N builds (applies on runtimes that support nested background dispatch; on Claude Code, discuss does not overlap planning/execution)
- REQ-INTERACT-04: Main context MUST only accumulate discuss conversations (lean context) on runtimes that support nested background dispatch; on Claude Code, inline plan/execute also accumulate in the main context

**Process:**
1. **Discuss inline** — Run discuss-phase in the main context with user interaction
2. **Dispatch** — On runtimes that support nested background dispatch: send plan and execute to background agents with fresh context windows. On Claude Code: run plan and execute inline.
3. **Pipeline** — On runtimes with background dispatch: while background agents build Phase N, begin discussing Phase N+1. On Claude Code: phases run sequentially.
