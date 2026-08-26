---
type: Changed
pr: 3888
---
**`.planning/` frontmatter is now parsed by a real YAML parser.** Block scalars, quoted keys and non-ASCII keys are read correctly instead of being mangled or silently dropped, and a document whose frontmatter cannot be parsed keeps its frontmatter block instead of losing it on the next write. (#3881)
