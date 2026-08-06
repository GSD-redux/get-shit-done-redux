---
type: Fixed
pr: 3105
---
**`state.*` writes no longer flip the milestone or rewrite progress with whole-project counts** — when the stored milestone had no matching non-shipped ROADMAP heading, `buildStateFrontmatter` auto-derived a confidently-wrong milestone and clobbered the stored value + progress on every write. The disk scan now scopes to the STORED milestone explicitly, so a state write that doesn't change progress leaves the milestone and progress block untouched. (#3017)
