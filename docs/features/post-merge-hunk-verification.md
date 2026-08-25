---
id: 103
title: Post-Merge Hunk Verification
group: v1.34.0 Features
---

**Command:** `/gsd-update --reapply`

**Purpose:** After applying local patches post-update, verify that all hunks were actually applied by comparing the expected patch content against the live filesystem. Surface any dropped or partial hunks immediately rather than silently accepting incomplete merges.

**Requirements:**
- REQ-PATCH-VERIFY-01: Reapply-patches MUST verify each hunk was applied after the merge
- REQ-PATCH-VERIFY-02: Dropped or partial hunks MUST be reported to the user with file and line context
- REQ-PATCH-VERIFY-03: Verification MUST run after all patches are applied, not per-patch
