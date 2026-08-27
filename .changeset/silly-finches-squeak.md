---
type: Changed
pr: 0
---
**Every GSD enforcement hook now declares its crash policy.** Hooks used to end their outer catch with a bare `process.exit(0)` or `process.exit(2)`, so whether a hook fails open or closed on its own bug was invisible without reading its source; hooks now terminate through `allow`/`deny`/`crash` and declare a required `ON_CRASH` policy, with no change to any hook's effective exit code. Also fixes #3838: `gsd-validate-commit.sh`'s config/JSON/git-subcommand checks no longer treat "could not run" the same as a genuine negative — a failed check now says so on stderr instead of silently allowing every commit. (#3911)
