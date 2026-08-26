---
type: Fixed
pr: 3791
---
**`state.advance-plan` now reads a plan position written as `Current Plan: N of M`, and writes the advanced value back to the field it came from.** The legacy field name carrying a compound value was accepted by neither parse branch, so the command reported a parse failure against a STATE.md whose plan numbers were plainly readable.

The write path now follows the read path. Advancing rewrites only the leading digits, so the zero-padding width and everything after it survive: `04 of 06` advances to `05 of 06` (widening to `10 of 12` rather than truncating), and the legacy pair no longer collapses `2 of 99` into a bare `3` or `04` into `5`. On a file carrying the field at both the header and the `## Current Position` line, both sites advance — previously the section stayed a plan behind the header. When the position genuinely cannot be read, the error names all three accepted shapes instead of asserting a cause it cannot know.
