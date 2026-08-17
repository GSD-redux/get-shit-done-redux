---
type: Fixed
pr: 3589
---
**Agent isolation guard enforces on multi-runtime machines** — the isolation guard (and Cursor's subagent-start fallback) resolved the project runtime from the host-wide ~/.gsd/defaults.json, which names whichever runtime installed last; on machines with two runtimes this confidently picked the wrong runtime and silently disabled executor worktree policing. Both now read the per-install .gsd-runtime marker above that file. (#3566)
