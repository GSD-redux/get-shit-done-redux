---
type: Fixed
pr: 3060
---
**Worktree timeout guards now fire on Windows** — the checks that detect a timed-out git command required the process to report a SIGTERM signal, which Node does not guarantee on every platform, so on Windows they could silently never fire and the guard they protect would pass without having verified anything. The check is now a single shared predicate keyed on the timeout code alone. (#3050)
