---
type: Fixed
pr: 4149
---
**`gsd-tools commit`, `commit-to-subrepo`, and `pr-subrepo` no longer silently refuse to commit a moved submodule pointer under `diff.ignoreSubmodules=all`** — on git 2.39.x, `git commit` itself (pathspec-scoped or whole-index) consults that config the same way `git diff` does and drops the change, and `pr-subrepo`'s own change-detection probe hid the same submodule bump before it ever reached the commit step. All three commit sites, plus the `pr-subrepo` probe, now pin `diff.ignoreSubmodules=dirty` the same way the pre-existing empty-diff probe in `commit` already did.
