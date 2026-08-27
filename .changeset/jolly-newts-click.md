---
type: Fixed
pr: 0
---
**Antigravity global skills and agents now install to `~/.gemini/config/`** — the directory Antigravity actually scans for machine-local discovery, so installed skills are no longer silently ignored at startup. Upgrading an existing install automatically removes the old artifacts from the deprecated `~/.gemini/antigravity` location (modified files are backed up; user-authored files are preserved). (#3738)
