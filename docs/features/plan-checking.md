---
id: 16
title: Plan Checking
group: Quality Assurance Features
---

**Purpose:** Goal-backward verification that plans will achieve phase objectives before execution.

**Requirements:**
- REQ-PLANCK-01: System MUST verify plans against 8 quality dimensions
- REQ-PLANCK-02: System MUST loop up to 3 iterations until plans pass
- REQ-PLANCK-03: System MUST produce specific, actionable feedback on failures
- REQ-PLANCK-04: System MUST be disableable via `workflow.plan_check: false`
