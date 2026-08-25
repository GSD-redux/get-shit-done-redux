---
id: 130
title: Graphify Commit-Based Staleness
group: v1.41.0 Features
---

**Purpose:** Surface whether the architecture graph was built from the current commit or an older one, complementing the existing mtime-based stale signal.

**Command:** `/gsd-graphify status`

**New fields returned (graphify v0.7+ graphs):**

| Field | Type | Description |
|-------|------|-------------|
| `built_at_commit` | string | Commit SHA the graph was built from |
| `current_commit` | string | Current `git HEAD` |
| `commits_behind` | number | How many commits behind HEAD the graph is |
| `commit_stale` | boolean \| null | `true`=stale, `false`=current, `null`=unavailable (pre-v0.7, non-git) |

**Rendered output (when signal is available):**
```
Source commit: abc1234 (3 commits behind HEAD)
```

**Security:** `built_at_commit` validated as 4–40 hex chars before reaching `git` — a hostile `graph.json` cannot inject dashed options into argv.

**Fallback:** pre-v0.7 graphs and non-git checkouts return `commit_stale: null`; callers fall back to the existing mtime-based `stale` flag. No behavior change for existing users.

**Reference issue:** [#3170](https://github.com/open-gsd/gsd-core/issues/3170)
