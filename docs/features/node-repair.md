---
id: 18
title: Node Repair
group: Quality Assurance Features
---

**Purpose:** Autonomous recovery when task verification fails during execution.

**Requirements:**
- REQ-REPAIR-01: System MUST analyze failure and choose one strategy: RETRY, DECOMPOSE, or PRUNE
- REQ-REPAIR-02: RETRY MUST attempt with a concrete adjustment
- REQ-REPAIR-03: DECOMPOSE MUST break task into smaller verifiable sub-steps
- REQ-REPAIR-04: PRUNE MUST remove unachievable tasks and escalate to user
- REQ-REPAIR-05: System MUST respect repair budget (default: 2 attempts per task)
- REQ-REPAIR-06: System MUST be configurable via `workflow.node_repair_budget` and `workflow.node_repair`
