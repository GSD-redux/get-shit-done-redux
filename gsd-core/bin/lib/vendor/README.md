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

## Do not hand-edit

These files are **verbatim** copies of the upstream build output. Never
edit them directly — refresh them from `node_modules` instead:

```
cp node_modules/re2js/build/index.cjs gsd-core/bin/lib/vendor/re2js.cjs
cp node_modules/re2js/build/index.d.cts gsd-core/bin/lib/vendor/re2js.d.cts
```

`node scripts/lint-vendored-deps.cjs` fails CI if the vendored copy drifts
byte-for-byte from `node_modules/re2js/build/` or from the `re2js` version
pinned in `package.json` `devDependencies`.
