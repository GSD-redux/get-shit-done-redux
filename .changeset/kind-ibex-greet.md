---
type: Added
pr: 4285
---
Context-monitor WARNING/CRITICAL fire-points are now readable from `.planning/config.json` via `hooks.context_warning_threshold` (default 35) and `hooks.context_critical_threshold` (default 25). Both are remaining-context percentages, so warning must sit above critical; a non-numeric, out-of-range or inverted pair is ignored and both defaults apply. Projects that do not set the keys are unaffected.
