---
type: Changed
pr: 0
---
**Progress percentages now come from one owner** — every `.planning/` completion percentage the CLI reports is computed by a single shared function instead of six hand-inlined copies, so a rounding or ceiling fix can no longer land on one command and silently miss the others. Reported values are unchanged. (#3180)
