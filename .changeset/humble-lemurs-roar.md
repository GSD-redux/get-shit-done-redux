---
type: Fixed
pr: 3393
---
**Global Claude installs load skill content correctly again** — the installer rewrote `@~/.claude/` file references to `@$HOME/.claude/`, which Claude Code does not expand, silently leaving every GSD skill with an empty execution_context (the model got scaffolding but never the workflow body). @-references now stay on the tilde form Claude resolves. (#3133)
