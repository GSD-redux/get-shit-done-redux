# Brand-typing compile fixtures (#2671)

These `.cts` files are **compiler inputs, not runtime code**. They are deliberately
excluded from `tsconfig.json` / `tsconfig.build.json` (both include `src/**/*.cts`
only), so they never enter `npm run build:lib` and never emit a `.cjs`.

`tests/phase-estimation.test.cjs` compiles them in-process with the TypeScript
compiler API, using the repo's real `tsconfig.build.json` options, and asserts on
the returned **diagnostic objects** (`code`, `file`) — never on rendered compiler
prose.

| Fixture | Must | Guards |
|---|---|---|
| `ok-correct-composition.cts` | compile clean | the positive control — proves a failure in any `bad-*` fixture is the brand rejecting, not a broken harness |
| `bad-double-calibration.cts` | fail | #2631 — applying the factor to an already-corrected figure (factor²) |
| `bad-raw-against-budget.cts` | fail | comparing an uncorrected projection against the smart-zone budget |
| `bad-calibrated-as-sample-basis.cts` | fail | #2632 — calibrating against the emitted figure instead of the raw basis |
| `bad-rebrand-calibrated-as-raw.cts` | fail | laundering a corrected figure back into the raw basis |
| `bad-unbranded-number-as-raw.cts` | fail | proves the brand is not vacuously `number` |

Each `bad-*` fixture contains **exactly one** deliberate type error, so the test can
assert a one-diagnostic-per-file contract. Adding a second error to one of these
files breaks that contract on purpose — split it into a new fixture instead.
