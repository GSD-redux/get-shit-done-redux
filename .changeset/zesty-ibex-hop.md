---
type: Fixed
pr: 0
---
**Plan files with Windows-style CRLF line endings now correctly enforce their `must_haves` contract** — `truths`, `artifacts`, `key_links`, and `prohibitions` blocks previously parsed to an empty list on any CRLF-authored plan file, silently degrading goal-backward verification to LLM-derived truths instead of the authored contract, with no error surfaced for the most common failure shape. (#3360)
