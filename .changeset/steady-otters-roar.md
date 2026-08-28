---
type: Fixed
pr: 0
---
**`STATE.md`'s `## Current Position` section now documents that its fields are single-valued.** The section is overwritten rather than appended to, and a duplicated `Phase:` resolves to the first occurrence with no warning — so a second entry added in good faith is silently ignored rather than winning. That behavior was always true and was never written down, which is what #3812 reported. Progress history belongs in `## Performance Metrics`, and the reference page now says so in all five languages. (#3812)
