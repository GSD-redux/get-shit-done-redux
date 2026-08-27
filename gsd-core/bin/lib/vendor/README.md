# vendor/

This directory holds **verbatim, unmodified** copies of third-party build
artifacts that `gsd-core/bin/**` needs at runtime.

## Why

`gsd-core/bin/**` is copied by the installer into trees that have **no
`node_modules`** (e.g. `~/.claude/gsd-core/`). Any external (non-relative,
non-builtin) `require()`/`import` under `gsd-core/bin/**` breaks `verify`
(and everything else) for every installed user, because the module simply
cannot be resolved there. The fix is to vendor the compiled artifact
in-tree instead of depending on it being installed as an npm package.
`eslint-rules/no-external-require-in-bin.cjs` enforces this at lint time.

## Contents

- `re2js.cjs` — verbatim copy of `node_modules/re2js/build/index.cjs`
  (upstream package `re2js`, pinned version see `package.json`
  `devDependencies.re2js`). Used by `src/pattern.cts` (compiled to
  `gsd-core/bin/lib/pattern.cjs`) for linear-time RE2 pattern compilation.
- `re2js.d.cts` — verbatim copy of `node_modules/re2js/build/index.d.cts`,
  so TypeScript resolves types for the relative import from `src/pattern.cts`.
- `js-yaml.cjs` — verbatim copy of `node_modules/js-yaml/dist/js-yaml.js`
  (upstream package `js-yaml`, pinned version see `package.json`
  `devDependencies.js-yaml`). ADR-3473 §8.1 (#3881): the single YAML parser
  this repo standardizes on. The `dist` UMD bundle is the vendorable
  artifact — js-yaml's `exports.require` entry (`index.js`) is *not*
  self-contained; `dist/js-yaml.js` loads under `require()`, contains zero
  `require()` calls of its own, and exposes `load`/`dump`/`FAILSAFE_SCHEMA`/
  `YAMLException`.

## Two kinds of type twin

Each vendored package needs a `.d.cts` under `src/vendor/` so TypeScript can
resolve types for a relative `./vendor/<pkg>.cjs` import from `src/**`
(module resolution for a `.cts` source is relative to `src/`, not the
compiled output dir). There are two kinds:

- **upstream-verbatim** (`re2js.d.cts`) — a byte-for-byte copy of an
  upstream `.d.cts`/`.d.ts` that ships with the package. Both the
  `gsd-core/bin/lib/vendor/` copy and the `src/vendor/` copy are checked by
  `scripts/lint-vendored-deps.cjs` against `node_modules` and against each
  other.
- **hand-authored** (`js-yaml.d.cts`) — js-yaml ships **no** type
  declarations upstream and `@types/js-yaml` is not installed, so there is
  nothing to copy verbatim. `src/vendor/js-yaml.d.cts` is written by hand,
  declares only the symbols actually used (`load`, `dump`,
  `FAILSAFE_SCHEMA`, `YAMLException`), and is **excluded** from
  `lint-vendored-deps.cjs`'s byte-compare — there is no upstream file to
  compare it against. The narrowness is deliberate: anchors, aliases,
  custom types and `loadAll` are unreachable from typed code, which is a
  compile-time enforcement of ADR-3473 §8.1's refusal to expand them.

## Do not hand-edit

These files are **verbatim** copies of upstream build output. Never edit
them directly — refresh them from `node_modules` instead:

```
cp node_modules/re2js/build/index.cjs gsd-core/bin/lib/vendor/re2js.cjs
cp node_modules/re2js/build/index.d.cts gsd-core/bin/lib/vendor/re2js.d.cts
cp node_modules/re2js/build/index.d.cts src/vendor/re2js.d.cts

cp node_modules/js-yaml/dist/js-yaml.js gsd-core/bin/lib/vendor/js-yaml.cjs
# js-yaml.d.cts has no upstream counterpart — update src/vendor/js-yaml.d.cts
# by hand if the js-yaml API surface this repo depends on changes.
```

`node scripts/lint-vendored-deps.cjs` fails CI if any vendored copy drifts
byte-for-byte from its `node_modules` upstream, from its own source-side
type twin (upstream-verbatim twins only), or from the version pinned in
`package.json` `devDependencies`. It is table-driven (`VENDORED` in that
script) — adding a third vendored package means adding a row, not a second
hardcoded check block (ADR-3473 §8.3, "one implementation per rule").
