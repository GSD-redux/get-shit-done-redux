---
type: Fixed
pr: 4295
---
**TDD dispatch pointers now cite the tdd.md sections that actually carry the material they promise** — the RED/GREEN/REFACTOR pointer in both `execute-plan.md` and `agents/gsd-executor.md` cited a single section for the commit-scope contract, fail-fast rule, and error handling, but only the commit-scope contract lived there; each is now cited correctly. `agents/gsd-executor.md`'s plan-level gate-enforcement rules, previously restated in full alongside `tdd.md`'s own copy, now point at `tdd.md` as the single owner. (#4267, #4269)
