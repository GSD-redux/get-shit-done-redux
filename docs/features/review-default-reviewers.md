---
id: 136
title: Review Default Reviewers
group: v1.42.1 Features
---

**Command:** `/gsd-review`

**Config key:** `review.default_reviewers`

**Purpose:** Let teams choose the default reviewer subset for no-flag `/gsd-review` runs.

**Precedence:**
```text
explicit reviewer flags -> --all -> review.default_reviewers -> all detected reviewers
```

**Requirements:**
- REQ-REVIEW-DEFAULTS-01: Missing `review.default_reviewers` MUST preserve the previous all-detected behavior.
- REQ-REVIEW-DEFAULTS-02: Empty arrays MUST be rejected; remove the key to restore all-detected behavior.
- REQ-REVIEW-DEFAULTS-03: Known but unavailable reviewers MUST be skipped with diagnostics rather than hard-failing the run.

**Reference:** [Configuration Reference](CONFIGURATION.md#reviewer-defaults-for-gsd-review)
