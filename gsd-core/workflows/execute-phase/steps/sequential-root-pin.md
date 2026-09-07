# Sequential root pin (#4254)

Apply response_language to all user-facing prose — narration between tool calls, status
updates, progress notes, and findings included; preserve code, paths, and identifiers.

Read and execute this fragment from `execute-phase.md`'s **Sequential mode** branch before
composing any sequential dispatch prompt. It owns the sequential root-pin build-time embed,
the `<required_reading>` root substitution, and the wave serialization rules.

## Root pin — ORCHESTRATOR build-time embed (#4254; NOT a sub-agent runtime step)

Before this dispatch, read `gsd-core/references/worktree-path-safety.md` step 0p
("Supplied-root pin") and copy its guard template into this prompt inside a
`<project_root_pin>` block, substituting `{PINNED_ROOT}` with the literal value of
`$ORCHESTRATOR_WT` resolved at execute_waves entry, shell-single-quoted per that section's
composition contract — the dispatched prompt must carry the bound, runnable guard verbatim;
do not pass this instruction through in its place.

In this dispatch's `<required_reading>`, also replace the self-derivation line
`PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)` with
`PROJECT_ROOT='<the same literal $ORCHESTRATOR_WT>'` — a sequential executor must never
re-derive its root from its own (possibly drifted) cwd. This substitution is sequential-mode
ONLY: worktree-mode dispatches keep the self-derived line — an isolated executor's own
toplevel IS its correct (and intentionally different) worktree, and substituting the
orchestrator's root there would break every worktree-mode dispatch.

## Wave serialization (moved verbatim from the host step — ADR-857 Phase 6 ceiling, #1168)

When worktrees are disabled for a plan (per-plan or project-level), that plan's executor runs
on the main working tree. If **any** plan in the current wave dropped to sequential mode,
execute the affected plan(s) **one at a time** to avoid concurrent writes to the main working
tree — plans in the same wave that retained worktree isolation can still run in parallel
alongside the sequential ones, but two non-worktree plans in the same wave must serialize.
When the project-level `USE_WORKTREES=false`, all plans in the wave serialize regardless of
the `PARALLELIZATION` setting.
