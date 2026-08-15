---
type: Added
pr: 0
---
**The read-injection scanner now reports which rules fired as structured data** — its PostToolUse output carries a `findings` array of `{ruleId, match}` records alongside the human-readable advisory, so consumers no longer have to parse the advisory sentence to learn what was detected. The advisory text itself is unchanged. (#3523)
