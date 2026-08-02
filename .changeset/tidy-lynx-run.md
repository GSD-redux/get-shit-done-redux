---
type: Fixed
pr: 2982
---
**MemPalace capture no longer silently disables itself when `capture_artifacts` is unset** — the skill gate used `!== true` (treating absent as disabled), but the capability schema defaults to enabled. Fixed to `=== false` (disabled only on explicit false). (#2641)
