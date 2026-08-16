---
type: Removed
pr: 3564
---
**Two workflow files that shipped to every runtime but were never loaded are gone** — `discovery-phase.md` and `plan-milestone-gaps.md` had no command, agent, or skill referencing them, and `docs/INVENTORY.md` claimed callers for one that did not exist. A new lint rule now fails the build if any shipped workflow becomes unreachable again. (#3560)
