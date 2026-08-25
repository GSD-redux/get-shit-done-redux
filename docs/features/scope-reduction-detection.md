---
id: 64
title: Scope Reduction Detection
group: v1.31 Features
---

**Part of:** `/gsd-plan-phase`

**Purpose:** Prevent silent requirement dropping during plan generation with three-layer defense.

**Requirements:**
- REQ-SCOPE-01: System MUST prohibit planners from reducing scope without explicit justification
- REQ-SCOPE-02: System MUST have plan-checker verify requirement dimension coverage
- REQ-SCOPE-03: System MUST have orchestrator recover dropped requirements and re-inject them
- REQ-SCOPE-04: System MUST implement three-layer defense: planner prohibition, checker dimension, orchestrator recovery

**Process:**
1. **Prohibit** — Planner instructions explicitly forbid scope reduction
2. **Check** — Plan-checker verifies all phase requirements are covered in the plan
3. **Recover** — Orchestrator detects dropped requirements and re-injects them into the planning loop
