---
type: Fixed
pr: 4414
---
**`check predicate` gates can no longer be satisfied from outside the project** — the `--phase-dir` input is now resolved against the project root and rejected if it escapes (including via a symlink), so a blocking capability-declared gate can no longer return a passing verdict sourced from an unrelated directory, and `${PHASE_DIR}` can no longer interpolate an out-of-project path into a `command-exit-zero` command.
