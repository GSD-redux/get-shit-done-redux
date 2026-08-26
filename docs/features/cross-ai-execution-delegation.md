---
id: 110
title: Cross-AI Execution Delegation
group: v1.36.0 Features
---

**Command:** `/gsd-execute-phase N --cross-ai`

**Purpose:** Delegate individual plans to an external AI runtime for execution. Plans with `cross_ai: true` in their frontmatter (or all plans when `--cross-ai` is used) are sent to the configured command via stdin. Successfully handled plans are removed from the normal executor queue.

**Requirements:**
- REQ-CROSSAI-01: `--cross-ai` forces all plans through cross-AI; `--no-cross-ai` disables it
- REQ-CROSSAI-02: `workflow.cross_ai_execution: true` and plan frontmatter `cross_ai: true` required for per-plan activation
- REQ-CROSSAI-03: Task prompt is piped via stdin to prevent injection
- REQ-CROSSAI-04: Dirty working tree produces a warning before execution
- REQ-CROSSAI-05: On failure, user chooses: retry, skip (fall back to normal executor), or abort

**Configuration:** `workflow.cross_ai_execution`, `workflow.cross_ai_command`, `workflow.cross_ai_timeout`
