---
id: 76
title: Debug `--diagnose` Flag
group: v1.32 Features
---

**Flag:** `/gsd-debug --diagnose`

**Purpose:** Diagnosis-only mode that investigates without attempting fixes.

**Requirements:**
- REQ-DIAG-01: System MUST perform full debug investigation (hypotheses, evidence, root cause)
- REQ-DIAG-02: System MUST NOT attempt any code modifications
- REQ-DIAG-03: System MUST produce a diagnostic report with findings and recommended fixes
