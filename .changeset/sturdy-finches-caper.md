---
type: Fixed
pr: 0
---
**The optional pre-commit hook now actually checks command-alias drift** — every guard in `.githooks/pre-commit` was inert: nine matched paths under the retired `sdk/` tree and invoked npm scripts that no longer exist, and the tenth watched gitignored build outputs that git can never stage. Staging `src/command-aliases.cts` now runs `check:alias-drift` instead of passing silently. (#2725)
