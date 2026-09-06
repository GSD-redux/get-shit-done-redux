---
type: Fixed
pr: 4381
---
**`state` no longer guesses the STATE.md `status` token from substrings of the status prose** — a status line mentioning `.planning/` (or Italian `verifica`, `completezza`, `fasi complete`) no longer silently becomes `status: planning`/`verifying`/`completed`; recognized vocabulary values keep normalizing and unrecognized prose stays visible, `state record-session` without arguments now errors instead of writing, and stray `*-SUMMARY.md` files without a plan twin stay excluded from `progress.completed_plans` recounts. (#4186)
