---
type: Fixed
pr: 2822
---
**Codex installs now ship the complete update-check hook set** — the `--codex` installer (both `--profile=core` and `--profile=full`) now installs and refreshes all four hook files the update-check/context-monitor feature needs (`gsd-check-update.js`, `gsd-check-update-worker.js`, `managed-hooks-registry.cjs`, `gsd-context-monitor.js`) together, instead of only the two parent scripts. Previously a registered parent hook pointed at a worker and registry the same installer never delivered. (#2695)
