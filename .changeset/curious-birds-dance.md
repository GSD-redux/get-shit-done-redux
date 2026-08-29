---
type: Fixed
pr: 0
---
**`workflow.inline_plan_threshold` now has one default owner** — the key is registered in the defaults manifest (default `2`), so `config-get` resolves the absent key instead of erroring, `settings-advanced` no longer misdocuments the default as 3, and every shipped surface (workflow fallback, reference tables) agrees. (#3801)
