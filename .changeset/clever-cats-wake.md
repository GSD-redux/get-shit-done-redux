---
type: Fixed
pr: 0
---
**`/gsd-review` no longer sweeps the run's own prompt/plan copies into `.review-diagnostics/`** — after a review, the preserved diagnostics folder is now dominated by actual evidence (reviewer reports and stderr sidecars) instead of byte-identical duplicates of the prompt, instructions, roadmap, and every plan under review. (#4097)
