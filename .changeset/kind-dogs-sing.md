---
type: Fixed
pr: 0
---
**Workflow config comparisons work again for string values** — every shipped `config-get` bash call site now passes `--raw`, so string-typed values (runtime, response_language, discuss_mode, …) reach shell comparisons unquoted instead of as JSON with literal quotes that never matched. (#3763)
