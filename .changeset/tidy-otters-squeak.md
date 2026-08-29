---
type: Fixed
pr: 4009
---
**Tiered profiles install the agents their own skills spawn** — the profile closure now follows each command into the workflow files it references (including split workflows' steps/ and modes/ fragments) when deriving the agent set, so `--profile=standard` no longer omits `gsd-verifier` (phase-goal verification failed at the point of spawn, after execution work had landed) or the thirteen other spawn targets living only in workflow bodies. (#3798)
