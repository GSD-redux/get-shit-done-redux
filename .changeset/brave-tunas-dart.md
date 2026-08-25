---
type: Fixed
pr: 0
---
**`state validate` now sees the `last_activity` invariant, and `--strict` makes the verdict gateable** — a STATE.md whose `Last activity` value no reader could parse used to validate clean (`{valid:true, warnings:[], scope:'complete'}`), and a wrapped description was silently truncated; both are now reported as coded diagnostics (`S008`/`S009`). `state validate --strict` exits non-zero when the report is not valid, so a CI step or git hook can gate on state correctness without parsing JSON — the default exit status is unchanged. (#3696)
