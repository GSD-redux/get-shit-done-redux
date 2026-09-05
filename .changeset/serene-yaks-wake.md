---
type: Fixed
pr: 4307
---
**`verify codebase-drift` no longer misclassifies non-ASCII paths as unmapped drift** — with git's default `core.quotepath`, C-quoted diff paths garbled `affected_paths`/`elements` and flagged documented directories as `new_dir`. Paths are now decoded before classification. (#4081)
