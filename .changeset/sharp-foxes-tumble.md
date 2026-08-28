---
type: Fixed
pr: 0
---
**`--exit-contract=<v>` now works in any argv position.** Passing the flag before the subcommand — `gsd-tools --exit-contract=v2 state validate` — failed with `Error: Unknown command: --exit-contract=v2`, because the token was read for version resolution but never removed from argv, so the dispatcher treated it as the command name. It is now spliced out like `--json-errors`, and is listed in `gsd-tools --help`. (#3912)
