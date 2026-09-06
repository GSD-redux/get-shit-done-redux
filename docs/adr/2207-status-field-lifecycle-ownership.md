# ADR-2207: STATE.md `Status` lifecycle — phase-completion writes an intermediate state; milestone-close owns termination

- **Status:** Accepted
- **Date:** 2026-07-12
- **Issue:** [#2207](https://github.com/open-gsd/gsd-core/issues/2207)
- **Implements:** [#2204](https://github.com/open-gsd/gsd-core/issues/2204) (Bug 7b, split from the #2191 batch)

## Context

STATE.md's `Status` field is written by two transitions with an **overloaded** value:

- `completePhaseCore` (phase-completion) writes a bare `Status: Milestone complete` on the last phase, keyed on `isLastPhase`.
- `milestoneCompleteCore` (milestone-close) writes the terminal `Status: <version> milestone complete` and resets `## Current Position` to `Awaiting next milestone`.

"Milestone complete" therefore spans **two distinct states** — an intermediate "all phases done, awaiting formal close" and the terminal archived state — and a **phase-level verb owns a milestone-level field**. Because `isLastPhase` is derived from the ROADMAP parse, a mis-parse (the bullet-form / membership bugs, #2199 / #2200) can flip the milestone status on the wrong phase.

## Decision

1. **Phase-completion writes an intermediate state, not the terminal one.** `completePhaseCore` writes the **existing** `All phases complete` value (already used in `gsd2-import.cts`) on the last phase — not `Milestone complete`.
2. **Milestone termination is owned solely by the milestone-close verb.** Only `milestoneCompleteCore` writes `<version> milestone complete` / `Awaiting next milestone`.
3. **The coupling is retained, not removed.** "Is this the last phase" stays on the phase-completion path; its correctness is carried by the existing `#2028` checkbox guard, the parse fixes (#2199 / #2200), and the `verify.cts` ship gate that already errors when STATE claims milestone-complete while phases are unstarted.

**Rejected alternative — decouple** (phase verbs never write milestone `Status`): rejected because `#2028` shows the last-phase signal is deliberately wanted on the phase-completion path; removing it would regress that.

## The `Status` lifecycle (ubiquitous language)

`Ready to plan` → `All phases complete` (all phases done, milestone awaiting formal close) → `<version> milestone complete` → `Awaiting next milestone` (terminal / archived).

## Consequences

**Positive:** the overload is removed; the intermediate and terminal "complete" states are distinct; a phase-level verb no longer writes the terminal milestone state; the wrong-phase flip becomes a parse-correctness concern already owned upstream.

**Cost / follow-through (implemented in #2204):** consumers that key on the `Milestone complete` string must recognize `All phases complete` — `workflows/progress.md` (Route D), `verify.cts`, and `workstream-inventory-builder.cts`. `normalizeStateStatus` already maps any status containing "complete" → `completed`, so it needs no change. *(Superseded mechanism, #4186: recognition is now an ANCHORED whole-field vocabulary match — `All phases complete` and `<version> milestone complete` still map to `completed`; prose merely containing "complete" passes through verbatim. The consumer-recognition consequence above is unchanged.)* A `CONTEXT.md` glossary entry enumerating the `Status` lifecycle lands with the #2204 implementation.
