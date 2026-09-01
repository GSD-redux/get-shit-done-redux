---
type: Fixed
pr: 0
---
**`/gsd-pause-work` phase/spike/sketch detection now works on macOS** — the #4112 fix removed a shell-syntax bug but left a GNU-only `grep -oP` that macOS's BSD grep silently fails on, so detection resolved to empty. A new lint (`lint-portable-grep`) now catches this class of GNU-only-grep-flag defect in workflow markdown before it merges. (#4112)
