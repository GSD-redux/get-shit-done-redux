# ADR-1953: Complexity-triggered refactor — the loop measures the entropy it just added

- **Status:** Proposed
- **Date:** 2026-08-09
- **Issue:** [#1953](https://github.com/open-gsd/gsd-core/issues/1953)
- **Implementation:** `src/complexity-trigger.cts`, `src/refactor-trigger-command-router.cts`, `capabilities/refactor-trigger/capability.json`, and a changed-files adapter in `src/git-base-branch.cts`
- **Extends:** [ADR-857](857-capability-system.md) (registers on the `execute:post` extension point) · [ADR-894](894-capability-declaration-format.md) (a `role: "feature"` manifest with `commands`, `steps`, and a `gates` entry)
- **Related:** [#1950](https://github.com/open-gsd/gsd-core/issues/1950) / the `broken-windows` capability — this ADR reuses its ledger rather than adding a second one

## Context

*The Pragmatic Programmer* Topic 40 — "Refactor Early, Refactor Often" — argues for
refactoring as gardening: a little, continuously, because entropy compounds. GSD today has
refactoring only as a **manual commit type** (`agents/gsd-executor.md`, `agents/gsd-planner.md`):
an optional cleanup the executor may perform. Nothing measures accumulated complexity and
nothing triggers a refactor. It happens if, and only if, someone remembers.

That gap is worse under an AI executor than under a human one, and for a structural reason:
**every phase runs in a fresh context**, so no single run ever sees the accumulated mess.
Each phase adds a branch here and a special case there, every one locally justified by "make
the tests pass". By the time a human notices, the hotspot is a rewrite.

The signal needed to close this is cheap and already sitting there: the loop knows exactly
which files a phase touched, and it knows the moment the phase ends. What is missing is a
trigger.

## Decision

**D1 — A capability on `execute:post`, not a change to the loop.** `refactor-trigger` is a
`role: "feature"` capability, `activationKey: refactor.trigger_enabled`, default **off**.
Nothing about the loop changes for anyone who does not opt in.

**D2 — The signal is computed in-core, with no new dependency.** A decision-point counter
over comment- and literal-stripped source, Node builtins only, in the same regex idiom
`src/intel.cts` already uses for export extraction. This was chosen over the issue's original
"use Memtrace's complexity signals" and over shelling out to ESLint `complexity` / radon.

The reason is not that the alternatives are worse metrics — they are better ones. It is that
the `execute:post` hook fires as a **deterministic CLI**, not as an agent holding MCP tools,
and core forbids external dependencies. An agent-side Memtrace variant could not be bound by
a behavioral test, which is a hard requirement of the linked issue's own acceptance criteria.
The metric sits behind a named seam so a second one is additive later.

**D3 — Two numbers, never one composite.** A function is a candidate when its absolute score
exceeds `refactor.complexity_threshold`, **or** when its growth over its anchor exceeds
`refactor.complexity_jump_delta`. Both are reported. Trigger semantics are ESLint's
`complexity: {max: N}` semantics — strictly greater — so a score equal to the threshold does
not trigger.

**D4 — The baseline is a stable anchor, not a rolling value.** It is set the first time a
function is observed and moves only when the proposal is *dispositioned*. The delta is
therefore cumulative since the last conscious decision about that function.

A rolling baseline was tried first and discarded: with it, the delta is always the
single-phase change, so a function creeping `+2` per phase against a delta of 5 never trips
the jump check, and the absolute threshold catches the creep first — leaving the jump-delta
contributing nothing. The stable anchor catches that creep a full phase earlier, which is the
entire reason the second number exists. The cost is that a legitimately-growing function
re-proposes until dispositioned.

**D5 — Advisory by default; strict mode tracks on *disposition*, never on the score.** This is
the load-bearing decision of the whole design. A blocking complexity number is a metric that
an executor optimizing for green gates can satisfy by splitting one coherent function into two
incoherent ones — identical total complexity, worse cohesion. So the tracked entry clears when
the proposal is **dispositioned** — `refactor accept` or `refactor decline`, either one — and
never asks whether the number went down.

**D6 — This capability declares no gates. Strict mode routes through the broken-windows
ledger.** An untriaged proposal becomes an open `deviation` entry via `appendWindow`;
blocking is broken-windows' existing, already-dispatched `ship:pre` gate, enabled separately
with `workflow.windows_enforce`. A declined proposal resolves its entry as `waived` with the
recorded reason; an accepted one resolves it as `fixed`. There is no second ledger and no
second gate.

Two earlier cuts of this decision were wrong and are recorded because the reason generalizes.
A `check.predicate` on the proposal artifact was killed by `artifact-frontmatter-equals`
mapping *artifact not found* to `block: true` — it would block every ship in which no
proposal was produced. A `check.query` was then killed by the test suite: `ship.md` has **no
generic `ship:pre` gate dispatch at all**, only two hardcoded branches (`security` at
`ship.md:105`, `broken-windows` at `ship.md:155`), so a third gate of either kind would be
declared and never evaluated — strict mode would silently do nothing. The structural guards
in `tests/loop-hooks-ship-pre-e2e.test.cjs` pin that reality rather than express a
preference. Generalized: **at `ship:pre`, a capability cannot add a gate; it can only add a
window.**

**D7 — A declined refactor is recorded in the existing broken-windows ledger.** The same
`appendWindow` path as D6, degrading to a note when that capability is absent. No second ledger.

**D8 — `execute:post` gains a generic step-hook dispatch contract.** `execute-phase.md`
dispatches `execute:post` step hooks only where `ref.skill == "code-review"`, so a `ref.command`
step there is declared-but-never-run. The contract added mirrors the existing one in `ship.md`.
The code-review branch is left byte-identical; the generic contract handles the rest.

## What stays OUTSIDE

- **Choosing or applying the refactor.** The capability surfaces a proposal. It never edits
  code, never picks a strategy, never auto-applies. Executing an accepted proposal remains the
  executor's existing `refactor` commit type.
- **Cognitive complexity, Halstead, maintainability index.** One metric behind a seam. Adding a
  second is a later, additive decision, not a reason to widen this one.
- **Non-JS/TS languages.** Unsupported extensions are reported as skipped, never scored.
- **Test files and generated output.** Excluded by default; branchy tests are not a defect.
- **Threading the touched-file set through `agents/gsd-executor.md`** (named in the issue's
  scope list). Deriving it from a bounded `git diff` inside the CLI is deterministic and
  testable and avoids the agent-size ripple.
- **Repo-wide or scheduled scanning.** The signal is strongest on exactly the files the phase
  just touched; a periodic full-repo scan is decoupled from the change that caused the growth.

## Consequences

**Good.** Continuous, automatic refactoring pressure that does not depend on anyone
remembering. Slow creep becomes visible a phase before the absolute threshold would catch it.
Declined cleanups stay tracked instead of evaporating. Zero cost when off, and zero new
dependencies when on.

**Bad, and accepted.** The metric is approximate by construction: biased against a flat
`switch` (SonarSource's well-known objection to raw cyclomatic complexity), blind to nesting
depth, and JS/TS-only. A rename reads as delete-plus-add and loses its anchor. Defaults will
need tuning — too low reads as refactor spam, which the linked issue names as the main
maintenance burden. The leak surface of a non-AST analyzer is real; it is handled by refusing
to emit a number rather than by emitting an approximate one.

**A soft dependency, disclosed.** Strict mode can only *block* when the broken-windows
capability is installed and `workflow.windows_enforce` is on — two toggles, not one. Without
it, strict mode still records the proposal and says so, but cannot stop a ship. `requires:
["broken-windows"]` was rejected because it would force-install the ledger on advisory users
who never enable strict mode.

**Risk we are deliberately holding.** D5 mitigates Goodhart exposure but does not eliminate it.
A team that turns on strict mode and treats proposals as chores to clear will get worse code
than one that leaves it advisory. The default and the documentation both push toward the latter.

## Open questions

1. Is 15 the right default threshold? SonarSource's default; ESLint's is 20; radon's rank C
   starts at 11. Needs field data.
2. Should an accepted proposal auto-create a task in the next phase's plan, rather than relying
   on the developer to act? Deferred — it would couple this capability to the planner.
3. Should cognitive complexity become the default once available, with cyclomatic as the
   fallback? The seam allows it; the evidence to decide does not exist yet.

## References

- *The Pragmatic Programmer*, Topic 40 — "Refactoring".
- T. J. McCabe, "A Complexity Measure", IEEE TSE, 1976 — `V(G) = E − N + 2P`.
- G. Ann Campbell, "Cognitive Complexity" (SonarSource) — the readability critique of raw
  cyclomatic complexity that motivates D2's seam and the flat-`switch` caveat.
- ESLint `complexity` rule — the source of D3's strictly-greater `max` semantics.
- Martin Fowler, *Refactoring* and "Code Smell" — a threshold crossing is a signal to look
  closer, not a verdict; the reason D5 surfaces rather than blocks.
- `docs/reference/capability-manifest.md`, `docs/reference/gate-predicates.md`.
