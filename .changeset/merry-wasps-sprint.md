---
type: Added
pr: 0
---
**`review.models.cursor` now pins the Cursor reviewer lane's model** — the lane previously discarded any configured model because it declared no `--model` flag; it now injects one exactly like the `codex` lane. (#3653)
