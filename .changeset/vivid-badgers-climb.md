---
type: Changed
pr: 3110
---
**21 GSD skills can now use the `Grep` tool** — skills that perform structured file search previously had to shell out to `grep` through `Bash`, costing an extra permission prompt per search and forcing text parsing where structured matches were available. The six `gsd-ns-*` namespace dispatchers, `gsd-help`, and `gsd-surface` are deliberately excluded per the least-privilege scoping approved in #3085.

<!-- docs-exempt: no file under docs/ enumerates per-skill allowed-tools declarations; the only mentions (ARCHITECTURE.md line 112, adr/0002) describe the frontmatter contract generically and are unaffected, and docs/AGENTS.md documents subagent tool grants, a different surface this PR does not touch -->
