---
type: Fixed
pr: 4228
---
**Non-TDD executor dispatches no longer embed the full RED/GREEN/REFACTOR protocol three times over** — the cycle is stated once in the canonical `gsd-core/references/tdd.md`, consumers carry pointers, and both dispatch paths load the reference only when the dispatch is actually TDD. (#3990)
