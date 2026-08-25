---
type: Fixed
pr: 3857
---
**A fully-spent ack fragment is no longer swept out from under an open pull request that changes more than 100 files** — `gh pr list --json files` truncates each PR file list at 100, so the fragment read as untouched and deleting it handed that PR the modify/delete conflict the staged sweep exists to prevent. (#3842)
