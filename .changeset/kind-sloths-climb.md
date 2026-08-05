---
type: Fixed
pr: 3093
---
**`docs/json-errors.md` now documents the ExitError plain-text carve-out** — the page previously claimed every CLI error emits a structured JSON envelope on stderr, but usage errors (ExitError) intentionally emit plain text with their own exit code. The structured-envelope guidance is now scoped to non-usage failures, with the carve-out stated explicitly and a characterization test pinning both paths. (#2979)
