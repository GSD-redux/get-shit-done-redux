---
type: Fixed
pr: 3455
---
Parallel phases running in the same working tree no longer corrupt STATE.md silently: state.begin-phase, state.advance-plan and phase.complete now consult a milestone claim (.planning/milestone.lock) keyed by phase + session id, and surface a visible milestone_conflict warning (stderr plus a typed JSON field, and phase.complete's warnings[]) when another live session holds a different phase — instead of silently overwriting the single Current Position slot.
