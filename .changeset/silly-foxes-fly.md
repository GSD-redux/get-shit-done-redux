---
type: Fixed
pr: 3011
---
**`scripts/lint-compiled-artifact-sync.cjs` no longer fails on containerized checkouts owned by a different uid** — its internal `git` calls now scope `safe.directory` to the repo root per-invocation, so the guard runs instead of erroring with "detected dubious ownership" in any CI lane where the checkout owner differs from the running user. (#2657)
