---
type: Fixed
pr: 3073
---
**Completing a phase no longer checks the box for a requirement the traceability table records as deferred or blocked** — the phase-completion write flipped the REQUIREMENTS.md checkbox unconditionally and kept the flip when the traceability row existed but rejected the same completion, so a requirement recorded as Deferred or Blocked read as shipped. The checkbox now rolls back when a row exists but rejects the write, matching the existing requirements mark-complete behavior so the two surfaces never silently disagree.
