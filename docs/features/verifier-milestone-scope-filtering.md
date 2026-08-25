---
id: 72
title: Verifier Milestone Scope Filtering
group: v1.32 Features
---

**Part of:** `/gsd-execute-phase` (verifier step)

**Purpose:** Distinguish between genuine gaps and items deferred to later phases, reducing false negatives in verification.

**Requirements:**
- REQ-VSCOPE-01: Verifier MUST check whether a gap is addressed in a later milestone phase
- REQ-VSCOPE-02: Gaps addressed in later phases MUST be marked as "deferred", not "gap"
- REQ-VSCOPE-03: Only genuine gaps (not covered by any future phase) MUST be reported as failures

**Process:**
1. **Verify** — Run standard goal-backward verification
2. **Filter** — Cross-reference detected gaps against later milestone phases
3. **Classify** — Mark deferred items separately from genuine gaps
