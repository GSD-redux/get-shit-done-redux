---
type: Changed
pr: 3539
---
**`effort.routing_tier_defaults` now merges over the built-in tier defaults instead of replacing them** — previously, creating an `effort` block without `routing_tier_defaults` silently disabled the built-in tier ladder (light:low / standard:high / heavy:xhigh), collapsing every non-overridden agent to `high`; one `agent_overrides` entry could reshape 20+ agents you never named. A partial block now fills gaps from the built-ins, and an invalid value falls back to that tier's built-in. (#3531)
