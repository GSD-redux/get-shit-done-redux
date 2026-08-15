---
type: Changed
pr: 3519
---
**state json and the state-mutating commands now agree with what is actually on disk** — a stale body annotation could beat a fresher curated frontmatter value in state json output, and commands reported fields as updated that the write pipeline had already discarded while staying silent about fields it restored. Preservation is now enforced in one place across every path, each command reconciles its report against the persisted file, and a value dropped because this write deliberately removed its body line is reported rather than silently lost. (#3471)
