---
type: Fixed
pr: 4017
---
**`STATE.md`'s `## Current Position` section now documents that its fields are single-valued.** The section is overwritten rather than appended to, and a duplicated `Phase:` line does not simply resolve to the first occurrence — it resolves by form first (bold, then plain, then pipe-table), scoped to the `## Current Position` section, and only within the winning form does the first occurrence win. So a bold line added in good faith after an earlier plain line silently overrides it rather than being ignored. That behavior was always true and was never written down, which is what #3812 reported. Progress history belongs in `## Performance Metrics`, and the reference page now says so in all five languages. (#3812)
