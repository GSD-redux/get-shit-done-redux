---
id: 109
title: External Code Review Command
group: v1.36.0 Features
---

**Command:** `/gsd-ship` (enhanced)

**Purpose:** Before the manual review step in `/gsd-ship`, automatically run an external code review command if configured. The command receives the diff and phase context via stdin and returns a JSON verdict (`APPROVED` or `REVISE`). Falls through to the existing manual review flow regardless of outcome.

**Requirements:**
- REQ-EXTREVIEW-01: `workflow.code_review_command` must be set to a command string; null means skip
- REQ-EXTREVIEW-02: Diff is generated against `BASE_BRANCH` with `--stat` summary included
- REQ-EXTREVIEW-03: Review prompt is piped via stdin (never shell-interpolated)
- REQ-EXTREVIEW-04: 120-second timeout; stderr captured on failure
- REQ-EXTREVIEW-05: JSON output parsed for `verdict`, `confidence`, `summary`, `issues` fields

**Configuration:** `workflow.code_review_command`
