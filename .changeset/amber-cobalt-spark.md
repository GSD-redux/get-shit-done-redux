---
type: Fixed
pr: 0
---
**`requirements mark-complete` now flips the traceability row when `## Traceability` holds more than one table** — `updateTableCell` no longer binds to the first table in the section; it scans for the table that actually carries the requested column. A section with a phase-summary table above the requirement rows previously made the Status write silently bail (`table_unmatched`) while the checkbox still flipped, leaving the row at `Pending` indefinitely. Single-table sections are unchanged. (#3255)
