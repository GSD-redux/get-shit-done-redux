---
type: Changed
pr: 2412
---
**`/gsd-plan-review-convergence` now accepts `--cursor` and `--qwen`** — the convergence loop previously parsed only a subset of the reviewers `/gsd-review` supports, silently dropping `--cursor`/`--qwen` to the `--codex` default; both flags are now recognized and forwarded to the inner review call, so you can converge a plan against Cursor or Qwen Code alone without pulling in every reviewer via `--all`. (#2272)
