---
type: Fixed
pr: 4357
---
**The decision-coverage gate now reads phase-prefixed decision IDs** — a CONTEXT.md whose decisions use D4-01-style IDs (a digit-run phase prefix) no longer reports could-not-parse for the whole file; its decisions are counted and coverage-checked like any other, and a typo'd prefix (D4x-01) still fails loud. (#4130)
