---
type: Fixed
pr: 0
---
**`gsd-tools query state update-progress` no longer rewrites Progress to 0% after a milestone close** — when the current-milestone phase scan finds zero plans (the post-archive state, where `.planning/phases/` is empty), the command is now a no-op that leaves STATE.md unchanged, instead of mapping 0/0 to 0% and destroying the shipped `[██████████] 100%` record. The legitimate 0% case (plans exist, none summarized) still writes 0%. (#3233)
