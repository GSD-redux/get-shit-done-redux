---
type: Fixed
pr: 2811
---
**Upgrading a Claude-global GSD install now uses the new version's skill content instead of the previous version's** — the installer read a `.gsd-source` marker that still pointed at the prior install's source location before rewriting it, so on an upgrade every converted skill was generated from the old version's command definitions (while the file manifest faithfully recorded the stale content's hash as correct). The marker is now written before anything reads it. (#2624)
