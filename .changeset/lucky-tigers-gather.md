---
type: Fixed
pr: 3791
---
**`state.advance-plan` now reads a plan position written as `Current Plan: N of M`** — the legacy field name carrying a compound value was accepted by neither parse branch, so the command reported a parse failure against a STATE.md whose plan numbers were plainly readable. Zero-padding is preserved on write-back (`04 of 06` advances to `05 of 06`, widening to `10 of 12` rather than truncating), and when the position genuinely cannot be read the error identifies itself as a parse failure and names all three accepted shapes.
