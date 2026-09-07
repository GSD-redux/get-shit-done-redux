---
type: Fixed
pr: 4508
---
The Conventional Commit hook no longer exits with SIGPIPE while reading large custom commit-type lists, preserving its documented allow and block exit contract.
