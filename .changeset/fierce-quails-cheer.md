---
type: Fixed
pr: 0
---
**`progress`, `stats`, and `query progress` now report a real percentage inside a workstream** — under `--ws`, these commands counted the workstream's own phases and plans but read the milestone window from the project root, which `workstream create` has already migrated away. The scope resolved as unreadable and the percentage was withheld, so a fully-complete workstream reported no progress at all. (#3597)
