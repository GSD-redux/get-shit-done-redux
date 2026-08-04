---
type: Fixed
pr: 3054
---
**Worktree safety gates no longer report success when they could not check** — a git command that timed out (a locked index, a stalled network mount) was treated the same as "this is not a git repository", so the base-divergence gate answered "safe to run parallel worktrees" without ever resolving the fork base, and worktree-context resolution silently fell back to the current directory. The base-divergence gate now degrades to sequential execution instead of assuming safety. Worktree-context resolution still falls back to the current directory (there is no safer default), but now surfaces a loud warning that planning artifacts may be written to the wrong tree instead of silently trusting it. Worktree creation also no longer skips its root-confinement check when the caller omits the root. (#3050)
