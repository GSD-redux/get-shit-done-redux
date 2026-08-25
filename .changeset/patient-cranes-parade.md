---
type: Fixed
pr: 0
---
**OpenCode subagents now carry the reasoning effort GSD resolved for them** — `query resolve-execution` reported an effort level that never reached the generated OpenCode agent, so every subagent ran at whatever the runtime defaulted the model to, silently ignoring `effort` config. The bake now emits a `variant` key alongside `model`, and only when effort is actually configured, so existing installs are unchanged. Config-supplied `model` and `variant` values are also escaped rather than interpolated raw, so a value containing a newline can no longer inject additional top-level keys into a generated agent file. (#3706)
