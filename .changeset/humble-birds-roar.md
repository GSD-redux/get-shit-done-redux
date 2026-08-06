---
type: Fixed
pr: 3115
---
**`--kimi-code` reviewer lane is now selectable in `/gsd:review`** — the lane was declared, documented, and its flag resolved, but the review workflow's CLI detection and flag list omitted it (hardcoded to 11 of 12 lanes). Both now include Kimi CLI detection and the `--kimi-code` flag. (#3035)
