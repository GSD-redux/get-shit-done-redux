---
type: Fixed
pr: 3027
---
**GSD-2 import no longer duplicates frontmatter in the generated SUMMARY.md** — importing a GSD-2 project whose task summaries were authored with CRLF line endings emitted the original GSD-2 frontmatter a second time, as body text, below the new one. Stripping now goes through the canonical line-ending-tolerant parser. (#2703)
