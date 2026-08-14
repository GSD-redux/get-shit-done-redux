---
type: Fixed
pr: 0
---
**STATE.md preservation now enforces every policy its own table declares** — a field could be declared `preserve-when-unchanged` and quietly go unenforced, because the executor branched on field names rather than on the declared policy, so four of eight rows were honored by a weaker mechanism elsewhere and two policies had no implementation at all. Preservation is now dispatched from the classification table, a declared row nothing enforces fails loudly instead of silently, and a whitespace-only curated value is no longer treated as a real one. (#3468)
