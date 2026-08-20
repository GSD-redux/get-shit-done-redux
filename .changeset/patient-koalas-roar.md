---
type: Added
pr: 0
---
**Code review depth can now be scoped by repository path** — set `workflow.code_review_depth_overrides` to a list of `{paths, depth}` rules and a review touching a sensitive directory such as `src/auth` automatically runs at the stronger tier, while the rest of the repository keeps the standard depth. Paths are matched as directory prefixes on whole path segments (glob syntax is rejected with a clear configuration error), `--depth=` still wins, and the resolved depth and the rule that matched are printed in the review output. (#2554)
