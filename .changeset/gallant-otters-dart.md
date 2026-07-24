---
type: Fixed
pr: 2610
---
**Worktree cleanup-wave now rescues the executor's uncommitted SUMMARY.md** — the committed-tree check used `git cat-file -e HEAD:<path>`, which exits 128 (never 1) for a missing path, making the rescue branch unreachable: every contract-following executor blocked cleanup with `worktree_dirty`. The check now uses `git ls-tree --name-only HEAD -- <path>`, which cleanly distinguishes absent-from-tree (exit 0, empty output) from a genuinely broken git (non-zero), preserving the fail-closed posture. (#2609)
