---
type: Added
pr: 3402
---
**Diagnostic rules for `.planning/` health checks now have a single parsed subject to read from** — `src/planning-snapshot.cts` composes the already-consolidated milestone, phase, and plan derivations into one scope-carrying projection, so a rule can no longer re-derive a field's location from raw document text the way three now-inert `validate health` predicates once did (#3162). No command output changes yet — `validate health` migrates onto it in a follow-up phase. (#3308)
