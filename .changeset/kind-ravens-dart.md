---
type: Changed
pr: 3825
---
**Plans must now say what output constitutes failure** — every runnable `<automated>` acceptance command needs a `<fails_when>` sibling naming an observable failure signal, and `/gsd-plan-phase` blocks a plan that omits one. A command with no expressible failure mode is not an acceptance test. Breaking for phases planned before this release: re-check reports one blocker per unstated command until statements are added or the phase is re-planned. (#3172)
