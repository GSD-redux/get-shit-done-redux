---
type: Fixed
pr: 2637
---
**`roadmap get-phase` no longer drops success criteria that wrap onto a second line** — the parser broke the criteria run at any indented continuation line, truncating the wrapped criterion (losing its trailing `[REQ-ID]` tag) and silently dropping every criterion below it. `verify-work` and `plan-phase` consumed the shortened list, so a phase could be planned and certified complete against a strict subset of its own success criteria with nothing reporting the gap. Continuation lines now fold into their criterion; blank-line-separated criteria still parse. (#2522)
