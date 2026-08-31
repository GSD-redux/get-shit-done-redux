---
type: Changed
pr: 4085
---
**`/gsd-verify-work` re-verification no longer reopens a closed gap-closure round on an unevidenced new finding** — a Step 7 anti-pattern blocker that isn't a carried-forward gap or a regression on a file touched since the prior pass now needs a red-capable test or another concrete artifact to stay blocking; without one it's recorded as advisory instead of reverting completed work and starting another `--gaps` cycle. (#3304)
