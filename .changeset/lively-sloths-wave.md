---
type: Added
pr: 3648
---
**`git.protected_branches` config field warns on additional shared branches, not just the resolved base branch** — a git-flow project whose GitHub-default branch differs from its actual integration branch (e.g. `main` vs. `develop`) can now list `develop`/`staging`/etc. so `execute-phase`'s `handle_branching` "none" strategy and `/gsd-ship`'s preflight warn on any of them, not only the one resolved base branch. Optional and additive — absent by default, existing projects see no behavior change. (#3552)
