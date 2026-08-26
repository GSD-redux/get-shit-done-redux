---
type: Fixed
pr: 3888
---
**`gsd-tools --project-dir <path>` now works** — the flag was documented in docs/CONFIGURATION.md's multi-repo workspace resolution section but wired nowhere, so it was silently ignored and every command still resolved the project root from cwd. Passing `--project-dir` now sets the project root directly and skips the ancestor walk-up, as documented. (#3881)
