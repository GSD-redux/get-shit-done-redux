---
type: Fixed
pr: 2865
---
**The statusline now renders GSD state correctly on Windows-authored (CRLF) STATE.md** — `parseStateMd` no longer drops the entire frontmatter block on CRLF input. The fence regex and downstream splits now accept CRLF line endings, matching the canonical `extractFrontmatter` parser. Previously a CRLF STATE.md silently produced an empty GSD-state segment (no status, phase, or milestone) with no error. (#2754)
