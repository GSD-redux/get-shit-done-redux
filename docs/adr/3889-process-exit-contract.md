# ADR-3889: One exit-code registry — 0 and 1 are free, everything else is allocated

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-08-26 |
| **Issue** | [#3889](https://github.com/open-gsd/gsd-core/issues/3889) |
| **Supersedes** | — |
| **Amends** | [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md) — supplies the compatibility boundary its "Revisit if" clause names |
| **Constrained by** | [ADR-2966](2966-loop-qa-walk.md) §5–§7, [ADR-2008](2008-command-exit-zero-gate.md), [ADR-1411](1411-resolution-provenance.md), [ADR-3473](3473-enforcement-by-construction.md) §B4 |

> **Evidence note.** Every count here is an **AST census** (`@typescript-eslint/parser`, `CallExpression`
> where `callee.object.name === 'process' && callee.property.name === 'exit'`), not a grep. A grep of
> `process\.exit` over-counts by roughly 2×: it matches comment prose (the hooks discuss
> `catch { process.exit(0) }` in their own comments) **and** it matches `process.exitCode`, which is
> the *correct* pattern. Behavioral claims below were executed, each with a control.

## Context

### What is actually true (measured, not inferred)

**128 real `process.exit()` call sites** (143 raw, less 15 `gsd-core/bin/lib/*.cjs` sites that are
tsc output of the `src/*.cts` originals). They are not evenly spread:

| Surface | Sites | Shape |
|---|--:|---|
| `hooks/**` | **91** | 83 × `exit(0)`, 8 × `exit(2)` |
| `bin/install.js` | 18 | generated installer |
| `src/**/*.cts` | 15 | mixed, incl. 4 ternaries |
| `bin/` other | 2 | |
| `scripts/**` | **1** | |
| `gsd-core/bin/gsd-tools.cjs` | 1 | |

Against that, **`process.exitCode` is assigned 88 times** — `src` 25, `scripts` 39, `gsd-core` 24,
`hooks` **0**.

Two conclusions follow, and both contradict the obvious framing:

1. **This repo already has an exit seam and already adopted it.** `src/cli-exit.cts`'s `runMain` +
   `ExitError` is the owner. `scripts/` runs **39 `exitCode` assignments to 1 `process.exit`** — that
   surface is done. The migration is not missing; it is *incomplete*, and it stopped at `hooks/`.
2. **71% of the remaining problem is one directory.** `hooks/` has zero `exitCode` usage, and for a
   sound reason recorded at `eslint.config.mjs:563-582`: a hook's stdin-timeout guard fires from a
   `setTimeout` where `process.exitCode = N; return;` terminates nothing. The seam has no adapter for
   the one surface whose entire contract *is* the exit code.

### The real defect: codes are invented locally, so the same number means four things

`src/ui-safety-gate.cts:137` states its contract in a comment:

```
// Exit 0 = UI found, 1 = no UI, 2 = startup error.
```

`0` and `1` are exactly right — pass and fail are universal. The third code is the problem: it was
**invented at the module**, and four other things in this repo also invented `2`:

| Emitter | `2` means |
|---|---|
| Claude Code hook harness | **deny** the tool call |
| `scripts/{secret,base64,prompt-injection}-scan.sh` | **usage error** (bad argv) |
| `gsd-test` (foreign repo) | **infra error** (dispatch failed) |
| `ui-safety-gate` / `api-coverage` / `assumption-delta` | **startup error** (stdin read failed) |

A wrapper that shells one into another — precisely what a `command-exit-zero` gate
([ADR-2008](2008-command-exit-zero-gate.md)) does — cannot interpret `2` without out-of-band
knowledge of which program produced it. Four modules independently reinvented the same
three-outcome convention (`ui-safety-gate`, `api-coverage`, `assumption-delta`, `teams-status`),
each documenting it only in a comment. **The convention exists; what is missing is an allocator.**

### The failures this produces, executed with controls

**(a) An empty input is reported as an authoritative negative verdict.** These gates' `exit(2)` arm
is bound to `stdin.on('error')` only. There is no arm for *stdin closed with zero bytes*:

```console
$ printf 'Build a React component with a button' | node gsd-core/bin/lib/ui-safety-gate.cjs; echo $?
0                       # control — UI found
$ printf '' | node gsd-core/bin/lib/ui-safety-gate.cjs; echo $?
1                       # "no UI" — but nothing was examined
$ printf '' | node gsd-core/bin/lib/api-coverage.cjs; echo $?
1                       # "no API integration" — same
```

An unset `$PHASE_SECTION` makes the UI safety gate assert that the phase has no UI.

**(b) A scan that could not run reports clean.**

```console
$ bash scripts/secret-scan.sh --diff origin/next;                 echo $?
secret-scan: scanned 2 files, 0 with findings
0                       # control
$ bash scripts/secret-scan.sh --diff refs/heads/does-not-exist;   echo $?
secret-scan: no files to scan
0                       # ← could not compute a diff
$ cd /tmp/not-a-repo && bash …/scripts/secret-scan.sh --diff origin/next; echo $?
secret-scan: no files to scan
0                       # ← not a git repository
```

`collect_files` (`scripts/secret-scan.sh:238-239`) ends `2>/dev/null || true`, which discards the
diagnostic and the status. Identical three lines at `base64-scan.sh:323-326` and
`prompt-injection-scan.sh:252-255`.

**(c) A failed probe fabricates a specific negative verdict.** Nine shell sites use
`… 2>/dev/null || echo '<json>'`. They split into two classes, and **the honest form already exists
in this repo**:

| Form | Site | Says |
|---|---|---|
| honest | `execute-phase/steps/codebase-drift-gate.md:19` | `{"skipped":true,"reason":"sdk-failed"}` |
| honest | `plan-phase.md:536` | `{"skipped":true}` |
| **fabricated** | `capabilities/ai-integration/fragments/api-coverage-plan-pre.md:25,114` | `{"detected":false,…}` |
| **fabricated** | `capabilities/assumption-delta/fragments/plan-pre.md:14` | `{"detected":false,…}` |

The fabricated form does not degrade — it asserts that no API integration exists, and that assertion
feeds the **blocking** `api-coverage.verify-pre` gate. A phase can ship without its COVERAGE.md
matrix because the detector failed to launch.

**(d) 25 failure reasons collapse to `1`.** `ERROR_REASON` (`src/io.cts:180-215`) is a curated
25-value enum whose docstring says it exists *"so tests can assert against typed values instead of
grepping stderr."* `error()` (`src/io.cts:246-254`) ends `process.exit(1)` unconditionally. Note the
symmetric fact: `output()` (`src/io.cts:144-168`) **never touches the exit code at all** — it writes
to fd 1 and returns. The `0` a caller observes is not a decision anyone made; it is the absence of
one.

### Why the existing guard cannot see it — proven, with a positive control

```console
# positive control: the rule works
$ printf "process.exit(0);" > scripts/_probe.cjs && npx eslint --no-cache scripts/_probe.cjs
  n/no-process-exit fired: 1

$ npx eslint --no-cache src/io.cts             # contains process.exit(1) at :253
  n/no-process-exit fired: 0
$ npx eslint --no-cache gsd-core/bin/lib/io.cjs
  "File ignored because of a matching ignore pattern"
$ npx eslint --no-cache hooks/gsd-read-guard.js
  n/no-process-exit fired: 0
```

Three independent reasons, all live at `next`: `'off'` for `hooks/**` (`eslint.config.mjs:582`);
never registered on `src/**/*.cts` (that block loads only the `local` plugin); and `'error'` on
`gsd-core/bin/**/*.cjs` (`:478`) but `gsd-core/bin/lib/io.cjs` is item **239** in the global
`ignores` list. The most-executed exit site in the product is invisible to its own rule.

## Decision

**`0` and `1` are free. Every other exit code is allocated from one registry.**

### 1. The bands

| Range | Rule |
|---|---|
| `0` | **Free.** Pass — the operation ran and its verdict is affirmative. |
| `1` | **Free.** Fail — the operation ran and its verdict is negative. |
| `2` | **Reserved to the Claude Code hook protocol** (deny). Emittable *only* by the hook adapter. No other GSD code may produce it. |
| `3`–`13` | **Forbidden.** Node reserves these (3 = internal JS parse error, 5 = fatal error, 9 = invalid argument, 13 = unfinished top-level await). A domain `3` is ambiguous with a Node crash. |
| `64`–`78` | **Generic entries**, aligned to `sysexits.h` mnemonics where they fit. |
| `80`–`125` | **Domain entries**, allocated per tool. |
| `126`, `127`, `128+N` | Shell (not executable / not found) and signals. Not ours. |

A tool that only needs pass/fail registers nothing. The moment it needs to say anything **more
specific** than pass/fail, it takes a number from the registry — because a locally-invented number
is exactly how `2` came to mean four things.

### 2. The registry is the database

One generated source of truth, following the pattern this repo already uses for
`capability-registry.cjs`, the model catalog, and the ADR index — a declaration per owner, a
generator, and a `--check` gate in `lint:generated-sync`.

Every entry carries: **code**, **symbolic name**, **meaning**, **owning module**, and the **issue or
ADR that authorized it**. Two invariants the generator enforces by failing the build:

- **One number, one meaning.** A second declaration of an allocated code is a hard error. This is the
  invariant whose absence produced the four-way `2`.
- **One owner.** A code is emitted only by its declaring module. A second emitter is a hard error —
  that is how a generic code silently acquires a second meaning.

Generic entries seeded from the measured population:

| Code | Name | Meaning |
|--:|---|---|
| `64` | `USAGE` | Caller error — bad argv, unknown subcommand, missing argument |
| `66` | `NO_INPUT` | Ran; **zero units were in scope**, and that emptiness is known to be genuine |
| `69` | `UNAVAILABLE` | **Could not run** — prerequisite absent, input unreadable, scope unestablished |
| `70` | `INTERNAL` | Self-failure — crash, timeout, killed subprocess |

`NO_INPUT` versus `UNAVAILABLE` is the distinction the failures in (a) and (b) collapse, and it is
deliberately uncomfortable to author: emitting `NO_INPUT` honestly requires proving the scope was
established, which means deleting the `2>/dev/null || true` that currently destroys the evidence.
That cost **is** the missing error handling.

**Domain entries are permitted** and are the reason this is a registry rather than an enum. A tool
with a genuinely tool-specific outcome registers it (`80`+) with an owner and a justification,
rather than reaching for a generic code that nearly fits. The `80`–`125` band bounds this at 46
entries; needing more would itself be a finding.

**`sysexits` honestly:** FreeBSD documents the `sysexits(3)` *interface* as deprecated. We adopt
neither the header nor conformance to it — we borrow a collision-free band and its established
mnemonics so `69` in a CI log has somewhere to be looked up.

### 3. Two terminators over one registry

The seam is the process boundary. `src/cli-exit.cts` already sits on it and is deepened, not
replaced:

- **`runMain(main)`** — drain-then-exit. Sets `process.exitCode`; stdout flushes and
  `process.on('exit')` handlers fire. Today's behavior, retyped. Serves `gsd-tools`, `scripts/`,
  generators — the 88 sites already doing this.
- **`terminateNow(outcome)`** — write-then-terminate. `fs.writeSync` then immediate `process.exit`.
  Required for `hooks/`, per the constraint `eslint.config.mjs:563-582` documents correctly and per
  `hooks/gsd-write-guard.js:159-175` (pipe writes are async on Windows). **This is the only
  sanctioned `process.exit` call site in the repo, and the only place `2` can be produced.**

Both project through the same registry lookup. A parity assertion test is mandatory — two
terminators with independent projections would re-create this ADR's defect inside its own fix
(`CONTEXT.md` → generative-fix-divergence).

### 4. Declaration is mandatory; the projection is versioned

- **Declaring an outcome is mandatory immediately.** Every terminating path names one. Under `v1`
  the projection reproduces today's integers exactly, so this is a pure refactor.
- **The integers are policy.** `v1` pins [ADR-2980](2980-payload-carried-error-is-a-degraded-result.md)'s
  60 ratified `output({error})` sites to exit 0 byte-for-byte. `v2` applies the registry. Selected by
  `GSD_EXIT_CONTRACT=v2` / `--exit-contract=v2`; default flips at the next major.

This is the compatibility boundary ADR-2980's "Revisit if" clause asks for verbatim.

**Exception — these flip to `v2` immediately**, because no ADR ratified them and their callers are
in-repo and enumerable: the three shell scanners, and the four gate modules' empty-input arm.

### 5. The fail-safe property

Every registered code is non-zero. A caller written `if ! cmd; then` or `cmd && next` behaves
**identically** for pass and trips for everything else. **This can turn a false green red; it can
never turn a red green.** That is what makes it shippable across a surface with 170 direct callers,
and it is the property ADR-2980's declined Option 3 lacked.

## Consequences

**Good.**

- One number, one meaning, machine-enforced. The four-way `2` becomes unrepresentable rather than
  merely documented.
- Four modules' hand-rolled convention consolidates onto one allocator — a consolidation, not a
  greenfield concept.
- A scan that could not run exits `69`, not `0`. A gate handed empty input says so instead of
  asserting a verdict.
- `exitCodeFor` is a pure total function over a closed table: exhaustively testable, and a natural
  `fast-check` bijection property.
- `soft-error-exit-zero` and `untyped-success` stop being permanent SMELLs, and their four frozen
  `tests/qa/smell-baseline.json` entries leave.

**Costs, stated plainly.**

1. **A registry is a governance surface.** Someone must review allocations, or `80`+ fills with
   near-duplicates and callers end up looking up codes that all mean "something went wrong". The
   generic four exist to absorb most cases; if domain allocations outpace them, the grain is wrong.
2. **The `NO_INPUT` / `UNAVAILABLE` split will be got wrong.** An author will reach for `NO_INPUT`
   rather than pay for the proof. That is a lint target that does not exist yet, and I do not have a
   design for one that is not itself a fingerprint-of-the-last-bug detector.
3. **`hooks/` is 71% of the work** and every hook edit doubles through `hooks/dist/**` via the build
   seam.
4. **Retiring `2` from `ui-safety-gate`, `api-coverage`, `assumption-delta`, `teams-status` and the
   three scanners changes observable behavior** for anything that pattern-matched on `2`.
5. **Under `v1`, most phases deliver no observable change.** The payoff is at the major. That is the
   price of not breaking ADR-2980's population.

**Guard ledger** (per [ADR-3473](3473-enforcement-by-construction.md) §B6 — net count must fall):
**retired** the two SMELL oracles and their four baseline entries, the 20-line
`n/no-process-exit: 'off'` exemption block, and the duplicated `scripts/lib/cli-exit.cjs`;
**added** one rule (`local/require-registered-exit`) plus the registry's own `--check`. Net **−2**.

## Revisit if

- Domain allocations exceed roughly a dozen. That means the generic four are wrong, not that the
  band is too small.
- A runtime we adopt collides with `64`–`125`. The projection is one generated table.
- `NO_INPUT` proves undecidable at more than a couple of sites — the distinction would be wrong, not
  the sites lazy.

## References

- `src/io.cts:144-168` (`output`, touches no exit code), `:180-215` (`ERROR_REASON`), `:246-254` (`error`)
- `src/cli-exit.cts` — the seam being deepened; `scripts/lib/cli-exit.cjs` — its drifted duplicate
- `src/ui-safety-gate.cts:137,149,154` — the convention stated in a comment
- `src/api-coverage.cts:977,981`, `src/assumption-delta.cts:248,253`, `src/teams-status.cts:88`
- `scripts/secret-scan.sh:238-239,330-333`; `base64-scan.sh:323-326`; `prompt-injection-scan.sh:252-255`
- `capabilities/ai-integration/fragments/api-coverage-plan-pre.md:25,114`;
  `capabilities/assumption-delta/fragments/plan-pre.md:14` — fabricated verdicts
- `gsd-core/workflows/execute-phase/steps/codebase-drift-gate.md:19` — the honest form, already in-tree
- `eslint.config.mjs:239,348-404,478,563-582`
- `tests/qa/oracles.cjs:574-619`, `tests/qa/smell-baseline.json`
- Node.js docs → *Exit codes* (1–13 reserved; 128+N signals); `sysexits(3)` — band borrowed, interface not adopted
- [#3838](https://github.com/open-gsd/gsd-core/issues/3838) — the filed hook fail-open instance
