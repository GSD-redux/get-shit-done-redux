---
type: Fixed
pr: 3766
---
**docs/INVENTORY.md rows are now enforced** — a shipped agent, command, workflow, reference, CLI module, or hook could be added to the generated manifest with no row in the authoritative roster and still pass CI; the roster is now anchored the same way the manifest is, and 32 pre-existing gaps are backfilled. (#3762)
