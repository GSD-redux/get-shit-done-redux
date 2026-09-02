---
type: Added
pr: 4190
---
**`quick-batch` core primitives** — new internal library for batching several quick tasks together: collision-safe ID preallocation, a versioned `BATCH.json` manifest, dependency-DAG + file-overlap wave scheduling, resumable state, and exactly-once STATE.md completion. Not yet reachable from any command — the `quick-batch` command itself lands in a later phase.
