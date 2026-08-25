---
id: 41
title: Fast Mode
group: v1.27 Features
---

**Command:** `/gsd-fast [task description]`

**Purpose:** Execute trivial tasks inline without spawning subagents or generating PLAN.md files. For tasks too small to justify planning overhead: typo fixes, config changes, small refactors, forgotten commits, simple additions.

**Requirements:**
- REQ-FAST-01: System MUST execute the task directly in the current context without subagents
- REQ-FAST-02: System MUST produce an atomic git commit for the change
- REQ-FAST-03: System MUST track the task in `.planning/quick/` for state consistency
- REQ-FAST-04: System MUST NOT be used for tasks requiring research, multi-step planning, or verification

**When to use vs `/gsd-quick`:**
- `/gsd-fast` — One-sentence tasks executable in under 2 minutes (typo, config change, small addition)
- `/gsd-quick` — Anything needing research, multi-step planning, or verification
