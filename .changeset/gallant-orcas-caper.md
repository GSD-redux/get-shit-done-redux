---
type: Added
pr: 3720
---
**`/gsd-pr-branch` gains a strict mode that keeps every planning artifact out of the PR branch** — set `planning.pr_strict: true` and the generated PR branch carries no `.planning/` path at all, structural files included, so a project can version its planning tree locally (keeping executor worktrees and `/gsd-undo` working) while publishing none of it. Defaults to `false`, which reproduces the previous classification and preservation exactly. (#2971)
