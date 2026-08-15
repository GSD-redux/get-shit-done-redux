---
type: Security
pr: 0
---
**MCP server configs are now explicitly flagged as unconfined in the capability consent prompt** — a capability's MCP servers can legitimately point at commands, args, env, and working directories anywhere on the machine (unlike its hooks, which are confined to the installed bundle), and the consent disclosure now says so plainly for every spawned server instead of leaving the asymmetry unstated. (#3515)
