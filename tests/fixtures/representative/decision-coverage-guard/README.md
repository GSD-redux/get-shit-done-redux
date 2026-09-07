# Decision-coverage guard fixture (#2347, graduated by #4130)

`d5-prefix-context.md` is the verbatim reproduction shape from #2347 — the
`- **D5-01:** some decision` bullet given in the issue's own "Steps to
reproduce" — used as a CONTEXT.md `<decisions>` block and driven through
`query check.decision-coverage-plan <phaseDir> <contextPath>` (the real
CLI gate; see `tests/decisions.test.cjs` for the established pattern this
follows), not `extractDecisions()` called in isolation.

History of the expected verdict for this exact shape:

1. **#2347 (original):** the #1365 fail-loud guard's "is this
   decision-shaped?" evidence test (`/\bD-[A-Za-z0-9]/`) reused the same
   `D-` grammar as the parser it guards, so `D5-01` was invisible to both
   and a populated CONTEXT.md passed silently. #2347 made the evidence test
   format-agnostic, and the fixture's expectation graduated from the
   characterized buggy green-skip to `could-not-parse`.
2. **#4130 (current):** the digit-run phase prefix itself became a LEGAL
   ID grammar — the parser now reads `D5-01`/`D5-02` — so this shape no
   longer fails loud at all. The gate reports a real coverage verdict:
   `total: 2`, `covered: 0`, `passed: false`, and NO `reason` field (the
   coverage path emits none). Pinned in `MANIFEST.json`'s
   `expectedTotal`/`expectedCovered`/`expectedPassed` and asserted in
   `tests/representative-corpus.test.cjs`.

The fail-loud contract itself is unchanged and still covered by the
`DEC-`-prefix (non-`D` universe) tests in `tests/decisions.test.cjs`:
an ID grammar the parser genuinely cannot read still yields
`could-not-parse`.
