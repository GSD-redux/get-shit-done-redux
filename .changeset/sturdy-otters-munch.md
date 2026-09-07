---
type: Fixed
pr: 4414
---
**`check predicate` gates can no longer be satisfied from outside the project, or shell-injected via `--phase-dir`'s content** — the `--phase-dir` input is now resolved against the project root and rejected if it escapes (including via a symlink), so a blocking capability-declared gate can no longer return a passing verdict sourced from an unrelated directory. Separately, `${PHASE_NUMBER}`/`${PHASE_DIR}`/`${PHASE_REQ_IDS}` are now exported as real environment variables on the `command-exit-zero` subprocess instead of being text-substituted into the command string, so a confined-but-attacker-influenced value containing shell metacharacters (`$()`, backticks, `;`, `|`) can no longer be re-parsed by `sh` as command syntax.
