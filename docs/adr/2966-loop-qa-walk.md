# ADR-2966: Test the five-step loop as a continuous walk, not isolated points

- **Status:** Accepted
- **Date:** 2026-08-01
- **Issue:** [#2966](https://github.com/open-gsd/gsd-core/issues/2966)
- **Supersedes:** —
- **Relationship to prior work:** Extends `RULESET.TESTS.feedback-loop-convergence` (`CONTEXT.md`) from its existing single instance, `tests/estimate-loop-convergence.test.cjs`, to the full five-step loop.

## Context

131 of roughly 705 test files already drive the real `gsd-tools` binary through `runGsdTools` in `tests/helpers.cjs` — CLI-altitude testing is solved and well trodden. What no existing test does is carry one project's accumulating state across all five loop steps in a single run. Every loop test today asserts a step in isolation, against state fabricated for that step alone. `CONTEXT.md`'s `RULESET.TESTS.feedback-loop-convergence` already names the alternative — assert convergence across an accumulating sequence — and one instance of it exists for estimation (`tests/estimate-loop-convergence.test.cjs`). This ADR extends that pattern to the loop itself.

## Decision

### 1. Walk the loop as a continuous trajectory

Build a walk driver, `tests/qa/loop-walk.cjs`, that runs the five loop steps in order against one project's accumulating on-disk state, rather than five independent point tests each seeded from scratch. This is `RULESET.TESTS.feedback-loop-convergence` generalized from estimation to the loop, anchored to the existing convergence instance rather than invented fresh.

### 2. Layer over `tests/helpers.cjs`; do not build a second substrate

`runGsdTools` already invokes the real subprocess with a 60s timeout and env injection, and 131 files depend on it. The walk driver is built strictly on top of it. The rejected alternative — a standalone harness re-implementing subprocess invocation — was considered and rejected as duplication (Gall's Law: a working complex system evolves from a working simple one).

### 3. The stub agent seam, and its limit stated plainly

`gsd-tools init new-project` (and the other loop init commands) write nothing — they are read-only context projections; the agent is the one that authors artifacts (STATE.md, phase files, etc.). A scripted stub writer standing in for the agent is therefore faithful to the real division of labor, and the entire engine — routing, state transitions, gates — runs for real behind it.

The limit is stated plainly and not glossed over: this walk proves the engine's state machine is coherent across all five steps. It proves nothing about whether a real LLM agent emits artifacts of the shape the walk's fixtures assume.

### 4. Oracles read a typed IR only, never rendered text

`tests/qa/oracles.cjs`'s ten invariant oracles (seven `SEVERITY.VIOLATION` oracles plus three `SEVERITY.SMELL` oracles — see §5) assert exclusively against `tests/qa/result.cjs`'s typed `RunResult` IR, never against raw stdout/stderr text. This is forced, not stylistic: `CONTRIBUTING.md` → "Prohibited: Raw Text Matching on Test Outputs" and `RULESET.TESTS.no-source-grep.tmp-file-traps` both ban it. The same constraint governs the tree-idempotence oracle: it compares `fs.statSync` facts (`size`, `mtimeMs`, `isFile()`) across runs, never content hashing or reading the SUT's own tmp-file output, which would trip the identical lint.

### 5. Findings carry severity; the harness reports evidence, it does not adjudicate

`tests/qa/oracles.cjs`'s `check(ctx)` outcomes carry a `severity`:

- `SEVERITY.VIOLATION` — the documented contract is broken. Fails `runOracles(ctx).failed` and therefore fails the build.
- `SEVERITY.SMELL` — legal under today's implementation but structurally questionable. Recorded in `.smells`, never folded into `.failed`, and never fails a build.

Rationale: an oracle set derived from current behavior can only ever confirm current behavior — that framing turns the harness into a conformance test for the status quo. Severity is what lets the harness say "this works and is still wrong," which is the sentence a quality tool must be able to form. The maintainer decides which smells become fixes; the tool's job is to make the trade visible instead of invisible.

Consequence, stated as an explicit safety property: `runOracles(ctx).failed` is a getter that deliberately aliases `violations` only — it never includes `smells`. Adding a smell oracle, or a new smell case to an existing oracle, can therefore never redden CI. The severity split is what makes it safe to keep adding observational oracles without turning every new observation into a build break.

### 6. `output({error: …})` is not changed here — its cost is now visible on every occurrence

42 call sites use `output({error: …})`: a JSON payload carrying an `error` key on stdout, exit 0. This is deliberately distinct from `error(msg, reason)`, which writes `{ok:false, reason, message}` to stderr and exits 1. `get_impact` rates `cmdStateSnapshot` — the function this idiom threads through — **CRITICAL** (55 affected symbols, 23 processes). Normalizing all 42 sites to the hard-failure path was considered and rejected: it would flip exit codes 0 → 1 across a seam that workflows and agents currently treat as a soft signal — Hyrum's Law applies directly, since the exit-0 behavior is observable and already depended on.

This is not left alone because it is judged fine. It is not changed here because a blast radius of that size warrants a separate, deliberate decision, not one folded into a QA-harness ADR — and the `soft-error-exit-zero` smell (§5) now fires on every occurrence so the cost stays visible instead of quietly disappearing back into the status quo. The concrete cost for a caller: a shell caller's `if ! cmd; then` is blind to a failure reported through a payload key with exit 0 — the process exits 0, so the conditional never trips. The walk's `RunResult` IR types this shape explicitly (`kind: 'soft-error'`) so it can be reported as a smell rather than silently swallowed.

### 7. The `docs/json-errors.md` vs. `src/cli-exit.cts` contract conflict is surfaced, not resolved

`docs/json-errors.md` states that every error emits exactly one JSON line to stderr and exits 1. `src/cli-exit.cts`'s `runMain` returns before reaching the json-error branch for `ExitError`, so CLI usage errors deliberately emit plain text instead. Both behaviors are current and they contradict each other.

This ADR does not pick a side — resolving it means changing every `ExitError` throw site, which is a separate decision with its own blast radius. What changes is how the conflict is surfaced: the `contract-conflict` smell (§5) fires on every occurrence in json-error mode and quotes both sides in its detail — the `docs/json-errors.md` sentence and the `src/cli-exit.cts` `runMain` early-return that produces the breach — so a reader gets the evidence needed to decide, not a bare note that a conflict exists. This is layered on top of `json-contract`, which already reports the same observation as a VIOLATION of the documented contract (`RunResult.kind: 'unstructured-error'` on rows the doc says should be structured); `contract-conflict` adds the reason it is ambiguous rather than a clear-cut bug.

### 8. Fixture provenance is honest, not borrowed

Scenario artifacts live at `tests/qa/fixtures/`, template-derived, carrying an explicit provenance comment. They deliberately do **not** live at `tests/fixtures/representative/`, which asserts real-user provenance this repo cannot substantiate — no `.planning/` directory exists in this repo and no real loop-artifact fixtures exist to source from. Per #2371, template-derived provenance is adequate for happy-path and sequence scenarios, because templates are exactly what agents are instructed to emit. It is **not** adequate for a negative fixture asserting that the engine correctly rejects malformed input — a rejection test needs to be grounded in what the engine's grammar actually forbids, not a plausible guess at malformed shape. Perturbations (`tests/qa/mutations.cjs`) are exempt from this constraint: a CRLF/BOM/truncate transform is drawn from a generic corruption catalog, not from the engine's grammar, so it carries no provenance claim to substantiate.

### 9. New `qa` test-suite marker, excluded from the default `unit` lane

`scripts/run-tests.cjs` gains a `qa` suite marker for `tests/loop-walk.qa.test.cjs` and its dependents, excluded from the default `unit` lane. The walk's subprocess fan-out is deliberately bounded and run sequentially within a file: `RULESET.HARNESS.test-memory-guard` denies node spawns above 4 GiB aggregate RSS, and parallelizing scenario runs would risk crossing it.

### What the first run found

Running the walk driver against the real engine — not a mock — produced 0 violations and three smell classes on this first pass:

- `value-hygiene` — `init` returns `agents_dir` pointing outside the project tree.
- `untyped-success` — `smart-entry` emits prose unconditionally (`gsd-core/bin/lib/smart-entry.cjs:577-587`), so the routing oracle cannot assert on it until a `--json` mode exists.
- `soft-error-exit-zero` — `state-snapshot` reports a missing STATE.md through a payload key with exit 0.

These are observations for a maintainer to weigh, not defects this PR fixes.

## Consequences

- **Positive — makes easy.** A defect that only manifests as accumulated state drifting across loop steps (a stale pointer, a field one step wrote that a later step misreads) is now catchable by a single walk instead of requiring a human to hand-construct multi-step state. The `RunResult` IR gives every future loop-facing test a typed, lint-compliant surface to assert against instead of re-deriving raw-text parsing per test. The convergence pattern (`RULESET.TESTS.feedback-loop-convergence`) now has a second, load-bearing instance beyond estimation, making it a demonstrated pattern rather than a one-off.
- **Positive — anti-vacuity guard.** The end-to-end test (`tests/loop-walk.qa.test.cjs`) asserts the walk produces at least one smell, because a QA harness reporting nothing on a first run against a real engine is more likely mis-specified than the engine is perfect. It deliberately does **not** assert exact smell ids or counts — pinning those would re-freeze current behavior, the same failure mode the severity split (§5) exists to avoid.
- **Negative — makes harder.** The walk is one more thing to keep in sync with the five-step loop's actual shape; `LOOP_HOST_CONTRACT` is consumed from the generated module rather than re-listed, specifically to prevent this from becoming a second copy that drifts (per the design's known-defect gauntlet). The `qa` suite's sequential-only execution bounds wall-clock cost as scenario count grows.
- **Known limits, stated rather than hidden.**
  - The stub agent is not an LLM. The walk validates the engine's state machine; it says nothing about whether a real agent produces artifacts of the assumed shape.
  - `ship` has no runnable predicate evaluator (`tests/loop-hooks-ship-pre-e2e.test.cjs`: "enforcement is ship.md prose only"), so the `ship` step is asserted at contract-shape level only, not behaviorally.
  - `smart-entry` emits prose unconditionally on success (`gsd-core/bin/lib/smart-entry.cjs:577-587`), which is one of several untyped-success commands (`config-path`, `audit-open`, `skill-manifest`, and others). The routing oracle cannot assert on `smart-entry`'s routing decision until it gains a `--json` mode; that is future work, not covered here.
  - The open `docs/json-errors.md` vs. `src/cli-exit.cts` contract conflict (§6) remains unresolved by this ADR.

## References

- `CONTEXT.md` → `RULESET.TESTS.feedback-loop-convergence`
- `tests/estimate-loop-convergence.test.cjs` — the existing convergence instance this ADR generalizes
- `tests/helpers.cjs` — `runGsdTools`, the substrate the walk is layered over
- `tests/qa/loop-walk.cjs`, `tests/qa/result.cjs`, `tests/qa/oracles.cjs`, `tests/qa/mutations.cjs`, `tests/qa/fixtures/**`, `tests/qa/scenarios/*.json`
- `tests/loop-walk.qa.test.cjs`
- `src/io.cts` — `output` (`output({error})` soft-failure idiom, 42 sites, `CRITICAL` per `get_impact`), `error`
- `src/state.cts:1388` — `cmdStateSnapshot`
- `src/cli-exit.cts` — `runMain`, the `ExitError` early-return that produces the §6 conflict
- `docs/json-errors.md`
- `CONTRIBUTING.md` → "Prohibited: Raw Text Matching on Test Outputs"
- `gsd-core/bin/lib/smart-entry.cjs:577-587`
- Issue #2371 (fixture provenance standard)
- `.gsd/phase/test-2966-loop-qa-walk/40-design.md` — the design this ADR records
