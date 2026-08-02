---
type: Fixed
pr: 2973
---
**Agent-skills warnings now suggest the `global:` prefix when a bare name matches a global skill** — configuring a skill by bare name (e.g. `patch-coverage-check`) that exists as a global skill was silently skipped with no hint that the fix is `global:patch-coverage-check`. The skip warning now appends a hint when the bare name matches an existing global skill. (#2941)
