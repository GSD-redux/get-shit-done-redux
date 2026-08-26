---
type: Fixed
pr: 3863
---
**Agent frontmatter no longer reverts to catalog Anthropic models when `model_policy` is configured** — the install-time bake for the static-frontmatter runtimes (OpenCode, Kilo) read `model_profile` and `model_profile_overrides` but never `model_policy`, so every update rewrote agent `model:` fields to `anthropic/claude-*` IDs that a custom provider does not serve, while dispatch-time resolution honored the policy correctly. The bake now consults the same policy resolver dispatch uses, at the same precedence: an explicit per-agent `model_overrides` entry still wins, then `model_policy`, then the tier table. (#3705)
