---
type: Fixed
pr: 4069
---
**Release coverage gate no longer OOMs as the test suite grows** — `test:coverage:unit` (used by the release finalize/rc jobs) and `test:coverage:report` (the sharded coverage-gate merge step) now pass c8's `--merge-async` flag, so raw V8 coverage files are merged one at a time instead of all being loaded into memory at once. (#4068)
