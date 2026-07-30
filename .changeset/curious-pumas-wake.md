---
type: Fixed
pr: 2886
---
**Discuss-phase advisor mode now spawns the registered `gsd-advisor-researcher` subagent instead of `general-purpose`** — resolving a contradiction with the universal-anti-patterns rule (injected into the same context) that forbids non-GSD agent types. The manual "read the agent def" prompt line is dropped (spawning by type auto-loads it). (#2771; the sibling assumptions-site needs a design decision — filed as #2883)
