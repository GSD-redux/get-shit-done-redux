---
type: Fixed
pr: 3727
---
**`state` no longer lets a lone non-matching milestone section's phases become another milestone's `total_phases`** — with exactly one milestone section in ROADMAP.md and a STATE.md asserting a different milestone, the section's phases were silently written as the asserted milestone's total (clobbering the stored value). Both that shape and the multi-section one now keep the stored total and warn, naming the asserted milestone. Flat roadmaps (no milestone headings at all) are unchanged. (#3642)
