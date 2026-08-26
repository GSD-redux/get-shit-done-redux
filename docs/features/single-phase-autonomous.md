---
id: 63
title: Single-Phase Autonomous
group: v1.31 Features
---

**Flag:** `/gsd-autonomous --only N`

**Purpose:** Execute just one phase autonomously instead of all remaining phases.

**Requirements:**
- REQ-ONLY-01: System MUST execute only the specified phase number when `--only N` is provided
- REQ-ONLY-02: System MUST follow the same discuss → plan → execute flow as full autonomous mode
- REQ-ONLY-03: System MUST stop after the specified phase completes

**Process:**
1. **Select** — Identify the target phase from `--only N` argument
2. **Execute** — Run full autonomous flow (discuss → plan → execute) for that single phase
3. **Stop** — Halt after the phase completes instead of advancing to the next
