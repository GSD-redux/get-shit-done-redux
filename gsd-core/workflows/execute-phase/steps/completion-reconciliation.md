# Completion reconciliation (#4217, split A of #3754)

Read and follow this fragment from `execute-phase.md` step 4 whenever an executor's
completion is in question. It owns the whole reconciliation policy — both arms — so the
host wait step stays inside the ADR-857 Phase 6 byte ceiling (#1168).

**Reconcile FIRST, classify SECOND.** How the child's session ended is bookkeeping
about the transport; what it wrote to disk and to git is the evidence about the work.

## When this runs

1. **No terminal response** — a spawned agent does not return a normal terminal
   completion signal but appears to have finished its work (or may still be running).
2. **Abnormal end** — the child's session ended without a normal terminal completion
   response: interrupted, aborted, closed, killed, timed out, or ended `turn_aborted` —
   INCLUDING ends the orchestrator itself initiated. **An abnormally-ended child is
   not evidence of failure (#4217):** the orchestrator's own interrupt/close says
   nothing about whether the work completed; only the artifacts do.

This policy applies to EVERY runtime and every isolation path — harness `Agent()`
dispatches, orchestrator-worktree process spawns, and sequential dispatch alike. Never
block indefinitely waiting for a signal; verify via filesystem and git state.

## Probes (per plan in the wave)

```bash
# For each plan in this wave, check if the executor finished:
SUMMARY_EXISTS=$(test -f "{phase_dir}/{plan_number}-{plan_padded}-SUMMARY.md" && echo "true" || echo "false")
# #4003: anchored, zero-pad-tolerant scope (see safe_resume_gate); --since stays.
SPOT_PHASE_N=$((10#{phase_number}))
SPOT_PLAN_N=$((10#{plan_padded}))
COMMITS_FOUND=$(git log --oneline --all -E --grep="^[a-z]+\((0*${SPOT_PHASE_N})-(0*${SPOT_PLAN_N})\):" --since="1 hour ago" | head -1)
COMMITS_SINCE_DISPATCH=$(git log "${EXPECTED_BRANCH}" --since="${DISPATCH_TS}" --oneline | head -1)
```

## Verdicts

**If SUMMARY.md exists AND matching commits are found:** the agent completed
successfully — treat the plan as complete WITHOUT requiring another terminal child
response, proceed to step 5, and do NOT re-dispatch a fresh executor for this plan:
the work is already committed, and a second executor would redo it on top of itself.
Log: `"✓ {Plan ID} completed (verified via spot-check — completion signal not received)"`.

**If SUMMARY.md does NOT exist after a reasonable wait:** the agent may still be
running or may have failed silently. Check `git log --oneline -5` for recent
activity. If commits are still appearing, wait longer. If no activity, report the
plan as failed and route to the failure handler in step 6.

Evidence is BOTH probes or neither: a SUMMARY without matching commits, and matching
commits without a SUMMARY, are each incomplete evidence — never auto-complete on one
of them. When an abnormal end reconciles to no completion evidence, it stays failed:
route to the failure handler exactly as a normal failure would, and let the
safe-resume gate handle any un-summarized commits on the next run.
