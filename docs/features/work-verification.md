---
id: 6
title: Work Verification
group: Core Features
---

**Command:** `/gsd-verify-work [N]`

**Purpose:** User acceptance testing — walk the user through testing each deliverable and auto-diagnose failures.

**Requirements:**
- REQ-VERIFY-01: System MUST extract testable deliverables from the phase
- REQ-VERIFY-02: System MUST present deliverables one at a time for user confirmation
- REQ-VERIFY-03: System MUST spawn debug agents to diagnose failures automatically
- REQ-VERIFY-04: System MUST create fix plans for identified issues
- REQ-VERIFY-05: System MUST inject cold-start smoke test for phases modifying server/database/seed/startup files
- REQ-VERIFY-06: System MUST produce UAT.md with pass/fail results

**Produces:** `{phase}-UAT.md` — User acceptance test results, plus fix plans if issues found
