# Brand-typing compile fixtures (#2671)

These `.cts` files are **compiler inputs, not runtime code**. They are deliberately
excluded from `tsconfig.json` / `tsconfig.build.json` (both include `src/**/*.cts`
only), so they never enter `npm run build:lib` and never emit a `.cjs`. `tests/` is
not in the package's `files` list either, so they do not ship.

`tests/phase-estimation.test.cjs` compiles them in-process with the TypeScript
compiler API, using the repo's real `tsconfig.build.json` options, and asserts on
the returned **diagnostic objects** (`code`, `file`, `start`) — never on rendered
compiler prose.

| Fixture | Must | Guards |
|---|---|---|
| `ok-correct-composition.cts` | compile clean | the positive control — proves the harness, imports, and option set are sound |
| `bad-double-calibration.cts` | fail | #2631 — applying the factor to an already-corrected figure (factor²) |
| `bad-raw-against-budget.cts` | fail | comparing an uncorrected projection against the smart-zone budget |
| `bad-calibrated-as-sample-basis.cts` | fail | #2632 — calibrating against the emitted figure instead of the raw basis |
| `bad-rebrand-calibrated-as-raw.cts` | fail | laundering a corrected figure back into the raw basis |
| `bad-unbranded-number-as-raw.cts` | fail | proves the brand is not vacuously `number` |

## The three rules that keep these non-vacuous

A negative-compile test is worthless if it can pass for the wrong reason. Three
independent checks prevent that, and each exists because of a demonstrated failure:

1. **The positive control must compile clean.** Otherwise a broken import path or
   an unusable option set would make every `bad-*` fixture "fail correctly" while
   testing nothing.
2. **No diagnostic may originate outside this directory.** Otherwise a real compile
   error in `src/` could hide inside fixture noise.
3. **Each `bad-*` fixture routes its violating value through a const named
   `OFFENDING`, and the diagnostic must land on that node.** Code-and-count alone
   is not enough — an adversarial review proved that a fixture whose brand
   violation had been *repaired*, but which gained an unrelated error of the same
   code (a string passed as the budget), still produced "exactly one TS2345" and
   would have reported green while no longer testing its regression at all.

Each `bad-*` fixture therefore contains **exactly one** deliberate type error, on
its `OFFENDING` marker. Adding a second error, or moving the violation off the
marker, breaks the contract on purpose — add a new fixture instead.

TypeScript reports an object-literal property mismatch on the property *name*
rather than its initializer, so the marker check also accepts the name of a
property initialized from `OFFENDING` (see `bad-calibrated-as-sample-basis.cts`).
