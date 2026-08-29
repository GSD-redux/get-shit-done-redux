---
id: 3970
title: Per-Task External-Tracker Content-Resolution Seam
group: v1.7.0 Features
---

**Purpose:** Let a capability declare that an external issue tracker — beads, Linear, Jira,
GitHub Issues — owns a task's *content* (`<action>`/`<verify>`/`<acceptance_criteria>`/
`<read_first>`/`<done>`), not just its status, so `execute-plan.md` can resolve that content
from the tracker at execution time instead of reading it inline out of `PLAN.md`.

**What changed (ADR-3646, #3970):**

- A new optional feature-body manifest field, `taskContentResolver`, declares a `trackerPrefix`
  (matched against a task's `<task tracker-id="beads:GSD-42">` attribute — everything before the
  first `:`) and a bounded `invoke` (`binary`, `args` carrying the `{{id}}` placeholder,
  `timeoutMs`).
- `execute-plan.md`'s per-task loop gains one new, unconditional call before that task's
  `read_first` gate: `gsd_run task resolve-content --plan <path> --task-id <tracker-id> --raw`.
  A task with no `tracker-id` attribute is unaffected — the call is only made when the attribute
  is present, and resolves instantly to a no-op for every project that declares none.
- **The safety property is a real process exit code, not a prose dispatch.** No capability
  registered for the tracker, or resolution succeeds with empty content, exits `0` with
  `resolved: false` and falls back to inline `PLAN.md` — the one legitimate pre-migration
  boundary case. Resolution succeeding with non-empty content exits `0` with `resolved: true` and
  its `content` supersedes the task's inline fields for every downstream gate in the execute step.
  A resolver that is declared but fails — tracker unreachable, id not found, timeout, malformed
  JSON — makes `task resolve-content` itself **exit non-zero**, which `execute-plan.md` treats as
  a **hard halt**: stop, surface the tracker-id/prefix/stderr, never fall back to stale
  `PLAN.md` content.
- `execute:task` is a new dispatch shape below wave granularity, deliberately **not** one of the
  12 existing loop extension points (`discuss:pre` … `ship:post`) and not routed through
  `gsd_run loop render-hooks <point>` / `activeHooks`. It exists because the existing
  `step`/`gate` prose-dispatch mechanism cannot deliver a hard-halt guarantee while dispatch
  reliability at that layer is an open concern (#3647) — see ADR-3646's Context and Rejected
  Alternatives for the full reasoning.

See [Develop a task-content resolver capability](../how-to/develop-a-task-content-resolver-capability.md)
for the authoring walkthrough, [Capability manifest → `taskContentResolver`](../reference/capability-manifest.md#taskcontentresolver)
for the field reference, and
[`loop-hook-dispatch.md`](../../gsd-core/references/loop-hook-dispatch.md#the-executetask-point-a-different-shape)
for how `execute:task` differs from the twelve prose-dispatched points.
