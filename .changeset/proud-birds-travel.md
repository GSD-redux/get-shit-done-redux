---
type: Added
pr: 3261
---
**Complexity-triggered refactor proposals** — after a phase runs, GSD can now measure the complexity of the code that phase touched and surface a scoped refactor proposal when a function crosses a threshold or drifts past its recorded anchor, so entropy gets caught while it is still one function instead of a rewrite. Advisory and off by default; enable with `gsd config-set refactor.trigger_enabled true`. (#1953)
