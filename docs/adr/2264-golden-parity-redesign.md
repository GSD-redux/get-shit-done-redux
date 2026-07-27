# ADR-2264: Redesign golden-install-parity — single-source manifest builder + split invariant

- **Status:** Superseded by [ADR-2719](2719-emitted-artifact-attribution.md) (Emitted-artifact attribution — replace the committed parity fixtures with a computed conservation law) (2026-07-27); originally Proposed (2026-07-14). ADR-2719 replaces Decision §2–§4 and the Amendment below; **Phase 1 (the single-source manifest builder) is retained and depended upon**, not reverted.
- **Date:** 2026-07-14
- **Issue:** [#2264](https://github.com/open-gsd/gsd-core/issues/2264) (epic); Phase 0 tracked by [#2265](https://github.com/open-gsd/gsd-core/issues/2265)
- **Supersedes:** nothing; amends the ADR-1239 Phase-B safety-net harness
- **Relationship to prior work:** Evolves `tests/golden-install-parity.test.cjs` (ADR-1239 Phase B). Related: #2086 (claude-local realpath normalization), #2095/#2100/#2117 (exclusion-set drift incidents), #1691 (scoped-CI drift guard).

## Why this was still `Proposed` (audited 2026-07-17; resolved by supersession 2026-07-27)

> **Resolved.** The unblock condition below proposed rewording AC1 away to match the amended design. [ADR-2719](2719-emitted-artifact-attribution.md) instead **satisfies** AC1, and supersedes Decision §2–§4 and the Amendment. Phase 1 is retained and depended upon. The audit is preserved unedited as the record of why.

Audited 2026-07-17 against the live tree and GitHub. Phase 1 shipped cleanly and is genuinely done: `buildParityManifest`, `buildInstallTree`, and the four exclusion constants (`VOLATILE_FILES`, `HOOK_CONFIG_FILES`, `HOOK_CONFIG_RELATIVE_PATHS`, `EXCLUDED_PREFIXES`) live as the single source of truth in `tests/helpers/install-shared.cjs` (lines 104-234); `scripts/gen-golden-install-parity-zcode.cjs` now imports them instead of re-declaring them; the anti-divergence guard (`tests/golden-parity-single-source.test.cjs`) enforces no second copy; `scripts/ci-test-scope.cjs` (lines 121, 145, 175-176) selects the golden suite on the wider path set the Amendment describes; `npm run gen:golden` (`package.json:93`) exists; and all five issues (#2264-#2268) are closed as completed.

**The blocker:** Acceptance criteria 3 and 4 name mechanisms that were never built. AC3 requires "A simulated converter bug ... caught by the converted-artifact golden" and AC4 requires "A simulated verbatim-copy corruption ... caught by the copy-parity property test" — neither `tests/fixtures/converted-artifacts/` nor any `*copy-parity*` test file exists anywhere in the tree (confirmed absent by direct filesystem check). The ADR's own same-day Amendment explains why (§3/§4 were found "unsound" in the Phase 2 spike) and states the old monolithic content-hash golden "is retained as-is" — but the Acceptance Criteria section itself was never edited to drop or reword AC1/AC3/AC4 to match the revised design. That leaves AC1 — the document's headline must-have, "editing the content of a verbatim/path-injected copied shipped file (e.g. a `workflows/*.md`) requires zero manual fixture regeneration" — literally unmet: `tests/golden-install-parity.test.cjs` still content-hashes every emitted file via the retained `buildParityManifest` (confirmed at `install-shared.cjs:218`, `crypto.createHash('sha256')`), and `EXCLUDED_PREFIXES` (`install-shared.cjs:154`) excludes only `gsd-core/bin/lib/` — `workflows/*.md` is still fully inside the hashed manifest, so editing one still requires `npm run gen:golden`. The functional invariants AC3/AC4 care about are still covered, but only by the legacy hash golden this ADR set out to partly replace, not by the mechanisms the criteria name.

**Unblock condition:** Edit the Acceptance Criteria section (items 1, 3, 4) to match the shipped, amended design — replace "zero manual fixture regeneration" and the named converted-artifact/copy-parity mechanisms with the criteria the Amendment actually delivers (file-set snapshot catches structural drift; the retained content-hash golden catches converter and copy corruption; `npm run gen:golden` is the one-command fix for legitimate content changes) — then flip Status. No further code work is required; this is a documentation edit against already-shipped, already-closed work.

## Context

`tests/golden-install-parity.test.cjs` snapshots the installer output for 18 runtime layouts. For each runtime it runs a real `runMinimalInstall`, walks every emitted file, normalizes volatile bits (temp root → `<HOME>`, package version → `<VERSION>`, macOS realpath `/private` → `<HOME>`), SHA-256s each file (16-char slice), and compares the entire path→hash map against a committed fixture under `tests/fixtures/golden-install-parity/*.json` (18 files, ~520 KB, ~7,500 hash lines).

It was created as a **refactor fence**: proof that moving `installRuntimeArtifacts` (ADR-1239) changed zero emitted bytes. That invariant is valuable and rarely triggered.

Four problems make it a recurring tax on ordinary code updates:

1. **It conflates two invariants.** ~95% of each manifest is "the installer copied a source file (`workflows/*.md`, `agents/*.md`, `templates/config.json`, `bin/shared/*.json`) to a destination." Those source files are **already version-controlled**. Storing a derived checksum of an already-tracked file adds ~zero review signal, yet every content edit to such a file trips the golden and forces a full 18-fixture regeneration. Only the ~5% of output that is **transformed** (per-runtime skill/command/agent projections produced by `runtime-artifact-conversion`: path rewrites, frontmatter edits, `@`-reference rewrites) is genuinely non-derivable from git and worth a content snapshot.

2. **Regeneration runs through a hand-maintained duplicate.** Local `node --test` is hook-blocked (`.claude/hooks/block-local-node-test.sh`), so regeneration goes through `scripts/gen-golden-install-parity-zcode.cjs`, which **re-declares the exclusion set and re-implements `buildParityManifest` inline**, kept in sync only by a comment: *"Must match tests/golden-install-parity.test.cjs exactly."* Its own comments record two prior drift incidents that shipped broken fixtures (#2100 missing `settings.local.json`; #2117 missing `.kimi/config.toml`).

3. **The duplicate has drifted again — a live divergence.** The test normalizes the macOS realpath form (`fs.realpathSync(root)` → collapse `/private/var/...`) added in #2086. The driver at `scripts/gen-golden-install-parity-zcode.cjs:51` does **not** — it only collapses bare `root` and `PKG_VERSION`. Regenerating any realpath-embedding layout (e.g. `claude-local`) on macOS via the driver bakes a literal `/private<HOME>` into the hashed content, which fails golden-parity on the Linux benches — the exact #2086 bug, reintroduced in the copy that was never fixed.

4. **The feedback loop is remote-only and the diff is unreviewable.** The suite runs solely in the `gsd-test` docker lane (and scoped CI when `src/`/`bin/`/installer paths change, per `scripts/ci-test-scope.cjs:117-145`) — never in local `npm test`. The loop is: edit → push → remote matrix fails → regenerate via the duplicate → re-push → re-run. A one-line `model-catalog.json` change rewrites hundreds of hash lines across 18 fixtures, burying the real change.

## Decision

Split the single monolithic content-hash manifest into three assertions with different change cadences, and collapse the manifest logic to a single source of truth so regeneration cannot drift.

### 1. Single-source manifest builder (Phase 1 — prerequisite refactor)

Lift `buildParityManifest` and the exclusion constants (`VOLATILE_FILES`, `HOOK_CONFIG_FILES`, `HOOK_CONFIG_RELATIVE_PATHS`, `EXCLUDED_PREFIXES`) out of the test into `tests/helpers/install-shared.cjs` (which already exports `walk`, `RUNTIME_META`, `runMinimalInstall`, `BUILD_SCRIPT`). The test and any generator import the one copy. Delete the inline re-implementation in `scripts/gen-golden-install-parity-zcode.cjs`. The #2086 `realRoot` divergence dies with the duplicate; the #2100/#2117 class of drift becomes structurally impossible. A guard test fails if a second inline copy of the exclusion set is reintroduced.

### 2. Emitted file-set snapshot — the tree shape (Phase 2a)

Per runtime, snapshot the **sorted list of emitted relative paths** (after the shared exclusions), with **no content hashes** → `tests/fixtures/install-tree/<runtime>.json` (a JSON array). This catches added / removed / renamed / moved files — the "installer stopped shipping X" or "installer emitted an unexpected Y" regression — and **changes only when the file set changes**, not when a file's content changes. The diff is proportional to the change (a few added/removed lines), not a rewrite of every hash.

### 3. Copy-parity property test — derive from source, store nothing (Phase 2b)

For every emitted file that is a copy (verbatim or copy-with-path-injection, e.g. `copyWithPathReplacement`), assert its normalized content is **derivable from its git-tracked source** — computed live at test time, no committed hash. The injected install path is the only variable and is already collapsed to `<HOME>` by normalization, so `normalize(emitted)` is the source content modulo a known, invertible substitution.

**Spike/risk (resolve in Phase 2 before committing to "fixture-free"):** validate that the path injection is cleanly invertible for every copied surface, so `normalize(emitted) === reference(source)` holds by pure derivation. Where a surface's injection is *not* cleanly invertible, that surface falls back to a small stored reference — but even then the reference is **re-derived from source at test time**, so a content edit to the source propagates automatically and needs **no manual regeneration**. This is the core win regardless of the spike outcome: content edits to copied files stop requiring hand-regenerated fixtures.

### 4. Converted-artifact golden — small and high-signal (Phase 2c)

Only the **transformed** outputs (per-runtime projections from `runtime-artifact-conversion`) keep a content-hash golden → `tests/fixtures/converted-artifacts/<runtime>.json`. This is the ~5% git cannot review (source is correct; the projection is derived and a converter bug corrupts it silently). The fixture is small and changes only when the converter logic or a converted source changes — exactly the changes that *should* require a human to bless. This gate stays a **hard failure** and is never auto-regenerated/auto-committed.

## Phases

- **Phase 0 — this ADR** ([#2265](https://github.com/open-gsd/gsd-core/issues/2265), docs-only PR on `docs/2265-golden-parity-adr`; PR `Closes #2265`, not the epic).
- **Phase 1 — single-source manifest builder** ([#2266](https://github.com/open-gsd/gsd-core/issues/2266), `refactor:`). Extract the shared builder + exclusions; delete the duplicate driver's inline copies; add the no-second-copy guard test. Expected fixture diff: **none** (byte-identical), which is the safety proof. Resolves the #2086 realRoot divergence.
- **Phase 2 — split invariant** ([#2267](https://github.com/open-gsd/gsd-core/issues/2267), `refactor:`/`test:`). Land the file-set snapshot (§2), the copy-parity property test + invertibility spike (§3), and the converted-artifact golden (§4). Migrate/replace the 18 monolithic fixtures once; delete the old per-file hash fixtures.
- **Phase 3 — optional, CI-owned regen** ([#2268](https://github.com/open-gsd/gsd-core/issues/2268), stretch). On file-set or converted-golden drift, CI regenerates and posts the exact patch as a PR artifact/comment (jest `--ci` posture: fail on new snapshot, regenerate deliberately) — never silent auto-commit for the converted golden. Optionally adopt Node's first-party `context.assert.snapshot` + `--test-update-snapshots` for §4 to delete the bespoke `UPDATE_GOLDEN` env + hand-rolled read/write/compare code.

## Acceptance criteria (must-haves)

1. Editing the content of a verbatim/path-injected copied shipped file (e.g. a `workflows/*.md`) requires **zero** manual fixture regeneration and the parity suite still passes. (Failing-first test: tweak a copied file, assert no fixture diff is needed.)
2. Adding/removing/renaming a shipped file is caught by the file-set snapshot with a diff proportional to the change.
3. A simulated converter bug (corrupt a transformed projection) is caught by the converted-artifact golden as a hard failure.
4. A simulated verbatim-copy corruption (installer truncates a copied file) is caught by the copy-parity property test.
5. The engine deep-refactor fence is preserved: the suite still proves byte-identical emitted output across all 18 runtimes.
6. Exactly one implementation of the manifest/exclusion logic exists; a guard test fails if a second copy is introduced.
7. macOS-generated fixtures match Linux-bench hashes (realRoot divergence resolved) — the #2086 class cannot reappear because there is one code path.

## Consequences

- **Positive:** the dominant churn trigger (content edits to copied files) becomes fixture-free; fixtures shrink from ~520 KB to a few KB; diffs become reviewable; the duplicate-driver drift class (#2100/#2117/#2086-realRoot) is eliminated; the refactor fence and converter-bug detection are preserved and sharpened.
- **Negative / risk:** copy-parity depends on modeling each surface's path injection (§3 spike). If a surface's injection is not cleanly invertible, it retains a small re-derived reference (still no manual regen). One-time migration churn to replace the 18 fixtures.
- **Neutral:** Phase 3 (CI-owned regen / `context.assert.snapshot`) is optional polish; the churn win lands in Phase 2.

## References

- `tests/golden-install-parity.test.cjs` — current harness
- `scripts/gen-golden-install-parity-zcode.cjs` — duplicate generator (to be deleted)
- `tests/helpers/install-shared.cjs` — shared install harness (target for the single-source builder)
- `scripts/ci-test-scope.cjs:117-145` — scoped-CI selection of the golden test
- ADR-1239 (Phase B safety net); issues #2086, #2095, #2100, #2117, #1691
- Node.js test runner: `context.assert.snapshot` + `--test-update-snapshots`
- Jest `--ci` snapshot posture (fail on new snapshot, deliberate `-u` regeneration)

## Amendment (2026-07-14): Phase 2 redesign — the copy/transform split was unsound

Implementing Phase 2 began with an empirical spike classifying every emitted install file. It **overturned the §2–§4 premise**:

- **The copy/transform boundary is not clean.** Nearly every emitted file passes through a *deterministic* rewrite (path-prefix canonicalization, `{{GSD_VERSION}}` stamping, hyphen-normalization) — even for claude, the reference host. Only ~36% of claude's files are byte-identical to source; ~64% are "transformed." A "content-hash only the transformed ~5%" golden (§4) was the wrong model.
- **The §3 from-source copy-parity property test is unsound.** Asserting `emitted == transform(source)` by calling the installer's own transform functions is largely tautological (it catches only non-determinism) — strictly *weaker* regression coverage than the current golden. Making it independent means reimplementing the transform in the test — the exact duplication this epic fights. It is also noisier than the golden it replaces: the harness's `configDir == $HOME` collapses path canonicalization differently than a real install, mis-classifying ~147 of claude's files as transforms.
- **The real defect was stale fixtures, not platform divergence.** The Phase-1 red (`gsd-statusline.js` + 3 claude-local files) was *deterministic* (macOS hash == Linux-bench hash for every entry); the fixtures were simply stale because `golden-install-parity` was not selected by CI when the emitting source (a `hooks/` file) changed, so it merged undetected.

**Revised Phase 2 (implemented in #2267):**

1. **File-set snapshot** — `tests/golden-install-tree.test.cjs` + `tests/fixtures/install-tree/*.json`: a per-runtime sorted list of emitted paths (no hashes), reusing the single-source exclusions via `buildInstallTree` (= sorted keys of `buildParityManifest`). Cheap structural coverage; changes only when the file *set* changes, giving a clean reviewable diff instead of hash noise.
2. **Anti-staleness CI selection** — `scripts/ci-test-scope.cjs` gains a rule selecting `golden-install-parity` + the file-set snapshot whenever an installed-source path changes: the four `gsd-core/` content subtrees (`workflows`, `templates`, `references`, `contexts`) + `gsd-core/bin/shared/*.json`, plus `hooks/**`, `commands/**`, `agents/**`, `skills/**`, and the shipped `scripts/*` files (`scripts/changeset/`, `scripts/lib/`, and three named generators) — not just `src/`/installer paths. `gsd-core/bin/**` (tsc-compiled) is deliberately excluded (already covered by the installer rule). This makes the #2266 silent-staleness class impossible: a source edit that changes emitted output re-verifies the fixtures at PR time.

3. **Regeneration convenience** (Phase 3, #2268) — an `npm run gen:golden` one-command regenerator (both fixture sets, each now self-building `hooks/dist`) that the golden-parity/tree failure messages point at, so drift caught by (2) is a one-command fix. The full CI-auto-comment (auto-posting the fixture patch on drift, jest `--ci` posture) is deferred: it needs a write-token workflow running on PR code (an injection surface) that cannot be verified locally.

**Deferred as an optional future refinement:** the §3-style content-dedup of verbatim copies. The *safe* subset (structurally raw-copied non-`.md`/`.js` data files) is modest, and the broad form is unsound — a `.md` file that is byte-equal today transforms the moment a self-reference is added, producing false property-test failures. Since the anti-staleness rule already removes the root pain (silent stale merges) and the file-set snapshot adds structural coverage, the content-hash golden is retained as-is; churn on *transformed* output is legitimate (you should review transformed output when you change its source).
