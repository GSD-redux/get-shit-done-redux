---
type: Fixed
pr: 0
---
**GSD no longer commits `.planning/` files you told it to ignore** — several workflow steps staged planning artifacts with raw `git add`, bypassing the `commit_docs` setting and the `.gitignore` auto-detect entirely, so planning docs reached shared history anyway. (#3585)
