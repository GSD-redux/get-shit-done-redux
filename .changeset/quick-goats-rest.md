---
type: Fixed
pr: 4004
---
`gsd-tools verify artifacts` and `verify key-links` no longer report a phase as fully verified when its `must_haves` block was authored as prose bullets. A block whose items carry no `path:`/`from:` key is now reported as `invalid` with `total: 0` instead of a silent all-passed GREEN over zero checks, so a phase with no verifiable acceptance evidence can no longer read green. (#3956)
