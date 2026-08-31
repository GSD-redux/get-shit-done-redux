---
id: 21
title: Requirements Coverage Gate
group: Quality Assurance Features
---

**Purpose:** Ensure all phase requirements are covered by at least one plan before planning completes.

**Requirements:**
- REQ-COVGATE-01: System MUST extract all requirement IDs assigned to the phase from ROADMAP.md
- REQ-COVGATE-02: System MUST verify each requirement appears in at least one PLAN.md
- REQ-COVGATE-03: Uncovered requirements MUST block planning completion
- REQ-COVGATE-04: System MUST report which specific requirements lack plan coverage

**When:** Runs automatically at the end of `/gsd-plan-phase` after the plan checker loop.
