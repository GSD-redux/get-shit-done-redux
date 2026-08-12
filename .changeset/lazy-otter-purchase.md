---
type: Fixed
pr: 3363
---
**`branching_strategy: "phase"`/`"milestone"` once again lands the first strategy-scoped commit on the strategy branch** — `gsd-tools query commit` now creates *and* switches to a brand-new phase/milestone branch (restoring the #1278 intent), instead of creating it without switching and leaving the commit on the base branch. The #3079 protection is preserved: an *already-existing* strategy branch is still never silently switched to (it warns and commits on the current branch). The first fresh create is now logged to stderr instead of being silent, and the misleading "already exists" warning no longer recurs on every subsequent commit once HEAD is on the strategy branch. (#3207)
