---
type: Fixed
pr: 2836
---
**Corrected the legacy ADR range documentation** — the legacy zero-padded ADR range is now stated once (in docs/adr/README.md, as 0001–0012) and referenced rather than restated by docs/contributor-standards.md, so the two can no longer drift. The two zero-padded files that look legacy but are not (0174, 0656) are now identified as modern, mis-padded issue-numbered ADRs. Previously the two documents disagreed and neither matched disk.
