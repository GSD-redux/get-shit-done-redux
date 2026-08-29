---
type: Fixed
pr: 4004
---
`gsd-tools verify artifacts` and `verify key-links` no longer report a phase as fully verified when its `must_haves` block was authored entirely as prose bullets. A block whose items are all bare strings (no checkable `path:`/`from:` entry) is now reported as `invalid` with `total: 0` instead of a silent all-passed GREEN over zero checks, so a phase with no verifiable acceptance evidence can no longer read green. A block that mixes a prose bullet with a real entry is unaffected — the string is skipped and the verdict follows the checkable entry. (#3956)
