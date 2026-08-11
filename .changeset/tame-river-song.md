---
type: Fixed
pr: 0
---
**Milestone phase counts no longer drop every letter-named phase directory** — `getMilestonePhaseFilter` now includes letter-named phase directories (`Phase A:`…`Phase L:`, GSD's own non-numeric phase convention per ADR-612) in milestone progress and plan counts. A greedy regex previously captured the whole hyphenated directory name (`A-tool-output-contract` was read as `A-tool-output-contract` instead of `A`), so every letter-named phase silently fell out of its milestone and the progress/plan totals were fabricated over whatever numeric directory happened to survive — a well-formed, plausible number that could even look correct at a phase boundary. Numeric and milestone-prefixed phases are unchanged. (#3213)
