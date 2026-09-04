---
type: Fixed
pr: 4279
---
**TDD executor now requires intentional RED evidence before GREEN** — a RED-phase test command that exits nonzero no longer authorizes production edits unless the persisted evidence record shows the TARGET test failing a real assertion. Syntax errors, zero-test discovery, fixture crashes, parser errors, and unrelated assertions classify as INVALID_RED and block GREEN. (#3770)
