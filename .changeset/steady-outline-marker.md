---
type: Fixed
pr: 4125
---
**`/gsd-plan-phase --chunked`'s outline resume-check no longer has a syntax error** — the `### 8.5.1 Outline Phase` step's resume-detection block had an empty `then` clause (only a comment, no command), which is invalid under both bash and zsh if executed literally. (#4113)
