# How to execute a phase

**Goal:** Run a planned phase through wave-based parallel execution and land every plan as an atomic git commit.

**Prerequisites:** The phase has at least one `PLAN.md` file. If planning is not yet done, run `/gsd-plan-phase N` first — see [Plan a phase](plan-a-phase.md).

---

## Run the full phase

```bash
/gsd-execute-phase 1
```

GSD reads the phase's plan files, groups them into dependency waves, and spawns a fresh executor agent per plan. Each executor commits its work atomically before the next wave begins.

Before any agents are dispatched, GSD prints a wave table:

```
## Execution Plan

Phase 1: Core middleware — 3 plans across 2 wave(s)

| Wave | Plans          | What it builds            |
|------|----------------|---------------------------|
| 1    | 01-01, 01-02   | Core validation function  |
| 2    | 01-03          | Express middleware wrapper |
```

Wave 1 plans run in parallel (each in an isolated git worktree). Wave 2 waits until all Wave 1 commits are merged.

For the underlying agent coordination model, see [Multi-agent orchestration](../explanation/multi-agent-orchestration.md).

---

## Run a single wave

If you want to execute only one wave — for example, to inspect Wave 1 output before committing to Wave 2 — use `--wave N`:

```bash
/gsd-execute-phase 1 --wave 2
```

GSD executes only Wave 2 plans. It first checks that all earlier waves are complete; if any Wave 1 plan is still marked incomplete, it stops and tells you to finish earlier waves first.

---

## Resume a stalled execution

If execution stops partway through — a quota error, a network drop, or a crashed session — the wave-level progress is preserved. GSD checks for a `SUMMARY.md` file for each plan; plans that have one are skipped automatically when you re-run:

```bash
/gsd-execute-phase 1
```

GSD will skip plans where `SUMMARY.md` already exists and pick up from the first incomplete plan.

**If commits exist but `SUMMARY.md` is missing** (the executor committed but did not write its summary before the session died), GSD surfaces a safe-resume gate and offers three options:

- `close out manually` — inspect the commits, write `SUMMARY.md`, then re-run.
- `re-execute from scratch` — revert or supersede the partial commits before dispatching a new executor.
- `mark-and-skip` — record the anomaly and move on, only with explicit confirmation.

For systematic failure diagnosis, see [Debug a failed execution](debug-a-failed-execution.md).

---

## Where output lands

After all waves complete, the phase directory contains:

```
.planning/phases/01-<name>/
  01-01-SUMMARY.md    # What plan 01 built, key files, deviations
  01-02-SUMMARY.md
  01-03-SUMMARY.md
  VERIFICATION.md     # Requirement-by-requirement pass/fail status
```

`STATE.md` and `ROADMAP.md` are updated automatically once all waves are done. `VERIFICATION.md` is written only when the phase is fully complete.

Git history will show one commit per task (from each executor), followed by tracking commits from the orchestrator.

---

## Cross-AI execution

To delegate execution to an external AI CLI (Codex, Gemini, etc.) configured in `workflow.cross_ai_command`:

```bash
/gsd-execute-phase 2 --cross-ai
```

To force local execution even when cross-AI is enabled in config:

```bash
/gsd-execute-phase 2 --no-cross-ai
```

---

## Related

- [Plan a phase](plan-a-phase.md)
- [Verify and ship](verify-and-ship.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [Commands](../COMMANDS.md)
