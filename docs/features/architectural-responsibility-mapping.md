---
id: 111
title: Architectural Responsibility Mapping
group: v1.36.0 Features
---

**Command:** `/gsd-plan-phase` (enhanced research step)

**Purpose:** During phase research, the phase-researcher now maps each capability to its architectural tier owner (browser, frontend server, API, CDN/static, database). The planner cross-references tasks against this map, and the plan-checker enforces tier compliance as Dimension 7c.

**Requirements:**
- REQ-ARM-01: Phase researcher produces an Architectural Responsibility Map table in RESEARCH.md (Step 1.5)
- REQ-ARM-02: Planner sanity-checks task-to-tier assignments against the map
- REQ-ARM-03: Plan checker validates tier compliance as Dimension 7c (WARNING for general mismatches, BLOCKER for security-sensitive ones)

**Produces:** `## Architectural Responsibility Map` section in `{phase}-RESEARCH.md`
