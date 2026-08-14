---
type: Fixed
pr: 0
---
roadmap validate now emits a V005 warning and exits non-zero when the active milestone's window is truncated — phase entries exist in ROADMAP.md but are excluded from the milestone's resolved section (e.g. an intervening version-bearing heading closes the window before its own Phase sections). Previously this passed silently with {"warnings":[]}.
