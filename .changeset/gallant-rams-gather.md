---
type: Changed
pr: 3831
---
**Shipped workflows can no longer reach a different package's `gsd-tools`** — a second package publishes a binary of the same name whose `phases.clear` deletes where GSD's archives, so a workflow could destroy planning directories and still print success. Workflows now resolve `gsd_run`, which only this package publishes, and stop with an install message rather than falling back to whatever `gsd-tools` is on `PATH`. Adds `gsd-tools runtime-identity` for confirming by hand which tool a project is running against. (#3146)
