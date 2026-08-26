# ADR-3889: The process-exit contract — one outcome vocabulary, one projection, two terminators

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-08-26 |
| **Issue** | [#3889](https://github.com/open-gsd/gsd-core/issues/3889) |
| **Supersedes** | — |
| **Amends** | [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md) (payload-carried error is a degraded result) — provides the compatibility boundary ADR-2980's "Revisit if" clause names |
| **Constrained by** | [ADR-2966](2966-loop-qa-walk.md) §5–§7, [ADR-2008](2008-command-exit-zero-gate.md), [ADR-1411](1411-resolution-provenance.md), [ADR-3473](3473-enforcement-by-construction.md) §B4 |

## Context

An exit code is the only thing every caller of this product can read. Shell workflows branch on
`$?`. `gsd_run` branches on `$?`. CI steps branch on `$?`. The Claude Code hook harness reads
nothing else. Capability gates declared under `check.predicate` with `kind: "command-exit-zero"`
read nothing else *by definition* ([ADR-2008](2008-command-exit-zero-gate.md)).

That channel currently carries **one bit**, and the bit is computed independently at every call
site from whatever local boolean happened to be in scope. There is no type, no projection, and no
owner.

### The measured population

Counted at `next` on 2026-08-26 across `src/`, `bin/`, `scripts/`, `hooks/`, `gsd-core/`,
`capabilities/`, `pi/`:

| Terminator | Count |
|---|--:|
| `process.exit(0)` | 199 |
| `process.exit(1)` | 50 |
| `process.exit(2)` | 27 |
| **Total JS/TS terminators** | **276** |

Shell surfaces add `exit 2` ×17, `exit 0` ×16, `exit 1` ×10, `exit 127` ×1.

Four distinct idioms reach the process boundary, and none of them owns it:

| Idiom | Where | Exit code | Information carried |
|---|---|--:|---|
| `error(message, reason)` | `src/io.cts` → `gsd-core/bin/lib/io.cjs:244` | always **1** | 25-value `ERROR_REASON` enum — **discarded at the boundary** |
| `output(payload)` | `src/io.cts` | always **0** | everything, but only to a caller that parses stdout |
| `ExitError(code, msg)` / `runMain` | `src/cli-exit.cts` | caller's choice | the only place a code is *chosen* |
| bare `process.exit(N)` | 276 sites | ad hoc | none |

### Conflation 1 — "did not run" is spelled the same as "ran and passed"

The three security scanners are the clearest instance, because their subject matter makes the cost
unambiguous:

```sh
# scripts/secret-scan.sh:238-239 — collect_files, --diff mode
git diff --name-only --diff-filter=ACMR "$base"...HEAD 2>/dev/null \
  | grep -vE '\.(png|jpg|…)$' || true
```

`2>/dev/null` discards the diagnostic and `|| true` discards the status. A bad base ref, a shallow
clone with no merge-base, a detached HEAD, or a non-repo cwd all produce an empty list that is
byte-identical to a genuinely empty diff. Twelve lines later:

```sh
# scripts/secret-scan.sh:330-333
if [[ -z "$files" ]]; then
  echo "secret-scan: no files to scan"
  exit 0
fi
```

**A secret scan that could not run reports clean.** The same three lines appear at
`scripts/base64-scan.sh:323-326` and `scripts/prompt-injection-scan.sh:252-255`.

Wire that to a capability gate — the sanctioned integration path — and the failure becomes a
verdict. `evaluateCommandExitZero` (`src/gate-predicate-evaluator.cts:134-140`) is total and correct
on its own terms:

```ts
if (res.exitCode === 0) {
  return { block: false, message: 'command exited 0', … };
}
```

The evaluator is not wrong. It is reading a one-bit channel that cannot express what it needs to
know. A scanner that examined zero files hands it a `0`, and it truthfully reports `block: false`.

The same shape appears in the check router, where the skip is stated in the payload and erased in
the exit code:

```js
// gsd-core/bin/lib/check-command-router.cjs:292
output({ passed: true, skipped: true, reason: 'CONTEXT.md missing',
         total: 0, covered: 0, uncovered: [],
         message: 'No CONTEXT.md - nothing to check.' }, raw, undefined);
```

`passed: true` for a gate that never evaluated anything, delivered with exit 0. Three sites
(`:279`, `:292`, `:321`) share it.

### Conflation 2 — a crash is spelled the same as an allow

Across the 19 source files in `hooks/`, `process.exit(0)` appears **94** times against **8**
`process.exit(2)`; only 6 of the 19 hooks contain any `exit(2)` at all. The dominant shape is an
outer fail-open catch:

```js
// hooks/gsd-read-guard.js:195-197 (the same block appears in 8 sibling hooks)
} catch {
  process.exit(0);
}
```

The hooks are candid about it — `hooks/gsd-read-guard.js:74` and `:87` and their siblings carry the
comment *"`catch { process.exit(0) }`: the same crash-to-allow this fix closes"*. Three shell hooks
(`gsd-phase-boundary.sh`, `gsd-session-state.sh`, `gsd-validate-commit.sh`) additionally run with no
`set -e` at all, so an unhandled failure mid-script falls through to whatever the last command
returned. [#3838](https://github.com/open-gsd/gsd-core/issues/3838) is the filed instance:
*gsd-validate-commit silently allows every command when node or the built scanner is unavailable.*

Fail-open is a defensible **policy** for some hooks — a guard that bricks a session on a transient
read error is worse than one that waves it through. What is not defensible is that the policy is
**unstated, unreviewable, and indistinguishable from success**. Nothing downstream can tell an
allow from a collapse, so nothing downstream can count collapses, alert on them, or fail a CI job
that experienced 40 of them.

### Conflation 3 — every failure reason collapses to `1`

`ERROR_REASON` (`gsd-core/bin/lib/io.cjs:174-209`) is a curated 25-value enum:
`CONFIG_KEY_NOT_FOUND`, `CONFIG_PARSE_FAILED`, `PHASE_NOT_FOUND`,
`WORKSTREAM_MODE_MARKER_UNRESOLVED`, `COMMIT_DOCS_GUARD_NOT_A_REPO`, `SECURITY_SCAN_FAILED`,
`USAGE`, … Its docstring says the enum exists *"so tests can assert against typed values instead of
grepping stderr."* Then:

```js
// gsd-core/bin/lib/io.cjs:236-245
function error(message, reason = ERROR_REASON.UNKNOWN, extra) {
    if (_jsonErrorMode) { … } else { writeAllSync(2, 'Error: ' + message + '\n'); }
    process.exit(1);
}
```

25 distinguishable conditions, one integer. The distinction survives only for a caller that opts
into `--json-errors` **and** parses stderr. Every shell caller — which is every workflow — sees `1`.
A caller cannot distinguish "your flag was misspelled" from "this repository is unreadable", and so
cannot retry the one and abort the other.

### Why the existing guards do not see any of this

The repo's answer to defect classes is a detector: 22 local ESLint rules and ~45 lint/drift scripts.
For this class, the detector is `n/no-process-exit` — and it is registered nowhere that matters.

1. **Hooks: explicitly off.** `eslint.config.mjs:582` sets `'n/no-process-exit': 'off'` for
   `hooks/**`, with a 20-line justification. The justification is *correct*: a hook's stdin-timeout
   guard fires from a `setTimeout` where nothing else terminates the process, so
   `process.exitCode = N; return;` is a behavior change, not a refactor. But the comment's own
   opening sentence — *"A hook is a standalone process whose ENTIRE contract is its exit code"* —
   is the argument **for** a typed exit seam, not against one. The surface where the exit code is
   the whole contract is the surface with zero enforcement over it.
2. **`src/**/*.cts`: never registered.** The `src` block (`eslint.config.mjs:348-404`) registers the
   `local` plugin only. `n` is not among its plugins and `n/no-process-exit` is not among its rules.
3. **`gsd-core/bin/lib/*.cjs`: globally ignored.** The rule *is* set to `'error'` on
   `gsd-core/bin/**/*.cjs` (`:478`) — but `gsd-core/bin/lib/io.cjs` is item 239 in the global
   `ignores` list as tsc output.

Net: the single most-executed exit site in the product, `error()`'s `process.exit(1)`, is invisible
to the rule that exists to govern it, from both directions at once. This is the same trap
[ADR-3473](3473-enforcement-by-construction.md) §B6 documents for `local/no-adhoc-markdown-parsing`
and `local/no-external-require-in-bin`.

The QA harness *does* see it, and is structurally forbidden from acting.
`tests/qa/oracles.cjs:574-598` defines the `soft-error-exit-zero` oracle, which fires on exactly
this shape. Per [ADR-2966](2966-loop-qa-walk.md) §5, `runOracles(ctx).failed` aliases `violations`
only and never includes `smells`, so the oracle **can never redden a build**. Four instances sit in
`tests/qa/smell-baseline.json` today, permanently.

### `2` is triple-booked

Three live protocols in this repo assign incompatible meanings to the same integer:

| Protocol | `2` means |
|---|---|
| Claude Code hook harness | **deny** the tool call |
| `scripts/*-scan.sh` | **usage error** (bad argv) |
| `gsd-test` (`CONTRIBUTING.md`) | **infra error** (dispatch failed) |

A wrapper that shells one into another — which `command-exit-zero` gates are designed to do — cannot
interpret `2` without knowing which protocol produced it.

### What this is not

It is **not** [ADR-3473](3473-enforcement-by-construction.md) §B4. That criterion — *"failure is a
value, not a shape"* — governs the **in-process return contract**: every routine that can fail
returns the hub's `Result = {ok,data} | {ok:false,kind,…}`. It stops at the function boundary. This
ADR governs the **process boundary**: what integer a terminating process hands its parent. The two
compose — §B4 produces the typed value, this ADR projects it — and neither substitutes for the other.
A perfectly §B4-compliant `Result` still exits 0 today, because nothing translates it.

## Decision

**Introduce one `Outcome` vocabulary, one pure projection to an integer, and two terminators that
share both. Make declaring an outcome mandatory; make the integer a policy that can be versioned.**

### 1. The vocabulary — six outcomes

```ts
const OUTCOME = Object.freeze({
  PASS:          'pass',           // ran, did the work, verdict affirmative
  FAIL:          'fail',           // ran, verdict negative — findings, drift, gate red
  USAGE:         'usage',          // caller error — bad argv, unknown command, missing arg
  NO_INPUT:      'no_input',       // ran, but ZERO units were in scope. Not a pass.
  UNAVAILABLE:   'unavailable',    // could NOT run — prerequisite absent, input unreadable
  INTERNAL:      'internal',       // self-failure — crash, timeout, killed subprocess
} as const);
```

`NO_INPUT` and `UNAVAILABLE` are the two that do the work; the other four already exist de facto.
The split between them is the load-bearing one and it is deliberately uncomfortable to author:

- `NO_INPUT` — *"I ran, my scope was empty, and I know the scope was genuinely empty."*
- `UNAVAILABLE` — *"I could not establish my scope."*

Today `secret-scan.sh` cannot tell these apart, because `2>/dev/null || true` destroyed the evidence
before the branch. Forcing the author to pick one is the point: it makes the missing error handling
a compile-time-visible gap rather than a silent third state hiding inside `NO_INPUT`.

### 2. The projection — `exitCodeFor(outcome)`

Pure, total, no I/O, no clock. The only function in the codebase permitted to produce an exit
integer.

| Outcome | Code | Basis |
|---|--:|---|
| `PASS` | `0` | universal |
| `FAIL` | `1` | universal |
| `USAGE` | `64` | `EX_USAGE` |
| `NO_INPUT` | `66` | `EX_NOINPUT` |
| `UNAVAILABLE` | `69` | `EX_UNAVAILABLE` |
| `INTERNAL` | `70` | `EX_SOFTWARE` |

**Why 64–78 and not 3–8.** Node reserves 1–13 for its own fatal conditions (3 = internal JS parse
error, 5 = fatal error, 9 = invalid argument, 13 = unfinished top-level await) and 128+N for signal
termination. A domain code in that band is ambiguous with a Node crash. 126/127 belong to the shell
(not executable / not found). The band 64–78 is the only wide gap left, and BSD `sysexits.h` already
assigns it mnemonic meanings that match ours almost exactly.

**Stated honestly:** the `sysexits(3)` *interface* is documented by FreeBSD as deprecated and its use
discouraged. We are not adopting the header, linking the symbols, or claiming conformance — we are
borrowing a collision-free numeric band and its established mnemonics so that a maintainer reading
`69` in a CI log has somewhere to look it up. If that band ever collides with something real, the
projection is one frozen table in one file.

**The fail-safe property, which is what makes this shippable.** Every new code is non-zero. Any
caller written as `if ! cmd; then` or `cmd && next` behaves *identically* for `PASS`, and for every
other outcome it now trips where it previously did not. **Adding this vocabulary can turn a false
green red. It can never turn a red green.** Compare [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md)'s
declined Option 3, which flipped `0 → 1` across a `CRITICAL` seam with 170 direct callers: the
objection there was Hyrum's Law over an observable exit-0 behavior. That objection is answered here
not by argument but by **scope** — see §5.

### 3. The seam — two terminators, one interface

The seam is the process boundary. `src/cli-exit.cts`'s `runMain` already sits exactly on it and is
the only existing construct shaped correctly. It is deepened, not replaced.

```ts
// Adapter A — drain-then-exit. For gsd-tools, scripts, generators.
//   Sets process.exitCode and lets the event loop drain: stdout flushes,
//   process.on('exit') cleanup fires. This is today's runMain, retyped.
runMain(main: () => Outcome | Promise<Outcome>): void

// Adapter B — write-then-terminate. For hooks ONLY.
//   fs.writeSync the payload, then process.exit(code) immediately. Required
//   because a hook's stdin-timeout guard fires from a setTimeout where nothing
//   else terminates the process, and because pipe writes are async on Windows
//   (hooks/gsd-write-guard.js:159-175).
terminateNow(outcome: Outcome, opts?: { stdout?: string; stderr?: string }): never
```

Two adapters, one interface, one projection. This is the design constraint
`eslint.config.mjs:563-582` correctly identified and that a naive "ban `process.exit` everywhere"
sweep would have broken. **`terminateNow` is the sanctioned `process.exit` call site** — there is
exactly one, and it is reviewed.

Hooks additionally get a `HOOK_DECISION` projection, because the Claude Code harness owns that
protocol and we do not: `ALLOW → 0`, `DENY → 2`, and — the new part — an outcome of `UNAVAILABLE`
or `INTERNAL` must resolve through a **declared** `onCrash: 'allow' | 'deny'` field rather than
falling into a bare `catch { exit(0) }`. Fail-open stays legal. Fail-open by accident does not.

### 4. Mandatory declaration, versioned projection

Two separately-gated things:

- **The `Outcome` is mandatory, immediately.** Every terminating path returns one. This is a pure
  refactor with no observable behavior change while the projection is pinned to v1, and it is what
  makes the codebase *correct* rather than merely *flagged*.
- **The integer is a policy.** `exitCodeFor` accepts a contract version. `v1` collapses everything
  except `PASS`/`USAGE` to today's codes (`NO_INPUT`/`UNAVAILABLE` → `0`, preserving ADR-2980's
  ratified behavior byte-for-byte). `v2` is the table above. Selected by
  `GSD_EXIT_CONTRACT=v2` / `--exit-contract=v2`, default `v1`, flipped to `v2` by default at the
  next major.

This is the compatibility boundary [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md)'s
"Revisit if" clause asks for verbatim: *"A future `gsd-tools` major version provides a compatibility
boundary that a CLI exit code otherwise lacks."*

**Exception — the security scanners flip to v2 immediately, ahead of the default.** They have no
ADR-2980 ratification, their callers are in-repo and enumerable, and "a scan that could not run
reports clean" is not a compatibility guarantee anyone is entitled to rely on.

### 5. Scope — what this ADR does *not* touch

The 60 `output({error: …})` sites ratified by [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md)
**keep exit 0 under v1 and are not rewritten by this epic.** Their `Outcome` is declared
(`NO_INPUT` for absent-artifact, `UNAVAILABLE` for unusable-input) so the information finally
exists, but the projection is pinned until the major. Reclassifying them is ADR-2980's own
"Revisit if" work and stays there.

This is the difference between this ADR and ADR-2980's declined Option 3: Option 3 proposed
flipping the exit code of a `CRITICAL` seam as its *first* act. This proposes building the type
first, flipping nothing, and letting the flip be a version bump years later if it happens at all.

## Consequences

**Good.**

- A scan that could not run is `69`, not `0`. That is the whole point and it is worth the rest of
  the cost on its own.
- The exit code becomes a *projection of a typed value* rather than a *display value re-derived per
  call site* — the same bug class as reusing a rendered string as an identity.
- `exitCodeFor` is a pure total function over a 6-value enum: exhaustively testable, and a natural
  `fast-check` bijection property (`CONTEXT.md` → property-based testing rule).
- `soft-error-exit-zero` and `untyped-success` stop being permanent SMELLs. Under a declared
  contract they become VIOLATIONs or they become unnecessary — either way the four frozen entries in
  `tests/qa/smell-baseline.json` leave.
- Fail-open hook policy becomes **declared and countable**. A CI job can assert that zero guards
  collapsed during a run, which today is unaskable.

**Costs, stated plainly.**

1. **This adds a concept.** Six outcome names are six things a contributor must learn, and the
   `NO_INPUT` / `UNAVAILABLE` distinction genuinely requires thought at each site. The mitigation is
   that it replaces an *undocumented* concept that contributors are already guessing at — 276 sites'
   worth — but the learning cost is real and new.
2. **The `NO_INPUT` / `UNAVAILABLE` split will be got wrong.** Some author will reach for `NO_INPUT`
   because the error handling to prove it is expensive. That is a lint target, not a design flaw,
   but it will happen and the guard for it does not exist yet.
3. **Two adapters is a real seam and must stay one.** If `terminateNow` and `runMain` ever grow
   independent projections, this becomes two contracts wearing one name — the exact failure this
   epic exists to fix, re-created inside the fix. A parity assertion test is mandatory
   (`CONTEXT.md` → generative-fix-divergence rule).
4. **`hooks/dist/**` doubles every hook edit.** The build seam (`scripts/build-hooks.js`,
   `npm run lint:hooks-runtime-build-seam`) already governs this, but the hook phases touch 19 files
   twice.
5. **Under v1 the epic delivers no observable behavior change** outside the three scanners. Most of
   the work is type plumbing whose payoff arrives at the major. That is the honest price of not
   breaking ADR-2980's ratified population, and it should be weighed before approving.

**Guard ledger** (per [ADR-3473](3473-enforcement-by-construction.md) §B6 — net guard count must
fall):

- **Retired:** the `soft-error-exit-zero` and `untyped-success` SMELL oracles and their four
  `smell-baseline.json` entries.
- **Retired:** `eslint.config.mjs:563-582`'s 20-line `n/no-process-exit: 'off'` exemption block and
  its prose justification — `terminateNow` satisfies the constraint the comment describes, so the
  exemption stops being needed.
- **Added:** one rule, `local/require-typed-exit`, replacing `n/no-process-exit` across all four
  surfaces with a single allowlisted call site.

Net: **−2 oracles, −1 exemption block, +1 rule.**

## Revisit if

- A fourth terminator appears that fits neither adapter (a long-running daemon, an MCP server). The
  projection still applies; the terminator set grows.
- The 64–78 band collides with a runtime we adopt. The projection is one frozen table.
- `NO_INPUT` proves undecidable in practice at more than a couple of sites — that would mean the
  distinction is wrong, not that the sites are lazy, and the vocabulary should shrink to five.

## References

- `src/io.cts` / `gsd-core/bin/lib/io.cjs:174-245` — `ERROR_REASON`, `error()`, `output()`
- `src/cli-exit.cts` — `ExitError`, `runMain` (the seam being deepened)
- `scripts/lib/cli-exit.cjs` — the drifted duplicate (Phase 0)
- `src/gate-predicate-evaluator.cts:101-151` — `evaluateCommandExitZero`
- `gsd-core/bin/lib/check-command-router.cjs:279,292,321` — `passed:true, skipped:true`
- `scripts/secret-scan.sh:238-239,330-333`, `scripts/base64-scan.sh:323-326`,
  `scripts/prompt-injection-scan.sh:252-255`
- `eslint.config.mjs:239,348-404,478,563-582` — the three-way enforcement gap
- `tests/qa/oracles.cjs:574-619`, `tests/qa/smell-baseline.json`
- Node.js docs → *Exit codes* (reserved 1–13; 128+N for signals)
- `sysexits(3)` — FreeBSD; band borrowed, interface not adopted
- [#3838](https://github.com/open-gsd/gsd-core/issues/3838) — the filed hook fail-open instance
