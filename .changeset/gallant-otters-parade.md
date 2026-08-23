---
type: Fixed
pr: 3785
---
**`state.advance-plan` now reads a plan position written as `Current Plan: N of M`** — the legacy field name carrying a compound value was accepted by neither parse branch, so the command reported a parse failure against a STATE.md whose plan numbers were plainly readable. Zero-padding is now preserved on write-back (`04 of 06` advances to `05 of 06`, not `5 of 06`), and when the position genuinely cannot be read the error names all three accepted shapes instead of naming none.
