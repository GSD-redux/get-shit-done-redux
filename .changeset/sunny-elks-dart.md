---
type: Fixed
pr: 0
---
**Installing with --config-dir into a directory that already holds another harness's agent files now warns instead of failing silently** — the installer says the emitted artifacts are shaped for the selected runtime and their tool IDs and MCP grants may be inert or invalid for the destination harness, then proceeds. Fresh custom directories and GSD-only directories stay silent. (#3664)
