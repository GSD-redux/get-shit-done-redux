---
type: Fixed
pr: 3277
---
**ESLint now actually runs on 56 previously-unlinted source files** — a file matching no `files:` glob was not linted-and-clean, it was skipped entirely while `eslint .` still exited 0. All of `hooks/` and `eslint-rules/` sat in that blind spot. A new drift guard fails the build if any tracked source file resolves to zero rules without a recorded reason, so the class cannot silently regrow. (#3059)
