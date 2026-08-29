---
type: Fixed
pr: 3774
---
**`milestone complete` now requires an explicit `--confirm` to mutate** — the command irreversibly archives ROADMAP.md/REQUIREMENTS.md, MOVES every phase directory in the milestone, and rewrites STATE.md, yet ran unconditionally on first invocation through every invocation path, including `query milestone.complete <version>`, whose `query` meta-prefix reads as a read-only namespace but performs no filtering. Without `--confirm` (and without `--dry-run`) the command now refuses before touching anything and names the flag that proceeds; `--dry-run` still previews the exact move list with no confirmation needed, and is now documented in the command's own usage block. `--force` keeps its narrow meaning (bypass the TRUNCATED-scope / unstarted-phase guards) and does not double as the mutation opt-in. The `/gsd-complete-milestone` workflow passes `--confirm` at its archive step. (#3726)
