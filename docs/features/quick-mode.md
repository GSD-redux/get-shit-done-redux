---
id: 10
title: Quick Mode
group: Planning Features
---

**Command:** `/gsd-quick [--full] [--discuss] [--research]`

**Purpose:** Ad-hoc task execution with GSD guarantees but a faster path.

**Requirements:**
- REQ-QUICK-01: System MUST accept freeform task description
- REQ-QUICK-02: System MUST use same planner + executor agents as full workflow
- REQ-QUICK-03: System MUST skip research, plan checker, and verifier by default
- REQ-QUICK-04: `--full` flag MUST enable plan checking (max 2 iterations) and post-execution verification
- REQ-QUICK-05: `--discuss` flag MUST run lightweight pre-planning discussion
- REQ-QUICK-06: `--research` flag MUST spawn focused research agent before planning
- REQ-QUICK-07: Flags MUST be composable (`--discuss --research --full`)
- REQ-QUICK-08: System MUST track quick tasks in `.planning/quick/YYMMDD-xxx-slug/`
- REQ-QUICK-09: System MUST produce atomic commits for quick task execution
