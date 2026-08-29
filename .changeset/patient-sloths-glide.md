---
type: Fixed
pr: 0
---
**`state advance-plan` refuses an ambiguous Current Position instead of silently advancing the first entry** — when the section carries more than one `Phase:` line (the wave-log style), the command now returns a typed `ambiguous_position_phase` error naming every candidate and leaves STATE.md byte-identical, instead of silently advancing the first entry's plan counter (in the reporting incident, a hard-gated final plan 7→8 of 8) with `advanced: true` and no ambiguity signal. (#3807)
