# How to enable concurrent per-plan planners in chunked mode

Speed up a multi-plan phase's chunked planning run by letting independent per-plan Tasks run at
the same time instead of one after another.

---

## Before you start

This only matters if you already use chunked mode (`workflow.plan_chunked: true`, or
`/gsd-plan-phase {N} --chunked`). Chunked mode splits planning into a short outline Task followed
by one short Task per plan, committing each plan individually so an interrupted run resumes from
the last committed plan. By default those per-plan Tasks still run one at a time.

## Enable it

```bash
gsd config-set planning.chunked_parallel true
```

```json
{
  "planning": {
    "chunked_parallel": true
  }
}
```

Then run chunked planning as usual:

```bash
/gsd-plan-phase {N} --chunked
```

That's it — no other setting to touch, and no other capability's config is involved.

## What actually changes

Nothing changes for a phase whose outline has only one plan per Wave — there is nothing to run
concurrently. For a phase with several plans in the same Wave, those plans' Tasks are now issued
together instead of one at a time; a later Wave still waits for the current one to finish and
commit before starting, so cross-Wave ordering is unaffected.

## Whether it actually does anything on your runtime

This setting is gated on the runtime's own negotiated concurrency ceiling
(`gsd-tools query dispatch-capacity`), not on the config value alone:

- **Claude Code** declares a capacity above 1, so turning this on has a real effect there.
- **Every other runtime today** (Codex, Cursor, OpenCode, ...) declares no concurrency ceiling and
  falls back to the safe floor of `1` — turning this setting on has no effect there; chunked
  planning stays exactly as serial as it was before. This is not a bug to work around: it means
  the setting never fires concurrent dispatch on a host that cannot usefully run it.

There is no per-runtime flag to set yourself — the gate is automatic and always correct for the
runtime you're on.

## Trade-offs to know before turning this on

- **Per-plan commits interleave.** With serial dispatch, plans commit strictly in outline order.
  With concurrent dispatch, whichever plans in a batch finish first commit first — still one
  commit per plan, never a combined commit, but not necessarily in outline order within a batch.
- **Crash-resume granularity is coarser.** If a run is interrupted mid-batch, every plan that
  already finished and committed stays committed — but "already finished" is no longer
  necessarily "everything up to the last plan in outline order," the way serial mode guarantees.
  Resuming the run picks up exactly where it left off either way; only the *shape* of what's
  already on disk when you resume can differ.

If either of those matters more to you than the speed-up, leave this setting at its default
(`false`) — chunked mode's crash resilience story is otherwise unchanged.

## Turn it off again

```bash
gsd config-set planning.chunked_parallel false
```

Or just remove the key from `.planning/config.json` — `false` is the default.

See also: [Configuration reference — Concurrent per-plan planners in chunked mode](../CONFIGURATION.md#concurrent-per-plan-planners-in-chunked-mode-3777).
