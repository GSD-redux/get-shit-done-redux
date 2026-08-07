---
type: Fixed
pr: 0
---
**Cross-AI reviewer lanes no longer silently drop on Windows** — `deps.spawn` used `shell: false` with a bare binary name, which fails with ENOENT on Windows .cmd shims (npm-installed CLIs). Now applies the #2667 `cmd.exe /d /s /c` shim gate. Spawn errors (ENOENT, ETIMEDOUT) are also surfaced in the reviewer err file instead of being silently dropped. (#3086)
