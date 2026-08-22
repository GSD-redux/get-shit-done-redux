---
type: Changed
pr: 3765
---
**Codex reasoning effort is now resolved per model, and every clamp is visible** — `max` reaches Codex instead of being silently downgraded to `xhigh`, `minimal` clamps up to `low` instead of being sent to models that reject it, and `resolve-execution` reports the level you asked for alongside the one actually rendered. `ultra` is refused outright because it switches Codex into proactive task delegation underneath GSD's own orchestration. (#3007)
