---
id: 37
title: Hook System
group: Infrastructure Features
---

**Purpose:** Runtime event hooks for context monitoring, status display, and update checking.

**Requirements:**
- REQ-HOOK-01: Statusline MUST display model, current task, directory, and context usage
- REQ-HOOK-02: Context monitor MUST inject agent-facing warnings at threshold levels
- REQ-HOOK-03: Update checker MUST run in background on session start
- REQ-HOOK-04: All hooks MUST respect `CLAUDE_CONFIG_DIR` env var
- REQ-HOOK-05: All hooks MUST include 3-second stdin timeout guard
- REQ-HOOK-06: All hooks MUST fail silently on any error
- REQ-HOOK-07: Context usage MUST normalize for autocompact buffer (16.5% reserved)
- REQ-HOOK-08: Update banner MUST be opt-in and silent unless an update is available (PR #2795)

**Statusline Display:**
```text
[⬆ /gsd-update │] model │ [current task │] directory [█████░░░░░ 50%]
```

Color coding: <50% green, <65% yellow, <80% orange, ≥80% red with skull emoji

**Update Banner (opt-in, when GSD statusline isn't used):**

When the user declines (or keeps a non-GSD) statusline, the installer offers a SessionStart banner that surfaces update availability without occupying statusline real estate. The banner reads `~/.cache/gsd/gsd-update-check.json` (written by `gsd-check-update-worker.js`) and emits one line only when an update is available:

```text
GSD update available: 1.39.0 → 1.40.0. Run /gsd-update.
```

The banner is silent when up-to-date and rate-limits "check failed" diagnostics to once per 24 hours. Removed cleanly by `npx @opengsd/gsd-core --uninstall` or by deleting the SessionStart entry that references `gsd-update-banner.js`.
