---
type: Fixed
pr: 4207
---
**A full test run can no longer exhaust the system temp filesystem** — the runner now scopes every fixture's temp tree under one per-run root, sweeps it between chunks, fails fast with a named culprit when residue persists, and removes it on exit; previously leaked fixture trees accumulated unbounded until tmpfs `/tmp` filled and the failure surfaced as unrelated `EDQUOT`/`-122` errors. (#4020)
