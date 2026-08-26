---
type: Fixed
pr: 3888
---
**A failing `state` command now exits non-zero.** Twenty-three error paths across the state command family printed an error payload and still exited 0, so `if gsd-tools state …; then` took the success branch on failure and the `$(… || echo default)` idiom never fired. (#3881)
