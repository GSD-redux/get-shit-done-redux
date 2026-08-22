---
type: Changed
pr: 0
---
**A lone hallucinated reviewer finding no longer forces an extra replan cycle** — with two or more reviewers running, `/gsd-plan-review-convergence` now weighs a single reviewer's HIGH by what it claims: an existence claim about a symbol, file or ID must be source-grounded or corroborated, while a design or correctness finding still counts on its own unless that reviewer produced no citable evidence at all. Uncorroborated findings stay visible, tagged rather than dropped, and single-reviewer runs are unchanged. (#2398)
