---
type: Fixed
pr: 0
---
**`phase complete` now reports `roadmap_updated` and `state_updated` honestly** — both flags read `fs.existsSync()`, so they were `true` for any project that had the file at all, and a rollup that silently wrote nothing was indistinguishable from one that landed. Each flag now reflects whether that file's content actually changed in the transaction, matching the contract `requirements_updated` already honored. (#3685)
