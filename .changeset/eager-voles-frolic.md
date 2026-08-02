---
type: Fixed
pr: 2970
---
**Hotfix branches with auto cherry-pick no longer abort on already-applied commits** — cutting a hotfix from a tag whose `chore: sync next package version` commit applied empty (already present by content) aborted the entire create run. The cherry-pick error handler now distinguishes empty picks (no unmerged paths → skip) from genuine conflicts (unmerged paths → abort), and the job summary lists skipped-as-empty commits separately. (#2913)
