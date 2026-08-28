---
type: Fixed
pr: 3791
---
**`state.advance-plan` now reads a plan position written as `Current Plan: N of M`, and advances every site that carries one instead of leaving the document disagreeing with itself.** The legacy field name carrying a compound value was accepted by neither parse branch, so the command reported a parse failure against a STATE.md whose plan numbers were plainly readable.

The total is no longer read out of prose. Both accepted shapes are matched by a grammar anchored at the start of the value, and every number comes from a capture group. Previously an unanchored search for `of <digits>` anywhere in the value made `Current Plan: 4 — blocked on review of 2 PRs` parse as "4 of 2", conclude the phase was over, and write `Status: Phase complete — ready for verification` into the file. A trailing annotation is still accepted on both shapes (`Plan: 2 of 5 in current phase`, `Total Plans in Phase: 5 phases`), and survives the write.

Advancing rewrites only the leading digits, so the zero-padding width and everything after it survive: `04 of 06` advances to `05 of 06`, widening to `10 of 12` rather than truncating, and the legacy pair no longer collapses `2 of 99` into a bare `3` or `04` into `5`. The `## Current Position` section advances alongside the header for every spelling — plain, bold and pipe-table — so the two can no longer report different plans. When the position cannot be read at all, the error names the accepted shapes rather than asserting a cause it cannot know.
