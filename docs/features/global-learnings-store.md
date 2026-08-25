---
id: 89
title: Global Learnings Store
group: v1.34.0 Features
---

**Commands:** Auto-triggered at phase completion; consumed by planner
**Config:** `features.global_learnings`

**Purpose:** Persist cross-session, cross-project learnings in a global store so the planner agent can learn from patterns across the entire project history — not just the current session.

**Requirements:**
- REQ-LEARN-01: Learnings MUST be auto-copied from `.planning/` to the global store at phase completion
- REQ-LEARN-02: The planner agent MUST receive relevant learnings at spawn time via injection
- REQ-LEARN-03: Injection MUST be capped by `learnings.max_inject` to avoid context bloat
- REQ-LEARN-04: Feature MUST be opt-in via `features.global_learnings: true`

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `features.global_learnings` | boolean | `false` | Enable cross-project learnings pipeline |
| `learnings.max_inject` | number | (system default) | Maximum learnings entries injected into planner |
