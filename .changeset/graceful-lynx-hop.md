---
type: Fixed
pr: 3208
---
**State validation properly detects drift** — Resolved an issue where state validation would silently fail to detect drift because it skipped scanning entirely when the shipped template lacked a specific field.
