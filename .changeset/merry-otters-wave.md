---
type: Fixed
pr: 4450
---
**`phase.add --ws` now numbers the next phase from the workstream's own roadmap** — in a project with sibling git worktrees, `phase.add`/`phase.add-batch` with `--ws` minted a phase number pulled from the root roadmap's maximum (e.g. Phase 40 in a workstream whose own roadmap stopped at Phase 2), creating a `40-<slug>` directory and a `Depends on: Phase 39` entry pointing at a phase that does not exist in the workstream. The sibling-worktree widening horizon is now scoped like every other number source: a workstream-scoped allocation counts numbers held by the same workstream in sibling worktrees only. (#4225)
