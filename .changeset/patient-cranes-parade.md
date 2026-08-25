---
type: Fixed
pr: 0
---
**OpenCode subagents now carry the reasoning effort GSD resolved for them** — `query resolve-execution` reported an effort level that never reached the generated OpenCode agent, so every subagent ran at whatever the runtime defaulted the model to, silently ignoring `effort` config. The bake now emits a `variant` key alongside `model`, and `effort sync` maintains it, so changing effort config no longer needs a reinstall. The key is written only when effort is actually configured; `inherit` and any level OpenCode does not accept omit it rather than naming a variant that cannot resolve. Config-supplied `model` and `variant` values are also quoted whenever YAML would not read them back verbatim — previously a value containing a newline could inject extra top-level keys into a generated agent file, and values like `no`, `12:30`, `@org/model` or a bare date were silently retyped or truncated. (#3706)
