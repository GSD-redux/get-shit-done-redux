---
type: Added
pr: 4343
---
**Executor commits now refuse to land on the planning repo's default/protected branch** — the pre-commit guard in the executor agent widened to run in every isolation mode (not just Claude Code worktrees) and now resolves the repository's actual default branch instead of a hardcoded five-name list, with a new `git.allow_default_branch_commits` config escape hatch for projects that intentionally execute on their default branch. (#3819)
