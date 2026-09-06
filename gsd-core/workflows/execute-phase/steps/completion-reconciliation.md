Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# Completion Reconciliation (#4217)

Read this before classifying any plan as failed.

## An abnormally-ended child is not evidence of failure

A child can stop returning without having stopped working — and it can stop *after*
having finished. Reported on Codex: an executor implemented its plan, passed
verification, made the commits and wrote the SUMMARY; the parent kept waiting for a
normal terminal response, then interrupted and closed it as `turn_aborted` with the
completion evidence sitting on disk.

This reconciliation is **REQUIRED before any plan is classified as failed**, and it
applies to every way a child can end without a normal terminal response — interrupted,
aborted, closed, killed, timed out, or a runtime-level `turn_aborted`.

Run the same two spot-checks step 3 defines, against the artifacts and git state:

- **SUMMARY.md present AND matching commits present → the plan is COMPLETE.** Log
  `"✓ {Plan ID} completed (verified via spot-check — child ended without a terminal response)"`,
  proceed to step 5, and do **NOT** re-dispatch: the work is already committed, and a
  second executor would redo it on top of itself.
- **Otherwise → the plan is incomplete.** Route to the failure handler as usual.

## If SUMMARY.md does NOT exist after a reasonable wait

The agent may still be running, or may have failed silently. Check `git log --oneline -5`
for recent activity. If commits are still appearing, wait longer. If there is no activity,
report the plan as failed and route to the failure handler in step 6.

## Why the order matters

Reconcile the artifacts FIRST, classify SECOND. How the child's session ended is
bookkeeping about the transport; what it wrote to disk and to git is the evidence about
the work. A runtime that reports an abnormal end is describing its own channel, not the
plan.
