---
type: Changed
pr: 4367
---
**Codex no longer installs a context-monitor hook that could never fire.** `gsd-context-monitor.js` read a remaining-context bridge file only Claude Code's statusline hook writes, so every one of its Codex hook-event registrations was a guaranteed silent no-op. Fresh Codex installs no longer copy or register it; a reinstall over an older install now removes the stale registrations and the orphaned script. Agent-facing context warnings and phase/lifecycle display are documented as unsupported on Codex until a real metrics producer exists for that runtime. (#2586)
