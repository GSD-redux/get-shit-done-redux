---
type: Fixed
pr: 3385
---
Installer: settings.json and settings.local.json are now written atomically (temp+rename), so a crash mid-write can no longer truncate the file. Hosts discard the entire settings file on a parse failure, so a truncated write previously cost users every hook, permission, env var, and statusline they had — not just GSD's.
