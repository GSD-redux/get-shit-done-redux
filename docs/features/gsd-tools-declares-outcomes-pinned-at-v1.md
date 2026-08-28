---
id: 3912
title: gsd-tools Declares Outcomes, Pinned at v1
group: v1.7.0 Features
---

**Purpose:** Give every `gsd-tools` terminating path a declared outcome name, and project that
declaration through the versioned exit contract ([ADR-3889](../adr/3889-process-exit-contract.md)
§4) — without changing a single exit code for a caller that has not opted in.

**Reference — what changed (ADR-3889 Phase 8, #3912):**

- `error(message, reason)` now maps its `reason` argument onto a declared outcome name (`USAGE`,
  `NO_INPUT`, `UNAVAILABLE`, `INTERNAL`, `FAIL`) via a fixed table closed over all 25
  `ERROR_REASON` members (`src/io.cts`'s `REASON_TO_OUTCOME`). Under the default contract version
  `v1`, the declaration is recorded but `error()` still throws `ExitError(1)` unconditionally,
  byte-identical to every prior release. Under `v2` (`--exit-contract=v2` /
  `GSD_EXIT_CONTRACT=v2`), it throws `ExitError(projectOutcome(outcome, 'v2'))` instead — e.g.
  `SDK_MISSING_ARG`/`SDK_UNKNOWN_COMMAND` project to `64` (`USAGE`), `CONFIG_KEY_NOT_FOUND` to `66`
  (`NO_INPUT`). All 278 call sites are untouched; 226 pass no reason and default to `UNKNOWN` ->
  `FAIL` -> exit `1` under both versions.
- `output()` now declares `DEGRADED` whenever its payload carries a **serializable** `error` value
  (any key order — `{found:false, error}` counts the same as `{error, found:false}`). The
  discriminator is survives-`JSON.stringify`, not mere key presence: `{ error: undefined }` does
  **not** declare `DEGRADED`, because `JSON.stringify` drops an `undefined`-valued property before
  the payload reaches the wire.
- A third `globalThis` cell (`src/cli-exit.cts`'s `PENDING_OUTCOME_KEY`) holds the pending declared
  outcome between `output()` and `runMain`. Semantics: **last declaration wins, cleared on
  consumption** — a later clean `output()` call in the same invocation undoes an earlier degraded
  one, and `runMain` clears the cell on every exit so a second `runMain` in the same process never
  inherits a stale declaration.
- **Precedence** for the code a void-returning `main()` ends up with, highest first: (1) an explicit
  `main()` return, (2) a non-zero `process.exitCode` `main()` already set directly, (3) the pending
  declared outcome, (4) otherwise `0`. Projection may only ever **set** a code, never **lower** one
  — a review pass wrongly concluded the cell was fail-closed by construction; without rule 2, `state
  validate --strict` briefly exited `0` where it must exit `1`.
- **`v1` is byte-identical.** `DEGRADED` projects to `0` under `v1` and to `80`
  (`exitCodeFor('DEGRADED')`) under `v2` — that asymmetry is
  [ADR-2980](../adr/2980-payload-carried-error-is-a-degraded-result.md)'s compatibility boundary,
  deliberately preserved, not a bug to reconcile.

**Explanation — why this is the shape it is:**

ADR-2980 ratified `output({error})`'s exit-0 population on measured blast radius (`output` has 170
direct callers) and Hyrum's Law grounds — a CLI exit code has no `/v2/` of its own, so normalizing
it in place would have broken every caller already treating exit `0` as a soft signal. Its own
"Revisit if" clause named the missing piece: *"a future `gsd-tools` major version provides a
compatibility boundary that a CLI exit code otherwise lacks."* ADR-3889 §4 built exactly that
boundary — a versioned projection selected by flag or env var, defaulting to today's behavior — and
this phase is what wires `error()` and `output()` onto it. Declaring an outcome is unconditional and
immediate; only its *projection* onto an integer is deferred behind the version switch, so the
population ADR-2980 ratified keeps exiting `0` until a caller explicitly asks for something else.

The count matters here too: an AST re-measure for this phase found **64** `output({error})` call
sites across the same nine modules ADR-2980 named — not the 60 that ADR itself recorded, the drift
concentrated in `frontmatter.cts`, `phase.cts`, and `roadmap.cts`. The `v2` projection is asserted
over the enumerated 64, not a restated 60; see ADR-2980's amendment for the module-by-module
breakdown.

See [Adopt the v2 exit contract](../how-to/adopt-the-v2-exit-contract.md) for how to opt in and what
it means for a CI gate, [`docs/json-errors.md`](../json-errors.md#outcome-declaration-and-the-versioned-exit-contract-adr-3889-4-3912)
for the full reference, and
[ADR-2980](../adr/2980-payload-carried-error-is-a-degraded-result.md) /
[ADR-3889](../adr/3889-process-exit-contract.md) for the decisions.
