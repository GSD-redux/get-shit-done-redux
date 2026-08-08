---
type: Fixed
pr: 3162
---
Resolved an issue where state validation would silently fail to detect drift because it skipped scanning entirely when the shipped template lacked a specific field.
