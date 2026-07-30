---
type: Fixed
pr: 2851
---
**Agents and workflows no longer instruct a bare `gsd-tools` that fails on a shim-only install** — command-position `gsd-tools` invocations in the shipped agent/workflow source are now the portable `gsd_run` resolver (already defined in those files), so they resolve the runtime-local shim on installs with no `gsd-tools` binary on PATH. Previously only the Codex install-conversion pipeline rewrote these; the Claude-facing source shipped them verbatim and failed with `command not found`. (#2751)
