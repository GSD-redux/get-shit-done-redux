# How to interpret scope-conformance warnings

**Goal:** Understand the advisory `warnings` that the `worktree.cleanup-wave` gauntlet emits when a plan branch commits changes outside the scope it declared, and decide what — if anything — to do about one.

**Prerequisites:** GSD Core is installed and you have run `/gsd-execute-phase` with worktree isolation enabled (`workflow.use_worktrees: true`, the default), so that plan branches were merged back by a `cleanup-wave`.

---

## What you will see

When `/gsd-execute-phase` runs plans in isolated worktrees, each plan branch is merged back into the phase branch by the `worktree.cleanup-wave` gauntlet. If the wave manifest recorded the plan's declared scope (`files_modified`, passed as `--files` to `worktree record-agent` / `worktree create`), the gauntlet compares the branch's actual committed diff (`HEAD...<branch>`) against that declared scope and reports any committed path that falls outside it.

A realistic `cleanup-wave` result with one such warning:

```json
{
  "ok": true,
  "reason": "wave-cleanup-complete",
  "warnings": [
    {
      "code": "scope_out_of_declared",
      "branch": "plan-04-add-rate-limiter",
      "path": "src/util/rate-limiter-cache.cts"
    }
  ],
  "entries": [
    {
      "branch": "plan-04-add-rate-limiter",
      "status": "merged_removed",
      "warnings": [
        {
          "code": "scope_out_of_declared",
          "path": "src/util/rate-limiter-cache.cts"
        }
      ]
    }
  ]
}
```

`ok: true` and `status: "merged_removed"` are unchanged by the warning — the merge happened. The same warning object appears twice: once nested under the offending entry, and once aggregated into the top-level `warnings` array so you can scan for conformance issues across the whole wave without walking every entry.

---

## Why this happens

`/gsd-execute-phase` gives each plan a declared scope up front (`files_modified` in the phase plan index), so that parallel plan branches can be reasoned about and merged with some confidence about what each one touched. The scope-conformance check is a post-hoc, best-effort verification of that promise: after a branch merges, the gauntlet diffs what was actually committed against what was declared, and flags any mismatch as a warning. This is issue #2596.

---

## The two warning codes

- **`scope_out_of_declared`** — emitted once per committed path that falls outside the plan's declared scope. A branch with three unexpected paths produces three of these warnings.
- **`scope_check_unavailable`** — emitted once per entry when the scope diff itself could not be computed (a `git` failure or a timeout), rather than once per path. This means conformance is **unknown** for that entry, not clean — the check deliberately distinguishes "could not verify" from "verified and clean" so an unknown result is never silently read as a pass.

---

## It does not block

Scope conformance is advisory by design. A `scope_out_of_declared` or `scope_check_unavailable` warning never changes `ok`, `reason`, the per-entry `status`, or the process exit code — the merge proceeds exactly as it would with zero warnings. There is no failure to fix here. Promoting scope conformance to a hard gate (one that blocks the merge) would be a separate, explicitly disclosed change — it is not what this check does today.

---

## What to do about one

1. Compare the reported `path` against the plan's declared `files_modified` in the phase plan index.
2. Decide which side is wrong: either the executor committed something outside its brief (over-reach), or the plan's `files_modified` under-declared what the work actually needed to touch.
3. If the plan under-declared its scope, widen `files_modified` in the plan so future waves report accurately.
4. If the executor over-reached, review that path's changes specifically — it is already merged into the phase branch, so treat the review as catching it before it travels further (into a PR, a release, or a later phase).

---

## When nothing is reported

Absence of `scope_out_of_declared` / `scope_check_unavailable` warnings is not proof that a branch stayed in scope. The check legitimately stays silent in three cases:

- **No `--files` was recorded for the plan.** Scope is unknown, so no comparison runs at all — not even a `git` call is made for that entry.
- **Every out-of-scope path is a `.planning/**/*SUMMARY.md` artifact.** These are always exempt: the executor writes them by orchestration contract, and no plan declares them as part of its scope, so flagging them would be noise rather than signal.
- **A declared pattern had no literal prefix** (for example, `*.md`). Matching is prefix-based (see below), so a pattern with no literal prefix cannot usefully bound anything — the check suppresses warnings for that entry by design, so an advisory check never cries wolf on a pattern it cannot meaningfully evaluate.

---

## Known limits

- **Glob matching is literal-prefix only.** `src/**/*.ts` matches anything under `src/`, including `src/a/b.json` — the check does not parse glob syntax past the literal prefix.
- **Renames are not detected specially.** A rename appears in the diff as an add plus a delete. In practice this rarely reaches the scope-conformance check at all: the pre-existing deletions guard blocks any entry whose diff contains a deletion before the scope-conformance check runs.
- **`/gsd-quick` worktrees have no plan-declared scope.** They are never checked, for the same reason as the "no `--files` recorded" case above.

---

## Related

- [CLI Tools reference — worktree commands](../CLI-TOOLS.md#worktree-commands) — the `worktree record-agent` / `worktree create` `--files` reference
- [Execute a phase](execute-a-phase.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [docs index](../README.md)
