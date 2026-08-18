# ADR-3625: The platform seam keeps its own Windows binary resolution rather than adopting a spawn library

- **Status:** Accepted
- **Date:** 2026-08-18
- **Issue:** [#3625](https://github.com/open-gsd/gsd-core/issues/3625)
- **Epic:** [#3411](https://github.com/open-gsd/gsd-core/issues/3411) — evaluated against its Phase 1 ([#3621](https://github.com/open-gsd/gsd-core/pull/3621))
- **Scope:** `src/shell-command-projection.cts` subprocess dispatch (`execTool`, `execNpm`, `execGit`)
- **Amends:** none. Constrained by [ADR-0009](0009-shell-command-projection-module.md).

**Decision summary.** GSD Core keeps its own Windows binary resolution and `cmd.exe` mediation and
does **not** adopt `cross-spawn`, `nano-spawn`, or `execa`. `nano-spawn` is async-only and cannot
back a `spawnSync` seam. `cross-spawn` is the only structurally eligible candidate, and it
independently arrives at the *same* escaping mechanism the seam already uses — which validates the
approach rather than superseding it — but it resolves `process.cwd()` first on Windows, mutates
global state via `process.chdir()` during resolution, and would break an observable contract across
53 dependent files. The decision carries explicit revisit-if conditions so it is not simply inertia.

## Context

`#3625` asked whether GSD Core should stop hand-rolling Windows binary resolution — PATH + PATHEXT
scanning, the extensionless npm shim problem, `.cmd`/`.bat` mediation through `cmd.exe`, and
case-insensitive environment reads — and adopt a maintained library instead. The question is fair:
epic `#3411` exists precisely because we got this wrong four separate times, and
`/choose-boring-technology` is a real argument against re-deriving a known-hard problem.

This ADR records the evaluation and its outcome, so a future author finds the decision rather than
re-deriving it.

### What was actually compared

The baseline is **not** `next`. Epic `#3411` Phase 1 (PR `#3621`, open at the time of writing) adds
roughly **241 production lines** to the seam plus 672 lines of tests and a 55-line security-posture
document. That implementation already:

- resolves through `PATHEXT` entries only and **never** the bare name on win32 — the extensionless
  npm POSIX shim that is the confirmed root cause of `#3275`;
- reads `PATH`, `PATHEXT`, and `ComSpec` case-insensitively, because spreading `process.env` into a
  plain object loses the case-insensitive proxy;
- mediates `.cmd`/`.bat` through `cmd.exe` with an **explicit argv array**, never `shell: true`;
- builds the mediated command line **verbatim**, force-quoting every token inside one outer pair and
  passing `windowsVerbatimArguments: true` — the same shape Rust's standard library adopted for the
  sibling CVE-2024-24576;
- documents its residual `%VAR%` expansion limit rather than hiding it.

Candidates were scored against *that*, not against a naive `spawnSync(name, args)`.

## Two premises in the issue that measurement did not support

Recorded because both are load-bearing in the original argument.

**1. The blast-radius figure is measured in the wrong direction.** The issue cites `get_impact`
depth 4 reporting 167 affected symbols across 53 files, rated **CRITICAL**, as the reason a
sync → async conversion "is a far larger epic than `#3411`". That figure is `direction: both`
(re-measured 2026-08-18: 168 symbols, 53 files, `total_affected_is_lower_bound: true`), and it is
inflated by **downstream callees** — the functions `execTool` calls. A call-shape change does not
ripple downstream; it ripples to **callers**. Measured upstream and transitively:

| Query | Result | Rating |
|---|---|---|
| `get_impact(execTool, direction=both, depth=4)` | 168 symbols / 53 files, truncated, lower-bound | CRITICAL |
| `get_impact(execTool, direction=upstream, depth=15)` | **14 symbols / 7 files / 6 flows**, terminates at depth 4, not truncated | **MEDIUM** |

The honest sync → async ripple for `execTool` is 14 symbols across 7 files, and it closes at depth 4
(`mcp-server.cts::runServer`). That is a real cost but it is not epic-scale, and the decision below
does **not** rest on the CRITICAL figure.

**2. The vendoring precedent exists, but not at the cited path.** The issue points at
`eslint-rules/lib/vendor/re2js.cjs`; that path does not exist. The real vendored copy is
`gsd-core/bin/lib/vendor/re2js.cjs` (with `src/vendor/re2js.d.cts`). The precedent stands — it was
simply mislocated.

## Candidate evaluation

Registry metadata read from `registry.npmjs.org` on 2026-08-18; behavior read from published
package source at the versions named.

### Maturity axes

| Axis | `cross-spawn` 7.0.6 | `nano-spawn` 2.1.0 | `execa` 10.0.1 |
|---|---|---|---|
| Adoption (weekly downloads) | 201.7 M | 3.9 M | 135.9 M |
| Age (first publish) | 2014-06-30 | 2024-08-19 | 2015-12-05 |
| Latest release | **2024-11-18 (~21 months ago)** | 2026-04-01 | 2026-07-31 |
| Release cadence | 58 versions; dormant since the CVE burst | 10 versions; steady | 66 versions; steady |
| Backing | single maintainer (`satazor`) | `sindresorhus`, `ehmicky` | `sindresorhus`, `ehmicky` |
| Interface stability | stable, effectively frozen | 2.x, young | 10.x, actively evolving |
| License | MIT | MIT | MIT |
| Module format | **CommonJS** | ESM-only | ESM-only |
| Node engines | `>= 8` | `>= 20.17` | `>= 22` |
| Transitive footprint (measured) | **6 packages, 160 KB** | **1 package, 76 KB** | **18 packages, 1.4 MB** |
| Prior security advisory | **CVE-2024-21538** (ReDoS, High, CVSS 7.7) in the escaping regex; fixed 7.0.5 / 6.0.6 | none found | none found |

For context, GSD Core currently ships **two** runtime dependencies
(`@anthropic-ai/claude-agent-sdk`, `ws`) plus one optional (`fallow`).

### Verdict 1 — synchronous call shape

The seam is `spawnSync` throughout. A candidate without a synchronous shape is structurally
disqualified regardless of its other merits.

| Candidate | Sync? | Evidence |
|---|---|---|
| `cross-spawn` | **Yes** | `index.js` exports `module.exports.sync = spawnSync`, wrapping `cp.spawnSync` |
| `nano-spawn` | **No** | Its own README lists "synchronous execution" among the features `execa` has and it does not; the API is Promise/`AsyncIterable` throughout |
| `execa` | **Yes** | `execaSync()` / `$.sync()`, though execa's own docs state synchronous execution "is generally discouraged as it holds the CPU and prevents parallelization", and it drops streams, IPC, piping, and signal-based termination |

`nano-spawn` — the library the issue leads with — is **async-only** and therefore cannot back this
seam without the sync → async conversion the issue itself sets aside. That is settled by the
package's own documentation, not by inference.

### Verdict 2 — CVE-2024-27980 argument-escaping posture

The class is argument injection through `.bat`/`.cmd` on Windows, whose mechanism is `shell: true`
and unquoted `cmd.exe` metacharacters.

| Candidate | Uses `shell: true`? | Mechanism | Verdict |
|---|---|---|---|
| `cross-spawn` | **No** | Resolves the command, then when the target is not `.com`/`.exe` rewrites to `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments: true`; arguments are quoted, backslash-doubled, then caret-escaped across cmd's metacharacter set (parentheses, brackets, percent, bang, caret, quote, backtick, angle brackets, ampersand, pipe, semicolon, comma, space, star, question mark) | **Safe against the class.** Note this is *the same mechanism* PR `#3621` implements |
| `nano-spawn` | No | Documents `.cmd`/`.bat` and `PATHEXT` support without a shell | Not applicable — disqualified on sync |
| `execa` | **No** | Its Windows documentation states "Execa does not require a shell (nor a `cmd.exe /c` prefix) for this" and resolves missing extensions via `PATHEXT` | Safe against the class |
| **hand-rolled (`#3621`)** | **No** | Explicit `cmd.exe` argv array; every token force-quoted inside one outer pair; `windowsVerbatimArguments: true`; CR/LF rejected rather than silently truncated | Safe against the class |

**The most important result of this spike is that no candidate is safer than what we built.**
`cross-spawn` — the ecosystem's most-deployed answer, at 201 M weekly downloads — arrives at the
identical mechanism: `cmd.exe /d /s /c` with a pre-escaped line and `windowsVerbatimArguments: true`.
Independent convergence on the same primitive **corroborates** the seam's approach — it does not by
itself establish correctness, and no Windows execution was performed here — but it does convert "we
hand-rolled it" into "we hand-rolled it, and the most-used library in the ecosystem reached the same
primitive independently."

### Verdict 3 — Windows resolution semantics

This is where the candidates and the seam actually diverge, and it decides the recommendation.

| Property | `cross-spawn` | hand-rolled (`#3621`) |
|---|---|---|
| Bare extensionless name tried on a dotless command? | **No** — `which`'s `getPathInfo` prepends the empty extension only when the command contains a dot, so `codex` probes `.EXE`/`.CMD`/`.BAT`/`.COM` and resolves `codex.CMD`. `#3275` is **not** reproduced | No, by explicit design |
| `process.cwd()` searched? | **Yes, first, on Windows — unconditionally, even when an explicit `PATH` is supplied** (`which`'s `pathEnv` prepends `process.cwd()` before `opt.path`) | **No** — PATH only |
| Global process state mutated during resolution? | **Yes** — calls `process.chdir()` when `options.cwd` is set, restoring in `finally`; disabled in worker threads | No |
| Escape depth | Heuristic: double-escapes metacharacters only when the resolved path matches `node_modules[\\/].bin[\\/][^\\/]+\.cmd$` | No degree of freedom — every token force-quoted once |
| `%VAR%` expansion inside the mediated line | Attempts to caret-escape `%` and `!` | Not escaped; **documented** as a known limit |

Three of these are adoption blockers on their own:

1. **`process.cwd()`-first resolution is a binary-planting surface.** A `codex.CMD` dropped in the
   project directory would win over the real one on Windows, and passing an explicit `PATH` does not
   prevent it. GSD executes tool binaries in directories whose contents are, by construction, the
   thing being worked on. The seam scans `PATH` only, deliberately.
2. **`process.chdir()` is a global side effect** in a function billed as a drop-in. `execTool`
   accepts `opts.cwd`, GSD runs concurrent work, and `process.chdir` is unavailable in worker
   threads.
3. **The escape-depth heuristic is keyed on a path regex** — structurally the same shape as the
   `/\.(cmd|bat)$/i` test in `bin/gsd-tools.cjs` that `#3411` identified as never matching. A
   cmd-shim outside `node_modules/.bin/` gets single-escaped.

The one axis where `cross-spawn` may do better is `%VAR%`: it attempts to caret-escape `%` and `!`,
where the seam does not and documents the gap. Whether `^%` actually suppresses expansion is
contested — `cmd.exe` performs percent-expansion before caret processing — and settling it requires
executing on Windows, which this spike did not do. Recorded as **unresolved, narrow, and
information-disclosure-only**, not as a reason to adopt.

## Observable-contract cost (Hyrum's Law)

`execTool` has 53 dependent files. Its observable behavior includes the **declared** program name
stamped into `` `${program}: not found` ``, `exitCode: 127` on not-found, and — per PR `#3621` —
`spawnSync`'s first argument, pinned by a spy in `tests/graphify.test.cjs`. Adopting `cross-spawn`
changes all three: it passes `cmd.exe` or a resolved absolute path as argument 0, and it signals
not-found by setting `result.error` from `verifyENOENTSync` rather than through the exit-127 shape
the seam's callers match on. This is a breaking change to a contract 53 files consume, in exchange
for behavior we already have.

## Forever-cost of adopting

What we could never remove once it landed:

- **The upstream.** `cross-spawn` has had no release since 2024-11-18 and has one maintainer. Its
  one security advisory to date was in exactly the code we would be depending on. Adopting a dormant
  single-maintainer package for a security-sensitive path means we would likely be the ones fixing
  the next issue anyway — with a fork or a patch, on someone else's schedule.
- **The dependency graph.** 2 runtime dependencies become 8 (`cross-spawn`, `which`, `isexe`,
  `path-key`, `shebang-command`, `shebang-regex`) — a 4× increase in runtime supply-chain surface
  for a tool whose own `docs/explanation/security-model.md` opens on supply-chain risk. `execa`
  would make it 20.
- **The matrix.** We would still test Windows behavior ourselves, because the observable contract is
  ours, not the library's.

### The vendoring option, considered separately

The issue notes in-tree precedent for taking a third party into `bin/lib` "when the case is made."
The precedent is real, though not at the cited path — it is `gsd-core/bin/lib/vendor/re2js.cjs`
(with `src/vendor/re2js.d.cts`), not `eslint-rules/lib/vendor/`. It is also not free:
`scripts/lint-vendored-deps.cjs` exists specifically to keep the vendored copy pinned to its
`node_modules` original, and it runs in `lint:ci`.

Vendoring is rejected here regardless of which candidate. It keeps the maintenance burden, adds a
drift gate, and forfeits the one thing a dependency is actually for — upstream security fixes
arriving without our involvement. For a path whose only historical advisory was a CVE in the
escaping code, that is the worst of the three options.

### Partial adoption: take the escaping, keep our resolution

The objections above are aimed at `cross-spawn` as a whole, and it is fair to ask whether the good
half can be taken without the bad. It is technically possible: `cross-spawn` publishes `lib` and
declares **no `exports` map**, so `require('cross-spawn/lib/util/escape')` resolves today. That would
import the escaping the ADR praises while keeping the seam's PATH-only resolution, sidestepping both
the `process.cwd()`-first lookup and the `process.chdir()` side effect.

Rejected, for reasons that are genuinely different from the full-adoption ones:

1. **It is a deep import into an undocumented internal path.** The absence of an `exports` map is
   what makes it reachable, not a promise that it is public. Adding an `exports` map is a routine
   change that would break us silently, and on a dormant upstream we would be pinned at a version to
   avoid it — which reintroduces the vendoring problem without the drift gate.
2. **The two escaping strategies are not drop-in interchangeable.** `escape.argument` is designed to
   pair with `cross-spawn`'s own line assembly — escape the command, escape each argument, join on
   spaces, wrap once. Our seam force-quotes each token instead. Taking one function without its
   assembly would be a re-derivation wearing a dependency's clothes, which is the precise failure
   mode `#3411` exists to end.
3. **It still costs six packages for roughly forty lines**, and the only behavioral delta it buys is
   the `%`/`!` caret-escaping — the one axis this ADR records as *unresolved*. Paying a permanent
   supply-chain cost to import a contested improvement is the wrong trade.

If the `%VAR%` question is ever resolved in `cross-spawn`'s favor, the cheap move is to port that one
behavior into the seam under our own test, not to take the dependency for it.

## Decision

**Stay hand-rolled.** The seam keeps ownership of Windows binary resolution and `cmd.exe` mediation
as implemented by epic `#3411`.

This is not "we already wrote it." It rests on measured properties:

1. No candidate is **safer** — `cross-spawn` independently arrives at the identical escaping
   mechanism, which validates the seam's approach rather than superseding it.
2. The only structurally-eligible candidate (`cross-spawn`; the others fail on sync or on footprint)
   is **less safe on Windows resolution** — `process.cwd()`-first lookup and a `process.chdir()`
   side effect — and carries an escape-depth heuristic of the same fragile shape `#3411` was filed
   to eliminate.
3. Adoption **breaks an observable contract** across 53 files in exchange for behavior already
   present.
4. It quadruples the runtime dependency graph, on a dormant single-maintainer upstream, for a
   security-sensitive path.

`/choose-boring-technology`'s first step is "solve the problem with what you have." Here that is
`node:child_process` plus resolution logic that is written, tested, documented, and contract-bound.
The boring choice and the hand-rolled choice are the same choice.

**Conditions attached.** A bare keep-verdict is what allowed four divergent implementations to grow.
This decision holds only while:

- resolution and mediation stay **in the seam**, with the three ad-hoc copies deleted by `#3411`
  Phases 2–3, not kept in sync;
- the guard from `#3411`'s goal list — rejecting a `spawn`/`execFile` of a bare binary name outside
  the seam — actually lands, alongside the existing `eslint-rules/no-unbounded-spawn.cjs`,
  `no-bare-npm-exec.cjs`, `no-unguarded-nonportable-exec.cjs`, and `require-subprocess-timeout.cjs`;
- the Windows CI lane keeps covering the mediated path.

If those erode, the argument for owning this code erodes with them.

### Revisit if

- The seam needs an **asynchronous** dispatch shape for an unrelated reason. The sync constraint is
  what disqualifies `nano-spawn` and most of `execa`'s value; if it lifts, re-run this comparison —
  the honest ripple is 14 symbols across 7 files, not 168.
- `cross-spawn` resumes releases **and** gains a way to disable `process.cwd()`-first resolution.
- A maintained, CommonJS-requirable, `spawnSync`-shaped library appears that does PATH-only
  resolution with no global side effects.
- Node's own `child_process` gains first-class `.cmd`/`.bat` resolution making all of this dead code
  — the outcome that would let us delete rather than delegate.

## Consequences

- `#3411` Phases 2 and 3 proceed unchanged. This ADR was explicitly scoped not to block them, and
  nothing measured here changes their work.
- The seam's `CONTEXT.md` entry gains a pointer to this ADR, so the next author who wonders "why
  didn't we just use `cross-spawn`?" finds the answer instead of re-deriving it.
- We continue to own this code, including the next Windows defect in it. That is the accepted cost,
  and it is smaller than the alternatives measured above.
- The `%VAR%` question is left open and documented. If it is ever worth closing, the fix is ours to
  make in one place.

## Known limits of this evaluation

- The baseline is PR `#3621`, which was **open and unmerged** on 2026-08-18. If it changes materially
  before merge, the comparison's baseline moves with it.
- **No Windows execution was performed.** Every Windows claim here comes from reading published
  package source and official documentation, not from running the candidates on Windows. The `%VAR%`
  question is the one place where that limit is load-bearing, and it is flagged as unresolved above.
- Registry metadata is a point-in-time reading; maintenance judgments age.

## References

- Spike issue: `#3625`
- Epic: `#3411`; Phase 1 PR: `#3621`; confirmed instances `#3275`, `#3329`
- Seam ADR: [ADR-0009](0009-shell-command-projection-module.md)
- Security posture: `docs/explanation/security-model.md` — note the **subprocess-execution** section
  cited above is not on `next` at the time of writing; it lands with PR `#3621`
- `cross-spawn` 7.0.6 — `index.js`, `lib/parse.js`, `lib/util/escape.js`, `lib/util/resolveCommand.js`;
  `which` 2.x `which.js` (`getPathInfo`)
- CVE-2024-21538 (`cross-spawn` ReDoS, High/7.7, patched 7.0.5 & 6.0.6) —
  <https://github.com/advisories/GHSA-3xgq-45jj-v275>
- `nano-spawn` 2.1.0 `readme.md` (execa comparison section); `execa` 10.0.1 `docs/execution.md`,
  `docs/windows.md`
- CVE-2024-27980 (Node.js Windows `.bat`/`.cmd` argument injection); CVE-2024-24576 (Rust std,
  sibling class); Node.js DEP0190 (`shell: true` with an args array)
