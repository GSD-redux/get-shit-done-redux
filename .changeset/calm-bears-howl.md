---
type: Changed
pr: 0
---
state validate now runs its drift scan for STATE.md files whose phase lives only in frontmatter, instead of silently skipping the scan and reporting a false-clean result (#3162); it also no longer lets a frontmatter status: key shadow the body Status field. Its output gains a scope field (complete/truncated/unscoped/unreadable) reporting whether the check could actually run — valid still means no drift was found, and is not derived from scope. (#3187)
