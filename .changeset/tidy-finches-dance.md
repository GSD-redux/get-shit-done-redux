---
type: Fixed
pr: 0
---
**Managed hooks no longer bake a prunable fnm version path on macOS and Linux** — `normalizeNodePath` matched only fnm's shim, but Node resolves `process.execPath` through that symlink to the concrete `node-versions/<ver>/installation/bin/node` directory, so the branch never fired on POSIX and every managed hook was pinned to one Node version. `fnm uninstall` or fnm's own pruning then broke all of them. The versioned path now rewrites to the stable `aliases/default` path, matching how the Homebrew, mise and volta branches already behave. (#3704)
