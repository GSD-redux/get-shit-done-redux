# How to batch quick tasks

`/gsd-quick-batch` runs several `/gsd-quick`-shaped tasks together as ONE
coordinated run: one coordinator parses the task list, plans and dispatches
each item (planner, and optionally researcher/plan-checker/verifier leaves),
merges them in a deterministic order, and owns every shared write
(`BATCH.json`, `STATE.md`, worktree create/merge/cleanup) so the leaves never
race each other (ADR-1239 "Quick-batch binding").

Use it instead of running `/gsd-quick` N separate times when you have several
independent (or lightly interdependent) small tasks you want planned and
executed together, with parallelism where the tasks allow it.

For the single-task case, see [Handle quick and fast tasks](handle-quick-and-fast-tasks.md).

---

## Basic use

Pass an inline task list — a bulleted or numbered list, at least 2 items,
one per line:

```bash
/gsd-quick-batch
- Fix the login timeout on mobile Safari
- Add a retry banner when the API call fails
- Update the README's setup instructions
```

Or point at a file containing the list:

```bash
/gsd-quick-batch --file .planning/my-tasks.md
```

Each item gets its own quick id, its own directory under
`.planning/quick/`, and (when isolation is available) its own worktree — the
same artifact shape a standalone `/gsd-quick` task produces, just planned and
dispatched together.

---

## Flags

| Flag | What it does |
|------|-------------|
| `--jobs auto\|N` | `auto` (default) uses the negotiated dispatch capacity as-is. `N` caps effective concurrency at `min(task count, N, capacity)` — never more than the number of tasks, never more than what the runtime negotiated. A non-numeric or non-positive `N` is rejected before any dispatch. |
| `--validate` | Enables the per-item plan-checker loop (max 2 iterations, same cap as `/gsd-quick --validate`) and post-merge verification. |
| `--research` | Dispatches a focused researcher per item before planning. |
| `--resume <batch-id>` | Skips task-list parsing and batch creation entirely — loads the existing batch and dispatches only its still-eligible items. |

**Not supported in v1:** `--discuss` and `--full` are rejected with a usage
error before any dispatch. If a task genuinely needs a discussion phase, run
it through `/gsd-quick --discuss` on its own instead of including it in a
batch.

```bash
/gsd-quick-batch --jobs 2 --validate --research   # research, up to 2 concurrent, plan-checked + verified
/gsd-quick-batch --resume 260101-abc               # resume an interrupted batch
```

---

## How capacity and isolation interact

Effective concurrency is computed from three things: `--jobs`, the
negotiated dispatch capacity (how many subagents your runtime can run at
once), and — for the mutating stage (worktree create → execute → merge) —
the isolation mode:

| Isolation | Effect on the mutating (executor/worktree) stage |
|---|---|
| `harness-worktree` / `orchestrator-worktree` | Runs up to the effective concurrency computed above. |
| `none` (no worktree isolation available, or `workflow.use_worktrees=false`) | Forced to concurrency **1**, regardless of `--jobs` or capacity — everything executes sequentially on the primary checkout. |

This cap applies **only** to the mutating stage. Planning and research are
never worktree-isolated, so they run at full effective concurrency even when
isolation is `none`.

Worktree creation, merging, and cleanup are always serialized one at a time
(`git worktree add`/`git merge`/`git worktree remove` never overlap) —
concurrency is about how many already-created worktrees' agents run at once,
not about the git operations themselves. Merges apply in the same
deterministic order the batch's dependency/file-overlap waves were computed
in, never in whichever order an executor happens to finish first.

---

## Dependencies and file overlap

Before planning, `/gsd-quick-batch` has no signal about which items depend
on each other or touch the same files — every item starts in the same wave.
Each item's planner is shown the full batch's task catalog (every item's id
and description) and is required to declare, in its plan's frontmatter,
which sibling items (if any) it depends on and which files it will touch.
After each planning round, the coordinator recomputes execution waves from
those declarations — independent items with disjoint files run in parallel;
a dependent item's wave always comes strictly after its dependency's.

---

## Resuming and failure recovery

A batch's `BATCH.json` (`.planning/quick-batches/<batch-id>/`) tracks every
item's status. Re-run with `--resume <batch-id>` at any point — including
after a crash — and the coordinator re-derives which items are still
runnable:

| Outcome | What happens | Recoverable via `--resume`? |
|---|---|---|
| Item completes normally | Marked `complete`; a `Quick Tasks Completed` STATE.md row is appended. | N/A |
| Verifier reports `human_needed` (`--validate` only) | Terminal for that item — no STATE row is appended. Review it yourself, then fix and re-run if needed. | Yes, once resolved |
| Verifier reports `gaps_found` (`--validate` only) | The item is marked `failed`. Its already-merged commit is **not** rolled back, and there is no automatic gap-fix retry. | Yes — resume re-evaluates it |
| A merge conflicts, or a committed diff includes an undeclared file deletion | The item is marked `failed` with a reason; its worktree is **preserved** (never deleted) so you can inspect what happened. | Yes, after you resolve the worktree by hand |
| An item this item depends on failed | The dependent item is automatically marked `blocked` on the next `--resume`. | Yes, once the blocking item is resolved |

Items unrelated to a failure continue normally in the same or a later batch
run — one item's problem never blocks the rest of the batch.

---

## Related

- [Handle quick and fast tasks](handle-quick-and-fast-tasks.md)
- [Commands](../COMMANDS.md)
- [Docs index](../README.md)
