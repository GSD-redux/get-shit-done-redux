'use strict';

// allow-test-rule: source-text-is-the-product (see #2933) — this file asserts on the
// literal bytes of EMITTED install artifacts (the deployed contract for the
// #2933 propagation proof: a leaked `gsd:section` marker byte, or a dropped
// fragment edit, ships to every user). Mirrors
// tests/workflow-fragments-emission.install.test.cjs's own annotation — the
// ESLint no-source-grep rule only fires on readFileSync of a SOURCE
// .cjs/.js/.ts path followed by a text-search method, never on an installed
// .md artifact, so this is documentation of intent, not a required
// suppression.

/**
 * fragment-single-edit-propagation.install.test.cjs — 50-test-matrix.md rows
 * 1-20 (issue #2933, epic #1671 Phase 6.4).
 *
 * Acceptance proof for the #2933 "Done when" criterion: `npm run
 * regen:derived` propagates a single-fragment edit to every emitted
 * per-runtime artifact, with NO second source surface requiring an edit (no
 * stub frontmatter, no reference fragment, no docs/ ripple). See
 * `.gsd/phase/chore-2933-regen-derived-propagation/40-design.md` and
 * `50-test-matrix.md` for the full risk analysis this file discharges.
 *
 * ── Why this file never runs `--write` / `npm run regen:derived` ──────────
 *
 * `buildOverlayRepo` (./helpers/overlay-repo.cjs) HARD-LINKS every
 * unmodified leaf file from THIS checkout into a throwaway overlay tree. A
 * generator invoked with `--write` (or `npm run regen:derived`, which
 * chains several `--write` invocations) does an in-place `writeFileSync` —
 * through a hard link, that is the SAME INODE as this real repository's own
 * tracked file. Running `--write` (or `regen:derived` itself) inside an
 * overlay would silently truncate/corrupt the REAL checkout, not a
 * disposable copy. Every derived-artifact assertion below spawns the
 * generator's own `--check` mode instead — NEVER `--write`, NEVER `npm run
 * regen:derived`. `--check` is read-only and a faithful substitute here: a
 * green `--check` on the overlay is exactly the statement "`regen:derived`
 * would rewrite nothing," i.e. no second source surface needed to change.
 *
 * Every row builds and tears down its own overlay + install target inline
 * (test-matrix "Independence" — no shared `before()` install cache).
 * Cleanup is via `t.after()` (never `try/finally` in the test body).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup, readFileNormalized } = require('./helpers.cjs');
const { RUNTIME_META, installerEnv } = require('./helpers/install-shared.cjs');
const { buildOverlayRepo, REPO_ROOT, OVERLAY_SKIP_TOP } = require('./helpers/overlay-repo.cjs');
// Read each generator's own typed reason enum (never invent/regex a reason
// string) — rows 7 and 12 assert the REAL code below. gen-registry.cjs,
// gen-adr-index.cjs, gen-capability-matrix.cjs, gen-inventory-manifest.cjs
// and sync-manifest-versions.cjs export no such enum (verified by reading
// each script — plain prose to stderr/stdout + a bare non-zero exit code),
// so rows 6/8-11 below assert only on exit code, never on stderr text.
const { REASON: SECTION_MANIFEST_REASON } = require(path.join(REPO_ROOT, 'scripts', 'gen-section-manifest.cjs'));
const { REASON: CONTEXT_INDEX_REASON } = require(path.join(REPO_ROOT, 'scripts', 'gen-context-index.cjs'));

/**
 * `regen:derived` (package.json) chain, for reference by the constants below:
 *   npm run build && npm run gen:registry &&
 *   node scripts/gen-adr-index.cjs --write &&
 *   node scripts/gen-capability-matrix.cjs --write &&
 *   node scripts/gen-inventory-manifest.cjs --write &&
 *   node scripts/gen-context-index.cjs --write &&
 *   npm run gen:section-manifest &&
 *   node scripts/sync-manifest-versions.cjs &&
 *   npm run gen:install-tree
 *
 * Every one of these steps that has its own `--check` (read-only) mode is
 * exercised somewhere below (row 4: gen-section-manifest; row 6: gen-registry,
 * gen-adr-index, gen-capability-matrix, gen-inventory-manifest,
 * gen-context-index, sync-manifest-versions). The two that do NOT are named
 * here, with the reason verified empirically against this checkout, so the
 * omission is disclosed rather than silent.
 */
const REGEN_STEPS_WITHOUT_CHECK_MODE = Object.freeze({
  'npm run build': (
    'Compound npm-script chain (generate:identity, build:lib, gen:section-manifest, ' +
    'gen:context-index, gen:plugin-skills, gen:loop-host-contract, gen:capability-registry, ' +
    'build:hooks) with no single unified --check entry point at the regen:derived call site. ' +
    'Two of its own constituents genuinely have no check mode at all: build:lib is a raw ' +
    '`tsc -p tsconfig.build.json` compile (its output under src/*.cjs is gitignored, never a ' +
    'committed artifact a --check could compare against — see .gitignore), and ' +
    'scripts/build-hooks.js unconditionally copies/builds hook files regardless of any flag ' +
    '(verified empirically: invoking it with --check still performs real file copies). The ' +
    'remaining four constituents (generate-package-identity.cjs, gen-plugin-skills.cjs, ' +
    'gen-loop-host-contract.cjs, gen-capability-registry.cjs) DO each support their own --check ' +
    '— not independently re-exercised here because regen:derived does not call them as a ' +
    'discrete top-level step in its own right (only as part of the opaque "npm run build" step); ' +
    'see 40-design.md "Known limits" for the full disclosure.'
  ),
  'npm run gen:install-tree': (
    'scripts/gen-install-tree-fixtures.cjs has NO read-only mode. Verified empirically: ' +
    'spawning it with a literal "--check" argument does not enable a check mode — the script ' +
    'takes positional RUNTIME NAMES, so "--check" is parsed as an unrecognized runtime, printed ' +
    'as a skip warning, and the script falls through to its unconditional default behavior, which ' +
    'always fs.writeFileSync()s every fixture (including the claude-local fixture, written ' +
    'unconditionally at the bottom of the script regardless of argv). This is exactly the hazard ' +
    'this file\'s module doc warns about for --write generators: never spawn this script inside ' +
    'an overlay in ANY invocation, because its only behavior is to write, and buildOverlayRepo ' +
    'hard-links tests/fixtures/install-tree/*.json to this real checkout.'
  ),
});

/**
 * Generators that DO support --check but whose check is structurally
 * INSENSITIVE to any edit `buildOverlayRepo` can produce. `buildOverlayRepo`
 * can only replace the CONTENT of a path that already exists (see its own
 * doc comment) — it cannot graft a net-new path or remove one. This is a
 * disclosed, empirically-verified finding (see the probe next to row 6's
 * gen-inventory-manifest assertion below), not a workaround: per the #2933
 * dispatch's honesty constraint, no negative control is fabricated for these.
 */
const CONTENT_EDIT_INSENSITIVE_CHECKS = Object.freeze({
  'scripts/gen-inventory-manifest.cjs': (
    'buildManifest() derives every family entry from fs.readdirSync() FILENAMES filtered by a ' +
    'regex on the name — it never reads file CONTENT. Verified empirically: appending a marker ' +
    'comment to an existing tracked module\'s content (gsd-core/bin/lib/milestone.cjs, in the ' +
    '"cli_modules" family) and running --check still reports "up to date" (exit 0). A ' +
    'content-only override can never drive this check red; only adding/removing a whole file ' +
    'would, and buildOverlayRepo cannot graft or remove paths.'
  ),
});

const RUNTIMES = Object.keys(RUNTIME_META);

// NOTE (verified against this checkout — contradicts a stated fact in the
// #2933 dispatch): `Object.keys(RUNTIME_META)` has 18 entries, not 19.
// `tests/helpers/install-shared.cjs`'s own `MANIFEST_FAMILIES` comment
// explains the 19th family is `claude-local`, a distinct install SCOPE of
// the already-counted `claude` runtime, not a 19th runtime key. Every
// assertion below derives its expected runtime set FROM `RUNTIME_META`
// rather than hardcoding a runtime count, so this file is correct
// regardless of which number is the "real" one.

const PILOT_WORKFLOW_REL = path.join('gsd-core', 'workflows', 'execute-phase.md');
const PILOT_WORKFLOW_REL_POSIX = 'gsd-core/workflows/execute-phase.md';
const PILOT_WORKFLOW_PATH = path.join(REPO_ROOT, PILOT_WORKFLOW_REL);

const PILOT_STEP_REL = path.join('gsd-core', 'workflows', 'execute-phase', 'steps', 'partial-wave.md');
const PILOT_STEP_REL_POSIX = 'gsd-core/workflows/execute-phase/steps/partial-wave.md';
const PILOT_STEP_PATH = path.join(REPO_ROOT, PILOT_STEP_REL);

// LF-normalized at the read boundary (helpers.cjs's readFileNormalized):
// this checkout's own line endings must not leak into what "the fragment
// content" means for every downstream row — most directly row 15, which
// deliberately converts LF -> CRLF and would double up any pre-existing
// \r on a Windows/autocrlf checkout otherwise (DEFECT.WINDOWS-CRLF-TEST-PORTABILITY).
const ORIGINAL_STEP_CONTENT = readFileNormalized(PILOT_STEP_PATH);
const ORIGINAL_WORKFLOW_CONTENT = readFileNormalized(PILOT_WORKFLOW_PATH);

const FRAGMENT_SENTINEL = 'GSD-2933-FRAGMENT-EDIT-SENTINEL-4c1a9f';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn a (possibly overlaid) `bin/install.js` at global scope and assert it
 * succeeded. Mirrors `workflow-fragments-emission.install.test.cjs`'s own
 * `spawnGlobalInstall` (rows 33/36) — kept local rather than extracted,
 * unlike `buildOverlayRepo`: it is a thin spawn wrapper with no independent
 * mechanism, so a second copy carries none of the "generative fix
 * divergence" risk the #2933 dispatch calls out for the hard-link overlay
 * builder itself.
 */
function installOverlay(overlayRoot, runtime, extraArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2933-dest-${runtime}-`));
  const installScript = path.join(overlayRoot, 'bin', 'install.js');
  const args = [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    installScript,
    `--${runtime}`,
    '--global',
    '--config-dir',
    root,
    ...extraArgs,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: installerEnv({ HOME: root, USERPROFILE: root }),
  });
  assert.equal(
    result.status,
    0,
    `${runtime}: overlay install must succeed\nstderr: ${result.stderr}`,
  );
  return { configDir: root, root, result };
}

/**
 * Same spawn as `installOverlay`, but does NOT assert success — for the one
 * row (16a) that expects the install to fail. `installOverlay` itself throws
 * on a non-zero exit, so it cannot be reused for a row whose whole point is
 * a non-zero exit; kept as its own thin wrapper rather than adding an
 * "expect failure" flag to `installOverlay`, matching that function's own
 * documented rationale for staying a local, mechanism-free copy of
 * `workflow-fragments-emission.install.test.cjs`'s `spawnGlobalInstall`.
 */
function installOverlayExpectingFailure(overlayRoot, runtime, extraArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2933-dest-${runtime}-`));
  const installScript = path.join(overlayRoot, 'bin', 'install.js');
  const args = [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    installScript,
    `--${runtime}`,
    '--global',
    '--config-dir',
    root,
    ...extraArgs,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: installerEnv({ HOME: root, USERPROFILE: root }),
  });
  return { configDir: root, root, result };
}

/**
 * Spawn one of the overlay's own `scripts/gen-*.cjs` generators in `--check`
 * mode — READ-ONLY, see the module doc's hazard note above; this file NEVER
 * spawns `--write` or `npm run regen:derived`. Because every generator
 * resolves its own `ROOT` from `__dirname` (script location), spawning the
 * OVERLAY's copy of the script operates on the overlay tree, never on this
 * real checkout.
 */
function runOverlayCheck(overlayRoot, scriptRelPath, extraArgs = []) {
  const scriptPath = path.join(overlayRoot, ...scriptRelPath.split('/'));
  return spawnSync(process.execPath, [scriptPath, '--check', ...extraArgs], {
    cwd: overlayRoot,
    encoding: 'utf8',
    env: installerEnv(),
  });
}

/**
 * Spawn an overlay's own `scripts/gen-*.cjs` generator in its DEFAULT mode
 * (no flags) — also read-only, printing the freshly-derived artifact as
 * JSON to stdout rather than writing anything. Row 7 uses this to prove,
 * independently of `--check`, exactly WHICH attribute the overlay's edit
 * actually changed.
 */
function runOverlayGenerate(overlayRoot, scriptRelPath) {
  const scriptPath = path.join(overlayRoot, ...scriptRelPath.split('/'));
  return spawnSync(process.execPath, [scriptPath], {
    cwd: overlayRoot,
    encoding: 'utf8',
    env: installerEnv(),
  });
}

/**
 * Compare an overlay's ENTIRE tree against REPO_ROOT's, returning the sorted
 * list of POSIX-relative paths whose content differs (or that exist on only
 * one side). Skips the same top-level symlinked entries `buildOverlayRepo`
 * itself never walks into (`node_modules`, `.git`).
 *
 * NOTE (P2 evidence lives elsewhere): this is used by row 5, a HARNESS
 * SELF-CHECK, not the "no second source surface" proof — `buildOverlayRepo`
 * constructs the overlay FROM REPO_ROOT by hard-linking every unmodified leaf
 * and writing only the caller's override map, so this diff can only ever
 * equal that same override map; it is structurally incapable of detecting a
 * real second-surface ripple in product behavior. See row 5's own comment
 * for what it actually guards, and rows 4/6 for the real P2 evidence.
 */
function diffOverlayFromRepoRoot(overlayRoot) {
  const differing = [];
  function walk(overlayDir, repoDir, relDir, isTop) {
    for (const entry of fs.readdirSync(overlayDir, { withFileTypes: true })) {
      if (isTop && OVERLAY_SKIP_TOP.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const overlayPath = path.join(overlayDir, entry.name);
      const repoPath = path.join(repoDir, entry.name);
      if (entry.isDirectory()) {
        walk(overlayPath, repoPath, rel, false);
        continue;
      }
      if (!fs.existsSync(repoPath)) {
        differing.push(rel);
        continue;
      }
      const overlayContent = fs.readFileSync(overlayPath);
      const repoContent = fs.readFileSync(repoPath);
      if (!overlayContent.equals(repoContent)) differing.push(rel);
    }
  }
  walk(overlayRoot, REPO_ROOT, '', true);
  return differing.sort();
}

// ─── Row 1 ──────────────────────────────────────────────────────────────────

test('propagatesSingleFragmentEditToAllRuntimeArtifacts', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  for (const runtime of RUNTIMES) {
    const install = installOverlay(overlay, runtime);
    t.after(() => cleanup(install.root));
    const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
    assert.ok(fs.existsSync(emittedPath), `${runtime}: emitted steps/partial-wave.md is missing`);
    // Presence, not whole-file identity: partial-wave.md's runtime-launcher
    // snippet embeds `.claude`-prefixed path tokens (e.g.
    // `${_GSD_RUNTIME_ROOT}/.claude/...`) that the installer's generic
    // per-runtime path-prefix rewrite legitimately replaces on EVERY
    // runtime, including claude itself (see row 20's
    // rewritesRuntimePathTokensInEmittedFragment, which locks that behavior
    // in) — verified empirically (windsurf -> `.windsurf`, qwen -> `.qwen`,
    // claude -> its absolute config dir). A byte-identity assertion here
    // would fail on every runtime for a reason that has nothing to do with
    // fragment propagation.
    assert.ok(
      fs.readFileSync(emittedPath, 'utf8').includes(FRAGMENT_SENTINEL),
      `${runtime}: emitted steps/partial-wave.md must carry the single edited fragment's sentinel`,
    );
    // Belt-and-braces cleanup: t.after() is the failure-path safety net (a
    // thrown assertion still tears every registered temp dir down when the
    // test returns), but t.after() alone defers ALL registered cleanups
    // across every runtime in this loop until the whole test finishes, so up
    // to ~18 full install trees would coexist on disk at once. This eager
    // cleanup() call bounds peak disk to one runtime's tree on the success
    // path; t.after() still fires afterward as a no-op (cleanup is
    // idempotent on an already-removed path — see helpers.cjs).
    cleanup(install.root);
  }
});

// ─── Row 2 ──────────────────────────────────────────────────────────────────

test('emitsNoSectionMarkerBytesInAnyRuntimeArtifact', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  for (const runtime of RUNTIMES) {
    const install = installOverlay(overlay, runtime);
    t.after(() => cleanup(install.root));
    const workflowPath = path.join(install.configDir, PILOT_WORKFLOW_REL);
    assert.ok(fs.existsSync(workflowPath), `${runtime}: emitted execute-phase.md is missing`);
    const emittedWorkflow = fs.readFileSync(workflowPath, 'utf8');
    assert.equal(
      emittedWorkflow.includes('gsd:section'),
      false,
      `${runtime}: emitted execute-phase.md still contains a gsd:section marker token (composition did not run)`,
    );
    cleanup(install.root);
  }
});

// ─── Row 3 ──────────────────────────────────────────────────────────────────

test('assertsEveryRuntimeEmittedTheFragmentArtifact', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const expected = new Set(RUNTIMES);
  const actual = new Set();
  for (const runtime of RUNTIMES) {
    // installOverlay itself asserts install success (throws loudly on a
    // nonzero exit) — a runtime that fails to install fails THIS test
    // immediately rather than being silently excluded from `actual` below.
    const install = installOverlay(overlay, runtime);
    t.after(() => cleanup(install.root));
    const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
    // Read existence BEFORE the eager cleanup below — cleaning up first would
    // make every runtime falsely report as missing.
    if (fs.existsSync(emittedPath)) actual.add(runtime);
    cleanup(install.root);
  }
  assert.deepEqual(
    Array.from(actual).sort(),
    Array.from(expected).sort(),
    'every runtime in RUNTIME_META must have emitted gsd-core/workflows/execute-phase/steps/partial-wave.md — ' +
      'a missing runtime must fail loudly here, never be silently skipped',
  );
});

// ─── Row 4 ──────────────────────────────────────────────────────────────────

test('bodyEditRequiresNoSectionManifestRegeneration', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/gen-section-manifest.cjs');
  assert.equal(
    check.status,
    0,
    `a body-only fragment edit must not require section-manifest.json regeneration\nstdout: ${check.stdout}\nstderr: ${check.stderr}`,
  );
});

// ─── Row 5 ──────────────────────────────────────────────────────────────────

// HARNESS SELF-CHECK — this is NOT the P2 "no second source surface" proof.
// `buildOverlayRepo` builds the overlay FROM REPO_ROOT by hard-linking every
// unmodified leaf and writing only the override map this test itself passes
// in ({ [PILOT_STEP_REL_POSIX]: editedStep }) — so `diffOverlayFromRepoRoot`
// can only ever report exactly that same override map back. Asserting it
// equals `[PILOT_STEP_REL_POSIX]` verifies the test's OWN fixture-building
// helper, not product behavior: it guards against a real risk (a future
// `buildOverlayRepo` bug that silently perturbs a file beyond its override
// map, which would corrupt every other row's overlay too), but it can never
// fail because a second SOURCE surface (a stub frontmatter, the workflow
// .md, docs/, gsd-core/references/) needed a maintainer edit — every one of
// those paths is hard-linked, not diffed against anything independent.
//
// The REAL P2 evidence that a body-only edit needs no second source surface
// is the `--check` GREENS in rows 4 and 6 below (gen-section-manifest,
// gen-registry, gen-adr-index, gen-capability-matrix, gen-inventory-manifest,
// gen-context-index, sync-manifest-versions all report "up to date" against
// the SAME overlay) — proven non-vacuous by the negative controls in rows
// 7-12, which show each of those same `--check` invocations CAN go red.
test('overlayFixtureOverridesExactlyOneSourceFile', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const differing = diffOverlayFromRepoRoot(overlay);
  assert.deepEqual(
    differing,
    [PILOT_STEP_REL_POSIX],
    'harness self-check: buildOverlayRepo must override CONTENT for exactly the one path named ' +
      'in its override map, and touch nothing else — this pins buildOverlayRepo itself, and is ' +
      'NOT evidence of "no second source surface" for product behavior (see the comment above)',
  );
});

// ─── Row 6 ──────────────────────────────────────────────────────────────────

// Extended per the #2933 defect review: `regen:derived` chains 9 steps (see
// the module-doc comment above `REGEN_STEPS_WITHOUT_CHECK_MODE`); this row
// now `--check`s every one of them that supports a read-only check mode,
// not a partial sample. `REGEN_STEPS_WITHOUT_CHECK_MODE` and
// `CONTENT_EDIT_INSENSITIVE_CHECKS` (both above) name and explain every step
// this row does NOT (and, for the latter, structurally cannot) exercise —
// disclosed omission, not silent partial coverage.
test('bodyEditRequiresNoOtherDerivedRegeneration', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const inventoryCheck = runOverlayCheck(overlay, 'scripts/gen-inventory-manifest.cjs');
  assert.equal(
    inventoryCheck.status,
    0,
    `a body-only fragment edit must not require INVENTORY-MANIFEST regeneration\nstdout: ${inventoryCheck.stdout}\nstderr: ${inventoryCheck.stderr}`,
  );
  // NOTE: this generator's --check is CONTENT-EDIT INSENSITIVE (see
  // CONTENT_EDIT_INSENSITIVE_CHECKS above) — a green here is real but weaker
  // evidence than the other checks in this row, which rows 8-12 each pin
  // with a genuine negative control; this one structurally cannot be.

  const contextIndexCheck = runOverlayCheck(overlay, 'scripts/gen-context-index.cjs');
  assert.equal(
    contextIndexCheck.status,
    0,
    `a body-only fragment edit must not require CONTEXT-INDEX regeneration\nstdout: ${contextIndexCheck.stdout}\nstderr: ${contextIndexCheck.stderr}`,
  );

  const registryCheck = runOverlayCheck(overlay, 'scripts/gen-registry.cjs');
  assert.equal(
    registryCheck.status,
    0,
    `a body-only fragment edit must not require docs/registries/*.md regeneration\nstdout: ${registryCheck.stdout}\nstderr: ${registryCheck.stderr}`,
  );

  const adrIndexCheck = runOverlayCheck(overlay, 'scripts/gen-adr-index.cjs');
  assert.equal(
    adrIndexCheck.status,
    0,
    `a body-only fragment edit must not require docs/adr/README.md index regeneration\nstdout: ${adrIndexCheck.stdout}\nstderr: ${adrIndexCheck.stderr}`,
  );

  const capabilityMatrixCheck = runOverlayCheck(overlay, 'scripts/gen-capability-matrix.cjs');
  assert.equal(
    capabilityMatrixCheck.status,
    0,
    `a body-only fragment edit must not require docs/reference/capability-matrix.md regeneration\nstdout: ${capabilityMatrixCheck.stdout}\nstderr: ${capabilityMatrixCheck.stderr}`,
  );

  const syncManifestVersionsCheck = runOverlayCheck(overlay, 'scripts/sync-manifest-versions.cjs');
  assert.equal(
    syncManifestVersionsCheck.status,
    0,
    `a body-only fragment edit must not require versioned-manifest resync\nstdout: ${syncManifestVersionsCheck.stdout}\nstderr: ${syncManifestVersionsCheck.stderr}`,
  );
});

// Pins the disclosure the two constants above document, so a future edit
// that silently drops or adds an omission (rather than updating the
// disclosure honestly) fails loudly here.
test('regenDerivedCheckCoverageDisclosureIsPinned', () => {
  assert.deepEqual(
    Object.keys(REGEN_STEPS_WITHOUT_CHECK_MODE).sort(),
    ['npm run build', 'npm run gen:install-tree'].sort(),
    'the disclosed set of regen:derived steps with NO read-only check mode must not silently drift',
  );
  for (const [step, reason] of Object.entries(REGEN_STEPS_WITHOUT_CHECK_MODE)) {
    assert.ok(typeof reason === 'string' && reason.length > 0, `${step}: disclosed reason must be non-empty`);
  }
  assert.deepEqual(
    Object.keys(CONTENT_EDIT_INSENSITIVE_CHECKS),
    ['scripts/gen-inventory-manifest.cjs'],
    'the disclosed set of content-edit-insensitive --check generators must not silently drift',
  );
  for (const [script, reason] of Object.entries(CONTENT_EDIT_INSENSITIVE_CHECKS)) {
    assert.ok(typeof reason === 'string' && reason.length > 0, `${script}: disclosed reason must be non-empty`);
  }
});

// ─── Row 7 (negative control) ───────────────────────────────────────────────

const PARTIAL_WAVE_MARKER_COMMITTED = '<!-- gsd:section id="partial-wave" when="flag:--wave" -->';
const PARTIAL_WAVE_MARKER_DRIFTED = '<!-- gsd:section id="partial-wave" when="always" -->';

test('structuralEditDrivesSectionManifestCheckRed', (t) => {
  // Going RED via a MISSING step file would only prove --check can exit
  // non-zero at all — it would not prove the check detects manifest DRIFT,
  // which is the actual "second source surface" claim this control exists
  // to falsify. Drive real drift instead: flip the EXISTING partial-wave
  // section's `when` from its committed "flag:--wave" to "always" — both
  // are in the frozen WHEN_VOCABULARY (Greenspun's Law note, 40-design.md),
  // the referenced step file still exists (no net-new path needed, honoring
  // buildOverlayRepo's own "replace, never graft" limitation), so the ONLY
  // possible cause of a red --check is the committed manifest no longer
  // matching the live source for this one attribute.
  assert.ok(
    ORIGINAL_WORKFLOW_CONTENT.includes(PARTIAL_WAVE_MARKER_COMMITTED),
    'sanity: execute-phase.md must still carry the exact committed partial-wave marker this test flips',
  );
  const editedWorkflow = ORIGINAL_WORKFLOW_CONTENT.replace(
    PARTIAL_WAVE_MARKER_COMMITTED,
    PARTIAL_WAVE_MARKER_DRIFTED,
  );
  const overlay = buildOverlayRepo({ [PILOT_WORKFLOW_REL_POSIX]: editedWorkflow });
  t.after(() => cleanup(overlay));

  // Sanity: the overlay's own generator, run in its read-only DEFAULT mode
  // (prints the live-derived manifest to stdout; never --write), must show
  // partial-wave's freshly-parsed `when` as "always" — proving the edit
  // changed exactly the attribute this control claims, before ever looking
  // at --check.
  const liveResult = runOverlayGenerate(overlay, 'scripts/gen-section-manifest.cjs');
  assert.equal(
    liveResult.status,
    0,
    `live (read-only) manifest generation must succeed\nstderr: ${liveResult.stderr}`,
  );
  const liveManifest = JSON.parse(liveResult.stdout);
  const livePartialWave = (liveManifest.workflows['execute-phase'] || []).find((s) => s.id === 'partial-wave');
  assert.ok(livePartialWave, 'sanity: the live manifest must still have a partial-wave entry for execute-phase');
  assert.equal(
    livePartialWave.when,
    'always',
    "sanity: the overlay edit must have actually flipped partial-wave's when to \"always\"",
  );

  // Read the typed --json envelope rather than matching stderr prose
  // (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs").
  const check = runOverlayCheck(overlay, 'scripts/gen-section-manifest.cjs', ['--json']);
  assert.notEqual(
    check.status,
    0,
    `drifting partial-wave's committed when= must drive --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  const report = JSON.parse(check.stdout);
  assert.equal(
    report.ok,
    false,
    'the typed --check --json envelope must report ok:false for manifest drift',
  );
  assert.equal(
    report.reason,
    SECTION_MANIFEST_REASON.FAIL_STALE,
    'the failure must be attributed to REASON.FAIL_STALE (manifest drift), read from the generator\'s own ' +
      'exported reason enum — not e.g. FAIL_MISSING_STEP_FILE or any other reason, so a future change that ' +
      'fails this check for an unrelated cause cannot silently keep this control "green"',
  );
});

// ─── Row 8 (negative control — gen-registry.cjs) ────────────────────────────

// Without this, a stubbed/no-op --check in gen-registry.cjs would pass
// silently in row 6 — the same vacuity class row 7 exists to rule out for
// gen-section-manifest. Drives drift via an override-only edit to the
// EXISTING docs/registries/eos.json (buildOverlayRepo cannot graft a
// net-new path): editing an existing entry's `name` field changes the
// derived eos-registry.md, so the committed copy goes stale.
test('registryCheckGoesRedOnEosRegistryContentDrift', (t) => {
  const eosPath = path.join(REPO_ROOT, 'docs', 'registries', 'eos.json');
  const originalEos = readFileNormalized(eosPath);
  const driftMarker = '"name": "GSD Cursor Model Profiles"';
  assert.ok(
    originalEos.includes(driftMarker),
    'sanity: docs/registries/eos.json must still carry the exact entry this test edits',
  );
  const editedEos = originalEos.replace(driftMarker, '"name": "GSD Cursor Model Profiles EDITED-2933-PROBE"');
  const overlay = buildOverlayRepo({ 'docs/registries/eos.json': editedEos });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/gen-registry.cjs');
  assert.notEqual(
    check.status,
    0,
    `drifting an existing eos.json entry must drive gen-registry --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  // gen-registry.cjs exports no typed reason enum / --json mode (verified by
  // reading the script) — asserting the exit code is the strongest evidence
  // available without regex-matching its stderr prose.
});

// ─── Row 9 (negative control — gen-adr-index.cjs) ───────────────────────────

// Drives drift via an override-only edit to an EXISTING ADR's H1 title
// (reflected verbatim in docs/adr/README.md's generated index table) —
// leaves Status/Date untouched so no lifecycle invariant is tripped, only
// the index table content.
test('adrIndexCheckGoesRedOnAdrTitleContentDrift', (t) => {
  const adrPath = path.join(REPO_ROOT, 'docs', 'adr', '0001-dispatch-policy-module.md');
  const originalAdr = readFileNormalized(adrPath);
  const committedTitle = '# Dispatch policy module as single seam for query execution outcomes';
  assert.ok(
    originalAdr.startsWith(committedTitle),
    'sanity: ADR-0001 must still carry the exact committed H1 this test edits',
  );
  const editedAdr = originalAdr.replace(committedTitle, `${committedTitle} EDITED-2933-PROBE`);
  const overlay = buildOverlayRepo({ 'docs/adr/0001-dispatch-policy-module.md': editedAdr });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/gen-adr-index.cjs');
  assert.notEqual(
    check.status,
    0,
    `drifting an existing ADR's H1 title must drive gen-adr-index --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  // gen-adr-index.cjs exports no typed reason enum / --json mode (verified by
  // reading the script) — asserting the exit code is the strongest evidence
  // available without regex-matching its stderr prose.
});

// ─── Row 10 (negative control — gen-capability-matrix.cjs) ─────────────────

// Drives drift via an override-only edit to the EXISTING (committed)
// gsd-core/bin/lib/capability-registry.cjs: flips one capability's declared
// `engines.gsd` range, which is rendered verbatim into a capability-matrix.md
// column (fmtEngines). No other row exercises this generator's --check yet
// this file's overall claim depends on it (regen:derived calls it directly),
// so the control needs the exact same override-only lever.
test('capabilityMatrixCheckGoesRedOnEnginesContentDrift', (t) => {
  const capRegistryPath = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
  const originalRegistry = readFileNormalized(capRegistryPath);
  const driftMarker = '"gsd": ">=1.6.0"';
  assert.ok(
    originalRegistry.includes(driftMarker),
    'sanity: capability-registry.cjs must still carry the exact engines range this test edits',
  );
  const editedRegistry = originalRegistry.replace(driftMarker, '"gsd": ">=1.7.0"');
  const overlay = buildOverlayRepo({ 'gsd-core/bin/lib/capability-registry.cjs': editedRegistry });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/gen-capability-matrix.cjs');
  assert.notEqual(
    check.status,
    0,
    `drifting a capability's engines.gsd range must drive gen-capability-matrix --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  // gen-capability-matrix.cjs exports no typed reason enum / --json mode
  // (verified by reading the script) — asserting the exit code is the
  // strongest evidence available without regex-matching its stderr prose.
});

// ─── Row 11 (negative control — sync-manifest-versions.cjs) ────────────────

// Drives drift via an override-only edit to the EXISTING vscode/package.json
// `version` field, desynchronizing it from the root package.json version
// sync-manifest-versions.cjs reconciles against.
test('syncManifestVersionsCheckGoesRedOnVersionContentDrift', (t) => {
  const vscodePkgPath = path.join(REPO_ROOT, 'vscode', 'package.json');
  const originalVscodePkg = readFileNormalized(vscodePkgPath);
  const currentVersion = JSON.parse(originalVscodePkg).version;
  const driftMarker = `"version": "${currentVersion}"`;
  assert.ok(
    originalVscodePkg.includes(driftMarker),
    'sanity: vscode/package.json must still carry the exact version field this test edits',
  );
  const editedVscodePkg = originalVscodePkg.replace(driftMarker, '"version": "0.0.0-2933-probe"');
  const overlay = buildOverlayRepo({ 'vscode/package.json': editedVscodePkg });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/sync-manifest-versions.cjs');
  assert.notEqual(
    check.status,
    0,
    `desyncing vscode/package.json's version must drive sync-manifest-versions --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  // sync-manifest-versions.cjs exports no typed reason enum / --json mode
  // (verified by reading the script) — asserting the exit code is the
  // strongest evidence available without regex-matching its stderr prose.
});

// ─── Row 12 (negative control — gen-context-index.cjs) ─────────────────────

// Drives drift via an override-only edit to the EXISTING repo-root
// CONTEXT.md: appends to one predicate's value, which the parser reflects
// verbatim in docs/CONTEXT-INDEX.json. Unlike rows 8-11, this generator DOES
// export a typed --json/REASON contract (mirrors row 7's pattern), so this
// control asserts the real REASON.FAIL_STALE rather than only an exit code.
test('contextIndexCheckGoesRedOnContextMdContentDrift', (t) => {
  const contextPath = path.join(REPO_ROOT, 'CONTEXT.md');
  const originalContext = readFileNormalized(contextPath);
  const driftMarker = '`PROBE.principle=verifier-reach-equals-spec-reach';
  assert.ok(
    originalContext.includes(driftMarker),
    'sanity: CONTEXT.md must still carry the exact PROBE.principle predicate this test edits',
  );
  const editedContext = originalContext.replace(driftMarker, `${driftMarker}-EDITED-2933-PROBE`);
  const overlay = buildOverlayRepo({ 'CONTEXT.md': editedContext });
  t.after(() => cleanup(overlay));

  const check = runOverlayCheck(overlay, 'scripts/gen-context-index.cjs', ['--json']);
  assert.notEqual(
    check.status,
    0,
    `drifting an existing CONTEXT.md predicate value must drive gen-context-index --check RED, got exit 0\nstdout: ${check.stdout}`,
  );
  const report = JSON.parse(check.stdout);
  assert.equal(
    report.ok,
    false,
    'the typed --check --json envelope must report ok:false for CONTEXT-INDEX drift',
  );
  assert.equal(
    report.reason,
    CONTEXT_INDEX_REASON.FAIL_STALE,
    'the failure must be attributed to REASON.FAIL_STALE (index drift), read from the generator\'s own ' +
      'exported reason enum — not e.g. FAIL_DUPLICATE_IDS or any other reason, so a future change that ' +
      'fails this check for an unrelated cause cannot silently keep this control "green"',
  );
});

// ─── Row 13 (anti-vacuity control) ──────────────────────────────────────────

test('detectsNeuteredComposerViaLeakedMarkerBytes', (t) => {
  const overlay = buildOverlayRepo({
    'gsd-core/bin/lib/workflow-fragments.cjs': 'module.exports = { composeWorkflow: (c) => c };\n',
  });
  t.after(() => cleanup(overlay));

  const install = installOverlay(overlay, 'claude');
  t.after(() => cleanup(install.root));

  const workflowPath = path.join(install.configDir, PILOT_WORKFLOW_REL);
  assert.ok(fs.existsSync(workflowPath), 'identity-stub install is missing execute-phase.md');
  const emittedWorkflow = fs.readFileSync(workflowPath, 'utf8');
  assert.equal(
    emittedWorkflow.includes('gsd:section'),
    true,
    'anti-vacuity control: with the composer neutered to identity, marker bytes must LEAK into the emitted ' +
      'workflow — proving emitsNoSectionMarkerBytesInAnyRuntimeArtifact (row 2) is CAPABLE of catching a ' +
      'broken composer, not pass-always theater',
  );
});

// ─── Row 14 (boundary: empty fragment) ──────────────────────────────────────

test('handlesEmptyFragmentFile', (t) => {
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: '' });
  t.after(() => cleanup(overlay));

  const install = installOverlay(overlay, 'claude');
  t.after(() => cleanup(install.root));

  const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
  assert.ok(fs.existsSync(emittedPath), 'emitted steps/partial-wave.md is missing for an empty fragment');
  assert.equal(
    fs.readFileSync(emittedPath, 'utf8'),
    '',
    'an empty fragment file must emit as an empty artifact — no crash, no gained content',
  );
  const workflowPath = path.join(install.configDir, PILOT_WORKFLOW_REL);
  assert.equal(
    fs.readFileSync(workflowPath, 'utf8').includes('gsd:section'),
    false,
    'an empty fragment file must not perturb the pointer workflow composition or leak a marker',
  );
});

// ─── Row 15 (boundary: CRLF) ─────────────────────────────────────────────────

test('preservesCrlfFragmentBodyThroughEmission', (t) => {
  const crlfSentinel = FRAGMENT_SENTINEL + '-CRLF';
  const editedStep = ORIGINAL_STEP_CONTENT.replace(/\n/g, '\r\n') + crlfSentinel + '\r\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const install = installOverlay(overlay, 'claude');
  t.after(() => cleanup(install.root));

  const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
  // Presence, not whole-file identity — see row 1's comment: the installer's
  // generic per-runtime path-prefix rewrite legitimately touches other
  // parts of this fragment's content. The property under test here is the
  // CRLF terminator surviving around the sentinel specifically.
  assert.ok(
    fs.readFileSync(emittedPath, 'utf8').includes(crlfSentinel + '\r\n'),
    'a CRLF-terminated fragment body must preserve the sentinel with its \\r\\n terminator intact',
  );
});

// ─── Row 16a/16b (corrected — a WRONG DESIGN ASSUMPTION caught by the remote
// runner, not a flake: `copyWithPathReplacement`'s scoping guard at
// `bin/install.js:7699` (`/(?:^|\/)gsd-core\/workflows\//`) is a
// path-SEGMENT match on the recursive-descent `srcPath`, so it matches
// `gsd-core/workflows/execute-phase/steps/partial-wave.md` exactly like it
// matches the parent workflow. `steps/*.md` fragment files ARE
// marker-parsed and composed — the original single row here
// (`doesNotMisparseMarkerShapedTextInsideAFragmentFile`) asserted the
// opposite ("never marker-parsed") and failed identically on
// linux-node22/linux-node24 with `TypeError: workflow-fragments: unclosed
// gsd:section marker "rogue-should-not-parse"`. Replaced with the true,
// verified behavior, split per input class: a malformed marker in a
// fragment file fails the install loudly (16a), and a well-formed marker
// pair in a fragment file composes exactly like it would in a parent
// workflow (16b). ─────────────────────────────────────────────────────────

test('malformedMarkerInFragmentFileFailsInstallWithoutPartialEmit', (t) => {
  const malformedMarkerLine = '<!-- gsd:section id="rogue-should-not-parse" when="always" -->';
  const editedStep = ORIGINAL_STEP_CONTENT + malformedMarkerLine + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const install = installOverlayExpectingFailure(overlay, 'claude');
  t.after(() => cleanup(install.root));

  // stderr text is a child process's rendered prose, not a typed value this
  // test can assert on across the process boundary (CONTRIBUTING.md
  // "Prohibited: Raw Text Matching on Test Outputs" — mirrors
  // workflow-fragments-emission.install.test.cjs's
  // malformedMarkersFailInstallWithoutPartialEmit, whose exact pattern this
  // row follows). Assert typed, observable facts instead: the install
  // process exits non-zero, and no output file is written for the fragment
  // that failed to compose.
  assert.notEqual(
    install.result.status,
    0,
    `install must fail loudly on a malformed marker inside a steps/ fragment file, got exit 0\nstdout: ${install.result.stdout}`,
  );
  const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
  assert.equal(
    fs.existsSync(emittedPath),
    false,
    'a half-composed steps/partial-wave.md must never be written when composition throws',
  );
});

test('composesWellFormedMarkersInsideAFragmentFile', (t) => {
  const wellFormedSentinel = 'GSD-2933-FRAGMENT-WELLFORMED-MARKER-SENTINEL';
  const editedStep =
    ORIGINAL_STEP_CONTENT +
    `<!-- gsd:section id="rogue-should-compose" when="always" -->\n${wellFormedSentinel}\n<!-- /gsd:section -->\n`;
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const install = installOverlay(overlay, 'claude');
  t.after(() => cleanup(install.root));

  const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
  assert.ok(fs.existsSync(emittedPath), 'emitted steps/partial-wave.md is missing');
  const emitted = fs.readFileSync(emittedPath, 'utf8');
  // Presence, not whole-file identity — see row 1's comment: the installer's
  // unrelated per-runtime path-prefix rewrite still runs elsewhere in this
  // fragment. The properties under test are: the wrapped body survived, and
  // the marker bytes that wrapped it did not — proving fragment files
  // participate in composeWorkflow's stripping exactly like a parent
  // workflow does, not merely receiving a verbatim copy.
  assert.ok(
    emitted.includes(wellFormedSentinel),
    'a well-formed gsd:section pair inside a steps/ fragment file must still emit its wrapped body',
  );
  assert.equal(
    emitted.includes('gsd:section'),
    false,
    'a well-formed gsd:section pair inside a steps/ fragment file must be stripped, proving the fragment ' +
      'was actually composed rather than copied verbatim',
  );
});

// ─── Row 17 (hostile: shell metacharacters) ─────────────────────────────────

test('doesNotInterpolateShellMetacharactersFromFragmentContent', (t) => {
  const shellSentinel = 'GSD-2933-SHELL-SENTINEL; $(echo pwned) `id` | rm -rf /nonexistent && echo done';
  const editedStep = ORIGINAL_STEP_CONTENT + shellSentinel + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  const install = installOverlay(overlay, 'claude');
  t.after(() => cleanup(install.root));

  const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
  // Presence, not whole-file identity — see row 1's comment. The shell
  // sentinel itself is the property under test: it must copy verbatim
  // (proving no shell interpolation), independent of the installer's
  // unrelated per-runtime path-prefix rewrite elsewhere in this fragment.
  assert.ok(
    fs.readFileSync(emittedPath, 'utf8').includes(shellSentinel),
    'shell metacharacters in fragment content must copy verbatim — any deviation would mean shell ' +
      'interpolation occurred somewhere in the install path',
  );
});

// ─── Row 18 (hostile: unicode + long, every runtime) ────────────────────────

test('preservesUnicodeAndLongFragmentContent', (t) => {
  const unicodeSentinel = `GSD-2933-UNICODE-日本語-🎉🔥Ω→∞-${'x'.repeat(4000)}`;
  const editedStep = ORIGINAL_STEP_CONTENT + unicodeSentinel + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  for (const runtime of RUNTIMES) {
    const install = installOverlay(overlay, runtime);
    t.after(() => cleanup(install.root));
    const emittedPath = path.join(install.configDir, PILOT_STEP_REL);
    // Presence, not whole-file identity — see row 1's comment. The unicode
    // sentinel itself is the property under test: it must be byte-preserved
    // through emission on every runtime, independent of the installer's
    // unrelated per-runtime path-prefix rewrite elsewhere in this fragment.
    assert.ok(
      fs.readFileSync(emittedPath, 'utf8').includes(unicodeSentinel),
      `${runtime}: unicode + long fragment sentinel must be byte-preserved through emission`,
    );
    cleanup(install.root);
  }
});

// ─── Row 19 (independence: two overlays, same run) ──────────────────────────

test('overlaysDoNotContaminateEachOther', (t) => {
  const sentinelA = 'GSD-2933-OVERLAY-A-SENTINEL';
  const sentinelB = 'GSD-2933-OVERLAY-B-SENTINEL';
  const overlayA = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: ORIGINAL_STEP_CONTENT + sentinelA + '\n' });
  t.after(() => cleanup(overlayA));
  const overlayB = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: ORIGINAL_STEP_CONTENT + sentinelB + '\n' });
  t.after(() => cleanup(overlayB));

  const installA = installOverlay(overlayA, 'claude');
  t.after(() => cleanup(installA.root));
  const installB = installOverlay(overlayB, 'claude');
  t.after(() => cleanup(installB.root));

  const emittedA = fs.readFileSync(path.join(installA.configDir, PILOT_STEP_REL), 'utf8');
  const emittedB = fs.readFileSync(path.join(installB.configDir, PILOT_STEP_REL), 'utf8');

  assert.equal(emittedA.includes(sentinelA), true, 'overlay A must carry its own sentinel');
  assert.equal(emittedA.includes(sentinelB), false, "overlay A must not leak overlay B's sentinel");
  assert.equal(emittedB.includes(sentinelB), true, 'overlay B must carry its own sentinel');
  assert.equal(emittedB.includes(sentinelA), false, "overlay B must not leak overlay A's sentinel");
});

// ─── Row 20 (permanent coverage for the per-runtime path-rewrite finding) ───

// The installer's generic content rewrite substitutes the bare runtime name
// as a `.{runtime}` path-segment token wherever a `.claude`-prefixed token
// (e.g. `${_GSD_RUNTIME_ROOT}/.claude/...`) appears in emitted content —
// verified empirically (real spawned installs, not this checkout's own
// claim). This is NOT derivable from RUNTIME_META: RUNTIME_META's own
// `globalSuffix` for windsurf is `.codeium/windsurf`, not `.windsurf` — a
// DIFFERENT path than this literal-token rewrite produces — so the
// runtime -> token mapping is kept here as a small explicit map rather than
// computed from RUNTIME_META (which would silently assert the wrong thing
// for any runtime whose install destination differs from its rewrite
// token).
const RUNTIME_PATH_REWRITE_TOKEN = {
  windsurf: '.windsurf',
  qwen: '.qwen',
};

test('rewritesRuntimePathTokensInEmittedFragment', (t) => {
  const editedStep = ORIGINAL_STEP_CONTENT + FRAGMENT_SENTINEL + '\n';
  const overlay = buildOverlayRepo({ [PILOT_STEP_REL_POSIX]: editedStep });
  t.after(() => cleanup(overlay));

  assert.ok(
    ORIGINAL_STEP_CONTENT.includes('${_GSD_RUNTIME_ROOT}/.claude/'),
    'sanity: partial-wave.md must still carry the unrewritten claude-specific token this test checks was replaced',
  );

  const claudeInstall = installOverlay(overlay, 'claude');
  t.after(() => cleanup(claudeInstall.root));
  const claudeEmitted = fs.readFileSync(path.join(claudeInstall.configDir, PILOT_STEP_REL), 'utf8');
  assert.ok(
    claudeEmitted.includes(FRAGMENT_SENTINEL),
    'claude: emitted fragment must still carry the sentinel',
  );

  for (const [runtime, token] of Object.entries(RUNTIME_PATH_REWRITE_TOKEN)) {
    const install = installOverlay(overlay, runtime);
    t.after(() => cleanup(install.root));
    const emitted = fs.readFileSync(path.join(install.configDir, PILOT_STEP_REL), 'utf8');
    assert.ok(
      emitted.includes(FRAGMENT_SENTINEL),
      `${runtime}: emitted fragment must still carry the sentinel after per-runtime path rewriting`,
    );
    assert.ok(
      emitted.includes(`/${token}/`),
      `${runtime}: emitted fragment must contain its own runtime directory token (/${token}/) — ` +
        'proves per-runtime emission actually ran (epic #1671 Phase 4), not a uniform copy',
    );
    assert.equal(
      emitted.includes('${_GSD_RUNTIME_ROOT}/.claude/'),
      false,
      `${runtime}: emitted fragment must not retain the unrewritten claude-specific token form`,
    );
    cleanup(install.root);
  }
});
