---
type: Fixed
pr: 4370
---
**Antigravity's seven GSD guards now actually fire** — the installer registers hook matchers in Antigravity's own tool vocabulary (`write_to_file`, `replace_file_content`, `view_file`, `run_command`) instead of Claude Code's, migrates an existing install's matchers in place, and the guards lift Antigravity's nested `toolCall` payload envelope before reading it. (#4332)
