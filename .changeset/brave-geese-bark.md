---
type: Changed
pr: 0
---
**`gsd-plan-checker` now flags same-wave plans that are coupled but don't say so** — two plans in the same wave that share mutable state (a config key, table, migration, env var, singleton) or depend on each other's execution order, with no `depends_on` edge between them, are reported as an advisory Dimension 3 finding. The coupling gets settled at plan time instead of surfacing as an intermittent failure during parallel execution. `docs/AGENTS.md`'s plan-checker entry, which claimed eight verification dimensions and listed eight names matching none of the agent's actual fifteen, is corrected to the real list in the same change. (#1954)
