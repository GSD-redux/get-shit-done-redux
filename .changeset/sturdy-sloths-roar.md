---
type: Fixed
pr: 0
---
**Global Claude installs now load agent-file `@`-includes** — agent files in a global Claude install (e.g. the planner) carried `@`-includes that silently loaded nothing, so guidance those agents were supposed to read — including the untrusted-input boundary — was absent from their context; those includes now resolve on `~/`. Also fixes a related path-rewrite bug where a `--config-dir` name extending `.claude` (e.g. `.claude-work`) doubled its own suffix in agent-file paths. (#3719)
