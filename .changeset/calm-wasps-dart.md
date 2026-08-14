---
type: Fixed
pr: 0
---
state.patch now reports a field as updated only when its post-write on-disk value matches the requested value; fields the write pipeline re-derives away (e.g. current_phase, current_phase_name) are reported as failed instead of phantom updated
