# Adding a cross-platform portability lint rule

GSD must run correctly on Windows as well as macOS/Linux. The `DEFECT.WINDOWS-*`
taxonomy in [`CONTEXT.md`](../../CONTEXT.md) names the recurring failure shapes; a family of
AST-based ESLint rules (the `local/*` plugin) enforces them **at write-time (in your editor)
and in CI**, so a Windows-only defect is caught before it ships — not after it reaches the
`windows-latest` CI lane.

This page is the **forward recipe**: how to add a new rule when you identify a portability
defect class that isn't yet mechanically enforced. The architecture and rationale live in
[ADR-1703](../adr/1703-portability-enforcement-architecture.md); the per-rule reference and
fix how-tos live in [`cross-platform-portability-rules.md`](./cross-platform-portability-rules.md).

> **Diátaxis note:** this is an *Explanation* — it describes the architecture and the reasoning
> behind the seams, so the recipe at the end makes sense. For "how do I fix a violation I got",
> see the per-rule how-tos in the reference page.

## Why AST rules, not regex

The original enforcement was a regex scanner with a hand-rolled balanced-paren parser, a frozen
`KNOWN_OFFENDERS` ratchet, and a bespoke `// windows-portability-ok:` comment opt-out. Adversarial
review of an attempt to *extend* the regex found it silently could not match `deepStrictEqual`,
had loose normalizer recognition, and hand-rolled paren-splitting fragility (Kernighan's Law /
Greenspun's Tenth — parsing a language with regex). The rip-and-replace decision: **one mechanism,
AST-based ESLint rules** using the parsers already in the stack, hard-fail with zero escape
hatches, no ratchet/grandfathering. Full rationale: ADR-1703 "Alternatives considered".

## The five seams (and where each lives)

Every portability rule composes the same five seams. Adding a rule means touching each one.

### 1. The rule — `eslint-rules/<rule-name>.cjs`

One file per rule, exporting `{ meta, create }`. Matches real syntax nodes (`CallExpression`,
`MemberExpression`, `Literal`, `TemplateLiteral`, `BinaryExpression`, `TryStatement`, …), **not**
text. Each rule runs in-editor *and* in CI via the existing `eslint .` (invoked by `lint:ci`).

The two shapes that recur:
- **Test-side rules** (surface `tests/**/*.test.cjs`) — flag a non-portable *assertion* or *test
  fixture* shape (path-literal-in-assert, posix-mode-bit-assert, unguarded exec, CRLF split,
  hardcoded `/tmp`, bare npm, HOME-without-USERPROFILE).
- **Production rules** (surface `src/**/*.cts`, `bin/install.js`, `scripts/build-hooks.js`) — flag
  a non-portable *production* shape (path-leak-in-content, unguarded fs-rename).

### 2. The shared vocabulary — `eslint-rules/lib/portability-vocab.cjs`

The single source of truth for path-related portability: `PATH_RETURNING_FNS` (Node builtins +
project resolvers), the POSIX-normalizer recognizers (`.replace(/\\/g,'/')`, `toPosixPath`, …),
and string-unwrap helpers. A new path resolver added to `src/runtime-homes.cts` MUST be registered
here — the drift-guard test (`tests/portability-vocab-drift.test.cjs`) parses that source and
**fails CI if a path-returning export is missing** from `PATH_RETURNING_FNS`.

### 3. The platform guard — `eslint-rules/lib/platform-guard.cjs`

The precision backbone. `isWindowsExcludedNode(node, sourceCode)` answers "is this node
control-dependent on a Windows platform condition?" via a **dominator check, not a textual mention**:
`if (process.platform !== 'win32') { … }`, early-return guards (`if (process.platform === 'win32') return;`),
`os.platform()`, and hoisted binding-aware booleans (`const isWindows = …` consumed by
`if (!isWindows)`, with reassignment detection). This is what makes **zero escape hatches** viable:
legitimately POSIX-only code is *structured* behind a recognized guard, never annotated around
(Postel's Law mitigation). If a legitimate shape isn't recognized, **teach the helper** — never add
an opt-out.

### 4. The disable ban — `tests/portability-rule-disable-ban.test.cjs`

Because there is no opt-out, an `eslint-disable` of a portability rule would silently bypass it.
This test runs **outside ESLint** (so it cannot itself be eslint-disabled) and fails the build on
any `eslint-disable[-next-line|-line]` that names a protected portability rule, or any blanket
disable. **Every new rule MUST be appended to `PROTECTED_RULES`** here, and if the rule covers a
new surface (e.g. `bin/install.js`), that surface MUST be added to `collectTestFiles()`.

### 5. CI test selection — `scripts/ci-test-scope.cjs`

The `portability lint rules (ADR-1703)` rule selects the rule suites + disable-ban when
`eslint-rules/`, `eslint.config.mjs`, or a covered production surface changes. Add new test files
to its `tests:` list.

## The zero-escape-hatch contract

Two things must hold, and they are the epic's primary risk:

1. **Rules must be precise.** Every rule recognizes legitimate platform-gating via
   `platform-guard.cjs` and the canonical compliant shapes, so correctly-written platform-specific
   code is never flagged. A false positive is a rule bug, fixed in the rule — never by adding an
   opt-out.
2. **Recognition must mean the cure, not just the symptom.** When a rule's compliance shape is "the
   catch handles the transient errno", the handler must actually *retry/fallback* (a loop `continue`
   backedge or a `return <call>` delegation), not merely *reference* the errno and rethrow. The
   `require-fs-op-fallback` rule encodes this (codex-review-tightened): the defect's cure is retry,
   not just recognition.

An unrecognized legitimate shape is fixed by teaching the helper/rule, never by annotation. This is
the discipline that keeps the rules honest as the codebase grows.

## Recipe — add a new `local/*` portability rule

Run the full engineering directive (rubber-duck → software laws → architecture → qa-test-architect
→ strict TDD via `RuleTester` → adversarial review → Diátaxis → rebase+PR). Concretely:

1. **Classify the defect.** Confirm it's a real `DEFECT.WINDOWS-*` shape (or a new class worth a
   predicate in `CONTEXT.md`). Decide the *sound* statically-detectable scope — narrow or document
   rather than ship FP-prone (Phase 5/6 each narrowed scope and documented the boundary).
2. **Write the rule** — `eslint-rules/<rule-name>.cjs` (`{ meta, create }`, `type: 'problem'`,
   message cites the `DEFECT.*` predicate). Reuse `portability-vocab.cjs` / `platform-guard.cjs`.
3. **TDD via `RuleTester`** — `tests/<rule-name>.rule.test.cjs`. Cover: the violation shape(s),
   every recognized compliant shape (platform guard, normalizer, retry signal, …), and the
   anti-patterns that must NOT satisfy compliance (silent-swallow catch, rethrow-only, unrelated
   errno). Use both espree (`.cjs`) and `@typescript-eslint/parser` (`.cts`) where the rule spans
   both. Tests are written FIRST and must fail before the rule exists, then pass.
4. **Register + scope** — in `eslint.config.mjs`: add the rule to the `local` plugin's `rules` map
   and enable at `'error'` in the matching file-glob block. If the rule covers a new surface (e.g.
   `bin/install.js`), add a config block for it — apply ONLY the portability rules to generated
   code, not the full recommended set.
5. **Disable ban** — append the rule name to `PROTECTED_RULES` in
   `tests/portability-rule-disable-ban.test.cjs`; add any new surface to `collectTestFiles()`.
6. **CI selection** — add the new test file to the `portability lint rules (ADR-1703)` rule in
   `scripts/ci-test-scope.cjs`.
7. **Fix every violation** — no ratchet, no grandfathering. Every existing + grandfathered offender
   is fixed in the same phase (route through a shared helper, add a guard, or normalize).
8. **Docs** — add the rule to the reference table + a fix how-to in
   `cross-platform-portability-rules.md`; rewrite the `DEFECT.*` predicate's `detect=`/`fix-forward=`
   in `CONTEXT.md` to point at the rule; record known boundaries honestly.
9. **Verify** — `npm run lint:ci` green; the touched modules' tests green; the `windows-latest` CI
   lane is the only true Windows signal.

## Catalog (shipped)

| Rule | DEFECT | Surface | Phase |
|---|---|---|---|
| `no-path-literal-in-assert` | `WINDOWS-PATH-LITERAL-IN-ASSERT` | tests | 1 |
| `no-posix-mode-bit-assert` | `WINDOWS-POSIX-MODE-BIT-ASSERT` | tests | 2 |
| `no-unguarded-nonportable-exec` | `WINDOWS-TEST-PORTABILITY` (chmod+`sh -c`) | tests | 3 |
| `no-crlf-fragile-split` | `WINDOWS-TEST-PORTABILITY` (G1–G3) | tests | 4 |
| `no-hardcoded-tmp` | `WINDOWS-TEST-PORTABILITY` (G4) | tests | 4 |
| `no-bare-npm-exec` | `WINDOWS-TEST-PORTABILITY` (G5) | tests | 4 |
| `require-userprofile-with-home` | `WINDOWS-TEST-PORTABILITY` (G6) | tests | 4 |
| `normalize-path-in-content` | `WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT` | `src/**/*.cts` | 5 |
| `require-fs-op-fallback` | `WINDOWS-FS-OPS` | `src/**/*.cts`, `bin/install.js`, `scripts/build-hooks.js` | 6 |
| `require-full-tmpdir-triad` | `WINDOWS-TEST-PORTABILITY` (#4220) | tests | #4244 |
| `no-unbounded-dirname-walk` | `WINDOWS-TEST-PORTABILITY` (#4020/#4220) | tests, `scripts/**/*.cjs` | #4244 |

`DEFECT.WINDOWS-ARGV-OVERFLOW` is deliberately **not** in this catalog: argv length is a runtime
property (the args-array size is not statically knowable), so no AST rule can soundly detect it.
It is addressed at the source (`run-tests.cjs` chunking under `RUN_TESTS_MAX_CMDLINE_CHARS`).

## Teardown (complete)

The legacy machinery this architecture replaced is fully retired: the regex scanner
`scripts/lint-windows-test-portability.cjs` (Phase 3), the `tests/windows-test-parity-guard.test.cjs`
ratchet (Phase 4), `allowlist-ratchet.cjs` usage for portability classes (the module remains for
unrelated size-budget lints), and the `// windows-portability-ok:` comment convention (swept — zero
remain). Every `DEFECT.WINDOWS-*` predicate in `CONTEXT.md` now points at its enforcing rule.
