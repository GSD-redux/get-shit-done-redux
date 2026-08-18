# Planner — Human Verification Mode

> Loaded by `gsd-planner` when deciding whether to emit `<task type="checkpoint:human-verify">` tasks. Read `workflow.human_verify_mode` from `.planning/config.json` (default `end-of-phase` since #3309).

## The two modes

### `end-of-phase` (default — issue #3309)

Do **not** emit any `<task type="checkpoint:human-verify">` tasks. Every mid-flight halt costs a full executor cold-start (CLAUDE.md, MEMORY.md, STATE.md, plan re-read on respawn) because subagent context is discarded across the pause; a plan with N human-verify checkpoints pays the cold-start cost N+1 times — measured at "tens of thousands of tokens" per round-trip on real projects. This is the default for that reason.

Instead, fold each would-be verification step into the relevant `auto` task using a `<verify><human-check>` sub-block:

```xml
<task type="auto">
  <name>Wire dashboard route</name>
  <files>app/dashboard/page.tsx, app/api/dashboard/route.ts</files>
  <action>...</action>
  <verify>
    <automated>npm test -- --filter=dashboard</automated>
    <human-check>
      <test>Visit http://localhost:3000/dashboard</test>
      <expected>Sidebar left, content right on desktop &gt;1024px; collapses to hamburger at 768px</expected>
      <why_human>Visual layout — grep cannot verify breakpoint behavior</why_human>
    </human-check>
  </verify>
  <done>Layout renders correctly across breakpoints</done>
</task>
```

The verifier (Step 8) harvests every `<verify><human-check>` block at end-of-phase and consolidates them into the existing `human_needed` → `{phase_num}-UAT.md` path in `workflows/execute-phase.md`. The user reviews everything in one batch instead of paying a cold-start cost per item.

### `mid-flight` (opt-back-in — pre-#3309 behavior)

Set `gsd config-set workflow.human_verify_mode mid-flight` to restore the canonical mid-flight pattern: emit `<task type="checkpoint:human-verify">` tasks at the points where human confirmation is required, and the executor halts at each one to ask the user.

```xml
<task type="checkpoint:human-verify" gate="blocking">
  <what-built>Dev server running at http://localhost:3000</what-built>
  <how-to-verify>
    1. Visit /dashboard
    2. Sidebar collapses at 768px
  </how-to-verify>
  <resume-signal>"approved" or describe issues</resume-signal>
</task>
```

Choose `mid-flight` when you genuinely need the work to stop before any subsequent task runs (e.g., the next task depends on visual confirmation of the previous one), and you accept the cold-start cost as the price of that hard barrier.

## What is *not* affected

`checkpoint:decision` and `checkpoint:human-action` tasks are still emitted in `end-of-phase` mode. Those gate the work itself (a choice the executor needs from the user, or an auth step only the user can perform), not post-hoc verification of completed work. Only `checkpoint:human-verify` is suppressed.

## The tracer feedback gate (executor-side, #3299)

This mode is not purely a planner concern. The **tracer feedback gate** — the executor's early integration checkpoint after a `type="tracer"` task, in `workflows/execute-plan.md` and `agents/gsd-executor.md` — synthesizes a `checkpoint:human-verify` at runtime that no planner ever emitted, so planner-side suppression cannot reach it.

That gate predates this mode (added by #2294; `end-of-phase` became the default in #3309, whose scope was the planner and verifier only), and until #3299 it branched on auto-mode alone. The result was that under the documented default, an interactive run halted after **every** tracer whose evidence was purely a test verdict, asking the user to retype a result the executor had just computed.

The gate now honors `human_verify_mode`.

The full precedence chain lives in `gsd-core/references/checkpoints.md` → "Tracer feedback gate (#3299)"; it is evaluated in order, and `gate="blocking-human"` outranks everything. Summary: an interactive `end-of-phase` run with an automated-only `<verify>` re-runs it and continues with no checkpoint (HALT on failure, unconditionally); `mid-flight`, `<human-check>`, and `blocking-human` all still STOP; the auto-mode branch is unchanged.

**Why a tracer carrying `<human-check>` still halts rather than deferring to the end-of-phase UAT batch.** Deferring would be the more uniform reading of this mode — `<human-check>` on an `auto` task defers, so arguably it should defer on a tracer too. It deliberately does not, for three reasons. First, and decisively: **the end-of-phase harvest does not cover tracers.** `agents/gsd-verifier.md` collects `<verify><human-check>` blocks from `auto` tasks; deferring a tracer's human evidence without first widening that seam would drop the evidence on the floor entirely — strictly worse than halting. Second, the tracer gate exists to stop expansion being layered onto an unproven slice; deferring its human evidence would let every expansion task build on a slice no human has confirmed, the exact failure the gate was introduced to prevent. Third, the reported defect is scoped to tracers with *no* human-observable evidence, and fail-closed is the safe direction outside that scope. If uniformity is later preferred, the harvest must be widened to tracers in the same change — record that decision here rather than re-deriving it.

`workflow.human_verify_mode` is **absent from `SCHEMA_DEFAULTS`** in `src/config.cts`, so `query config-get workflow.human_verify_mode` exits non-zero with `Key not found` on any project whose `config.json` predates #3309 — it does not resolve the documented `end-of-phase` default. Every consumer must therefore pass `--default end-of-phase` explicitly.

## Compatibility with other modes

- **`workflow.tdd_mode`**: orthogonal. TDD tasks still emit `tdd="true"` and `<behavior>`; the `<verify>` block carries the human-check sub-element when `human_verify_mode = end-of-phase`.
- **`MVP_MODE`**: orthogonal. Vertical-slice ordering is unchanged. The first task remains a failing end-to-end test; later auto tasks may carry `<verify><human-check>` instead of standalone checkpoint tasks.
- **`workflow.auto_advance` / `_auto_chain_active`**: in mid-flight mode these auto-approve checkpoint:human-verify halts. In end-of-phase mode there are no *planner-emitted* halts to auto-approve, so the flags have no effect on the planner's output. They are not inert at execution time, though: the executor-side tracer feedback gate above synthesizes its own checkpoint, and the auto-mode branch takes precedence over `human_verify_mode` there — except for `gate="blocking-human"`, which is evaluated first and STOPs in every mode (#3299).
