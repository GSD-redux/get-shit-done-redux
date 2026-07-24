---
type: Fixed
pr: 2611
---
**Worktree cleanup-wave now rescues uncommitted SUMMARY.md** — the rescue step's `git cat-file -e HEAD:<path>` check assumed an absent path returns exit 1, but git returns 128, so rescue never fired: the executor's uncommitted `<id>-SUMMARY.md` blocked cleanup as `worktree_dirty` and risked silent loss on `worktree remove --force`. Rescue now fires on any non-zero exit (only exit 0 = committed → skip), so uncommitted SUMMARYs are copied into the main tree before the dirty check. (#2556)
