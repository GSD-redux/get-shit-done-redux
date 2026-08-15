# Planner Preconditions — `<precondition>` Element

> Progressive-disclosure reference for `agents/gsd-planner.md`. The planner agent
> reads this file when it needs the full emission rules for the `<precondition>`
> task element (issue #1949, *The Pragmatic Programmer* Topic 23 — Design by
> Contract). The slim pointer in `agents/gsd-planner.md` → `<task_breakdown>`
> routes here; the canonical schema row lives in `docs/reference/plan-md.md`.

## The contract triad

Every task in a PLAN.md participates in a three-sided contract:

| Contract side | GSD element | When it binds |
|---|---|---|
| **Precondition** | `<precondition>` (optional element on `<task>`) | Before the task begins. What must already be true for the task to run safely. |
| **Postcondition** | `<verify>` + `<done>` + `<acceptance_criteria>` | After the task ends. What the task guarantees on return. |
| **Invariant** | `must_haves.truths` (plan frontmatter) | Across the whole plan/phase. What always holds. |

GSD already models postconditions and invariants well. `<precondition>` closes
the missing side: it states, in runnable/checkable terms, what must be true
*before* a task begins — so an autonomous executor stops the instant an
assumption is false, instead of building ten atomic commits on top of a
migration that never ran.

This is the front-of-task companion to the tracer-bullet proposal (#1945):
tracers prove the *architecture* end-to-end before expansion; preconditions prove
each expansion task's *assumptions* before it runs. Together they close both ends
of the "outrunning your headlights" failure mode.

## When to emit `<precondition>`

Emit `<precondition>` ONLY when a task relies on state the plan's own `depends_on`
ordering does not already guarantee. Three cases cover every legitimate use; if
the task's prerequisite is intra-plan sequencing, use `depends_on`, NOT
`<precondition>`.

### Case 1 — External service setup (`user_setup`)

The task depends on an external service the developer must set up (account
creation, secret retrieval, dashboard configuration, billing activation). The
`user_setup` frontmatter field already enumerates these steps; `<precondition>`
on the consuming task ties a specific setup step to a specific task so the
executor halts if the setup was skipped.

```xml
<task type="auto">
  <name>Send welcome email via SendGrid</name>
  <precondition>SENDGRID_API_KEY is set (user_setup step 1 complete)</precondition>
  <files>src/email/welcome.ts</files>
  <action>...</action>
  <verify>...</verify>
  <done>Welcome email dispatched for a test user</done>
</task>
```

### Case 2 — Prior-phase artifact dependency

The task consumes an artifact a prior phase promised (a generated schema, a
migration's dist output, a contract file). Cross-phase `depends_on` does not
cross phase boundaries, so a `<precondition>` is the explicit pointer.

```xml
<task type="auto">
  <name>Generate TypeScript client from schema</name>
  <precondition>dist/schema.json from Phase 02 exists and is non-empty</precondition>
  <files>src/client/generated.ts</files>
  <action>...</action>
  <verify>...</verify>
  <done>Client generated and compiles</done>
</task>
```

### Case 3 — Environment variable / runtime configuration

The task shells out to a tool, hits an API, or runs a script that requires an
environment variable or runtime config that exists *now* (not at plan time).

```xml
<task type="auto">
  <name>Add /reveal endpoint handler</name>
  <precondition>server bootstraps and responds to GET /health (from the tracer slice)</precondition>
  <files>server/reveal.ts</files>
  <action>...</action>
  <verify>curl /reveal?path=... opens the OS file manager</verify>
  <done>Endpoint committed and manually verified</done>
</task>
```

## Format

`<precondition>` is a single line of prose inside the `<task>` element, placed right after `<name>` and before `<files>`. It is **prose, not a structured block** — concrete enough that the executor agent can run a read-only check (file existence, env var presence, idempotent `GET /health`-style ping), prose enough not to require a parser extension. The executor MUST verify with read-only checks only: no writes, no network POSTs, no secret emission. If a side-effecting check seems required, the executor halts and surfaces a checkpoint rather than running it.

```xml
<task type="auto">
  <name>...</name>
  <precondition>...</precondition>
  <files>...</files>
  <action>...</action>
  <verify>...</verify>
  <done>...</done>
</task>
```

## What NOT to put in a `<precondition>`

- **Vague readiness checks.** "The system is ready" is not checkable. Name the
  concrete signal: a `curl` response, a file path, an env var name.
- **Intra-plan ordering.** "Task 1 has completed" — that is what `depends_on`
  is for. Reserve `<precondition>` for state the plan's wave/dependency graph
  cannot express.
- **Implementation choices.** "We have chosen library X" — that belongs in the
  `<action>` body or a `## Decisions` row, not a runtime fact.
- **Things the task itself creates.** A precondition names a fact the task
  *assumes*; if the task produces it, it is a postcondition (`<done>`).

## Executor behavior (assertion contract)

The executor agent reads `<precondition>` before any other task work:

| State | Executor behavior |
|---|---|
| **Absent** | No visible change — execute the task exactly as today. Back-compat for every existing plan. |
| **Met** | No visible change — proceed with the task. The precondition is logged in the SUMMARY only if it was non-trivial to verify. |
| **Unmet** | STOP — return a `checkpoint:human-verify` reporting `**Gate:** blocking-human` (use `checkpoint_return_format`) with `**Blocked by:** Precondition not met: <precondition text>`. Do NOT partial-commit the task. Unmet preconditions are NEVER auto-approved — a missing prerequisite is not a verification step a human can rubber-stamp, it is a fact the executor cannot establish on its own. |

## Plan-structure validation

`cmdVerifyPlanStructure` checks for the presence of required tags (`<name>`,
`<action>`, etc.) and warns on missing recommended tags (`<verify>`, `<done>`,
`<files>`). It does **not** reject unknown optional tags, so adding
`<precondition>` to a plan passes validation unchanged. A future ADR may add
structured validation if drift emerges; v1 ships prose-only to keep the surface
minimal (Hyrum's Law: the smaller the observable surface, the less the system
depends on by accident).

## Out of scope

The following are explicitly NOT part of v1:

- **Structured precondition DSL** (e.g. `<precondition kind="env" var="X"/>`).
  Prose-first keeps complexity flat; structured validation can land in a later
  PR if prose proves insufficient.
- **Automatic precondition emission for every task.** The three cases above are
  a hard ceiling (Zawinski's Law guard). Most tasks do not need a precondition.
- **Cross-task preconditions.** A precondition binds one task to one fact. Use
  `depends_on` or a parent plan's `must_haves` for multi-task contracts.

## See also

- *The Pragmatic Programmer*, Topic 23 — "Design by Contract" (Hunt & Thomas).
- `docs/reference/plan-md.md` — canonical PLAN.md schema reference (where
  `<precondition>` appears in the task-element table).
- Tracer-bullet proposal (#1945) — the architectural-end companion to this
  front-of-task contract.
- `agents/gsd-executor.md` → `<execution_flow>` → precondition check step — the
  assertion surface that consumes what this reference defines.
