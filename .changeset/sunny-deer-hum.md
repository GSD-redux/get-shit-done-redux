---
type: Fixed
pr: 3551
---
**Global Claude Code installs now load their referenced workflow context** — `gsd-core/workflows/*.md` and other spec-tree files previously emitted `@$HOME/.claude/...` `@`-file-references, a form Claude Code's `@`-import resolver silently drops (only `~/` and absolute paths resolve). Every such reference now resolves on `~/`, matching the already-working skill/command surface; double-quoted shell $HOME references are untouched. (#3544)
