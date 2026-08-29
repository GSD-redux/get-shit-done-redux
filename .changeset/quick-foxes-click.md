---
type: Fixed
pr: 3977
---
**Package-legitimacy-gate tests no longer silently drop malformed table rows.** The test suite's markdown-table parsing now reuses the ADR-2143 seam instead of two hand-rolled copies, so a ragged row or an escaped-pipe cell fails loudly instead of being silently mis-parsed. (#3239)
