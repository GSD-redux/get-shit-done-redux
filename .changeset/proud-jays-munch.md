---
type: Fixed
pr: 2942
---
**gsd-code-fixer no longer creates its review-fix worktree outside the project tree on Windows** — the worktree was hardcoded to a `/tmp/sv-...` mktemp path, which on Git Bash landed outside the repository (every file read inside it prompted for permission) and produced an un-removable short path. The worktree now lives repo-relative under `.claude/worktrees/`, the same location the executor worktrees use. (#2647)
