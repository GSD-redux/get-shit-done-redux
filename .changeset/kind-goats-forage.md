---
type: Fixed
pr: 3682
---
**Hung checks no longer orphan a core-pegging worker process** — the bounded check runner now reaps its whole process subtree on timeout, where previously only the direct child was signalled and the per-file test worker survived at ~100% CPU forever, one per hung check, invisible behind a green suite. (#3660)
