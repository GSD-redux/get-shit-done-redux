# How to migrate an install test to the executed plan

**Goal:** Convert a test group that probes install output with `fs.existsSync` into a value assertion against the executed plan `installRuntimeArtifacts` now returns — without silently dropping coverage the probes established.

**Prerequisites:** A test in `tests/install.test.cjs` (or a sibling install test file) that installs a runtime and then calls `fs.existsSync`/`fs.readFileSync` against the destination to confirm something landed.

---

## What `installRuntimeArtifacts` now returns

`installRuntimeArtifacts` (`src/install-engine.cts:770`) no longer returns `void`. Every call — including the opencode/kilo combined-family path, which used to early-return `undefined` — now returns:

```
{
  runtime,
  scope,
  kinds: [{ kind, sourceDir, destDir, preserved }],   // one entry per artifact kind actually written
  cleanup: [{ dir, ok }],                              // best-effort cleanupDirs, success visible per dir
  postSteps: { hermesBareStemCleanup, nativePlugin },  // booleans for the two post-steps
}
```

`kinds` names every kind the layout wrote this call (`skills`, `agents`, `commands`, …), each with the `sourceDir`/`destDir` it copied between and which user-owned subdirs (e.g. `gsd-dev-preferences`) were preserved across a wipe-and-replace. `cleanup` makes a previously-silent, best-effort `rmSync` failure visible instead of swallowed. This value never claims bytes landed — see [What this cannot prove](#what-this-cannot-prove). For the full contract and the fs-adapter injection point, read the doc comment on `installRuntimeArtifacts` in `src/install-engine.cts` and the module doc in `src/install-fs-adapter.cts`; this guide covers only the migration mechanics.

---

## Migrating a probing test group

The worked example is the qwen group in `tests/install.test.cjs` (`describe('install/uninstall — qwen …')`, test `'installs GSD into ./.qwen and removes it cleanly'`). The pattern:

1. Run the real install as before (`install(false, 'qwen')`), unchanged.
2. Immediately after, call `installRuntimeArtifacts` again directly with the same `runtime`/`targetDir`/`scope`/resolved profile. Because the tree the first call wrote is already installed, this second call is an idempotent re-run (prune + rewrite converges to the same on-disk result) — it does no new writes, but it surfaces the same executed-plan value the first call's caller (`bin/install.js`) discarded.
3. Replace each `fs.existsSync(destPath)` probe that was checking a *destination directory's existence* with one `assert.deepStrictEqual` against the relevant `plan.kinds` entries — keyed by `kind`, read off `destDir`.
4. Leave every other probe exactly where it was (see the next section).

---

## The step people will get wrong: enumerate first

Before converting a probing group, list every fact its existing `fs.existsSync`/`fs.readFileSync` calls establish. Convert only the facts the plan's per-kind contract actually covers. A migration that asserts *less* than the probes it replaces looks like a simplification and is a regression — a shrinking assertion surface with no visible signal that coverage was dropped.

In the qwen migration, nine facts were enumerated. Only **two** moved to the value assertion — that `skills` and `agents` kinds wrote to the expected `destDir`. The other **seven** were deliberately retained as `fs` probes, because they sit outside the plan's per-kind contract (one `destDir` per kind, not a file list, and not everything the surrounding `install()`/`uninstall()` functions do):

- the specific nested `SKILL.md` file existing at its stem-level path (finer-grained than a per-kind `destDir`)
- the `gsd-core/VERSION` file, written by `install()`'s own copy step, not by `installRuntimeArtifacts`
- the manifest's file-key content (`writeManifest`'s own output, not the executed plan)
- four post-uninstall absence checks

Before converting a group of your own, write down that same enumeration — what each existing probe proves — and mark each fact "covered by `plan.kinds`" or "stays a probe, because …". If you cannot state the "because", the fact likely belongs on the value-assertion side; if you can, keep the probe. Do not delete a probe just because it is adjacent to one that migrated cleanly.

---

## Testing against a fake adapter

An install can be driven end-to-end with no real filesystem contact by injecting a fake `InstallFsAdapter` as the 7th positional argument's `.fs` key:

```js
const result = installRuntimeArtifacts(
  runtime, configDir, scope, resolvedProfile, undefined, undefined,
  { fs: fakeFs },
);
```

`fakeFs` must implement the methods the exercised code path actually touches — `existsSync`, `mkdirSync`, `rmSync`, `readdirSync`, `readFileSync`, `writeFileSync`, `copyFileSync`, `cpSync`, `lstatSync`, `realpathSync`, `unlinkSync`, `rmdirSync`, and (for anything that reaches `installer-migrations.cts`'s `sha256File`) the raw-fd trio `openSync`/`readSync`/`closeSync`. `tests/executed-plan.test.cjs`'s `createFakeInstallFs` is a working in-memory reference implementation over one `Map<absPath, entry>` store — reuse it rather than writing a partial fake from scratch.

Two traps, both documented at the seam in `src/install-fs-adapter.cts`'s module comment:

- **A partial fake silently falls back to real `fs` for any method it omits.** `withInstallFs` merges your injected object *over* the real adapter (`{ ...REAL_ADAPTER, ...partial }`), so an incomplete fake is not a smaller fake — for the methods it does not define, it *is* the real filesystem, doing real IO you did not intend and your test will not flag.
- **The seam is ambient and synchronous-only.** One mutable module-level variable holds "the active adapter" for the duration of one synchronous call; there is no `async`/await anywhere on the routed call tree. Do not run two installs concurrently in the same process (the second `withInstallFs` call clobbers the first's adapter mid-flight), and do not defer any work — a `setTimeout`, a promise continuation, a `process.on('exit', …)` callback — that reads `installFs()` past the point `withInstallFs`'s `finally` has already restored the previous adapter. (`install-profiles.cts`'s deferred skill-dir cleanup avoids this trap by capturing the adapter *object* at staging time instead of re-resolving it later — read that code before writing your own deferred cleanup against this seam.)

---

## The destination-vs-package-source boundary

The seam's claim is **zero real destination IO**, never zero real IO. `findInstallSourceRoot`, `findAgentsSourceRoot` (both `src/runtime-artifact-layout.cts`) and `readGsdCommandNames` (`src/command-roster.cts`) are deliberately left unrouted — they locate *this package's own source tree* (`commands/gsd/`, `agents/`), not the install destination. A destination-fake's in-memory store starts empty and is never seeded with the repo's own real paths; routing those lookups through it would make every fake-adapter install throw "could not locate commands/gsd" instead of exercising the install.

`tests/executed-plan.test.cjs`'s F2 test group encodes this boundary by poisoning **by path**, not by method: `poisonRealFsAgainstDestination` wraps every fs method the routed call tree touches so that a call against a non-package-source path throws, while a call whose resolved path falls under `commands/gsd/` or `agents/` is allowed through to the real filesystem and counted. Each F2 test then positively asserts the package-source count is non-zero (`packageSourceHits.get('readdirSync') > 0`), proving the unrouted read actually happened rather than merely being tolerated.

Do not poison by method (blocking `readdirSync`/`statSync` outright regardless of target path). That makes a correct, unmodified `findInstallSourceRoot`/`readGsdCommandNames` fail for a reason that has nothing to do with destination-IO routing — a mistake already made once on this seam. If you add a test asserting no real fs contact, derive your poison set from the destination/package-source rule above, and re-derive it (not copy-paste it) if the routed call tree changes.

---

## What this cannot prove

The executed plan describes what `installRuntimeArtifacts` *executed* — which kinds it wrote to, which dirs it preserved, which cleanup it attempted and whether that attempt succeeded. It is not a post-hoc verification that bytes are on disk. A best-effort `cleanup` entry with `ok: false` means the `rmSync` call was attempted and failed, visibly — the install still succeeds either way. When you need proof of on-disk state rather than proof of what was attempted, that is exactly the case an `fs.existsSync`/`fs.readFileSync` probe still earns its place, per the enumeration step above.

---

## Related

- [ADR-58](../adr/58-runtime-install-policy-module.md) — the policy/adapter boundary this seam implements
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — why install correctness is modeled this way
- `src/install-fs-adapter.cts` — the adapter seam's own module doc (delivery mechanism, partial-adapter trap, deliberately-unrouted list)
- `.gsd/phase/feat-2874-executed-plan-return/40-design.md` — the design doc this phase shipped against
- [docs index](../README.md)
