---
type: Fixed
pr: 3140
---
**`state planned-phase` no longer overwrites authoritative `last_activity_desc`** — when the frontmatter and body had the same activity date but different descriptions, the write path preserved the date but overwrote the frontmatter's description with stale body prose. Same-date frontmatter desc is now preserved. (#3052)
