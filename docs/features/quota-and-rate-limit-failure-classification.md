---
id: 139
title: Quota and Rate-Limit Failure Classification
group: v1.42.1 Features
---

**Command:** `/gsd-execute-phase`

**Purpose:** Treat provider quota and rate-limit failures as wait-and-resume conditions, not normal executor failures.

**Behavior:** Agent output is classified for signals such as `429`, `rate limit`, `usage limit`, `RESOURCE_EXHAUSTED`, and `usage_limit_reached`. Matching failures present a wait-for-reset recovery path.

**Requirements:**
- REQ-QUOTA-01: Quota failures MUST NOT offer immediate retry as the primary recovery.
- REQ-QUOTA-02: Classification MUST cover Claude, Copilot, Codex, and generic provider sentinels.
- REQ-QUOTA-03: Non-quota failures MUST continue through the normal execution failure path.

**Reference:** [Provider Rate Limit Signals](research/provider-rate-limit-signals.md)
