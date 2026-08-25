---
id: 66
title: Worktree Toggle
group: v1.31 Features
---

**Config:** `workflow.use_worktrees: false`

**Purpose:** Disable git worktree isolation for users who prefer sequential execution.

**Requirements:**
- REQ-WORKTREE-01: System MUST respect `workflow.use_worktrees` setting when deciding isolation strategy
- REQ-WORKTREE-02: System MUST default to `true` (worktrees enabled) for backward compatibility
- REQ-WORKTREE-03: System MUST fall back to sequential execution when worktrees are disabled

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.use_worktrees` | boolean | `true` | When `false`, disables git worktree isolation |
