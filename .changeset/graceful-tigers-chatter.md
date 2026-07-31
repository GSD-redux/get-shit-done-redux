---
type: Fixed
pr: 2910
---
**`verify-summary` no longer reports a valid SUMMARY as failed because of a path mentioned in prose** — file-claim extraction is now bound to a creation/modification claim (a `Created:`/`Modified:`/`key-files` line), so a prose mention of a future deliverable is not checked for existence; and `verify-summary` now resolves the project root, so invoking it from a subdirectory no longer manufactures missing files.
