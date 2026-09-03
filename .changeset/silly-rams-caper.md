---
type: Added
pr: 4212
---
**`/gsd-quick-batch` batches several quick-shaped tasks together** — one coordinator plans, dispatches, and merges N /gsd-quick-shaped items in a single run (planner/researcher/checker/executor/verifier leaves per item, deterministic wave dispatch and merge, resumable via --resume). Supports --jobs auto|N, --validate, --research, and --file. Use it instead of running /gsd-quick N times when the tasks are independent or lightly interdependent.
