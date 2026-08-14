---
type: Changed
pr: 0
---
**milestone complete no longer lets a stale STATE.md body line overwrite fresher frontmatter** — it wrote through a path that re-derived frontmatter from the body with no preservation pass, so a stale Stopped-at line silently replaced a newer curated value, exactly as phase complete did before it was fixed. It now runs the same preservation the rest of the write path uses, and reports each field it protected in a new preservation_warnings array instead of staying silent about the divergence. (#3469)
