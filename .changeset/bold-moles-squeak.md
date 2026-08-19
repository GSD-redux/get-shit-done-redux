---
type: Fixed
pr: 3690
---
**Upgrading the Codex runtime no longer aborts when a top-level config key sits below the GSD marker** — the regenerated `[agents]` table captured such keys into its scope, so post-write schema validation rejected the merged `config.toml` and the install failed mid-flight. Surviving top-level keys are now hoisted above the managed block, preserving their file scope. (#3610)
