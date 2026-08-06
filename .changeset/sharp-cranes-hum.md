---
type: Fixed
pr: 3113
---
**Claude Code plugin installs no longer silently disable all hooks** — the plugin manifest (`.claude-plugin/plugin.json`) explicitly declared `hooks/hooks.json`, which Claude Code also auto-loads by default, causing a duplicate-declaration rejection that silently disabled every hook (security guards, monitors, injection scanners). The redundant declaration is removed; Claude Code's auto-load path handles it. (#3029)
