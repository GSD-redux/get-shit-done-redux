---
id: 90
title: Queryable Codebase Intelligence
group: v1.34.0 Features
---

**Command:** `/gsd-map-codebase --query [<term>|status|diff|refresh]`
**Config:** `intel.enabled`

**Purpose:** Maintain a queryable JSON index of codebase structure, API surface, dependency graph, file roles, and architecture decisions in `.planning/intel/`. Enables targeted lookups without reading the entire codebase.

**Requirements:**
- REQ-INTEL-01: Intel files MUST be stored as JSON in `.planning/intel/`
- REQ-INTEL-02: `query` mode MUST search across all intel files for a term and group results by file
- REQ-INTEL-03: `status` mode MUST report freshness (FRESH/STALE, stale threshold: 24 hours)
- REQ-INTEL-04: `diff` mode MUST compare current intel state to the last snapshot
- REQ-INTEL-05: `refresh` mode MUST spawn the intel-updater agent to rebuild all files
- REQ-INTEL-06: Feature MUST be opt-in via `intel.enabled: true`

**Intel files produced:**
| File | Contents |
|------|----------|
| `stack.json` | Technology stack and dependencies |
| `api-map.json` | Exported functions and API surface |
| `dependency-graph.json` | Inter-module dependency relationships |
| `file-roles.json` | Role classification for each source file |
| `arch-decisions.json` | Detected architecture decisions |
