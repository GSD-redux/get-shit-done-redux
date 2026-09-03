# ADR-1703: Cross-platform portability enforcement as AST ESLint rules

- **Status:** Accepted
- **Date:** 2026-06-25 (Phase 0); **Accepted 2026-06-26** (Phase 7 closeout — all phases shipped)
- **Issue:** [#1703](https://github.com/open-gsd/gsd-core/issues/1703) — Phase 0 of epic [#1702](https://github.com/open-gsd/gsd-core/issues/1702)
- **Supersedes:** the regex-based `scripts/lint-windows-test-portability.cjs`, the
  `tests/windows-test-parity-guard.test.cjs` named-set ratchet (G1–G6), the
  `// windows-portability-ok:` comment convention, and `scripts/lib/allowlist-ratchet.cjs`
  usage for portability classes.

## Context

GSD must run correctly when installed and run on Windows (backslash paths, `C:\`,
`cmd`/PowerShell, no `/bin/sh`, DOS file modes, `\r\n`), not just macOS/Linux. `CONTEXT.md`
documents a `DEFECT.WINDOWS-*` taxonomy of failure shapes that recur and ship to the
`windows-latest` CI lane undetected because the local `gsd-test` gate is Mac/Linux only.

Enforcement accreted as **three incompatible, hand-rolled mechanisms**:

1. **`scripts/lint-windows-test-portability.cjs`** — today a narrow regex *tripwire* for the
   chmod exec-bit + `sh`/`bash -c` shape, with a `windows-portability-ok` opt-out matched against
   the whole source. This epic was seeded (#1694) by an attempt to *extend* this script to the
   path-literal-in-assert shape; adversarial review of that extension found a regex that
   *silently could not match `deepStrictEqual`*, loose normalizer recognition (false negatives),
   and hand-rolled balanced-paren-splitting fragility — so the extension was **abandoned** in
   favour of this redesign. That abortive attempt is the concrete demonstration that growing the
   regex path is the wrong direction (Kernighan's Law, Greenspun's Tenth Rule); `CONTEXT.md`
   still records the path-literal lint as "enhancement TBD".
2. **`tests/windows-test-parity-guard.test.cjs`** — a *ratchet*: a frozen `KNOWN_OFFENDERS`
   allowlist (G1–G6) that grandfathers existing violations and only blocks *new* ones. It
   institutionalizes the defects instead of removing them.
3. **`// windows-portability-ok:`** — a bespoke comment opt-out matched by a whole-source regex,
   coarse enough that a single occurrence anywhere in a file can disable that file's check.

This is three parsers, two escape conventions, and a permanent grandfather list — to do a job
that a linter does natively.

## Decision

Replace all three with a single coherent mechanism: **AST-based ESLint rules in the existing
`local/*` plugin** (`eslint-rules/`, registered in `eslint.config.mjs`; ESLint v9 flat config,
`RuleTester` available from `require('eslint')`). They use the parsers already in the stack:
**Espree** (ESLint's default, `sourceType: 'commonjs'`) for the test-file `.cjs` rules, and
**`@typescript-eslint/parser`** (already configured for `src/**/*.cts`) for the two production
`.cts` rules. Specifically:

1. **AST, not regex.** Each portability check is an ESLint rule that matches real syntax nodes
   (`CallExpression`, `MemberExpression`, `Literal`, `TemplateLiteral`), not text. Rules run
   in-editor *and* in CI via the existing `eslint .` (invoked by `lint:ci` through `npm run
   lint`) — strictly more coverage than the CI-only `node scripts/lint-windows-test-portability.cjs`
   they replace.
2. **Hard-fail, no ratchet, no grandfathering.** There is no `KNOWN_OFFENDERS` allowlist.
   Every existing and currently-grandfathered violation is **fixed**, not registered.
3. **Zero escape hatches.** No per-line `eslint-disable` is permitted for portability rules
   (enforced — see "Strictness" below). Legitimately platform-specific code must be
   *structured* so the rule recognizes it (e.g. guarded by `process.platform !== 'win32'`),
   not annotated around.
4. **Single source of truth.** Shared vocabulary (the `PATH_RETURNING_FNS` set, mode-bit
   octals, non-portable exec names) lives in one module `eslint-rules/lib/portability-vocab.cjs`,
   consumed by every rule and guarded against drift by an AST completeness check.
5. **Tested with `RuleTester`.** Each rule ships an ESLint `RuleTester` suite of `valid`/
   `invalid` cases. Because `RuleTester` feeds fixtures to the rule directly (it does not scan
   the test file), the self-flagging problem that forced the whole-file opt-out simply does not
   exist — the opt-out hack is deleted, not reimplemented.

### Rule catalog (maps 1:1 to `DEFECT.WINDOWS-*`)

| Rule (`local/…`) | DEFECT (greppable in `CONTEXT.md`) | Surface |
|---|---|---|
| `no-path-literal-in-assert` | `DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT` | tests |
| `no-posix-mode-bit-assert` | `DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT` | tests |
| `no-unguarded-nonportable-exec` | `DEFECT.WINDOWS-TEST-PORTABILITY` (chmod+`sh -c`) + `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` | tests |
| `no-crlf-fragile-split` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G1/G2/G3) + `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` | tests |
| `no-hardcoded-tmp` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G4) | tests |
| `no-bare-npm-exec` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G5) | tests |
| `require-userprofile-with-home` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G6) | tests |
| `normalize-path-in-content` | `DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT` (`RULESET.CONTENT-PATH-NORMALIZATION`) | `src/**/*.cts` |
| `require-fs-op-fallback` | `DEFECT.WINDOWS-FS-OPS` | `src/**/*.cts`, build/install |
| `no-private-binary-resolution` | `DEFECT.WINDOWS-PRIVATE-BINARY-RESOLUTION` | `src/**/*.cts`, `gsd-core/bin/**`, `scripts/**`, `hooks/**` |
| `no-exact-case-env-access` | `DEFECT.WINDOWS-EXACT-CASE-ENV-ACCESS` | `src/**/*.cts`, `gsd-core/bin/**`, `scripts/**`, `hooks/**` |
| `require-full-tmpdir-triad` | `DEFECT.WINDOWS-TEST-PORTABILITY` (#4220) | tests |
| `no-unbounded-dirname-walk` | `DEFECT.WINDOWS-TEST-PORTABILITY` (#4020 / #4220) | tests, scripts |

**Amendment (2026-08-18, epic #3411 Phase 3 / #3619).** `no-private-binary-resolution` is the
first catalog entry added after the original seven, and it extends this architecture to a
**production** Windows-runtime class rather than a test-portability one. It flags the two
unambiguous signals of re-implementing Windows binary resolution outside the platform seam:
reading `PATHEXT` (in any casing, from any object), and a hardcoded list containing two or more of
`.exe`/`.cmd`/`.bat`/`.com`. Both are exactly the shapes the four resolvers that epic #3411 deleted
actually had.

It deliberately does **not** flag a bare-name `spawn`, which is what #3411's own text asked for:
~30 such call sites exist and none is a defect (`git`, `gh`, `npm` ship native `.exe` on Windows),
so under rules 2 and 3 above a literal rule would be unsuppressable and would force rewriting
correct code. It also does not flag a `PATH` scan, which is used for legitimate membership checks
(`bin/install.js`) and cannot be soundly distinguished from a resolution scan. An unsound rule in a
zero-escape-hatch architecture is worse than no rule.

Two scoping consequences worth recording, because both were arrived at rather than assumed:

- **`eslint-rules/**` is outside this rule's surface** — `lib/portability-vocab.cjs` owns the
  extension set per rule 4 and would otherwise flag itself. This is expressed by *not linting that
  tree*, never by an exemption, so rule 3 holds.
- **The seam exemption is path-suffix-anchored**, matching `src/shell-command-projection.cts`
  or any path ending in `/src/shell-command-projection.cts` — not a substring match. The rule's
  own configured surface is `src/**/*.cts`, `gsd-core/bin/**/*.cjs`, `scripts/**/*.cjs`, and
  `hooks/**/*.js`; `tests/**` is deliberately outside that surface, because test setup
  legitimately assigns `process.env.PATHEXT` (`tests/fallow-runner.test.cjs`'s P3 case does this).
  So the suffix-vs-substring distinction is proven only by case I9 of the rule's `RuleTester`
  suite, which feeds the rule a synthetic filename directly — not by real-world linting of
  `tests/shell-command-projection-dispatch.test.cjs`, which this rule never scans.

The rule started **green** with nothing suppressed and nothing grandfathered — Phases 1 and 2 had
already removed every private resolver, which is what made a strict ratchet possible at all.

**Amendment (2026-08-27, epic #3411 Phase 4 / #3624).** `no-exact-case-env-access` extends the
architecture to a second production-runtime class: PR #3621 (epic #3411 Phase 1) shipped
`resolveExecutableBinary` reading `env['PATH']` where `env` could be a plain object (`{
...process.env, ...opts.env }`, which loses `process.env`'s case-insensitive Proxy) — a Windows
CI-only failure caught and fixed by adding `envGet(env, name)` inside the seam. This rule
generalizes that fix into a ratchet: it flags a read of any casing of `PATH`, `PATHEXT`,
`ComSpec`, `USERPROFILE`, `TEMP`, `TMP`, or `APPDATA` (the vocabulary's
`WINDOWS_CASE_VARYING_ENV_VARS`) off any receiver that is not literally `process.env` — dot or
bracket notation, or destructuring — using the same seam exemption anchoring as
`no-private-binary-resolution`.

Matching had to be narrower than "any property access whose name matches the vocabulary,
case-insensitively": a first pass produced 113 false positives, because ordinary lowercase
property access (`config.path`, `artifact['path']`) collides with the vocab entry `PATH` under
case-insensitive comparison. The shipped rule additionally requires the receiver to be
"env-shaped" — literally `<expr>.env` / `<expr>['env']` or a bare identifier named `env` (any
casing) — for both notations and for destructuring alike, which is what distinguishes
`opts.env['PATH']` (flagged) from `artifact['path']` (not flagged) without def-use/scope tracing.
One real pre-existing violation of the tightened rule was found and fixed in the same PR:
`src/runtime-hooks-surface.cts`'s `normalizeNodePath` read `env.APPDATA` off a runtime union
(`(opts && opts.env) || process.env`) that may be a plain object — migrated to `envGet(env,
'APPDATA')`. `envGet` (formerly the seam-private `_envGet`) is now exported from
`src/shell-command-projection.cts` specifically so this rule's remediation message ("route
through `envGet`") names a real, callable helper.

**Amendment (2026-09-03, #4244).** Two rules add author-time coverage for the bug class behind
two real, hard-evidence Windows CI incidents this week: #4020 (`scripts/run-tests.cjs`'s
`sweepProtectSet` ancestor walk hung every scoped Windows CI lane) and its follow-on #4220 (the
regression test written for #4020's own fix masked a second bug — see below). Per Node's own docs,
`os.tmpdir()` on Windows reads only `TEMP` then `TMP`; `TMPDIR` is never consulted there at all
(on every other platform, `TMPDIR` is checked first). Per empirical verification this session,
`path.dirname()` is a fixed point at the platform root on both OSes, but the fixed-point VALUE
differs: `path.posix.dirname('/') === '/'` (length 1) vs. `path.win32.dirname('C:\\') === 'C:\\'`
(length 3) — so a root check written as a POSIX-shaped length heuristic (`cur.length > 1`) never
fires on Windows.

- `require-full-tmpdir-triad` flags a `TMPDIR` environment override — `process.env.TMPDIR = …`,
  or a `TMPDIR` property in an object literal passed as a spawn-like call's `env:` option — that
  is not accompanied by `TEMP` and `TMP` in the same scope. Anti-pattern: `runNode(['-e', probe],
  { env: { ...process.env, TMPDIR: outer } })` — on Windows the child inherits the parent's
  ambient `TEMP`/`TMP` and its `os.tmpdir()` silently resolves to the wrong place. Fix: set all
  three to the same value. This is the exact shape #4220 found already shipped in
  `tests/run-tests-temp-root.test.cjs`'s own #4020 regression test, masked because Windows died in
  the unrelated dirname-walk hang before ever reaching it. The same #4244 sweep additionally found
  and fixed one more live instance in `tests/config-schema.property.test.cjs`'s
  `config-set accepts code_quality.fallow keys` test (direct `process.env.TMPDIR = writableTmp`
  assignment with no TEMP/TMP counterpart).
- `no-unbounded-dirname-walk` flags a `while`/`do-while` loop that reassigns its condition
  variable from `dirname()` (bare, `path.`, `.posix.`/`.win32.`) without a fixed-point termination
  guard (`dirname(cur) !== cur`, or `path.parse(cur).root`) in the loop condition. Anti-pattern:
  `while (cur && cur !== root && cur.length > 1) cur = dirname(cur);` — on a Windows runner where
  `cur` can never equal `root` (e.g. repo on `D:\`, temp root on `C:\`), the walk reaches the
  drive root and spins there at 100% CPU forever, since `cur.length` stays 3 (`> 1`) at the fixed
  point. Fix: add the `dirname(cur) !== cur` conjunct. The same #4244 sweep found this exact,
  still-unfixed shape live in `scripts/run-tests.cjs`'s `sweepProtectSet` block (the original
  #4020 site) and fixed it in the same change by extracting a pure `computeSweepProtectSet`
  helper with the fixed-point check, mirroring the shape of the (at-authoring-time separately
  in-flight, not yet merged) #4220 fix.

Both rules join the catalog's **zero-escape-hatch** discipline (rule 3 above): neither carries a
bespoke `// allow-*` comment marker, and both are added to `tests/portability-rule-disable-ban.test.cjs`'s
`PROTECTED_RULES` list so an `eslint-disable` naming them is independently banned outside ESLint
too. `no-unbounded-dirname-walk` is registered on **both** `tests/**/*.cjs` and `scripts/**/*.cjs`
(the narrower `scripts/**/*.cjs`-only block, alongside `no-private-binary-resolution`) — the
production surface registration is load-bearing, since the real #4020 bug lived in `scripts/`, not
`tests/`. `require-full-tmpdir-triad` follows the established test-portability convention
(`no-hardcoded-tmp`, `require-userprofile-with-home`) and is registered on `tests/**/*.cjs` only,
matching both real incident sites.

A repo-wide sweep for other instances of either pattern (beyond the incident sites above) found
none: `require-full-tmpdir-triad` and `no-unbounded-dirname-walk` both ran clean against the rest
of the tree once the three live sites were fixed.

**Taxonomy coverage.** This catalog addresses every `DEFECT.WINDOWS-*` class plus
`DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` in `CONTEXT.md`, to the extent each is *statically*
detectable. `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` has two parts: (a) the CRLF / literal-`\n`
fence-match shape — covered by `no-crlf-fragile-split`; and (b) feeding a Windows `os.tmpdir()`
path into a Git Bash glob / `bash -c` — covered jointly by `no-hardcoded-tmp` (steer tmp usage)
and `no-unguarded-nonportable-exec` (require a platform guard on `bash -c`). The residual runtime
Git-Bash path-translation behavior is not fully statically decidable; the rules catch the source
shapes that produce it, not the runtime outcome. `DEFECT.WINDOWS-ARGV-OVERFLOW` is deliberately
**not** in this catalog: it is a *runtime* argv-length property (the args-array size is not
statically knowable — e.g. `execFileSync('node', [...N runtime paths])`), so no AST rule can
soundly detect it. Phase 3 evaluated a `no-oversized-test-argv` heuristic and **dropped it as
unsound** (it could only catch a contrived literal `.repeat(N)` command string, never the
canonical array overflow). The class is addressed at the source: the production `run-tests.cjs`
argv chunking under `RUN_TESTS_MAX_CMDLINE_CHARS`, with its anchor `tests/run-tests-harness.test.cjs`.

### Architecture

- **`eslint-rules/<rule>.cjs`** — one file per rule, matching the existing `local/*` rule
  style. Each exports `{ meta, create }`.
- **`eslint-rules/lib/portability-vocab.cjs`** — the single source of truth: `PATH_RETURNING_FNS`,
  mode-bit octal predicates, non-portable command names, normalizer-call recognizers.
- **`eslint-rules/lib/platform-guard.cjs`** — shared AST helper answering "is this node
  *control-dependent* on a Windows platform condition?" (a dominator check, not a textual
  mention). It MUST recognize the guard shapes that actually occur in the suite:
  `process.platform !== 'win32'` / `=== 'win32'` (negated), `os.platform()`, a hoisted
  `const isWindows = …` consumed by a later `if (!isWindows)`, early-return guards, nested `if`
  blocks, and `node:test` skips (`t.skip()`, the `{ skip }` option / skip objects). The current
  regex lint is unsound here — it treats a bare `const isWindows = …` as "guarded" without
  requiring the dangerous call to be inside the branch; the AST helper fixes that by checking
  control dependence. This is the precision backbone that makes zero-escape-hatch viable
  (Postel's Law mitigation), and its correctness is the epic's primary risk: with no opt-out, an
  unrecognized legitimate shape is a CI-blocking false positive. Mitigation — `platform-guard`
  is `RuleTester`-tested against guard shapes harvested from the existing suite, and an
  unrecognized legitimate shape is fixed by teaching the helper, never by adding an opt-out.
- **Drift guard** — a plain unit test (**not** `RuleTester`, which only feeds code *strings* to
  a rule and cannot read files or enumerate exports) parses `src/runtime-homes.cts` (and the
  relevant `bin/install.js` exports) with `@typescript-eslint/parser`, walks the AST to collect
  exported functions that return a filesystem path, and asserts each is present in
  `portability-vocab`'s `PATH_RETURNING_FNS` (or an explicit, reason-bearing ignore set). A new
  resolver that isn't registered fails CI.
- **Wiring** — rules register in `eslint.config.mjs`'s `local` plugin and are set to `error`.
  No new `lint:ci` step; they ride the existing `eslint .` (which `lint:ci` runs via `npm run
  lint`). The **production** rules additionally require expanding the `eslint.config.mjs` file
  globs to cover `bin/install.js` and the build/install scripts — today the globs are
  `src/**/*.cts`, `gsd-core/bin/**/*.cjs`, `scripts/**/*.cjs`, and `tests/**/*.test.cjs`, so the
  top-level `bin/install.js` named by `DEFECT.WINDOWS-FS-OPS` is **not yet linted**; the glob
  expansion lands in the phase that ships `require-fs-op-fallback`.

### Strictness — enforcing zero escape hatches (Postel's Law)

Because there is no opt-out, two things must hold:

1. **Rules must be precise.** Every rule recognizes legitimate platform-gating via
   `platform-guard.cjs` and the canonical normalizer forms, so correctly-written
   platform-specific code is never flagged. A false positive is a rule bug, fixed in the rule.
2. **The disable directive is itself banned for these rules.** Note `reportUnusedDisableDirectives`
   is **not** sufficient — it only flags directives that suppress *nothing*; a developer could
   write `// eslint-disable-next-line local/no-path-literal-in-assert` on a genuinely-violating
   line and the directive would count as "used" and pass. The ban is enforced by a dedicated
   guard: a small `local/no-portability-disable` meta-rule (matching `Program` comments) that
   **errors on any `eslint-disable[-next-line|-line]` directive referencing a
   `local/<portability-rule>`**. This is precise (only the portability rules are protected;
   every other rule keeps its normal inline-disable affordance), self-contained (no new
   dependency), and is itself unit-tested. `linterOptions.noInlineConfig: true` was rejected as
   the mechanism because it would ban *all* inline disables repo-wide, not just the portability
   rules.

## Applied software laws (engineering directive, Step 2.2)

- **Kernighan's Law / Greenspun's Tenth** — motivate the whole change: stop parsing a language
  with regex; use the real parser.
- **Choose Boring Technology** — ESLint + `typescript-eslint` already present; no new tech.
- **Gall's Law** — the migration is **incremental**: each phase adds one rule, fixes its
  violations, and removes only that class's hack. The old mechanisms keep running until their
  replacement lands. Full teardown is the *last* phase, not the first.
- **Postel's Law** — zero escape hatches raises the precision bar; `platform-guard.cjs` is the
  required mitigation so the strict rules never reject legitimate code.
- **Hyrum's Law** — removing `// windows-portability-ok:` breaks existing uses; every current
  occurrence is migrated (code restructured or the underlying violation fixed) in the phase
  that retires it. The vocab + rule semantics are documented here as the new contract.

## Consequences

**Positive:** one mechanism; in-editor feedback; debuggable, unit-tested rules; no grandfather
list; no bespoke comment parser; a documented, extensible architecture.

**Cost / risk:** fixing every grandfathered violation across the suite is a large, real diff
(~15+ offender files for G1–G6 alone, plus the path-literal/mode-bit sets). Mitigated by
phasing (one rule at a time, each independently reviewed and shipped) and by the rules being
`error` from the moment they land so no new debt accrues.

**Migration is phased (Gall's Law):**

- **Phase 0** ADR (this) — the design record.
- **Phase 1–3** `no-path-literal-in-assert`, `no-posix-mode-bit-assert`, `no-unguarded-nonportable-exec`,
  each landing with `portability-vocab.cjs` / `platform-guard.cjs` / the `RuleTester` harness as
  they are first needed.
- **Phase 4** the G1–G6 rules + fix all grandfathered offenders + delete the ratchet test.
- **Phase 5–6** production `normalize-path-in-content`, `require-fs-op-fallback`.
- **Phase 7** teardown: delete the `windows-test-parity-guard` ratchet + `allowlist-ratchet` usage
  for these classes + sweep any residual `// windows-portability-ok:` comments; finalize the
  `CONTEXT.md` `DEFECT.WINDOWS-*` predicate rewrite; the forward architecture guide ("how to add a
  portability rule"). (The regex script `scripts/lint-windows-test-portability.cjs` was retired
  earlier — in Phase 3 — as its `no-unguarded-nonportable-exec` replacement landed.)

Each implementation phase runs the full engineering directive (rubber-duck → laws → architecture
→ qa-test-architect → strict TDD via `RuleTester` → codex adversarial → Diátaxis → rebase+PR)
and is its own approved child issue + PR under epic #1702.

## Phase 7 — as-built / acceptance (2026-06-26)

All seven phases shipped; the architecture is exercised in production and accepted. Two
as-built deviations from the Phase 0 catalog, both within this ADR's precision discipline:

- **Phase 6 scope — `require-fs-op-fallback` narrowed to rename.** The catalog row named
  `DEFECT.WINDOWS-FS-OPS` for "`src/**/*.cts`, build/install". The defect's own `.fix-forward`
  defines the cure as *"catch EPERM/EBUSY/EACCES, fall back to copy + unlink with retry"* — so
  `copyFile`/`unlink` are the **fallback primitives**, not separate defect sites, and flagging
  them would flag the cure (`unlink` also has ~30 intentional best-effort cleanup sites that would
  be a FP minefield). v1 recognition is therefore `fs.rename`/`fs.renameSync` only, with the
  `RENAME_RETRY_ERRNOS` retry loop as the recognized compliant shape; `copyFile`/`unlink`
  transient-lock sub-classes are documented for a possible follow-up. The ADR-mandated glob
  expansion to `bin/install.js` + `scripts/build-hooks.js` (L124-126) landed as specified.
  Documented on [#1740](https://github.com/open-gsd/gsd-core/issues/1740).

- **Phase 6 precision tightening (codex review).** The rule's compliance shape was tightened after
  an adversarial gpt-5.5 review: a catch must BOTH reference a transient errno AND carry a retry
  signal (a loop `continue` backedge or a `return <call>` delegation — NOT a bare rethrow), and
  only the **nearest catching** try/catch counts (an outer errno-catch is unreachable once an inner
  catch intercepts). This enforces the defect's *"never silently swallow"* + cure-is-retry clauses
  honestly. See [`eslint-rules/require-fs-op-fallback.cjs`](../../eslint-rules/require-fs-op-fallback.cjs).

The forward "how to add a portability rule" recipe delivered by this phase lives at
[`docs/contributing/adding-a-portability-rule.md`](../contributing/adding-a-portability-rule.md).

Two further as-built deviations from the Phase 0 text, reconciled in the post-merge
coverage audit (#1749):

- **Disable-ban mechanism — meta-rule → out-of-band test.** §"Strictness" specified a
  `local/no-portability-disable` ESLint meta-rule to ban inline disables of portability
  rules. What shipped is [`tests/portability-rule-disable-ban.test.cjs`](../../tests/portability-rule-disable-ban.test.cjs)
  — a `node:test` that scans files for disable directives **outside ESLint**, so it cannot
  itself be eslint-disabled (an advantage over an in-process meta-rule, which the ADR noted
  as the motivating risk). The substitution is at least as strong; recorded here so the
  ADR's written mechanism matches the as-built one.

- **Drift-guard `bin/install.js` scope.** §"Architecture" said the drift guard parses
  `src/runtime-homes.cts` *and the relevant `bin/install.js` exports*. The shipped
  [`tests/portability-vocab-drift.test.cjs`](../../tests/portability-vocab-drift.test.cjs)
  originally covered only `runtime-homes.cts`; the audit extended it to `bin/install.js`
  with a SOUND shape only (a top-level function that directly `return path.*(...)` must be
  registered; plus a curated two-way existence lock on the installer path helpers). The
  looser body-contains heuristic used for `runtime-homes.cts` is unsound for the generated
  12k-line installer (~33 false positives), so a new installer resolver that builds a path
  via a temp variable relies on review — documented as a boundary in the test. The active
  resolver module (`runtime-homes.cts`) remains fully drift-guarded by the looser heuristic.

## Alternatives considered

1. **Keep extending the regex lint.** Rejected — the adversarial review proved it is
   structurally fragile; every extension adds parser surface and bugs.
2. **Keep the ratchet, just add rules.** Rejected — grandfathering is the thing being removed;
   the maintainer's directive is rip-and-replace, not legacy preservation.
3. **Keep `// windows-portability-ok:` as an escape hatch.** Rejected — zero escape hatches
   chosen; precision via `platform-guard.cjs` replaces the need for an opt-out.
4. **A standalone custom AST tool (not ESLint).** Rejected — Greenspun/Choose-Boring: ESLint is
   the boring, in-stack, in-editor linter; building a parallel tool repeats the original mistake.
