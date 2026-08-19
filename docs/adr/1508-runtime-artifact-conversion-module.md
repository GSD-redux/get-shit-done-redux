# Runtime Artifact Conversion Module owns per-runtime content rewriting

- **Status:** Accepted
- **Date:** 2026-06-20
- **Issue:** #1508
- **Epic:** #1507
- **Implementation:** Phase 1 (helper relocation, no behavior change) → Phase 2 (engine move + relay deletion)

The **Runtime Surface Module** (`src/surface.cts` → `surface.cjs`) re-materializes a resolved skill surface to disk via `applySurface`. For `skills` kinds it must rewrite staged `SKILL.md` bodies so their `@`-ref paths point at the install target (`pathPrefix`) instead of the converter's default `~/.claude` paths (#813). To do that it reaches **up** into the 12,289-line hand-authored `bin/install.js` via `getInstallExports()` (`src/runtime-artifact-layout.cts:53-69`) — a lazy `require('../../../bin/install.js')` guarded by a save/set/restore of `GSD_TEST_MODE` — to borrow `computePathPrefix` and `applyRuntimeContentRewritesInPlace`.

This is the **last upward dependency from the `.cts` source tree into the hand-authored installer**. It forces an env-var dance at a test seam, and it leaks: `applySurface` (and `bin/install.js`'s own three call sites) each re-derive the same five path-prefix inputs (`scope→isGlobal`, `runtime==='opencode'`, `process.platform`, normalized `resolvedTarget`, normalized `homeDir`) before calling `computePathPrefix`. The prefix-derivation knowledge is duplicated across `surface.cts` and `install.js`.

`CONTEXT.md` already names the **Runtime Artifact Conversion Module** (`src/runtime-artifact-conversion.cts`) as the `[Planned]` sibling of the Layout Module — placement vs. content. ADR-3660 *§Initial Scope* deferred exactly this consolidation: *"A future ADR may consolidate them into a Skill Conversion Module if a second consumer emerges."* `surface.cts` is that second consumer. This is that future ADR.

## Decision

- Promote the `[Planned]` **Runtime Artifact Conversion Module** (`src/runtime-artifact-conversion.cts`) to the single owner of per-runtime **content rewriting**: the per-runtime converters (already relocated as ADR-3660's "first slice", #1099), **plus** the rewrite engine `_applyRuntimeRewrites`, the staged-content walkers, path-prefix derivation, and commit attribution. The **Runtime Artifact Layout Module** keeps owning **placement** only. **Exception:** opencode and kilo path-prefix rewriting remains a deliberate `bin/install.js`-owned pre-conversion step (see `applyOpencodeFamilyPathPrefix`); this is intentional per #784 and is not a violation of the single-owner rule.
- **Public seam** — two deep calls; the caller passes only what it has, the module derives the rest:
  - `rewriteStagedSkillBodies(stagedDir, { runtime, configDir, scope }, env?)` — in-place walk (skills / kimi-agents).
  - `rewriteStagedCommandBodies(stagedDir, { runtime, configDir, scope }, env?) → tempDir` — copy-to-temp (commands).
  - The module internally derives `isGlobal`/`isOpencode`/`isWindowsHost`/`resolvedTarget`/`homeDir` and the path prefix. `env = { homedir = os.homedir, platform = process.platform } = {}` is an injected test seam (the clock-seam analog, `RULESET.TESTS.clock-seam`).
- `computePathPrefix` becomes **private** to the module, exported as `_computePathPrefix` for direct unit + `fast-check` property tests (`RULESET.TESTS.property-based-testing`). The hand-reimplemented copy in `tests/path-replacement.test.cjs` is deleted so the **real** function is what's tested (it is effectively untested today).
- **Dependency direction:** `bin/install.js` and `runtime-artifact-layout.cts` import the conversion module; the conversion module imports **nothing upward** (not `install.js`, not `layout`) — only deeper leaves.
- `getDirName(runtime)` relocates to `src/runtime-name-policy.cts` (a clean `fs`/`path`-only leaf), so the conversion module can consume it **without** dragging in `capability-registry.cjs` (which `runtime-homes.cjs` requires). `processAttribution` / `getCommitAttribution` move **into** the conversion module (attribution is content transformation).
- The duplicate `convertClaudeToAugmentMarkdown` (verified **byte-identical** in `install.js:2584` and `conversion.cts:976`) collapses to the conversion-module copy; `install.js`'s local copy is deleted (it already re-exports `...runtimeArtifactConversion`).
- `getInstallExports` / `loadInstallExports` / the `InstallExports` interface **and the `GSD_TEST_MODE` require of `bin/install.js`** are deleted from `runtime-artifact-layout.cts`. `surface.cts` (the sole consumer) calls the conversion module's deep functions directly — removing the last upward `.cts → install.js` dependency.

## Initial Scope

### Phase 1 — helper relocation (no behavior change)
1. Move `getDirName` → `runtime-name-policy.cts`; re-point its 13 `install.js` call sites.
2. Move `processAttribution` + `getCommitAttribution` → `conversion.cts`; re-point their 21 `install.js` call sites.
3. Delete `install.js`'s local `convertClaudeToAugmentMarkdown` (copies confirmed byte-identical); rely on the conversion-module copy via the existing `...runtimeArtifactConversion` export spread. Add a **characterization test** snapshotting current augment skills-rewrite output as insurance — it should pass unchanged.
4. No public-interface change; `install.js` and `surface.cts` behavior unchanged.

### Phase 2 — engine move + deepen + delete relay
1. Move `_applyRuntimeRewrites`, `applyRuntimeContentRewritesInPlace`, `applyRuntimeContentRewritesForCommandsInPlace`, and `computePathPrefix` into `conversion.cts`.
2. Expose `rewriteStagedSkillBodies` / `rewriteStagedCommandBodies`; privatize `computePathPrefix` (`_computePathPrefix` for tests).
3. `surface.cts:applySurface` and `install.js`'s three internal sites (`7261`/`7276`, `9475`) call the deep functions; delete the per-site prefix derivation.
4. Delete `getInstallExports` / `loadInstallExports` / `InstallExports` + the `GSD_TEST_MODE` `bin/install.js` require from `runtime-artifact-layout.cts`.
5. Tests: `fast-check` property test for the rewrite engine (`$HOME`-collapse invariant; path-rewrite idempotency), direct `_computePathPrefix` unit tests, delete the `path-replacement.test.cjs` reimplementation, and a `DEFECT.GENERATIVE-FIX` parity guard ensuring no second converter copy reappears.

### These phases should NOT
- Bundle ADR-3660 **Phase 2** (install/uninstall `layout.kinds` loop collapse, ~250 lines, separate issue #3664).
- Relocate `getConfigDirFromHome` or other general install helpers the rewrite engine does not need.

## Migration Inventory

### New files
- `docs/adr/1508-runtime-artifact-conversion-module.md` (this ADR) + README index row.
- `CONTEXT.md` glossary: flip **Runtime Artifact Conversion Module** `[Planned]` → shipped, and update the Runtime Artifact Layout Module entry (the `getInstallExports` seam sentence is removed). *(lands with Phase 2)*

### Phase 1 modified
- `src/runtime-name-policy.cts` — `+getDirName`.
- `src/runtime-artifact-conversion.cts` — `+processAttribution`, `+getCommitAttribution`.
- `bin/install.js` — re-point 13 (`getDirName`) + 21 (attribution) call sites; delete local `convertClaudeToAugmentMarkdown`.
- tests — augment characterization test.

### Phase 2 modified
- `src/runtime-artifact-conversion.cts` — `+_applyRuntimeRewrites`, `+`both walkers, `+computePathPrefix` (private) + deep seam.
- `src/surface.cts` — deep-call cutover; drop the `getInstallExports` import + prefix math.
- `src/runtime-artifact-layout.cts` — delete `getInstallExports`/`loadInstallExports`/`InstallExports` + the `install.js` require.
- `bin/install.js` — three sites call the deep functions; import them back from the conversion module.
- tests — engine property test, `_computePathPrefix` unit tests, delete `path-replacement.test.cjs` reimplementation, parity guard.

## Consequences

- **+** `surface.cts` and `install.js` stop re-deriving the path prefix — one owner, leak dissolved at both sites.
- **+** The `.cts` source tree no longer reaches into hand-authored `bin/install.js`; `runtime-artifact-layout.cts` no longer requires `install.js` or toggles `GSD_TEST_MODE`.
- **+** `computePathPrefix` gains real unit + property coverage it lacks today.
- **−** `bin/install.js` stays hand-authored JS; it now imports the rewrite engine back from the generated `conversion.cjs` — the same pattern it already uses for `hooksSurface` and `...runtimeArtifactConversion`. Only the moved functions become TypeScript; `install.js` itself is not converted.
- **−** Two-phase sequence; CONTEXT.md glossary, ADR README index, and `lint:ci` (ADR-HEADER) updates required at merge.

## Relationship to other ADRs and issues

- **ADR-3660 (Runtime Artifact Layout Module):** resolves its *§Initial Scope* deferral ("A future ADR may consolidate them … if a second consumer emerges"). Layout owns placement; this module owns content. Independent of ADR-3660 **Phase 2** (#3664).
- **ADR-457 (generated-CJS single source):** the moved engine is authored in `src/*.cts` and consumed as generated `bin/lib/*.cjs`, consistent with the single-source rule.
- **ADR-1235 (descriptor-driven agent conversion):** complementary — both narrow `bin/install.js`'s ownership of conversion concerns.
- **Epic #1507** tracks the phases. **Distinct from epic #1258** (cross-runtime skill mapping + plugin skill provision/consumption): #1258 Phase A documents the converter *transform-contract catalog*; this ADR decides *module ownership + dependency direction + engine relocation*. Continues **#1099** (closed first slice that created the module) and is a sibling of **#1173** (agent-converter wiring).

## Amendment — 2026-06-24: Implementation complete (epic #1507 closed)

The decision recorded above is **implemented** on `next`. The ADR `Status` stays **Accepted** — per this directory's append-only convention there is no "Implemented" status; this dated amendment records that the decision is realized.

Landed:
- **Phase 1 (#1512):** `getDirName` → `src/runtime-name-policy.cts`; `processAttribution` → `src/runtime-artifact-conversion.cts`. (`getCommitAttribution` stays in `bin/install.js` — a documented scope refinement: it is impure install-time config I/O, not a content-transformation helper, so it cannot move into the pure conversion module. Phase 2 injects the resolved attribution value instead.)
- **Phase 2 (#1513):** the content-rewrite engine (`_applyRuntimeRewrites`), both staged-content walkers, and `computePathPrefix` (private; `_computePathPrefix` for tests) live in `src/runtime-artifact-conversion.cts` behind the deep seam `rewriteStagedSkillBodies` / `rewriteStagedCommandBodies({runtime, configDir, scope, homedir?, platform?, resolveAttribution?})`. The `getInstallExports` / `loadInstallExports` / `InstallExports` relay and the `GSD_TEST_MODE` install.js `require` are **deleted** from `src/runtime-artifact-layout.cts` — the last upward `.cts → bin/install.js` dependency is gone. `CONTEXT.md` marks the module **SHIPPED**. (The install-side cutover lands one indirection deeper than the literal issue text — `install.js` delegates to `createRuntimeArtifactInstallPlan`, which performs the deep calls in `src/runtime-artifact-install-plan.cts` — satisfying the same dependency-direction intent with a cleaner owner.)

Two deferred follow-ups were spun out as **sub-issues of #1507** and have since been **delivered** (neither was a blocker; the architectural goal — single ownership, downward dependency direction, relay deletion — was already met by the merged slices above):
- **#1675** (PR #1685) — deduped the byte-identical `convertClaudeToAugmentMarkdown` / `convertSlashCommandsToAugmentSkillMentions` between `bin/install.js` and the conversion module (the Phase 1 → Phase 2 deferred cleanup; install.js now binds them from the conversion module, single-sourced).
- **#1676** (PR #1686) — added the `fast-check` property test (`$HOME`-collapse invariant + path-rewrite idempotency) promised in #1511's test scope.

Delivery verified by a Codex (`gpt-5.4`, high-effort, read-only) review against the epic's stated deliverables, cross-checked against the indexed code graph and live source.

## Amendment — 2026-08-17 (#2876): the re-export mandate's stated beneficiary was the test suite

This ADR's relocation slices, and ADR-857's before them, kept a re-export spine in `bin/install.js`
so that *"existing consumers that do `require('../bin/install.js').writeCursorHooksJson` (etc.)
continue to work unchanged"* — the wording carried in `src/runtime-hooks-surface.cts`'s own header.

**Epic #2866 Phase 7 measured the consumers. There are none.**

`bin/install.js` exported **197** names. Every reference to it outside `tests/` — in `src/`,
`hooks/`, `scripts/` and `bin/` — sits **inside a comment**, including the one in
`runtime-hooks-surface.cts` that named the case. Not one line of production code has ever required
the file. The 44 consumers are test files.

So the pattern was real and the reasoning behind it was sound; the beneficiary was simply
misidentified. The compatibility spine was preserving access for a caller that did not exist, while
the actual dependency — the test suite reaching implementation through the installer rather than
through the modules that own it — went unnamed and therefore unmanaged.

**What Phase 7 changed.** 9 dead exports and 61 pass-throughs are gone; their tests now import the
extracted modules directly. `bin/install.js` exports **127** — 197 − 9 − 61 — and every one of those
127 is substantive local implementation. They are not a compatibility wall; they are code with no
other home yet, and extracting them is a different piece of work.

**What this does not change.** The dependency direction this ADR established — installer and layout
import the conversion module, the conversion module imports nothing upward — is untouched, and so is
ADR-857's capability-registry contract. Relocation still requires the moved symbol to keep working
for its real callers; the correction is only about who those callers are.

**The generalizable point.** A back-compat re-export is a claim about consumers, and a claim about
consumers is checkable. This one went four ADRs and several epics without being checked, which let
an interface be shaped by test access while everyone believed it was shaped by callers. Before
adding a compatibility layer, enumerate what it is compatible *for*; if the answer is "the tests",
the honest fix is to point the tests at the owning module.
