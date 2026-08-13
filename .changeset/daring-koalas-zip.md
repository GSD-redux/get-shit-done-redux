---
type: Fixed
pr: 0
---
**`phase add` no longer files new phases inside archived roadmap history** — the insertion point used the file's last horizontal rule, which on a long roadmap sits deep in shipped/archive content, so new phases landed under an unrelated archived phase's heading instead of at the end of the active phase list. Insertion is now scoped to the current milestone. (#3163)
