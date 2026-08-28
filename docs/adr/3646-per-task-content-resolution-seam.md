# ADR-3646: Per-task external-tracker content-resolution seam

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-08-27 |
| **Issue** | [#3646](https://github.com/open-gsd/gsd-core/issues/3646) |
| **Phase-0 sub-issue** | [#3969](https://github.com/open-gsd/gsd-core/issues/3969) |
| **Implementation phase** | [#3970](https://github.com/open-gsd/gsd-core/issues/3970) |
| **Related** | [#3554](https://github.com/open-gsd/gsd-core/issues/3554) (generic `ship:pre` gate/step dispatch — same class of gap, independent) · [#3647](https://github.com/open-gsd/gsd-core/issues/3647) (lifecycle-dispatch steps intermittently skipped) · [#3606](https://github.com/open-gsd/gsd-core/issues/3606) (validator checks hook existence, not dispatch — CLOSED) |
| **Reference** | [`loop-hook-dispatch.md`](../../gsd-core/references/loop-hook-dispatch.md), [`autonomous-ui-design-contract.md`](../../gsd-core/references/autonomous-ui-design-contract.md) |

## Context

`gsd-core/workflows/execute-plan.md`'s `<step name="execute">` reads every task's instructions
(`<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`, etc.) directly out of
the `PLAN.md` task block. There is no seam for a capability to resolve that content from an
external issue tracker (beads, Linear, Jira, GitHub Issues, …) by an id carried in the task block
instead. A project that wants the tracker to own task *content* — not just task *status* — has to
patch the workflow file locally. #3646 asks for a native, opt-in seam.

The Feature Review Report on #3646 approved this `go-with-conditions`, with four conditions this
ADR exists to resolve before any implementation lands.

### The existing extension-point system

`gsd-core/references/loop-hook-dispatch.md` defines the dispatch contract consumed by
`gsd_run loop render-hooks <point>`. Twelve points exist today, all phase- or wave-scoped:
`discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:pre`, `execute:wave:pre`,
`execute:wave:post`, `execute:post`, `verify:pre`, `verify:post`, `ship:pre`, `ship:post`. A
search for `task:pre` / `task:post` / `execute:task` across the tree returns nothing — the finest
granularity in the system is the wave, one level coarser than what #3646 asks for.

Each point's `activeHooks` array carries entries of `kind: "contribution" | "step" | "gate"`,
dispatched by prose instructions in the consuming workflow file: `step` invokes a Skill/Agent/
command; `gate` evaluates a check and blocks or advises depending on `blocking`. Both kinds are
**natural-language instructions inside a markdown workflow document**, executed by whichever LLM
is driving the loop.

### Why that mechanism cannot deliver this feature's safety property

The seam's own stated purpose is a **hard halt** on an unresolvable id — deliberately, because a
silent fall-back to inline `PLAN.md` text would require the tracker and `PLAN.md` to stay in sync
forever, defeating the point of moving content out of `PLAN.md`.

But #3647 (filed the same day as #3646, still open) reports that lifecycle-dispatch steps are
**intermittently skipped in real usage** — 1 of 4 wave-close dispatches observed firing. #3606
(closed) documented a related but distinct failure: the capability validator checked that a hook
call site *existed*, not that it *dispatched*, so a wired-and-enabled hook could be declared and
silently never run; that specific validator gap is now closed, but #3647's broader dispatch-
reliability problem is not.

A per-task point built as a `step`/`gate` entry in `activeHooks`, dispatched the same way the
twelve existing points are, inherits that reliability profile. Per-task dispatch multiplies the
number of dispatch opportunities by the task count — a plan with 20 tasks creates 20 chances for
the dispatch to silently not fire, instead of the 1-per-wave exposure the existing points carry.
When a per-task dispatch does not fire, nothing errors: the executor simply proceeds to read the
task's inline `PLAN.md` body. That is **exactly branch 3 of the proposal** (the legitimate
pre-migration fall-back for tasks authored before a tracker migration) — a missed dispatch and a
genuine pre-migration task are indistinguishable at the point of failure, so the executor edits
stale content while believing it authoritative. This reproduces the exact hazard the proposal's
own hard-halt requirement exists to prevent.

## Decision

### 1. Granularity tier

This ADR adds a **thirteenth extension point, at a new tier below wave**: `execute:task`. It sits
inside the existing `execute:wave:pre` / `execute:wave:post` bracket, evaluated once per task,
immediately before that task's `read_first` gate (`execute-plan.md:221`) — the `read_first` list
is itself a field this point can resolve, so a point evaluated after `read_first` would gate on
content that has not been fetched yet.

`execute:task` is **not registered as a `contribution` / `step` / `gate` entry in
`loop-hook-dispatch.md`'s existing `kind` vocabulary.** Decision 2 explains why a new `kind` is
required rather than reusing one of the three.

Ordering within one task: `execute:task` → `read_first` gate → task body (`type="auto"` /
`"tracer"` / `"checkpoint:*"`) → `acceptance_criteria` hard gate. A `checkpoint:*` task never
enters `execute:task` — its interactive structure (options, pros/cons, resume-signal) is
irreducibly a human-facing prose step and stays sourced from `PLAN.md`. Plan-level sections
(`<objective>`, `<context>`, `<verification>`, `<success_criteria>`) are out of scope for this
point; `load_prompt`'s whole-file read is unchanged.

### 2. Hard-halt enforcement: Lens B — a code-side resolution seam

**Chosen over Lens A** (a prose `step`/`gate` dispatched the same way as the twelve existing
points), for the reason argued in Context: #3647 is open, so any `step`/`gate`-shaped
implementation inherits a live, unresolved reliability defect and cannot deliver the feature's own
safety property. The Feature Review Report's Lens B recommendation is adopted as-is; Lens A is
rejected outright rather than sequenced behind #3647, because sequencing behind an open reliability
issue with no committed fix date blocks #3646 indefinitely on someone else's timeline for no
architectural gain — Lens B is buildable today and is strictly the safer shape regardless of
whether #3647 is ever fixed.

`execute:task` resolution is a **real subprocess invocation with a real exit code**, not an LLM
instruction:

```bash
gsd_run task resolve-content --plan "<PLAN.md path>" --task-id "<task id>" --raw
```

Contract:

- **No capability registers a task-content resolver for this plan** → the command exits `0` with
  `{"resolved": false}`. The workflow proceeds to read the task's inline `PLAN.md` body exactly as
  it does today. This is the unconditional default for every existing project — the seam is
  additive and opt-in.
- **A capability registers a resolver and the resolution fails** (tracker unreachable, id not
  found, malformed response) → the command **exits non-zero**. `execute-plan.md`'s `execute` step
  treats any non-zero exit from `task resolve-content` as a hard halt for that task: surface the
  id, the tracker, and the raw error, and stop. This is enforced by the same mechanism every other
  `gsd_run` subcommand's failure is enforced by (`src/cli-exit.cts`'s `runMain` / `ExitError`
  seam — see [ADR-3889](3889-process-exit-contract.md)) — a real process exit code the calling
  loop cannot fail to observe the way it can fail to execute a prose instruction.
- **A capability registers a resolver and resolution succeeds with non-empty content** → exits `0`
  with `{"resolved": true, "content": {...}}`; that payload's fields stand in for the task's
  `<read_first>` / `<action>` / `<verify>` / `<acceptance_criteria>` / `<done>` PLAN.md elements
  for every downstream gate in the `execute` step (the `read_first` MANDATORY gate, the
  `acceptance_criteria` HARD GATE, `<verify>`/`<done>` checks).
- **A capability registers a resolver and resolution succeeds with empty/absent content** → exits
  `0` with `{"resolved": false, "reason": "empty"}` — the documented pre-migration boundary case;
  the workflow falls back to the inline `PLAN.md` body. This is the *only* legitimate fall-back
  path, and it is now distinguishable from a missed dispatch: a missed dispatch cannot happen
  because there is no dispatch to miss — the resolver either runs (and reports which of the three
  outcomes above occurred) or is absent by construction (`resolved: false`, no resolver
  registered).

Resolver registration itself (how a capability declares "I own task-content resolution for this
project") is implementation detail for #3970, constrained by Decision 3.

### 3. Registration and validation

`execute:task` is declared in `gsd-core/references/loop-hook-dispatch.md` in the same change that
implements it (#3970), as a new section documenting the `kind: "resolver"` shape (Decision 4) and
the `gsd_run task resolve-content` contract above — not as a new entry in the existing
`contribution`/`step`/`gate` dispatch-rules list, since it is dispatched differently (a required
subprocess call with a binding exit code, not a best-effort prose step). `gsd-core/bin/lib/
capability-validator.cjs` is extended in the same change to recognize a manifest declaring a
task-content resolver, so a capability that declares one but never wires the corresponding command
fails validation at install time rather than failing silently at first use — closing, for this new
point, the exact class of gap #3606 closed for the existing twelve.

### 4. Autonomous-mode behavior

`gsd-core/references/autonomous-ui-design-contract.md:34` records that `activeHooks` entries with
`kind == "gate"` are silently ignored on the autonomous path, because autonomous mode is always
pipeline mode and has no blocking-gate UI to route through. `execute:task` is **not** a `gate` —
it is the new `kind: "resolver"` — so that silent-ignore rule does not apply to it and does not
need an exception carved out. `execute:task` runs identically in autonomous and interactive modes:
a required subprocess call whose exit code is either observed (halt) or falls through by design
(`resolved: false`). Autonomous mode has no discretion to skip it, because there is no discretion
built into a `kind` that autonomous mode's dispatcher does not special-case at all — the contract
is honored by omission, not by an added branch.

## Rejected alternatives

- **Lens A, unconditionally** — matches the established `step`/`gate` pattern, cheapest to build,
  reviewable in one PR. Rejected: cannot deliver the hard-halt guarantee while #3647 is open (see
  Context); multiplies dispatch-reliability exposure by task count.
- **Lens A, sequenced behind a fix to #3647** — would deliver the guarantee once #3647 lands.
  Rejected: blocks #3646 on an unscoped, undated fix to a different issue, for no benefit over
  Lens B, which needs no such dependency and is architecturally the more precise fit (a resolution
  failure is a data-fetch failure, which is what process exit codes exist to signal — not a
  workflow-routing decision, which is what the `step`/`gate` vocabulary exists for).
- **Reusing `gate` with `kind: "gate"` and `blocking: true`** — would at least be checked by the
  existing dispatch contract. Rejected: `blocking: true` gates still route through the autonomous
  silent-ignore rule at `autonomous-ui-design-contract.md:34` for *other* points sharing that
  `kind`, and reusing the tag would require carving out a per-point exception to that rule rather
  than making the safety property structural. It also still depends on the LLM executing the
  dispatch instruction at all, which is the reliability problem this ADR exists to route around.
- **A per-task point that falls back to inline `PLAN.md` on ANY resolver error** (matching
  branch-3 semantics for both failure and pre-migration) — rejected explicitly by the issue itself:
  it requires the tracker and `PLAN.md` to stay in sync forever, defeating the purpose of the
  feature.

## Consequences

- `execute-plan.md`'s per-task loop gains one new required call before the `read_first` gate,
  for every task, on every plan — including plans with no resolver registered, where it is a
  fast, always-`{"resolved":false}` no-op. This is a small, unconditional per-task cost in
  exchange for the hard-halt guarantee being real.
- A new `kind: "resolver"` is added to the dispatch vocabulary alongside `contribution` / `step` /
  `gate`. Any future per-task or finer-grained point that needs a binding (not best-effort)
  outcome has a precedent to follow instead of inventing its own shape.
- `capability-validator.cjs` grows a new manifest shape to validate, and every runtime's emitted
  copy of `execute-plan.md` carries the new step through the installer — this puts the change
  under the workflow-content gates (`docs/INVENTORY.md`, manifest regen, `size:baseline`) for
  #3970, not the doc-only exemption this ADR itself qualifies for.
- The `beads`/`bd` local patch referenced in #3646 becomes portable: its three branches (halt on
  fetch failure, non-empty description supersedes PLAN.md, empty description falls back) map
  directly onto the three `gsd_run task resolve-content` outcomes above, so #3970 can validate the
  new seam against that existing, already-proven-in-production patch.

## Open questions for #3970

- Exact resolver-registration surface in the capability manifest schema (a new `contributions`
  entry shape, most likely — concrete design left to the implementation phase).
- Whether `gsd_run task resolve-content` needs a `--dry-run`/preview mode for `gsd-plan-checker`
  to validate resolver reachability before execution starts, rather than only at first task.
