---
type: Changed
pr: 0
---
**An unevidenced lone reviewer finding no longer forces an extra replan cycle** — with two or more reviewers running, `/gsd-plan-review-convergence` now weighs a single reviewer's HIGH by what it claims: an existence claim about a symbol, file or ID must be source-grounded or corroborated, while a design finding still counts on its own unless that reviewer cited no source evidence anywhere in its review. Findings that stop counting stay visible, tagged rather than dropped, and single-reviewer runs are unchanged. A design finding from a reviewer that did cite evidence still counts alone — deliberately, so that a real architectural concern only one reviewer noticed keeps blocking. (#2398)
