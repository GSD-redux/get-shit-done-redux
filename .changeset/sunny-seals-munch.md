---
type: Fixed
pr: 3955
---
**`migrate-config` and health repairs no longer write outside the scoped project under `GSD_PROJECT`** — planning-path composition now goes through the project-aware resolver everywhere, so a scoped migration no longer rewrites another project's `config.json`, `project_exists` answers for the project actually being queried, and `validate.health --repair` keeps its writes in one directory. (#3749)
