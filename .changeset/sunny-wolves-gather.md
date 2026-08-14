---
type: Fixed
pr: 3454
---
gsd-review no longer creates empty gsd-review-context.md / gsd-review-research.md section files (or hangs waiting on input) when a phase has no CONTEXT/RESEARCH notes: the build_prompt guards now test the glob expansion itself instead of probing with ls, which the block's nullglob setting had made always-true.
