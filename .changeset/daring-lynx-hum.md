---
type: Changed
pr: 2558
---
**Every workflow now carries response-language coverage, and every directive names inter-tool narration** — previously uncovered workflows (including `/gsd-review` and lazy-loaded mode/step files) now apply a shared or inline directive, and the 44 workflows whose directive covered only "questions, prompts, and explanations" now name narration between tool calls, status updates, progress notes, and findings, so running commentary no longer stays in English beside translated answers. A CI lint (`lint:response-language`) prevents future workflows from shipping uncovered or with the weaker wording. (#2529)
