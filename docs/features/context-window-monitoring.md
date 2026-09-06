---
id: 22
title: Context Window Monitoring
group: Context Engineering Features
---

**Purpose:** Prevent context rot by alerting both user and agent when context is running low.

**Requirements:**
- REQ-CTX-01: Statusline MUST display context usage percentage to user
- REQ-CTX-02: Context monitor MUST inject agent-facing warnings at the WARNING fire-point — ≤35% remaining by default, overridable per project via `hooks.context_warning_threshold`
- REQ-CTX-03: Context monitor MUST inject agent-facing warnings at the CRITICAL fire-point — ≤25% remaining by default, overridable per project via `hooks.context_critical_threshold`
- REQ-CTX-04: Warnings MUST debounce (5 tool uses between repeated warnings)
- REQ-CTX-05: Severity escalation (WARNING→CRITICAL) MUST bypass debounce
- REQ-CTX-06: Context monitor MUST differentiate GSD-active vs non-GSD-active projects
- REQ-CTX-07: Warnings MUST be advisory, never imperative commands that override user preferences
- REQ-CTX-08: All hooks MUST fail silently and never block tool execution

**Architecture:** Two-part bridge system:
1. Statusline writes metrics to `/tmp/claude-ctx-{session}.json`
2. Context monitor reads metrics and injects `additionalContext` warnings
