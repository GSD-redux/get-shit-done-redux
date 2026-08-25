---
id: 17
title: Post-Execution Verification
group: Quality Assurance Features
---

**Purpose:** Automated check that the codebase delivers what the phase promised.

**Requirements:**
- REQ-POSTVER-01: System MUST check against phase goals, not just task completion
- REQ-POSTVER-02: System MUST produce VERIFICATION.md with pass/fail analysis
- REQ-POSTVER-03: System MUST log issues for `/gsd-verify-work` to address
- REQ-POSTVER-04: System MUST be disableable via `workflow.verifier: false`
