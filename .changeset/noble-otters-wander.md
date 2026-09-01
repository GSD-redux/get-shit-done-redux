---
type: Added
pr: 4159
---
**`workflow.code_review_point` config to run code review per-wave instead of once per phase** — set it to `execute:wave:post` and the automatic code-review step registers at each completed wave instead of at the end of the phase, scoped to what changed since the phase's prior review. Defaults to `execute:post` (today's behavior, unchanged).
