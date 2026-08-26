---
type: Fixed
pr: 0
---
**A `scripts/`-side tool that fails unexpectedly under `--json-errors` now emits the documented `{ok:false, reason, message}` envelope** — it previously printed a raw stack trace, because the exit module under `scripts/` was a second hand-written copy that never gained the structured-error branch its `src/` twin has. The copy is now generated from one source and byte-compared in CI, so the two cannot drift again. (#3904)
