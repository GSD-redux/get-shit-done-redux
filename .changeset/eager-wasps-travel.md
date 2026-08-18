---
type: Fixed
pr: 3594
---
**`phase remove` no longer corrupts STATE.md after removing an inserted (decimal) phase** — the removed-phase write prepended a second, partially-wrong frontmatter block (and left the phase's ROADMAP heading behind, so total_phases kept counting it); removal now updates STATE.md in place as a single block, drops the heading, and clamps phase counts at zero. (#3572)
