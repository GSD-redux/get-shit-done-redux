---
type: Fixed
pr: 0
---
**Full-line `#` comments in `.planning/STATE.md` (and every frontmatter surface) now survive a mutating write** — `parseYamlRegion` carries column-0 comments through to `reconstructFrontmatter` via a Symbol-keyed channel, and `syncStateFrontmatter` propagates that channel across its fresh-rebuild of the frontmatter object, so a comment like `# NOTE: current_phase is hand-maintained` is no longer silently destroyed on the next `state` verb. Comment-less frontmatter is unchanged; data identity (keys/values/arrays/nested) is preserved alongside the comments. (#3257)
