---
type: Fixed
pr: 2574
---
**`--validate` is no longer documented for `/gsd-plan-phase` and `/gsd-execute-phase`** — both commands silently ignored the flag (only `/gsd-quick` implements it), so the docs promised a state-validation step that never ran. The false flag-table rows, CLI examples, and the `manager.flags.execute: "--validate"` config example are removed across the English docs and the ja-JP/zh-CN/ko-KR/pt-BR mirrors; the config example now shows `--cross-ai` (a flag execute-phase actually parses). `/gsd-quick`'s `--validate` docs are unchanged. (#2197)
