---
type: Fixed
pr: 4116
---
**`/gsd:review` no longer misdispatches or undercounts reviewer lanes under zsh** — a shell word-splitting bug collapsed multiple selected reviewers onto one bogus iteration when the workflow's dispatch, gate-check, and plan-coverage logic ran under zsh (the macOS default shell); all affected sites across gsd-core/workflows/*.md are fixed, and a new ShellCheck + structural lint gate catches this bug class in CI going forward. (#4109)
