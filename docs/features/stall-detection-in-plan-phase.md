---
id: 100
title: Stall Detection in Plan-Phase
group: v1.34.0 Features
---

**Command:** `/gsd-plan-phase`

**Purpose:** Detect when the planner revision loop has stalled — producing the same output across multiple iterations — and break the cycle by escalating to a different strategy or exiting with a clear diagnostic.

**Requirements:**
- REQ-STALL-01: Revision loop MUST detect identical plan output across consecutive iterations
- REQ-STALL-02: On stall detection, system MUST escalate strategy before retrying
- REQ-STALL-03: Maximum stall retries MUST be bounded (capped at the existing max 3 iterations)
