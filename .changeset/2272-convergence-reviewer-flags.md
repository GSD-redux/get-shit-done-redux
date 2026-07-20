---
type: Changed
pr: 2412
---
**`/gsd-plan-review-convergence` now accepts `--cursor` and `--qwen`.** The convergence loop previously parsed only a subset of the reviewers `/gsd-review` supports, silently dropping `--cursor`/`--qwen` to the `--codex` default. Both flags are now recognized and forwarded to the inner review call, so you can converge a plan against Cursor or Qwen Code alone without pulling in every reviewer via `--all`. The same flags (plus `--agy`/`--antigravity`, which had the identical gap) now also survive the `--converge` passthrough on `/gsd-autonomous` and `/gsd-progress --next --converge`, which previously dropped them to `--codex` before the convergence loop ever saw them. (#2272)
