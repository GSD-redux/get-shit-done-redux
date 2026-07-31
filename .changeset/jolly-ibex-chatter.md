---
type: Fixed
pr: 2886
---
**Discuss-phase no longer carries four internal text contradictions** — auto-mode removed a dead `max_discuss_passes` config read that contradicted its single-pass rule; the gate-prompts reference now matches the actual context-handling options and drops the 'Let Claude decide' cop-out that conflicted with the workflow's no-skip rule; the auto_advance fallback no longer routes back to the already-run confirm_creation step; and the assumptions workflow's answer_validation is re-synced to the canonical parent block.
