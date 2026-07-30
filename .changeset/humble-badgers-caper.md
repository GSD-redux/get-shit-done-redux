---
type: Fixed
pr: 2829
---
**Plan, summary, verification, and state validators now reject NUL-corrupted files** — `frontmatter validate`, `verify plan-structure`, and `state validate` now fail loud (valid:false) when a file contains embedded NUL bytes, with an error naming the encoding problem and its downstream consequence. Previously such a file passed as valid:true but was silently skipped by recursive/binary-skipping search tools (rg, grep -I), reading downstream as 'file absent' rather than 'file corrupt.'
