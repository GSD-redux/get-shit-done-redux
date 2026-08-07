---
type: Changed
pr: 3154
---
**`/gsd:debug` now initializes in one round-trip instead of three** — the workflow previously made three separate `gsd-tools` calls to assemble its context (`state.load`, `resolve-model`, and `config-get workflow.tdd_mode`); it now makes a single `init.debug` call carrying the same resolved values. (#3149)
