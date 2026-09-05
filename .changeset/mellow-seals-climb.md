---
type: Fixed
pr: 4284
---
**TDD dispatch now correctly embeds `tdd.md` only when a plan is actually TDD** — both executor dispatch backends previously referenced an unassigned `${TDD_APPLICABLE}` placeholder, so the RED/GREEN/REFACTOR procedure could silently be dropped for a real TDD plan or embedded for a non-TDD one with no error. Both backends now resolve TDD-applicability via the single `phase.tdd-applicable` predicate and fail closed if it cannot be resolved, rather than guessing. (#4264, #4265, #4266, #3800)
