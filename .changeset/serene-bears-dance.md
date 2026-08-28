---
type: Added
pr: 0
---
**CONTEXT.md seam claims are now checkable.** New `SEAM.<id>.owns`/`SEAM.<id>.enforced-by` predicates plus a `lint:ci` gate (`scripts/lint-seam-enforcement.cjs`) fail the build when a declared single-owner seam names no existing, registered lint rule or test file, so a seam claim can no longer silently decay into an unenforced assertion. (#3626)
