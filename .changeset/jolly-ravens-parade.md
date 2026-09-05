---
type: Added
pr: 0
---
**`hooks.commit_types` config surface for `gsd-validate-commit.sh`** — projects using `hooks.community: true` can now extend the Conventional Commits type allowlist with a `hooks.commit_types` array in `.planning/config.json` (e.g. `["enhance", "enh", "revert"]`), added to rather than replacing the 10 built-in types. Configured values are validated against a safe-token pattern and the regex/error text now derive from a single source of truth. (#3811)
