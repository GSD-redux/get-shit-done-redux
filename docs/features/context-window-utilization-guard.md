---
id: 124
title: Context-Window Utilization Guard
group: v1.40.0 Features
---

**Command:** `/gsd-health --context`

**Purpose:** Quality guard against context-window saturation. Two thresholds: 60 % utilization warns ("consider `/gsd-thread`"), 70 % is critical ("reasoning quality may degrade"; matches the fracture-point per recent context-attention research).

**Requirements:**
- REQ-CTX-GUARD-01: `/gsd-health --context` prints a structured status line with current utilization, threshold tier (`ok` / `warn` / `critical`), and a remediation suggestion.
- REQ-CTX-GUARD-02: The same triage is exposed as `gsd-tools.cjs validate context --tokens-used <int> --context-window <int>` — a structured envelope for status-line and hook callers (#125). Both flags are required; the handler returns the same `{ percent, state }` envelope as the pure classifier in REQ-CTX-GUARD-03.
- REQ-CTX-GUARD-03: The classifier (`bin/lib/context-utilization.cjs`) is pure: input `(tokensUsed, contextWindow)`, output `{ percent, state }`. Easy to unit-test, easy to reuse from any caller.

**Reference issue:** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)
