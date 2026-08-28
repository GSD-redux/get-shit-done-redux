# ADR-3626: CONTEXT.md seam claims carry a checkable enforcement pointer

- **Status:** Accepted
- **Date:** 2026-08-27
- **Issue:** [#3626](https://github.com/open-gsd/gsd-core/issues/3626)
- **Amends:** none. Applies ADR-1703's "seam it" strategy (Decision 2) by adding the verification
  step that strategy lacked.

**Decision summary.** `CONTEXT.md` gains a new machine-readable predicate pair,
`SEAM.<id>.owns=<capability>` / `SEAM.<id>.enforced-by=lint-rule:<name>|test:<path>`, generalizing
the existing `WORKTREE.SEAM.*` vocabulary rather than introducing a parallel one. A new
`scripts/lint-seam-enforcement.cjs`, wired into `lint:ci`, fails when an `owns` claim has no
matching `enforced-by` pointer, or when that pointer names a lint rule that is not registered in
`eslint.config.mjs` (or whose source file is missing), or a test file that does not exist on disk.

The gate is deliberately **resolves-only**: it proves the named enforcement mechanism *exists and
is wired up*, not that its surface actually *covers* every file the seam claims to own. That
broader "coverage" verification was the issue's own explicitly-flagged larger, harder design
(ESLint glob matching for a rule; no static notion of "coverage" at all for a test-file anchor) and
was decided against by the maintainer in chat before implementation (2026-08-27), per the "cheap
and honest" framing in the issue's own scope caveat.

## Context

`CONTEXT.md` declares several single-owner/single-seam claims in prose — "the single canonical
owner of X", "the single seam for Y". ADR-1703 established that a portability class gets either a
lint rule (self-verifying) or a centralized seam (an assertion, with no verification step). Epic
#3411 found the Shell Command Projection Module's Windows-binary-resolution seam claim was false
for years: four divergent implementations existed, and a fix to one never reached the others,
because nothing checked that the claimed seam was actually the only place that logic lived.

The gap: strategy 2 ("seam it") has no equivalent of strategy 1's self-verification. A seam
declaration can decay silently as the next author needs something the seam doesn't offer and
writes around it.

## Decision

1. **Vocabulary**: reuse and generalize the `<NAME>.SEAM.*` predicate-fact shape already shipped
   for the Worktree Safety Policy Module (`WORKTREE.SEAM.current`, `.files`, `.interface`,
   `.caller-rule`, `.test-anchor-w017`, ...) rather than invent a second one. The new top-level
   keys are `SEAM.<id>.owns` and `SEAM.<id>.enforced-by`, coexisting alongside any existing
   `<NAME>.SEAM.*` descriptive facts for the same module (see `WORKTREE.SEAM.*` +
   `SEAM.worktree-safety-policy.*` in `CONTEXT.md` for the pattern).
2. **Enforcement pointer schemes**: exactly two, `lint-rule:<name>` (must resolve to a key in
   `eslint.config.mjs`'s `localPlugin.rules` map AND a corresponding `eslint-rules/<name>.cjs`
   file) and `test:<path>` (must exist relative to the repo root). A third scheme is a lint
   failure ("unrecognized enforcement-pointer scheme"), not a silent pass.
3. **Scope**: resolves-only. The gate does not compute whether a rule's ESLint `files` glob or a
   test's exercised code paths actually reach every file the seam claims. This is a conscious,
   disclosed limitation — see Consequences.
4. **No grandfather list** (ADR-1703 Decision 2, applied here): every current module-level
   single-owner/single-seam claim in `CONTEXT.md` was enumerated and either backed with a real
   `SEAM.*.owns`/`enforced-by` pair, or its prose would be corrected to stop claiming exclusive
   ownership. Six claims were found (Shell Command Projection Module's Windows-binary-resolution
   axis, Verification Module's `isPhaseComplete`, Phase Locator Module's
   `listMilestonePhaseDirs`, Git Query Module, the capability-activation precedence engine, and
   the Worktree Safety Policy Module); all six already had an existing, on-disk lint rule or test
   file that plausibly anchors the claim once actually pointed to — none required a prose
   downgrade. See `.gsd/phase/feat-3626-context-seam-claim-gate/40-design.md` for the full
   seam-by-seam disposition table and verification evidence.

## Consequences

**Positive:** an unbacked seam claim is now a `lint:ci` failure, not a silent, decaying assertion.
The fixture in `tests/lint-seam-enforcement.test.cjs` (row 4, "owns with no matching enforced-by")
proves the gate can actually fail, not just pass vacuously. The mechanism generalizes cleanly —
adding a seventh seam claim later is one predicate pair, not a new gate.

**Cost / risk — the disclosed limitation.** A claim can be "backed" by a real rule or test that is
narrow relative to what the prose claims to own. `SEAM.<id>.enforced-by=test:<path>` accepts any
existing file at that path; the gate does not parse the test to confirm it actually references the
claimed symbol (each of the six seams landed with this PR was spot-checked by hand via Memtrace's
`find_code`, not by the gate itself). A future author could, in principle, satisfy the gate with a
test file that exists but tests something unrelated. This is the accepted trade of the
resolves-only decision: cheap and honest about what it checks, not a claim of exhaustive coverage
verification.

**Revisit-if**: if a claim backed only by an existing-but-irrelevant test/rule pointer is found in
practice (i.e., the resolves-only gap is exploited, deliberately or by drift), re-open the coverage
-verification design the issue flagged and this ADR declined to build.

## Alternatives considered

- **Coverage verification** (does the rule's ESLint `files` glob, or the test's exercised paths,
  actually include every file the seam declares) — rejected as the issue's own "much larger
  design," requiring a per-enforcement-type coverage computation with no honest static notion of
  "coverage" for a test-file anchor. See design doc's Rejected section.
- **A new parallel predicate vocabulary** instead of generalizing `WORKTREE.SEAM.*` — rejected per
  explicit maintainer direction (issue comment, 2026-08-18) to generalize the shipped precedent.
