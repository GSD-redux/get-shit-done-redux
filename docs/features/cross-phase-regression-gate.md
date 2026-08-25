---
id: 20
title: Cross-Phase Regression Gate
group: Quality Assurance Features
---

**Purpose:** Prevent regressions from compounding across phases by running prior phases' test suites after execution.

**Requirements:**
- REQ-REGR-01: System MUST run test suites from all completed prior phases after phase execution
- REQ-REGR-02: System MUST report any test failures as cross-phase regressions
- REQ-REGR-03: Regressions MUST be surfaced before post-execution verification
- REQ-REGR-04: System MUST identify which prior phase's tests were broken

**When:** Runs automatically during `/gsd-execute-phase` before the verifier step.
