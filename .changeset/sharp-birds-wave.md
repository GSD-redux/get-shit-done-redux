---
type: Fixed
pr: 0
---
**`/gsd-plan-phase`'s §13a Decision Coverage Gate no longer reports false total-coverage failures when a decision's own body contains a bulleted cross-reference to a sibling decision** — a bullet nested (indented) under an already-open decision, elaborating on how it relates to another decision, was previously indistinguishable from a malformed top-level declaration attempt. A single such bullet forced the whole coverage analysis to `could-not-parse`, discarding every decision that DID parse correctly and reporting `covered: 0` even when every decision was, in fact, fully covered by the phase's plans. (#3169)
