---
type: Fixed
pr: 2
---
**`/gsd:plan-review-convergence` finds REVIEWS.md on paths with spaces** — the reviews-file lookup was unquoted, so a project path containing a space resolved to nothing and the run aborted blaming the review agent for a file that existed. A path containing a glob metacharacter could silently resolve to a different phase's REVIEWS.md. The path is now resolved directly and quoted, and an unreadable one fails closed with an error naming the expected location.
