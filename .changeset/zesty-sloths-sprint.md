---
type: Added
pr: 0
---
**`/gsd-review` can now dispatch reviewer lanes concurrently** — a multi-reviewer pass cost roughly the sum of its lanes even though every lane inspects the same immutable plan snapshot and none depends on another. Set `review.parallel_lanes` to `true` to overlap them within a single pass; the default stays sequential and keeps the provider-rate-limit protection, and convergence cycles stay sequential either way. This also corrects `docs/COMMANDS.md`, which described `--all` as running every configured reviewer in parallel when dispatch was in fact sequential. (#3034)
