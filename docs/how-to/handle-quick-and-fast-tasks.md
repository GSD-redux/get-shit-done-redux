# How to handle quick and fast tasks

Not every piece of work fits inside a phase. GSD provides two lightweight commands for work that does not need the full discuss → plan → execute → verify loop.

For context on when the full phase pipeline is worth its overhead, see [Context engineering](../explanation/context-engineering.md).

---

## Deciding which command to use

| Situation | Command |
|-----------|---------|
| Fixing a bug, adding a small feature, or any task you cannot summarise as a single trivial edit | `/gsd-quick` |
| Fixing a typo, updating a config value, adding a `.gitignore` entry, or any change that touches ≤ 3 files and takes under a minute | `/gsd-fast` |
| The task has unknowns, needs research, or will touch more than a handful of files | `/gsd-quick` with `--research` |

**The rule of thumb:** if you hesitate for even a moment about whether the task is trivial, use `/gsd-quick`. `/gsd-fast` redirects you to `/gsd-quick` automatically if the scope looks non-trivial.

---

## `/gsd-quick` — ad-hoc tasks with GSD guarantees

`/gsd-quick` runs a planner and executor with the same atomic-commit and STATE.md tracking guarantees as a full phase, but without the phase overhead (no ROADMAP entry, no discuss-phase, no wave coordination across multiple plans).

### Basic use

```bash
/gsd-quick
```

GSD prompts you for a task description, then plans and executes it. Artifacts land in `.planning/quick/`.

You can also pass the description directly:

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

### Flags

Add flags to bring in more of the quality pipeline when the task warrants it.

| Flag | What it adds |
|------|-------------|
| `--discuss` | A lightweight pre-planning discussion that surfaces grey areas and captures your decisions in a `CONTEXT.md` before the planner runs |
| `--research` | A focused research agent investigates approaches, libraries, and pitfalls before planning |
| `--validate` | Plan-checking (up to 2 iterations) plus post-execution verification |
| `--full` | All of the above — equivalent to `--discuss --research --validate` |

Flags compose freely:

```bash
/gsd-quick --research --validate   # research + plan-checking + verification, no discuss
/gsd-quick --discuss               # just surface grey areas before planning
/gsd-quick --full                  # the complete quality pipeline
```

### When to add flags

- Add `--research` when you are unsure how to approach a task or which library to use.
- Add `--validate` when the task touches critical code paths and you want a verifier agent to confirm the must-haves were met.
- Add `--discuss` when the task has design choices you want to lock in before the planner runs — for example, when the right error-handling behaviour is not obvious.
- Use `--full` when a task is genuinely significant and you would normally plan it as a phase but it does not belong in the ROADMAP.

### Listing and resuming quick tasks

```bash
/gsd-quick list                    # show all quick tasks with status
/gsd-quick status my-task-slug     # show status of a specific task
/gsd-quick resume my-task-slug     # resume an interrupted task
```

---

## `/gsd-fast` — inline trivial edits

`/gsd-fast` does the work directly in the current context. There are no subagents, no `PLAN.md`, and no research. It is suitable only for changes you could make yourself in under a minute.

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to .gitignore"
```

If you omit the description, GSD prompts you for it.

`/gsd-fast` checks whether the task is actually trivial before proceeding. If it judges the scope too large it stops and redirects you:

```text
This looks like it needs planning. Use /gsd-quick instead:
  /gsd-quick "your task description"
```

After making the change, `/gsd-fast` commits atomically and, if a `Quick Tasks Completed` table exists in `.planning/STATE.md`, appends a row to it.

---

## What `/gsd-quick` does that `/gsd-fast` does not

| Capability | `/gsd-fast` | `/gsd-quick` |
|------------|------------|--------------|
| Subagent planner | No | Yes |
| Subagent executor | No | Yes |
| Research agent | No | Optional (`--research`) |
| Plan-checking | No | Optional (`--validate`) |
| Post-execution verification | No | Optional (`--validate`) |
| Discussion phase | No | Optional (`--discuss`) |
| Worktree isolation | No | Yes (default) |
| Atomic commits per task | Single commit | One per plan task |
| STATE.md tracking | Row appended if table exists | Always updated |
| `.planning/quick/` artifacts | No | Yes |

The key distinction is subagent isolation. `/gsd-quick` spawns a fresh planner and executor in separate context windows, which means the work is planned properly, commits are atomic per task, and the orchestrator can verify results. `/gsd-fast` uses only the current context window and is intentionally limited to changes trivial enough not to need any of that.

---

## Archiving quick tasks

`.planning/quick/` accumulates one directory per `/gsd-quick` task forever unless you archive it. Archival is **opt-in** (#2142) — it deliberately does not mirror phase-directory archival, which is default-ON. Do nothing and `.planning/quick/` stays exactly as it is.

There are two paths in, depending on when you archive:

### Forward path — archive at milestone close-out

When you run `/gsd-complete-milestone` and `.planning/quick/` has at least one directory, you are asked:

```text
Archive completed quick tasks into this milestone too?
  Yes — archive quick tasks into v[X.Y]
  Skip
```

Choosing "Yes" folds `--archive-quick` into the same `gsd-tools milestone complete` call that archives `ROADMAP.md`/`REQUIREMENTS.md` and phase directories — one command, one `STATE.md` write. "Skip" (or an empty `.planning/quick/`) leaves everything untouched.

### Retroactive path — archive an already-completed milestone

`/gsd-complete-milestone` only runs once per milestone, so if quick tasks piled up after you already closed one out, use `/gsd-cleanup` instead. When it finds `.planning/quick/` non-empty, it offers to sweep it into the most recent completed milestone that doesn't yet have a `-quick` archive:

```text
Archive ALL {N} quick-task directories into v{X.Y} — {Milestone Name}?
This buckets every remaining quick task into this ONE milestone;
there is no way to split them per-milestone.
  Yes — archive quick tasks into v{X.Y}
  Skip
```

Under the hood this calls the narrower `gsd-tools milestone archive-quick <version>` command — the same move/index/reset logic as `--archive-quick`, but without touching `ROADMAP.md`, `REQUIREMENTS.md`, `MILESTONES.md`, or milestone-completion guards, so it is safe to run against a milestone that's already closed.

### What both paths do

1. Move every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`.
2. (Re)write that archive directory's `README.md` — a plain list, one entry per archived task directory, linking to its `<dir>-SUMMARY.md` (or legacy bare `SUMMARY.md`) when one exists, listed unlinked when it doesn't. The index is built by scanning the archive directory itself, never from `STATE.md`'s table — the table is known to drift from disk, so the filesystem is the only source of truth here.
3. Clear the data rows of `STATE.md`'s `### Quick Tasks Completed` table, preserving its header row and whichever column variant (with or without a Status column) was detected.

**Bucket-all, not per-milestone.** Quick tasks carry no on-disk record of which milestone they belong to, so every remaining `.planning/quick/*` directory lands in the ONE milestone you're archiving into — including tasks that predate an earlier, unarchived milestone. There's no way to split them after the fact; this is a known limit, not a bug.

### Telling "nothing to archive" from "refused to touch it"

Four cases look similar from the outside but mean different things:

| What you see | Meaning |
|---|---|
| No archive prompt at all | `.planning/quick/` is absent or empty — nothing to archive, nothing reported |
| Archive prompt appears, directories move, but `STATE.md` doesn't change | Your `STATE.md` has no `### Quick Tasks Completed` section yet — normal, since `/gsd-quick` creates that section lazily on first completion, not the project template. This is a silent no-op, not a failure |
| Directories move, but you see a `warnings` entry naming `quick_tasks_table` | Your `### Quick Tasks Completed` table has a column set that matches neither registered variant. The reset is **refused** — every row is preserved untouched rather than risk destroying data under a schema GSD doesn't recognize |
| Fewer directories moved than existed in `.planning/quick/` | A rename failed partway through. The result's `archived` count reflects exactly what succeeded — never a false full count — and the directories that didn't move are still in `.planning/quick/` for a retry |

---

## Related

- [Batch quick tasks](batch-quick-tasks.md) — run several `/gsd-quick`-shaped tasks together with `/gsd-quick-batch`
- [The phase loop](../explanation/the-phase-loop.md)
- [Context engineering](../explanation/context-engineering.md)
- [Commands](../COMMANDS.md)
- [Docs index](../README.md)
