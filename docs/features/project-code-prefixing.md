---
id: 67
title: Project Code Prefixing
group: v1.31 Features
---

**Config:** `project_code: "ABC"`

**Purpose:** Prefix phase directory names with a project code for multi-project disambiguation.

**Requirements:**
- REQ-PREFIX-01: System MUST prefix phase directories with project code when configured (e.g., `ABC-01-setup/`)
- REQ-PREFIX-02: System MUST use standard naming when `project_code` is not set
- REQ-PREFIX-03: System MUST apply prefix consistently across all phase operations

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `project_code` | string | (none) | Prefix for phase directory names |
