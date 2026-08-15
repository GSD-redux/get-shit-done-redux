---
type: Changed
pr: 0
---
**Internal cleanup with no behavior change** — the STATE.md write-seam helpers took eight positional arguments with three optional trailing ones, so a call site could silently pass the wrong thing in the wrong slot, and phase-completion reporting re-derived by string matching which of its entries were fields and which was a whole section. Both are now expressed directly in the types. No command output changes. (#3408)
