# Executor self-repair of a worktree base mismatch via `git reset --hard`

**Source:** [#4463](https://github.com/open-gsd/gsd-core/issues/4463)
**Decision:** wontfix — No-go as filed; conflicts with the shipped #48 design
**Date:** 2026-09-07

## Proposal summary

Reporter ran a controlled probe on Claude Code and reported two findings, plus a proposal:

1. **Measurement:** the harness worktree it was dispatched into forked from the
   *orchestrator session's HEAD* (the main checkout's current branch tip), not from
   `origin/HEAD` as the `#3659`/`#3779`/`#48` family assumed. The reporter is explicit
   that this does not mean the `worktree.base-check` degrade is wrong in the case they
   observed — the stated *reason* for the degrade may be inaccurate even where the
   degrade itself is still warranted.
2. **Measurement:** because a linked worktree shares the common git object/ref store,
   the phase branch is reachable as a local ref with no `git fetch`, and
   `git reset --hard <phase-branch>` on the executor's own branch is cheap, does not
   switch or detach HEAD, and does not conflict with "branch already checked out
   elsewhere" (that check only fires on `git checkout`, not on moving one's own branch
   pointer via `reset`).
3. **Proposal:** where `worktree-branch-check` currently halts with `exit 42` on a base
   mismatch, let the executor **repair itself** — `git reset --hard <orchestrator HEAD>`
   on its own branch — and proceed, converting the halt into a self-heal.

## Why GSD does not own this

- **This is the exact primitive #48 removed, for the exact failure mode #48 was filed
  to fix.** #48 (closed, `approved-enhancement`, shipped) replaced sub-agent-side
  `git reset --hard` recovery with a verify-only, fail-closed `exit 42` check, specifically
  because (a) a permission deny-rule on `git reset --hard*` — common in safety-conscious
  host configurations — can make the recovery command itself fail, and depending on shell
  error handling the sub-agent may silently proceed on the wrong base or report success
  without re-verifying; and (b) a sub-agent should not hold state-correction primitives
  (`reset`, force-move, branch-switch) on a worktree it did not create — that
  responsibility belongs to the lifecycle owner, the orchestrator. #4463's proposal
  reintroduces precisely this: the executor mutating its own worktree state in response
  to a detected mismatch, on the sub-agent side.
- **The shipped design is live in current source, not just historically decided.**
  `gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md:7` states, verbatim:
  *"`worktree_branch_check` is verify-only — an executor that hits a base/HEAD-namespace
  mismatch prints `FATAL:` and exits **42** instead of self-recovering... The orchestrator —
  the worktree lifecycle owner — performs any base correction... the sub-agent never does."*
  This is an active architectural invariant, not stale rationale from a closed issue.
- **The "it costs almost nothing and nothing objects" framing is exactly what #48 warned
  about.** #4463's own Finding 3 confirms `git reset --hard` ran with no hook and no
  refusal in its probe — which is the *absence of a safety net* #48 is trying to compensate
  for by moving the responsibility off the sub-agent entirely, not evidence the operation
  is safe to grant back to it.

## What this does NOT cover

- **The fork-base measurement itself is not denied and is worth keeping.** If the
  harness-worktree fork base is genuinely the orchestrator session's HEAD rather than
  `origin/HEAD`, that is new information relevant to `#3659`'s and `#3779`'s closure
  rationale and to how `worktree.base-check`'s degrade condition is described. A follow-up
  that only re-verifies and documents this measurement (with the session cwd inside a
  feature worktree, which the original probe did not test) is not this proposal and is
  welcome.
- **Orchestrator-side repair is a different proposal.** #48's split explicitly assigns
  base correction to the orchestrator (e.g., recreate the worktree on `{EXPECTED_BASE}`,
  or fast-forward the branch from the orchestrator side before dispatch). A proposal that
  moves the repair step to the orchestrator, before or around dispatch, rather than having
  the executor self-repair after detecting a mismatch, is not denied here and would need
  its own review.
- **Fixing `#4415`** (cleanup-wave blocking when Claude Code has already removed the
  executor's worktree) is unrelated and not affected by this decision.

## Re-open criteria

- A proposal that keeps repair on the **orchestrator** side of the #48 split (the
  lifecycle owner), not the sub-agent side — matching, not reversing, the shipped
  architecture.
- Or: a demonstrated, host-enforced guarantee that the executor's `git reset --hard` call
  cannot be silently denied or misreported by a permission policy — removing the specific
  failure mode #48 was filed against. Absent that guarantee, granting the primitive back
  to the sub-agent reintroduces the original risk regardless of how cheap the operation is
  in the success case.

## Related

- [#48](https://github.com/open-gsd/gsd-core/issues/48) — the decision this proposal reverses
- `gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md` — the shipped fail-closed invariant
- [#3659](https://github.com/open-gsd/gsd-core/issues/3659), [#3779](https://github.com/open-gsd/gsd-core/issues/3779), [#683](https://github.com/open-gsd/gsd-core/issues/683) — the fork-base family #4463's measurement bears on
- [#4415](https://github.com/open-gsd/gsd-core/issues/4415) — adjacent cleanup-wave gap, unaffected by this decision
