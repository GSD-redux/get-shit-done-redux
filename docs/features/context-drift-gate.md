---
id: 3348
title: Context Drift Gate
group: v1.7.0 Features
---

**Purpose:** Warns (or optionally blocks) before `/gsd:plan-phase` reuses an existing
`RESEARCH.md`, `PATTERNS.md`, `VALIDATION.md`, or `SPEC.md` that predates a decision added to the
phase's `CONTEXT.md` after that artifact was derived from it. Deterministic — compares git commit
time (falling back to mtime for uncommitted edits), no model call. Sibling to the existing
codebase-drift and schema-drift gates in the `drift` capability. Configure with
`workflow.context_drift_precheck` (on/off) and `workflow.context_drift_action` (`warn`/`block`).
