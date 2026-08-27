---
type: Fixed
pr: 3828
---
**Trailing prose below the ledger's JSON block is no longer destroyed when that prose contains its own fenced JSON array** — `writeLedgerAtomic` located the block to preserve prose after by passing the POST-mutation entry count as its disambiguation hint, which can never match the pre-image's own count. The lookup fell back to the last array-shaped fenced block in the file, so an operator's notes containing a ```json array bound the preservation to the wrong fence and everything above it was dropped on the next write — the exact loss the preservation exists to prevent. (#3689)
