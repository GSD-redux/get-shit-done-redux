---
type: Fixed
pr: 2887
---
**`/gsd-plan-phase --reviews` now actually replans in chunked mode instead of silently skipping every plan** — the per-plan resume-check skips existing plans for crash-resume, but now exempts `--reviews` (whose purpose is to replan with review feedback). Also fixed the outline resume-check, which looked for a marker the agent only returned (never wrote to the file), so the outline always re-ran. (#2762)
