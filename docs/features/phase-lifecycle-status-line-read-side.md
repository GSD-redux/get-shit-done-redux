---
id: 125
title: Phase-Lifecycle Status-Line Read-Side
group: v1.40.0 Features
---

**Purpose:** Surface phase orchestration state on the status-line. `parseStateMd()` reads four new STATE.md frontmatter fields and `formatGsdState()` renders in-flight, idle, and progress scenes. Write-side wiring follows in a later RC.

**Requirements:**
- REQ-LIFECYCLE-01: `parseStateMd()` reads four optional fields:
  - `active_phase` — phase number when an orchestrator is in flight
  - `next_action` — recommended next command when idle
  - `next_phases` — YAML flow array of next phase numbers
  - `progress` — nested `total_phases` / `completed_phases` / `percent` block
- REQ-LIFECYCLE-02: `formatGsdState()` checks the lifecycle fields in priority order and emits the first matching scene (Phase active → Idle next-recommended → Milestone complete → Default fallback).
- REQ-LIFECYCLE-03: All four fields default to undefined; existing STATE.md files render byte-for-byte identically.

**Reference issue:** [#2833](https://github.com/open-gsd/gsd-core/issues/2833) — see [`docs/STATE-MD-LIFECYCLE.md`](reference/state-md.md) for the full field reference and rendering rules.
