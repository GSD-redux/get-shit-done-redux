---
type: Fixed
pr: 3967
---
**`workflow.use_worktrees=false` at the root now applies inside workstreams too** — the dispatch-isolation resolver inherits the root opt-out under `GSD_WORKSTREAM` exactly as `config-get` does, so a root-level opt-out no longer leaves workstream runs recording `harness-worktree` over the mandated `none`. (#3963)
