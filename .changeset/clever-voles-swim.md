---
type: Fixed
pr: 3434
---
**`/gsd:code-review-fix <phase> --auto` now commits the converged REVIEW.md alongside REVIEW-FIX.md and reliably commits REVIEW-FIX.md at all** — the --auto re-review loop overwrote REVIEW.md every iteration but the workflow's single docs commit staged only REVIEW-FIX.md, so the committed REVIEW.md stayed at iteration 1 and contradicted the committed REVIEW-FIX.md (and the converged REVIEW.md plus .iterN.md backups survived only as uncommitted working-tree state). Separately, the two inline frontmatter validators exported REVIEW_PATH into a node -e body that reads process.env.FIX_REPORT_PATH, so the status check was always empty and REVIEW-FIX.md was never committed (the user was wrongly told the agent produced malformed output). The validators now export FIX_REPORT_PATH, the --auto commit stages REVIEW.md too, and spent .iterN.md backups are removed on successful convergence (retained on degradation). Non-auto single-pass runs are unchanged. (#3190)
