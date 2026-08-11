---
type: Fixed
pr: 3347
---
**`state add-decision` no longer persists a literal `[Phase ?]`** — omitting `--phase` wrote `- [Phase ?]:` into STATE.md even when that file's own frontmatter carried a resolvable `current_phase`, permanently losing the decision's provenance unless someone noticed and hand-edited it. The phase is now resolved from the document being written, via the same frontmatter → `Current Phase` field → scoped prose ladder `state prune` already used. An explicit `--phase` still wins, and a genuinely unresolvable phase still renders `?` rather than a guess. (#3231)
