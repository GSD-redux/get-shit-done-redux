---
type: Fixed
pr: 3720
---
**`/gsd-pr-branch` no longer deletes the base branch's planning files or silently drops commits** — the generated PR branch used to stage a deletion for any `.planning/` path the target branch already tracked, and a second commit touching the same planning file aborted the cherry-pick with "untracked working tree files would be overwritten", dropping that commit and every one after it. The filter now forces excluded paths back to what the target branch tracks in both the index and the working tree. Verification also asserts against the active filter mode instead of an unconditional zero, so a correct default-mode run that preserved `STATE.md` no longer reports itself as failed. (#2971)
