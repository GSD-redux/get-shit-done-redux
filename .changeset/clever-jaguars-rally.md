---
type: Added
pr: 3824
---
**GSD now publishes a machine-readable state snapshot at every step boundary** — external tools that show project state no longer have to parse STATE.md and ROADMAP.md heuristically. `.planning/state.json` carries a versioned `contract`, the current `milestone`, every phase with its `complete`/`in_progress`/`pending` status, and the same recommended `next` action the `/gsd` front door routes. The write is best-effort and can never fail, slow, or alter the command that triggered it. (#3227)
