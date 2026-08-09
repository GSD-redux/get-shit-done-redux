---
type: Changed
pr: 0
---
**The ADR gate now resolves documentation links and checks H1 status brackets** — a link in `docs/adr/` that pointed nowhere, and an H1 whose trailing `[Status]` bracket contradicted its own `Status:` field, both passed CI green; readers and agents following those citations hit dead ends the build had already blessed. `gen-adr-index.cjs --check` now fails on either, naming the file, the line, and the unresolved target. Links inside fenced or inline code are left alone, and resolution is case-exact on every platform. A new `--json` flag reports the same findings as a structured document with stable `reason` codes, so tooling never has to pattern-match an error message. (#2704)
