---
type: Fixed
pr: 0
---
the STATE.md Quick Tasks log accepts milestone-suffixed section headings (Quick Tasks Completed (v1.1+)) — the exact-anchored lookup never matched them, so every /gsd:fast append and milestone reset silently failed before the columns were even checked; among several matching sections the one with a recognized table schema wins (#3860)
