---
type: Fixed
pr: 0
---
**The installer writes settings.json and settings.local.json atomically (temp+rename)** — a crash mid-write can no longer truncate the file. Hosts discard the entire settings file on a parse failure, so a truncated write previously cost users every hook, permission, env var, and statusline they had — not just GSD's.
