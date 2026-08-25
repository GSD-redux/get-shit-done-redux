---
id: 47
title: Multi-Repo Workspace Support
group: v1.27 Features
---

**Purpose:** Auto-detection and project root resolution for monorepos and multi-repo setups. Supports workspaces where `.planning/` may need to resolve across repository boundaries.

**Requirements:**
- REQ-MULTIREPO-01: System MUST auto-detect multi-repo workspace configuration
- REQ-MULTIREPO-02: System MUST resolve project root across repository boundaries
- REQ-MULTIREPO-03: Executor MUST record per-repo commit hashes in multi-repo mode
