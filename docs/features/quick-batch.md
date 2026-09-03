---
id: 4015
title: Quick Batch Mode
group: Planning Features
---

**Command:** `/gsd-quick-batch [--file <path>] [--jobs auto|N] [--validate] [--research] [--resume <batch-id>]`

**Purpose:** Batch several `/gsd-quick`-shaped tasks together — one coordinator plans, dispatches, and merges them as a single run, with per-item leaves and deterministic merge ordering (ADR-1239 "Quick-batch binding").

**Requirements:**
- REQ-QB-01: System MUST accept an inline task list (≥2 items) or `--file <path>`
- REQ-QB-02: System MUST reject `--discuss` and `--full` with a usage error before any dispatch
- REQ-QB-03: System MUST reject a malformed `--jobs` value before any dispatch
- REQ-QB-04: System MUST resolve effective concurrency as `min(task count, jobsN, capacity)` for `--jobs N`, or `capacity` alone for `--jobs auto`
- REQ-QB-05: System MUST force a mutating (worktree/executor) wave's concurrency to 1 when isolation is `none`, without capping a non-mutating (research/planning-only) wave
- REQ-QB-06: System MUST dispatch a planner per eligible item per DAG layer, providing the full batch task catalog and always requiring `depends_on`/`files_modified` frontmatter
- REQ-QB-07: System MUST recompute execution waves after each planning layer from the planners' declared dependencies/files
- REQ-QB-08: System MUST serialize worktree create/merge/cleanup while allowing already-created worktrees to run concurrently
- REQ-QB-09: System MUST merge items strictly in the deterministic wave order, never completion order
- REQ-QB-10: System MUST NOT call the STATE.md completion primitive for an item routed to `human_needed`
- REQ-QB-11: System MUST fail an item routed to `gaps_found`/`merge_failed`/`scope_violation` without rollback, without an automatic retry, and with its worktree preserved
- REQ-QB-12: System MUST support `--resume <batch-id>` to re-derive eligibility and dispatch only still-runnable items, refusing closed on an unknown batch id or a diverged base revision
