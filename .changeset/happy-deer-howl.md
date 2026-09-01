---
type: Fixed
pr: 0
---
**`gsd-tools commit` no longer silently refuses to commit a moved submodule pointer under `diff.ignoreSubmodules=all`** — on git 2.39.x a pathspec-scoped `git commit -- <path>` consulted that config the same way `git diff` does and dropped the change; the commit invocation now pins `-c diff.ignoreSubmodules=dirty` the same way the empty-diff probe already does.
