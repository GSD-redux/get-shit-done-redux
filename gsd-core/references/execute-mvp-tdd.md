# Execute-Phase — TDD Gate (Runtime Enforcement)

> Loaded by `execute-phase` workflow and `gsd-executor` agent when `TDD_MODE=true` for the phase (#4011 — the gate no longer requires MVP mode; MVP may imply TDD, but TDD never requires MVP). Defines the runtime gate that blocks behavior-adding tasks until a failing-test commit exists.

## When this gate fires

- `TDD_MODE` is `true` (resolved from `--tdd` flag → `workflow.tdd_mode` config). MVP mode is NOT required (#4011).
- The current task being executed has `tdd="true"` in its `<task>` frontmatter (set by the planner per Phase 1).
- The task's `<behavior>` block lists at least one expected behavior.

If any of these is false, the gate is inactive — execution proceeds normally.

## What the gate checks

For each task gated by TDD, the executor MUST verify (before running the implementation step):

1. **A failing-test commit exists.** Search git log on the current branch for a commit matching `test({phase}-{plan})` whose subject mentions the same plan as the current task.
2. **The failing-test commit carries its evidence, and that evidence authorizes.** The commit carries a `red-evidence:` trailer; the executor reads that trailer and reports it. A matching commit whose trailer value comes back empty is `missing_red_evidence` — the commit exists but was made without evidence. Judging the recorded run against the RED predicate in `~/.claude/gsd-core/references/tdd.md` **is** mechanised: the gate passes the trailer, plus the commit's changed files (`git show --name-only`), to `gsd_run query task.red-evidence-verdict` and proceeds only when the verdict is `authorize`. That call also decides membership — whether the commit actually touches the file its evidence declares — via `changedFilesInclude` (`src/task-command-router.cts`), not a filename-extension or directory-glob heuristic. Any other verdict — `red_commit_not_failing`, `unexpected_pass` — trips the gate under that verdict's own name. Existence of a subject-matching commit authorizes nothing on its own.
3. **No implementation commit yet.** No `feat({phase}-{plan})` commit may exist for the same plan ID before the failing-test commit.

If any check fails, the gate trips.

## What "behavior-adding task" means

A task is behavior-adding when:
- Its frontmatter has `tdd="true"` AND
- Its `<behavior>` block names at least one user-visible outcome (not a config-only or doc-only task) AND
- Its `<files>` list includes at least one source file (not exclusively docs/tests/config files such as `*.md`, `*.json`, `*.test.*`, `*.spec.*`, `*.yml`, `*.yaml`, `*.toml`, `*.ini`, `.env*`)

Pure documentation, configuration, or test-only tasks are skipped by this gate even when both modes are active.

## What happens when the gate trips

The executor MUST:

1. Halt before running the task's implementation step.
2. Emit a structured halt report:

   ```
### TDD GATE TRIPPED — Plan {plan_id}, Task {task_id}

   Reason: {missing_red_commit | missing_red_evidence | red_commit_not_failing | unexpected_pass | feat_before_test}

   Behavior expected to be tested:
   - {first behavior bullet}

   Required next step:
   1. Write a failing test for the behavior above.
   2. Commit it as: test({phase}-{plan}): {short description}
   3. Re-run /gsd execute-phase
   ```

   The required next step above applies as written only to `missing_red_commit` and
   `red_commit_not_failing`. The other three reasons each need a different remedy:

   - **`missing_red_evidence`**: the RED commit already exists, made without evidence, so the
     remedy is amending that commit's trailer, not writing another failing test:
     1. Re-run the RED test and record its `red-evidence:` trailer.
     2. Amend the existing `test({phase}-{plan})` commit with that trailer.
     3. Re-run `/gsd execute-phase`
   - **`feat_before_test`**: a `feat({phase}-{plan})` commit already precedes any RED test commit
     for this plan, so writing a new failing test afterward leaves that ordering violation intact
     and the gate stays tripped. The remedy is reordering or rewriting commit history so the RED
     test commit precedes the `feat({phase}-{plan})` commit, then re-running `/gsd execute-phase`.
   - **`unexpected_pass`**: the run the executor performed exited 0, so the declared behavior
     already holds. Writing another failing test or retrying loops forever against a test that
     already passes. Halt and reconcile the declaration with reality instead.

3. Exit the current execution wave cleanly. Do NOT roll back any prior commits in the same wave.
4. Update `STATE.md` with `last_gate_trip: {plan_id}/{task_id}` so the user can resume after resolving the reported gate reason.

## Escalation: end-of-phase TDD review under TDD

The existing end-of-phase TDD review (in `workflows/execute-phase.md`'s `tdd_review_checkpoint` step) is normally **advisory** — it surfaces gate violations but does not block phase completion.

Under TDD mode, escalate this to **blocking**:
- If any TDD plan is missing a RED or GREEN commit, the executor MUST refuse to mark the phase complete.
- The user is shown the same review table, but the verdict line reads:
  > "Phase blocked: {N} TDD plan(s) violate the RED→GREEN gate sequence under TDD. Resolve and re-run /gsd execute-phase, or override with `/gsd execute-phase {phase} --force-mvp-gate` to ship anyway."

The `--force-mvp-gate` flag is documented but not introduced by this plan — it is the escape hatch the spec mentions; if the user later builds it, the workflow already references the contract.

## What this gate does NOT do

- It does not enforce REFACTOR commits. REFACTOR remains optional (per `gsd-core/references/tdd.md`).
- It does not check test quality (the test could be trivially passing). That's the planner's job.
- It does not run tests. The executor only inspects git log + file system. Running tests is the implementation step's job.
- It does not gate config-only or doc-only tasks (see "behavior-adding task" definition).

## Compatibility with existing TDD discipline

This gate is additive to `gsd-core/references/tdd.md`. Tasks not under TDD mode continue to use the existing advisory TDD discipline (RED/GREEN/REFACTOR commits with end-of-phase review checkpoint). Only the runtime gate and the blocking escalation are new.
