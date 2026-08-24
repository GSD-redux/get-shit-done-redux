---
type: Fixed
pr: 0
---
**Workflows no longer send AI runtimes hunting the filesystem for the `gsd-tools.cjs` shim** — 50 places across 23 runtime-loaded workflow, agent, reference, and command files told the agent to run the shim by filename, which is not on PATH under any name. The agent got "command not found", fell back to locating the file, and on Git Bash for Windows `find /` walked the entire drive until someone killed it. Every one now calls the canonical `gsd_run` launcher, along with a `node`-prefixed call that carried no path and a shared anti-pattern rule that prescribed the bare filename outright. (#3809)
