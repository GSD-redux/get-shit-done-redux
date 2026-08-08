---
type: Fixed
pr: 3192
---
**`review-lane` rejects an unknown subcommand instantly instead of after a dozen subprocess spawns** — an unrecognized subcommand fell through to the usage-error branch only after loading the capability registry and building a per-lane plan, which spawns one child process per lane. The error now fires before any of that work starts (~119ms instead of ~1288ms). (#3148)
