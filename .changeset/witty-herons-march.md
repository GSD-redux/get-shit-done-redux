---
type: Fixed
pr: 3229
---
**npm-global installs can now actually fail the agents-installed gate** — `checkAgentsInstalled` resolved the claude agents directory relative to its own install location, so an npm-global install validated the package's bundled `agents/` against itself and `agents_installed` could never be `false`, silently disabling the halt/warn gates in `new-project` and `new-milestone`. When the install-relative path lies inside a `node_modules` tree the claude runtime now resolves `getGlobalConfigDir('claude')/agents` like every other runtime, honouring `CLAUDE_CONFIG_DIR`; repo runs and runtime-config-dir installs are unchanged, and the `GSD_AGENTS_DIR` override stays priority 1. (#3203)
