---
type: Fixed
pr: 0
---
**STATE.md frontmatter comments now survive every state write** — a column-0 comment no longer depends on an unrelated body line being present, and an indented comment above the `progress:` counters (the natural provenance spot) is preserved instead of silently stripped. (#3742)
