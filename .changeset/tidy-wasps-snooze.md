---
type: Fixed
pr: 4232
---
**A plain `query dispatch-isolation` re-query no longer clobbers the #683 worktree base-check degrade** — the resolver now re-derives the base-check degrade in-process for the decision it records (as it already did the `use_worktrees` opt-out since #3737), so on a repo whose HEAD has diverged from its fork base the run-scoped isolation sentinel stays `none` across the orchestrator's own `--json` harnessFlag read and any subagent `gsd_run` traffic, and the isolation guard stops denying the sequential executor dispatch the degrade itself mandated. Stdout is unchanged (it still reports the host capability the workflow branches on); a repo whose HEAD matches its fork base still records the natural capability, and nothing is sticky — the evaluation reads live git state on every call. (#4222)
