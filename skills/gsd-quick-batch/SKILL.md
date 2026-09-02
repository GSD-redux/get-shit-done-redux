---
name: gsd-quick-batch
description: "Execute several /gsd:quick-shaped tasks together — planned, dispatched, and merged as one coordinated batch"
argument-hint: "[--file <path>] [--jobs auto|N] [--validate] [--research] [--resume <batch-id>] [task list]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
---

<objective>
Batch several `/gsd-quick`-shaped tasks together: one coordinator parses the
task list, dispatches per-item planner/researcher/checker/executor/verifier
leaves, and owns every shared write (`BATCH.json`, STATE.md, worktree
create/merge/cleanup) so leaves never race each other (ADR-1239 "Quick-batch
binding").

**Task list:** either an inline bulleted/numbered list (≥2 items — the same
grammar `/gsd-quick`'s planner-facing description uses, one item per line) or
`--file <path>` pointing at a file containing one.

**`--jobs auto|N` flag:** `auto` (default) uses the negotiated dispatch
capacity as-is. `N` caps effective concurrency at `min(task count, N,
capacity)`. A non-numeric or non-positive `N` is rejected before any
dispatch.

**`--validate` flag:** enables the per-item plan-checker loop (max 2
iterations) and post-merge verification.

**`--research` flag:** dispatches a focused researcher per item before
planning.

**`--resume <batch-id>` flag:** skips task-list parsing and batch creation
entirely — loads the existing batch and dispatches only its still-eligible
items.

**Not supported in v1:** `--discuss` and `--full` are rejected with a usage
error before any dispatch. Use `/gsd-quick --discuss`/`--full` per item
instead, or file the tasks individually.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/quick-batch.md
</execution_context>

<context>
$ARGUMENTS

Context files are resolved inside the workflow (`init quick-batch`,
`quick-batch create`/`quick-batch resume`) and delegated via
`<required_reading>` blocks.
</context>

<process>

**Parse $ARGUMENTS FIRST, before any dispatch.** Route argument validation
through the CLI's own `quick-batch parse-args` verb — it wraps
`parseQuickBatchArgs` (`src/quick-batch-dispatch.cts`), the single source of
truth for this grammar, so the command layer and the workflow layer can never
silently diverge on what counts as a valid invocation:

```bash
QUICK_BATCH_PARSE=$(gsd_run quick-batch parse-args --raw -- $ARGUMENTS)
QUICK_BATCH_PARSE_RC=$?
```

(`gsd_run` is defined by the workflow's own preamble — this parse happens
INSIDE the workflow's Step 1, not before it; the shim is not yet in scope at
this point in the command file. See `gsd-core/workflows/quick-batch.md` Step
1 for the literal invocation.)

**If the parse fails** (`$QUICK_BATCH_PARSE_RC != 0`, e.g. `--discuss`/
`--full` present, or a malformed `--jobs` value): print the CLI's error
message verbatim and STOP. Do not create `BATCH.json`, do not dispatch
anything.

**If `--resume <batch-id>` is present:** proceed straight to the workflow's
resume path — it loads the batch via `quick-batch resume` and dispatches only
eligible items. Task-list parsing is skipped entirely.

**Otherwise:** proceed to the workflow's normal path — parse the task list
(inline or `--file`), create the batch (`quick-batch create`), resolve
capacity/isolation, and dispatch wave-by-wave.

</process>

<success_criteria>
- [ ] `--discuss`/`--full` rejected with a usage error before any dispatch
- [ ] A malformed `--jobs` value rejected before any dispatch
- [ ] `--resume <batch-id>` skips task-list parsing and dispatches only eligible items
- [ ] Otherwise: task list parsed (inline or `--file`), batch created, items dispatched per the workflow's process
</success_criteria>
