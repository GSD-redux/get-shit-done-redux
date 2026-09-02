---
type: Fixed
pr: 0
---
**`workflow.tdd_mode: true` now actually enforces TDD** — the RED-commit runtime gate no longer requires MVP mode, so the obvious TDD opt-in stops being silently inert on non-MVP phases; the end-of-phase TDD review escalation follows the same decoupling. (#4011)
