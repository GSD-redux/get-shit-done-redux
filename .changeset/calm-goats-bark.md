---
type: Fixed
pr: 4453
---
**`state begin-phase` no longer rewrites prose that merely quotes a bold field label** — a `**Status:**` (or any served field label) quoted mid-sentence inside prose captured the field rewrite and silently destroyed the rest of its line; the bold form is now anchored to line start, so only the real field updates. Frontmatter round-trip through begin-phase (custom keys, progress subkeys, milestone identity without a ROADMAP) is pinned with regression tests. (#4243)
