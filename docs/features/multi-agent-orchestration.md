---
id: 25
title: Multi-Agent Orchestration
group: Context Engineering Features
---

**Purpose:** Coordinate specialized agents with fresh context windows for each task.

**Requirements:**
- REQ-ORCH-01: Each agent MUST receive a fresh context window
- REQ-ORCH-02: Orchestrators MUST be thin — spawn agents, collect results, route next
- REQ-ORCH-03: Context payload MUST include all relevant project artifacts
- REQ-ORCH-04: Parallel agents MUST be truly independent (no shared mutable state)
- REQ-ORCH-05: Agent results MUST be written to disk before orchestrator processes them
- REQ-ORCH-06: Failed agents MUST be detected (spot-check actual output vs reported failure)
