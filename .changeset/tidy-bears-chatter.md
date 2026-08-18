---
type: Added
pr: 3598
---
**GSD now warns when `.planning/` is gitignored but still tracked by git** — adding `.planning/` to `.gitignore` has no effect on files git already tracks, so planning docs kept landing in commits while `commit_docs` reported false. `validate health` now reports this as W029 with the `git rm -r --cached` remedy. (#3586)
