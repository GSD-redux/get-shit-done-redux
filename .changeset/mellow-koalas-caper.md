---
type: Changed
pr: 4384
---
**Pending todos now render as one bounded bullet per todo in STATE.md.** Each capture used to append to a single run-on sentence in "### Pending Todos", growing unbounded and wrecking `git diff` readability; captures now produce one bullet per todo, capped at 240 characters, with a fail-safe refresh that leaves the section untouched on a malformed lookup. (#2618)
