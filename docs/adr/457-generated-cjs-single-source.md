# ADR 457: Generation model for `bin/lib/*.cjs` type safety [Accepted]

- **Status:** Accepted
- **Date:** 2026-05-28 (rewritten and accepted 2026-05-31 after correcting fabricated context)

> **Accepted direction:** build-at-publish (model 2 below). Implementation is
> tracked in a separate migration issue and proceeds module-by-module. The sole
> prerequisite — the ESLint harness (ADR 452) — is already **accepted/merged**.
>
> **Provenance note.** An earlier draft of this ADR (and issue #457) was authored
> by an agent and asserted a codebase state that did not exist — "~13 files
> generated from `.ts` via `tsc`", `gsd-core/src/` / `sdk/src/` source trees,
> and a `tests/cjs-ts-parity.test.cjs`. None of those existed. This rewrite
> grounds the decision in verified ground truth. Do not restore the earlier
> "natural completion of the 13 generated files" framing; it was fiction.

## Context

### What actually exists today (verified 2026-05-31)

- `gsd-core/bin/lib/` holds **84** `.cjs` files. **Exactly one** carries a
  `// @generated` header: `package-identity.cjs`.
- That one generated file is **not** `tsc` output. It is produced by
  `scripts/generate-package-identity.cjs` — a plain Node script that reads
  `package.json` and **bakes literal coordinate values** into a CJS module.
- There is **no** `gsd-core/src/` or `sdk/src/` TypeScript tree. There is
  **no** TS→CJS transpilation pipeline. There is **no**
  `tests/cjs-ts-parity.test.cjs`. The only parity test is
  `tests/issue-498-package-identity.test.cjs`, scoped to the one baked file: it
  regenerates from `package.json` and asserts the committed output is not stale.
- `tsconfig.lint.json` exists with `allowJs` + `checkJs`, but it is **not**
  wired into `eslint.config.mjs`. The `.cjs` config block (`eslint.config.mjs`
  lines 61–92) sets only `sourceType`/`globals` — **no `parser`, no
  `parserOptions.project`, no `projectService`, and no `@typescript-eslint`
  rule** is enabled. A comment on line 60 nonetheless *claims* "Type-aware via
  parserOptions.project=tsconfig.lint.json" — so the file is linted **without**
  type information while the config advertises the opposite.
- `eslint.config.mjs` lists 12 files in `GENERATED_CJS_IGNORES` and treats them
  as generated (never linted) — but those 12 are all **hand-written** (verified:
  none carry an `@generated` header). This is a latent inconsistency: the lint
  config already pretends a generation pipeline exists for them.

So the real situation is: **83 hand-written `.cjs`, 1 value-baked `.cjs`, and a
lint config that already advertises — in a comment and in a 12-file ignore list
— a type-aware generation pipeline that was never built.**

### Two different things are both called "generation"

This distinction is the crux of the decision, and the earlier draft erased it:

- **Value baking (exists, forced).** `package-identity.cjs` must be generated
  because the *installed* tree carries no `package.json` with a `.name`. The
  only ones GSD stages are synthetic `{"type":"commonjs"}` markers — and since
  #2544 those sit inside the directories GSD owns (`hooks/`, and the native
  plugin dir), not at the runtime config root — so a runtime
  `require('package.json').name` is `undefined` where it resolves at all, and
  a `MODULE_NOT_FOUND` where it does not (bug #378; see also the Codex case in
  `src/runtime-artifact-conversion.cts`, whose root never carried one). The
  values literally cannot be read at runtime;
  baking them at build time is the only option. **Deletion test:** remove the
  generator and the complexity reappears across every consumer. It is a deep
  seam and earns its keep.

- **Transpilation (proposed, optional).** Authoring `bin/lib` logic as TS and
  emitting `.cjs` via `tsc`. **Deletion test:** remove it and *nothing*
  reappears — a hand-written `.cjs` and a `tsc`-emitted `.cjs` are behaviorally
  identical at runtime. The seam buys **no runtime leverage**. Its entire value
  is **author-time and CI type checking**.

`package-identity` is therefore **not** precedent for the proposed transpilation
work. They are different techniques with different forcing functions.

### The problem actually worth solving

Type safety on the hand-written runtime surface is **second-class**: type errors
surface (if at all) as lint findings via the un-wired `tsconfig.lint.json`, not
as compile errors. Any contributor — human or agent — adding a `bin/lib` file
must decide hand-write vs generate, with no enforced answer. That inconsistency
is real and grows.

## The decision this ADR must make

Type-checking TS sources is the goal. The load-bearing question the earlier
draft skipped is: **do we check the generated `.cjs` into git, or treat it as a
build artifact?** Three models:

1. **Check in both `.ts` source and `.cjs` output.** Creates a permanent
   "two copies must match" invariant, requiring parity tests, dual commits, and
   a pre-commit/CI drift gate. This is the model the earlier draft assumed —
   inherited from value-baking, where checking in output is *forced*. For
   transpilation, nothing forces it, so this imports maximum friction for no
   runtime gain.

2. **Build at publish (recommended).** `bin/lib/*.cjs` becomes a gitignored
   build artifact emitted from a TS `src/` tree by `tsc`; npm publishes the
   built output. **Feasible today:** `package.json` already ships `gsd-core`
   and `scripts` via its `files` array, and already runs a pre-publish build
   step (`"prepublishOnly": "npm run build:hooks"`) — the `.cjs` emit hooks into
   the same step, and `npm pack` includes on-disk artifacts regardless of
   `.gitignore`. No drift invariant, no parity test, no dual commits — the
   "Negative" consequences below mostly evaporate. Cost: contributors run a
   build to exercise local changes, and CI must build before test.

3. **Build at install.** Rejected: fragile across Node versions and platforms
   (CONTEXT.md notes Windows / Node 24 hazards) and slows every install.

## Decision [Accepted]

1. **Pursue type safety via a TS `src/` tree compiled with `tsc`**, adopting
   **model 2 (build at publish)**: TS source is canonical, `.cjs` is a
   gitignored artifact. This dissolves the drift-policing machinery rather than
   building it.
2. **Keep value baking separate.** `package-identity.cjs` stays a checked-in
   baked artifact under its existing generator and parity test; the install-tree
   #378 constraint is unaffected by this ADR.
3. **Migrate incrementally, lowest-coupling module first**, behind one pilot PR
   that stands up the `src/` tree + build wiring for a single module before any
   bulk move.
4. **Reconcile the lint config to reality first.** The 12-entry
   `GENERATED_CJS_IGNORES` list currently lies about hand-written files; it must
   be corrected (those files linted as hand-written) before, not after, a
   pipeline exists — otherwise the inconsistency masks the migration's progress.
5. **Wire type-aware linting** to the real `tsconfig.json` as modules become TS;
   retire `tsconfig.lint.json` only when the last hand-written `.cjs` is gone.

## Consequences

### Positive
- Type-aware `typescript-eslint` rules apply to migrated runtime code.
- No checked-in generated `.cjs`, so **no** drift invariant and **no** parity
  test to maintain for the transpiled surface (contrast: the rejected model 1).
- One enforced answer to "hand-write or generate?" for new `bin/lib` code.

### Negative
- A build step now sits between editing `src/*.ts` and running `bin/lib/*.cjs`.
  Local dev and CI must build before exercising runtime behavior.
- Migration touches ~83 files; each may surface latent type errors to fix.
- Tooling that today reads `bin/lib/*.cjs` from a checkout (not an install) must
  build first or read from `src/`.

### For testing
- Tests importing `bin/lib/*.cjs` keep working **only if** the build has run;
  the test command must depend on the build. This is the main behavioral change
  versus today, where the `.cjs` is always present in the tree.

## Rejected Alternatives

- **(a) Keep the split indefinitely** — leaves the type-aware gap and the
  un-wired `tsconfig.lint.json` permanently. Rejected as a final state.
- **(b) Check in `.ts` + generated `.cjs` (model 1)** — imports a drift
  invariant, parity tests, and dual commits for zero runtime benefit. Rejected
  in favor of build-at-publish.
- **(c) Full ESM rewrite** — breaks `require()` consumers (no `"type":"module"`
  today); semver-major. Out of scope.
- **(d) Wire `tsconfig.lint.json` into ESLint and stop there** — keeps the
  stopgap permanent and never delivers compile-level (vs lint-level) type
  errors. Rejected as the final state, but acceptable as an interim while the
  pilot proves out.

## Open questions

- Does any consumer rely on `bin/lib/*.cjs` being present in a raw (un-built)
  checkout? If so, build-at-publish needs a `prepare`-script bridge.
- `tsc` CJS interop details (`esModuleInterop`, `__importDefault` shims) for the
  modules that re-`require` each other.
- Whether the pilot should be a leaf utility or one of the 12 mislabeled
  `GENERATED_CJS_IGNORES` files (which already advertise themselves as generated).

## References

- ESLint harness prerequisite (**accepted**): `452-eslint-lint-harness.md`
- Test-rigor policies (**accepted**): `456-test-rigor-architecture.md`
- Single-runtime collapse (**accepted**): `0174-retire-gsd-sdk-package-boundary.md`
- Superseded shared-module seam: `3524-cjs-sdk-hard-seam.md`
- Tracking issue: [#457](https://github.com/open-gsd/gsd-core/issues/457)
- Value-baking precedent (distinct technique): `scripts/generate-package-identity.cjs`,
  `tests/issue-498-package-identity.test.cjs`
