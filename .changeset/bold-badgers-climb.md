---
type: Added
pr: 3542
---
**`resolve-execution` now tells the truth about what the agent will run at** — the query reported only the config-cascade effort, which is not what an installed agent uses when its `effort:` frontmatter was hand-stripped or drifted. `--json` adds `effort_effective` (read from the installed agent frontmatter for the claude runtime; `"inherit"` when the key is absent) and `effort_effective_source` (`frontmatter` | `frontmatter-absent` | `resolved`). All existing fields, including `--pick effort`, are unchanged. (#3534)
