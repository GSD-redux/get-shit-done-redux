---
type: Fixed
pr: 2710
---
**Codebase scan and ship-time capability hooks now honor your model settings** — /gsd:scan dispatched its mapper agent with a model placeholder nothing resolved, and ship-time capability hooks did the same, so `model_overrides` and `model_policy` were silently ignored at both and the agent ran on whatever the session happened to be using. Both now resolve a real model, and omit the model parameter entirely when it resolves to "inherit" or empty rather than passing an empty value that fails on non-Claude runtimes. Note: the scan mapper now runs on the model your profile selects rather than inheriting the session's. (#2684)
