---
type: Fixed
pr: 0
---
Six STATE.md frontmatter fields whose preservation policy is declared in the field-classification table were not honored by the table-driven preservation pass — `last_activity_desc`, `paused_at`, `current_phase`, `current_plan` (preserve-when-unchanged) and `milestone`, `milestone_name` (preserve-if-placeholder). The pass now implements every declared row, so editing a preservation row is a one-row table edit as the table's own contract documents. Curated frontmatter values for `paused_at` / `current_phase` / `current_plan` now survive a body-only write (e.g. `state update`) even when the body carries a stale-but-present derived value — previously only an absent derived value triggered the fallback, so a stale body value silently overwrote the curated frontmatter value. `last_activity_desc` is now governed by a single rule (the table row) rather than a separate date-comparison guard that could disagree with it. (#3258)
