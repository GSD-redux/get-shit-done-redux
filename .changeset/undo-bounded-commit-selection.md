---
type: Fixed
pr: 4472
---
**`/gsd:undo --phase` and `--plan` no longer select commits from a previous milestone or an unreachable branch** — commit selection now anchors on the target phase's own directory (the `#3995` `PHASE_START` pattern already used by `code-review.md`) and runs over `PHASE_START^..HEAD` instead of a repository-wide `git log --all` commit-subject grep. The dead `.planning/.phase-manifest.json` primary path, which nothing in the repository writes, is removed rather than left as documented-but-unreachable behaviour, and both modes now fail closed when no anchor resolves instead of widening to an unbounded search. `dependency_check` reads the workstream-resolved planning root, so an active workstream's roadmap and phase directories are consulted rather than the root's. (#4465)
