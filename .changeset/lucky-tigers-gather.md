---
type: Fixed
pr: 3791
---
**`state.advance-plan` now reads a plan position written as `Current Plan: N of M`, writes the advanced value back to every field that carries it, and refuses values it cannot fully read.** The legacy field name carrying a compound value was accepted by neither parse branch, so the command reported a parse failure against a STATE.md whose plan numbers were plainly readable.

Both accepted shapes are now matched by an **anchored** grammar, and every number comes from a capture group. Previously the total was found by an unanchored search for `of <digits>` anywhere in the value, so `Current Plan: 4 — blocked on review of 2 PRs` parsed as "4 of 2", concluded the phase was over, and wrote `Status: Phase complete — ready for verification` into the file. Values with a sign, a non-numeric leading token, or a number past `Number.MAX_SAFE_INTEGER` are now refused rather than coerced. A trailing note after the total (`Plan: 2 of 5 in current phase`) is still accepted.

Advancing rewrites only the leading digits, so the zero-padding width and any ` of M` survive: `04 of 06` advances to `05 of 06` (widening to `10 of 12` rather than truncating), and the legacy pair no longer collapses `2 of 99` into a bare `3` or `04` into `5`. Every site carrying a plan position is written in its own spelling, so a header and a `## Current Position` line can no longer disagree about where execution is. When the position cannot be read, the error names the accepted shapes, derived from the schema rather than transcribed beside it.
