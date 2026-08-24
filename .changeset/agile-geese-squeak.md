---
type: Fixed
pr: 0
---
**Workflows no longer send AI runtimes hunting the filesystem for the GSD shim** — 50 places across 23 runtime-loaded workflow, agent, reference, and command files told the agent to run `gsd-tools.cjs` by filename, which is not on PATH under any name. The agent got "command not found", fell back to locating the file, and on Git Bash for Windows `find /` walked the entire drive until someone killed it. Every one now calls the canonical `gsd_run` launcher. (#3809)
