# How to vendor a dependency

**Goal:** Add a third-party package that `gsd-core/bin/**` needs at runtime, in the vendored form the installer's copy step actually supports, without breaking the lint gate that keeps the vendored copy from silently drifting.

**Prerequisites:** The package is a devDependency already (`npm install --save-dev <pkg>`), and its build output ships (or can be built into) a self-contained CommonJS/UMD bundle with zero external `require()` calls.

---

## Why vendoring exists at all

`gsd-core/bin/**` is copied by the installer into trees that have **no `node_modules`** (for example `~/.claude/gsd-core/`). Any external, non-relative, non-builtin `require()`/`import` under `gsd-core/bin/**` breaks every command that touches it for every installed user, because the module simply cannot be resolved on disk there — there is no `node_modules` to resolve it from. `eslint-rules/no-external-require-in-bin.cjs` (`local/no-external-require-in-bin`) enforces this at lint time: it fails on any bare-specifier `require`/`import` under `gsd-core/bin/**`, whether or not the target actually exists in this repo's own `node_modules`. Vendoring — copying the package's compiled build artifact in-tree under `gsd-core/bin/lib/vendor/` and importing it with a relative path — is the only way around that constraint; there is no exemption mechanism, and there should not be one.

## The package MUST stay a devDependency

The package that gets vendored stays pinned in `package.json` `devDependencies`, never `dependencies`. Promoting it to `dependencies` does not make the vendored copy redundant — the installer never runs `npm install` on your behalf inside a target tree, so a runtime `dependencies` entry buys nothing there — and it actively breaks every already-installed tree's own `npm install`/`npm ci` step, which now expects a package that is not vendored anywhere the installed tree can see. #3496 is the concrete cost of getting this wrong: promoting a vendored package to `dependencies` produced 100 test failures across 8 install-surface suites. `devDependencies` is correct precisely because the vendored copy, not the npm-resolved package, is what ships at runtime; the devDependency exists only so this repo's own build/lint/test tooling has something to byte-compare the vendored copy against.

## Picking the right upstream artifact

Not every file the package ships is vendorable. You need a **self-contained CJS or UMD bundle** — one file, loadable with a single `require()`, containing zero `require()` calls of its own to anything outside Node builtins. Do not reach for the package's `exports.require`/`main` entry point (often `index.js`) without checking it first: that entry is frequently a thin loader that `require()`s several sibling files, which is exactly the shape vendoring cannot tolerate (a vendored `index.js` copied alone would throw at runtime looking for siblings that were never copied). Look instead for a `dist/` bundle purpose-built for standalone consumption.

For js-yaml (ADR-3473 §8.1, #3881) the correct artifact is `dist/js-yaml.js` — the UMD bundle, self-contained, loads under `require()` with zero external `require()` calls, and exposes the symbols this repo needs (`load`, `dump`, `FAILSAFE_SCHEMA`, `YAMLException`). The tempting-looking `index.js` (the `exports.require` entry point) is **not** self-contained and is the wrong choice. Verify your candidate the same way: `require()` it in isolation (outside this repo's `node_modules` resolution, e.g. from a scratch directory with only that one file present) and confirm it loads without reaching for a sibling file.

## Adding the `VENDORED` manifest row

`scripts/lint-vendored-deps.cjs` is table-driven over a `VENDORED` array (one row per vendored package) rather than hardcoded to a single package — this is deliberate (ADR-3473 §8.3, "one implementation per rule"): adding a second or third vendored package should never require a second hardcoded check block. Add a row:

```js
{
  name: 'your-package',                                    // matches package.json devDependencies key
  upstreamCjs: 'node_modules/your-package/dist/bundle.js',  // the self-contained artifact you picked above
  vendoredCjs: 'gsd-core/bin/lib/vendor/your-package.cjs',
  upstreamDts: null,           // or a path, if the package ships its own .d.ts/.d.cts
  vendoredDts: null,           // or the gsd-core/bin/lib/vendor/ copy of that .d.ts
  srcTwin: 'src/vendor/your-package.d.cts',
  twinKind: 'hand-authored',   // or 'upstream-verbatim' — see below
},
```

Then copy the artifact in:

```
cp node_modules/your-package/dist/bundle.js gsd-core/bin/lib/vendor/your-package.cjs
```

## The two kinds of type twin

Every vendored package needs a `.d.cts` under `src/vendor/` so TypeScript can resolve types for the relative `./vendor/your-package.cjs` import from `src/**` — module resolution for a `.cts` source is relative to `src/`, not the compiled output directory, so `gsd-core/bin/lib/vendor/your-package.d.cts` alone is not enough. There are two kinds, distinguished by `twinKind`:

- **`upstream-verbatim`** — the package ships its own `.d.ts`/`.d.cts` upstream. Copy it verbatim to both `gsd-core/bin/lib/vendor/your-package.d.cts` and `src/vendor/your-package.d.cts`. `lint-vendored-deps.cjs` byte-compares both copies against the upstream file and against each other, so any manual edit is caught as drift.
- **`hand-authored`** — the package ships no type declarations upstream (js-yaml's case: no bundled `.d.ts`, and `@types/js-yaml` is not installed). Write `src/vendor/your-package.d.cts` by hand, declaring only the symbols this repo actually imports — narrower is safer, since anything not declared is simply unreachable from typed code. This twin is **excluded** from the byte-compare (there is no upstream file to compare it against) and is instead pinned by a test asserting the declared surface matches what the module actually uses.

Set `upstreamDts`/`vendoredDts` to `null` for a hand-authored twin — `checkRow` in `scripts/lint-vendored-deps.cjs` skips the byte-compare checks entirely when either is `null`.

## Document it in `gsd-core/bin/lib/vendor/README.md`

Add an entry alongside the existing ones: which upstream artifact you copied, why it (and not the package's main entry point) is the vendorable one, which symbols it exposes, and the refresh command. This is the first place a future contributor looks when `lint-vendored-deps.cjs` reports drift.

## The `docs/INVENTORY.md` row

`gsd-core/bin/lib/vendor/your-package.cjs` is a shipped file under `gsd-core/bin/**`, so it needs a row in `docs/INVENTORY.md` per the inventory-drift rule for anything added under a manifest-scanned directory. Describe it as a vendored third-party artifact (not a GSD module), name the ADR/issue that introduced it, and cross-reference `gsd-core/bin/lib/vendor/README.md`.

## The ordering trap: build before you regenerate the manifest

`node scripts/gen-inventory-manifest.cjs --write` derives its manifest from the **compiled** `gsd-core/bin/**` tree, not from `src/**`. If you regenerate the inventory manifest before running `npm run build:lib`, the generator either misses your new vendored file (if `gsd-core/bin/lib/vendor/your-package.cjs` was not yet copied in) or captures a stale prior build's contents. The required order is:

1. `cp node_modules/your-package/dist/bundle.js gsd-core/bin/lib/vendor/your-package.cjs` (and the type twins, per above)
2. `npm run build:lib`
3. `node scripts/gen-inventory-manifest.cjs --write`

Running step 3 before step 1/2 produces a manifest that silently omits or misdescribes the new vendored file, and that drift is exactly what the manifest gate exists to catch on someone else's PR instead of yours.

## Verifying

- `node scripts/lint-vendored-deps.cjs` — exits 0 once the vendored copy, its type twins (if `upstream-verbatim`), and the `package.json` devDependency version pin all agree with `node_modules`.
- `npx tsc --noEmit -p tsconfig.json` — confirms the `src/vendor/*.d.cts` twin actually resolves for every `.cts` importer.
- `npm run lint` — confirms `local/no-external-require-in-bin` still finds zero external requires under `gsd-core/bin/**`.

---

## Related

- `gsd-core/bin/lib/vendor/README.md` — the vendored-files README this how-to keeps in step with
- `scripts/lint-vendored-deps.cjs` — the table-driven freshness gate (`VENDORED` array)
- `eslint-rules/no-external-require-in-bin.cjs` — the rule that makes vendoring necessary in the first place
- ADR-3473 §8.1 (#3881) — the js-yaml vendoring this how-to was extracted from
- [docs index](../README.md)
