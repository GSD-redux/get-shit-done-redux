---
id: 5
title: Phase Execution
group: Core Features
---

**Command:** `/gsd-execute-phase <N>`

**Purpose:** Execute all plans in a phase using wave-based parallelization with fresh context windows per executor.

**Requirements:**
- REQ-EXEC-01: System MUST analyze plan dependencies and group into execution waves
- REQ-EXEC-02: System MUST spawn independent plans in parallel within each wave
- REQ-EXEC-03: System MUST give each executor a fresh context window (200K tokens)
- REQ-EXEC-04: System MUST produce atomic git commits per task
- REQ-EXEC-05: System MUST produce a SUMMARY.md for each completed plan
- REQ-EXEC-06: System MUST run post-execution verifier to check phase goals were met
- REQ-EXEC-07: System MUST support git branching strategies (`none`, `phase`, `milestone`)
- REQ-EXEC-08: System MUST invoke node repair operator on task verification failure (when enabled)
- REQ-EXEC-09: System MUST run prior phases' test suites before verification to catch cross-phase regressions

**Produces:**
| Artifact | Description |
|----------|-------------|
| `{phase}-{N}-SUMMARY.md` | Execution outcomes per plan |
| `{phase}-VERIFICATION.md` | Post-execution verification report |
| Git commits | Atomic commits per task |

**Wave Execution:**
- Plans with no dependencies → Wave 1 (parallel)
- Plans depending on Wave 1 → Wave 2 (parallel, waits for Wave 1)
- Continues until all plans complete
- File conflicts force sequential execution within same wave

**Executor Capabilities:**
- Reads PLAN.md with full task instructions
- Has access to PROJECT.md, STATE.md, CONTEXT.md, RESEARCH.md
- Commits each task atomically with structured commit messages
- Uses `--no-verify` on commits during parallel execution to avoid build lock contention
- Handles checkpoint types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`, `checkpoint:human-action`
- Reports deviations from plan in SUMMARY.md

**Parallel Safety:**
- **Pre-commit hooks**: Skipped by parallel agents (`--no-verify`), run once by orchestrator after each wave
- **STATE.md locking**: File-level lockfile prevents concurrent write corruption across agents
