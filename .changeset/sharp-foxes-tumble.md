---
type: Fixed
pr: 0
---
**Global flags now work in any argv position, including before `run-with-timeout`.** Passing `--exit-contract=<v>` before the subcommand — `gsd-tools --exit-contract=v2 state validate` — failed with `Error: Unknown command: --exit-contract=v2`, because the token was read for version resolution but never removed from argv, so the dispatcher treated it as the command name. Separately, `gsd-tools --json-errors run-with-timeout ...` failed with `Unknown command: run-with-timeout` and never ran the child, because `run-with-timeout` is intercepted before the flag is stripped. Both flags are now resolved and stripped ahead of that interception, and `--exit-contract` is listed in `gsd-tools --help`. (#3912)
