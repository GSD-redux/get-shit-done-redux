---
type: Fixed
pr: 4140
---
**`/gsd-pause-work` no longer fails on its first step** — the Context Detection step's phase/spike/sketch lookups used a $(( construct that POSIX `sh`/dash rejects as a hard syntax error (bash/zsh happened to tolerate it via an undocumented fallback). (#4112)
