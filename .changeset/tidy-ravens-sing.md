---
type: Fixed
pr: 0
---
phase-plan-index silently drops short-form depends_on references (e.g. ["01"]), collapsing every plan into wave 1. The planner template's two worked dependency examples taught exactly that broken short form; they now teach the full-form plan id (e.g. ["01-01"]) the file's own frontmatter comment and other examples already document, so newly authored plans keep resolvable dependency edges. Resolver-side short-form handling is tracked separately in #3473.
