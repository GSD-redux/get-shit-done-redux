---
id: 107
title: AI Eval Review
group: v1.35.0 Features
---

**Command:** `/gsd-eval-review [N]`

**Purpose:** Retroactively audit an executed AI phase's evaluation coverage against the `AI-SPEC.md` plan. Identifies gaps between planned and implemented evaluation before the phase is closed.

**Requirements:**
- REQ-EVALREVIEW-01: Review MUST read `AI-SPEC.md` from the specified phase
- REQ-EVALREVIEW-02: Each eval dimension MUST be scored as COVERED, PARTIAL, or MISSING
- REQ-EVALREVIEW-03: Output MUST include findings, gap descriptions, and remediation guidance
- REQ-EVALREVIEW-04: `EVAL-REVIEW.md` MUST be written to the phase directory

**Produces:** `{phase}-EVAL-REVIEW.md` with scored eval dimensions, gap analysis, and remediation steps
