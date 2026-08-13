---
type: Fixed
pr: 3401
---
**`milestone.complete` no longer records the wrong line as a release's accomplishment** — the one-liner was extracted from the first bold text under the SUMMARY's first heading, so an incidental first heading (a rule list, deviation notes) could contribute `Rule 1 - Bug` or `NeutralPath` as the milestone's permanent accomplishment in MILESTONES.md. Extraction now anchors to a Summary/Overview/Accomplishments heading and falls back to empty when none is present. (#3170)
