---
type: Changed
pr: 3222
---
**Progress, stats, and phase listings now stay within the current milestone.** `progress`, `stats`, and `phases list` no longer count backlog (`999.*`) or pre-milestone (`0-*`) directories as current-milestone phases, and `phases clear` / `milestone complete` no longer delete or archive those directories. `phases list --phase` and `--include-archived` are unaffected, since they intentionally look up or list beyond the current milestone. (#3185)
