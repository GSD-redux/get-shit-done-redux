---
type: Fixed
pr: 3896
---
**`generate-slug` and phase/workstream slugs no longer diverge from the canonical formula.** — Some slug-producing commands and internal call sites re-implemented the ASCII slug formula by hand instead of delegating to the shared one: Cyrillic and other non-Latin titles could collapse to an empty slug where the canonical transliterates them, and slug truncation could leave a dangling trailing hyphen (regression of #2849). Every slug call site now delegates to the single canonical implementation. (#3883)
