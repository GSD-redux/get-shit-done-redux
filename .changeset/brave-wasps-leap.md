---
type: Added
pr: 0
---
**Live-DOM UAT: browser-backed UI acceptance checks during execution** — a phase whose acceptance criteria needed a live DOM could not be finished by the agent that executed it, so it silently degraded to "executed, then finished by hand in the orchestrator". Enable `workflow.live_dom_uat` (default off) and a purpose-built `gsd-dom-verifier` checks those criteria after each wave and reports whether it looked, or could not. The plan executor's tool surface is unchanged in every configuration. (#2856)
