---
id: 95
title: Safe Undo
group: v1.34.0 Features
---

**Command:** `/gsd-undo --last N | --phase NN | --plan NN-MM`

**Purpose:** Roll back GSD phase or plan commits safely using the phase manifest and git log, with dependency checks and a hard confirmation gate before any revert is applied.

**Requirements:**
- REQ-UNDO-01: `--phase` mode MUST identify all commits for the phase via manifest and git log fallback
- REQ-UNDO-02: `--plan` mode MUST identify all commits for a specific plan
- REQ-UNDO-03: `--last N` mode MUST display recent GSD commits for interactive selection
- REQ-UNDO-04: System MUST check for dependent phases/plans before reverting
- REQ-UNDO-05: A confirmation gate MUST be shown before any git revert is executed
