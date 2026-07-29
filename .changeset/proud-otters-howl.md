---
type: Fixed
pr: 2688
---
**A corrupt `.planning/config.json` no longer silently discards your entire configuration** — a single trailing comma used to fall back to built-in defaults with no signal, indistinguishable from having no config file at all, so a project could run for weeks on defaults while its model profile, workflow toggles and branching strategy sat unread on disk. GSD now tells you the file could not be used and that its settings were not applied, and reports the cause (`config_unparseable` / `config_unreadable`) distinctly from genuine absence. The same applies to an unreadable file and to the global `~/.gsd/defaults.json`. (#1880)
