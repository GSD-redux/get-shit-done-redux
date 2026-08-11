---
type: Fixed
pr: 0
---
**`gsd-tools validate health` no longer flags `.planning/WINDOWS.md` as an unrecognized file** — the broken-windows ledger that gsd-core's own `windows` command writes is now registered as a canonical `.planning/` artifact. Previously the W019 warning advised archiving or deleting a file that, with `workflow.windows_enforce` on, gates `/gsd-ship`. (#3224)
