# Execute-Phase — TDD Gate (Runtime Enforcement)

> Loaded by `execute-phase` workflow and `gsd-executor` agent when `TDD_MODE=true` for the phase (#4011 — the gate no longer requires MVP mode; MVP may imply TDD, but TDD never requires MVP). Defines the runtime gate that blocks behavior-adding tasks until a failing-test commit exists.

## When this gate fires

- `TDD_MODE` is `true` (resolved from `--tdd` flag → `workflow.tdd_mode` config). MVP mode is NOT required (#4011).
- The current task being executed has `tdd="true"` in its `<task>` frontmatter (set by the planner per Phase 1).
- The task's `<behavior>` block lists at least one expected behavior.

If any of these is false, the gate is inactive — execution proceeds normally.

## What the gate checks

For each task gated by TDD, the executor MUST verify (before running the implementation step):

1. **A failing-test commit exists.** Search git log on the current branch for a commit matching `test({phase}-{plan})` whose subject mentions the same plan as the current task. The commit must touch a test file (`*.test.*`, `*.spec.*`, `tests/**`).
2. **The test was actually red — INTENTIONALLY (#3770).** A nonzero exit is not RED by itself: syntax errors, zero-test discovery, fixture crashes, parser errors, and unrelated assertions are INVALID_RED. The executor must persist the RED evidence record (command, exit code, failing test, expected result from `<behavior>`, actual result) and verify it:
   ```bash
   gsd_run check tdd-red-evidence <record.json> --raw
   ```
   - `RED_EVIDENCE_OK` (reason `target_test_failed`): the TARGET test named by the plan failed on a real assertion — the ONLY verdict that authorizes GREEN.
   - `INVALID_RED` (reasons `unexpected_green`, `zero_tests_discovered`, `nonzero_exit_without_test_failure`, `fixture_or_load_failure`, `no_target_test_failure`, `invalid_record`, `unreadable_record`): the gate trips — halt, fix the RED phase (test identity, fixture, discovery), and re-verify before any implementation step. A `RED:` prefix or `(RED)` tag in the commit message is NOT sufficient evidence on its own.
3. **No implementation commit yet.** No `feat({phase}-{plan})` commit may exist for the same plan ID before the failing-test commit.

If any check fails, the gate trips. For check 2, an INVALID_RED verdict (`check tdd-red-evidence`) trips the gate — the executor MUST halt and block the implementation step.

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

   Reason: {missing_red_commit | red_commit_not_failing | feat_before_test | invalid_red}

   Behavior expected to be tested:
   - {first behavior bullet}

   Required next step:
   1. Write a failing test for the behavior above.
   2. Commit it as: test({phase}-{plan}): {short description}
   3. Re-run /gsd execute-phase
   ```

3. Exit the current execution wave cleanly. Do NOT roll back any prior commits in the same wave.
4. Update `STATE.md` with `last_gate_trip: {plan_id}/{task_id}` so the user can resume after writing the test.

## Escalation: end-of-phase TDD review under TDD

The existing end-of-phase TDD review (in `workflows/execute-phase.md`'s `tdd_review_checkpoint` step) is normally **advisory** — it surfaces gate violations but does not block phase completion.

Under TDD mode, escalate this to **blocking**:
- If any TDD plan is missing a RED or GREEN commit, the executor MUST refuse to mark the phase complete.
- The user is shown the same review table, but the verdict line reads:
  > "Phase blocked: {N} TDD plan(s) violate the RED→GREEN gate sequence under TDD. Resolve and re-run /gsd execute-phase, or override with `/gsd execute-phase {phase} --force-mvp-gate` to ship anyway."

The `--force-mvp-gate` flag is documented but not introduced by this plan — it is the escape hatch the spec mentions; if the user later builds it, the workflow already references the contract.

## What this gate does NOT do

- It does not enforce REFACTOR commits. REFACTOR remains optional (per `gsd-core/references/tdd.md`).
- It does not check test quality (the test could be trivially weak). That's the planner's job. It DOES check that the RED failure was intentional — the target test failing an assertion (#3770).
- It does not run tests. The executor only inspects git log + file system. Running tests is the implementation step's job.
- It does not gate config-only or doc-only tasks (see "behavior-adding task" definition).

## Compatibility with existing TDD discipline

This gate is additive to `gsd-core/references/tdd.md`. Tasks not under TDD mode continue to use the existing advisory TDD discipline (RED/GREEN/REFACTOR commits with end-of-phase review checkpoint). Only the runtime gate and the blocking escalation are new.
