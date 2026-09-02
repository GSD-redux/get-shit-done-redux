---
type: Fixed
pr: 4178
---
**`npm run lint` no longer fails on a leftover Stryker sandbox** — `eslint.config.mjs` now ignores `.stryker-tmp/**`, the scratch directory Stryker itself, `.gitignore` and `stryker.config.mjs` already treat as disposable. A mutation run interrupted before cleanup used to leave a copy of the tree there, and linting that copy reported the path-scoped `local/*` rules as undefined — hundreds of "Definition for rule … was not found" errors on a clean branch. (#4141)
