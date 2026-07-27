---
type: Fixed
pr: 2687
---
**The host-integration capability matrix now documents the `kimi-code` runtime** — kimi-code shipped as a distinct runtime but its section was never added, so its `hostIntegration` axes had no cited source. Sourcing each axis against Kimi Code CLI's own docs also corrected three values that had been inherited from the unrelated Python `kimi` CLI: `embeddingMode` is `declarative` (plugins are a manifest plus markdown Skills, with no in-process API), `dispatch.nested` is `true` (the `coder` built-in dispatches nested sub-agents), and `dispatch.maxDepth` is `undocumented` (no depth bound is published). (#2603)
