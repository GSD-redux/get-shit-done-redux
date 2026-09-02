---
type: Removed
pr: 4179
---
**Dropped the `test:mutation:since` npm script** — it passed `--since`, which Stryker 9.x does not accept (`error: unknown option '--since'`), so it could not run at all. Nothing invoked it: the mutation gate runs the per-module matrix from `scripts/mutation-matrix.cjs` instead, so no workflow regresses. To see which modules a change puts in scope, run `node scripts/mutation-matrix.cjs --base origin/next --print`. (#4106)
