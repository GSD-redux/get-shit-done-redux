---
type: Changed
pr: 4418
---
The workflow and agent size-cap test suites now report each capped file's remaining headroom on every run and flag files past a 95% reserved margin, so cap pressure is visible before a contributor hits the cap rather than only when they cross it.
