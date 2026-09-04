---
type: Fixed
pr: 4274
---
**Antigravity CLI global skills: corrected the host-integration matrix evidence and pinned the CLI-only install path** — a live `agy` 1.1.17 probe showed the CLI discovers global skills in `~/.gemini/config/skills/` and silently drops everything under its configHome; the runtime layout was already fixed by #3738, and the matrix no longer cites the disproven blog claim while a new test pins the CLI-only probe branch so the silent-drop class cannot regress. (#3747)
