---
type: Fixed
pr: 4175
---
**Blocking guards no longer silently disable themselves when the host stalls** — the six blocking PreToolUse guards are registered (and migrated on existing installs) with a 120 s timeout instead of 5 s; Claude Code treats a timed-out hook as non-blocking, so the old budget dropped the gate exactly under load. (#3981)
