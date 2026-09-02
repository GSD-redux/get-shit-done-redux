---
type: Fixed
pr: 0
---
**Code-review scope no longer balloons on repos with past milestones** — the diff base for a phase now derives from the phase directory own first commit instead of a milestone-blind commit-subject grep that selected the OLDEST same-numbered phase in history. A 7-file phase could review 3388 files at downgraded depth. All three derivation sites move in lockstep. (#3995)
