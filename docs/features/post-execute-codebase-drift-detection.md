---
id: 27a
title: Post-Execute Codebase Drift Detection
group: Brownfield Features
order: 27.2
---

**Introduced by:** #2003
**Trigger:** Runs automatically at the end of every `/gsd-execute-phase`
**Configuration:**
- `workflow.drift_threshold` (integer, default `3`) — minimum new
  structural elements before the gate acts.
- `workflow.drift_action` (`warn` | `auto-remap`, default `warn`) —
  warn-only or spawn `gsd-codebase-mapper` with `--paths` scoped to
  affected subtrees.

**What counts as drift:**
- New directory outside mapped paths
- New barrel export at `(packages|apps)/*/src/index.*`
- New migration file (supabase/prisma/drizzle/src/migrations/…)
- New route module under `routes/` or `api/`

**Non-blocking guarantee:** any internal failure (missing STRUCTURE.md,
git errors, mapper spawn failure) logs a single line and the phase
continues. Drift detection cannot fail verification.

**Requirements:**
- REQ-DRIFT-01: System MUST detect the four drift categories from `git diff
  --name-status last_mapped_commit..HEAD`
- REQ-DRIFT-02: Action fires only when element count ≥ `workflow.drift_threshold`
- REQ-DRIFT-03: `warn` action MUST NOT spawn any agent
- REQ-DRIFT-04: `auto-remap` action MUST pass sanitized `--paths` to the mapper
- REQ-DRIFT-05: Detection/remap failure MUST be non-blocking for `/gsd-execute-phase`
- REQ-DRIFT-06: `last_mapped_commit` round-trip through YAML frontmatter
  on each `.planning/codebase/*.md` file
