'use strict';

/**
 * mcp-catalog-parity.install.test.cjs — the anti-drift gate mandated by
 * ADR-1671 ("Dual-surface drift if any future MCP channel is added —
 * requires parity assertions"), issue #3072 (epic #1671 Phase B),
 * `.gsd/phase/feat-3072-mcp-served-catalog/40-design.md` "The parity
 * assertion".
 *
 * ## PRIOR DEFECT (review BLOCKER, fixed by this rewrite)
 *
 * The original `tests/mcp-catalog-parity.test.cjs` never imported, spawned,
 * or otherwise exercised `bin/install.js`. It recomputed the "installer
 * side" by calling `shouldCompose`/`composeWorkflow` directly — the SAME
 * functions the catalog itself calls — so it only proved `src/mcp-catalog.cts`
 * is self-consistent with itself. Its row-52 assertion compared
 * `shouldCompose` against a regex literal frozen inside the test file, never
 * against `bin/install.js`'s real behavior. Net effect: a re-introduced,
 * divergent inline composition-scope regex in `bin/install.js` (the exact
 * regression `ADR-1671:309` `DEFECT.GENERATIVE-FIX` warns about) would have
 * stayed GREEN.
 *
 * This file instead drives a REAL spawned `bin/install.js` (via
 * `tests/helpers/install-shared.cjs`'s `runMinimalInstall` — the same driver
 * `tests/workflow-fragments-emission.install.test.cjs` and
 * `tests/agent-fragments-emission.install.test.cjs` use) and compares its
 * REAL emitted output against the catalog's served content, renamed to
 * `.install.test.cjs` to land in the slow `install` suite (`npm run
 * test:install`) alongside those files.
 *
 * ## Why marker PRESENCE, not byte-equality
 *
 * `bin/install.js` applies per-runtime path rewrites (`~/.claude/` -> the
 * runtime's prefix, attribution stamping, per-runtime `.md` converters)
 * AFTER composition (`shouldCompose`/`composeWorkflow`, just below in
 * `copyWithPathReplacement`). The catalog is host-agnostic and applies none
 * of those rewrites. Raw byte-equality between an emitted file and served
 * content is therefore FALSE BY CONSTRUCTION for every file whose content
 * embeds a rewritten path or attribution stamp. What DOES survive every
 * rewrite untouched is the COMPOSITION DECISION itself: did this file's
 * `<!-- gsd:section` markers get stripped or not? Marker-token presence is
 * that observable (the same detector
 * `tests/workflow-fragments-emission.install.test.cjs`'s
 * `noSectionMarkerLeaksIntoEmittedArtifacts` already uses), and it is
 * insensitive to every rewrite that runs after composition.
 *
 * ## Single representative runtime
 *
 * `shouldCompose`/`composeWorkflow` do not depend on runtime — only the
 * REWRITES applied after composition do, and this gate's marker-presence
 * comparison is deliberately blind to those. A multi-runtime loop would
 * therefore just re-run the identical composition decision N times; one real
 * spawned install (`claude`, the canonical host per `src/mcp-catalog.cts`'s
 * own module doc) is sufficient real-install evidence for what this gate
 * checks, and keeps this already-slow suite bounded.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');
const { runMinimalInstall, installerEnv } = require('./helpers/install-shared.cjs');
const { buildOverlayRepo } = require('./helpers/overlay-repo.cjs');

const { buildCatalog, readResource, shouldCompose } = require('../gsd-core/bin/lib/mcp-catalog.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MARKER_TOKEN = 'gsd:section';

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/** Recursively collect `.md` file paths under `absDir`, relative to `REPO_ROOT`, POSIX-normalized. */
function collectMarkdownFiles(absDir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.relative(REPO_ROOT, abs).replace(/\\/g, '/'));
    }
  }
  return out;
}

function realParitySet() {
  return [
    ...collectMarkdownFiles(path.join(REPO_ROOT, 'gsd-core', 'workflows')),
    ...collectMarkdownFiles(path.join(REPO_ROOT, 'gsd-core', 'references')),
  ];
}

/** `gsd-core/workflows/x.md` -> `gsd://workflows/x.md`; `gsd-core/references/y.md` -> `gsd://references/y.md`. */
function toResourceUri(relPath) {
  const m = /^gsd-core\/(workflows|references)\/(.+)$/.exec(relPath);
  if (!m) throw new Error(`fixture bug: unexpected relPath shape ${relPath}`);
  return `gsd://${m[1]}/${m[2]}`;
}

function hasMarker(text) {
  return text.includes(MARKER_TOKEN);
}

/**
 * Spawn a (possibly overlaid) `bin/install.js` at global scope and assert it
 * succeeded. Mirrors `workflow-fragments-emission.install.test.cjs`'s and
 * `fragment-single-edit-propagation.install.test.cjs`'s own `spawnGlobalInstall`
 * / `installOverlay` — kept local per those files' own documented rationale:
 * it is a thin spawn wrapper with no independent mechanism (unlike
 * `buildOverlayRepo`, which IS imported/reused), so a local copy carries none
 * of the "generative fix divergence" risk.
 */
function installOverlay(overlayRoot, runtime, extraArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-3072-parity-dest-${runtime}-`));
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
  const result = runNode(args, {
    cwd: root,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return { configDir: root, root, result };
}

// ─── row 48 — the real gate ─────────────────────────────────────────────────

describe('the parity gate — real installer vs real catalog', () => {
  test('installer composition decision matches the served catalog for every file in the real installed tree (row 48/52)', (t) => {
    const catalog = buildCatalog({ root: REPO_ROOT });
    const install = runMinimalInstall({ runtime: 'claude', scope: 'global' });
    t.after(() => cleanup(install.root));

    // Anti-vacuity guard: the installer must actually have emitted files —
    // proves the spawned install really ran (not a silent no-op / early exit).
    const emittedFileCount = install.manifest && install.manifest.files
      ? Object.keys(install.manifest.files).length
      : 0;
    assert.ok(
      emittedFileCount > 0,
      'the installer must have emitted at least one file — proves the real install actually ran',
    );

    const relPaths = realParitySet();
    assert.ok(relPaths.length > 0, 'the real parity set must be non-empty');

    let comparedCount = 0;
    let markerBearingWorkflowSeen = false;
    let nonComposedFileSeen = false;

    for (const relPath of relPaths) {
      const emittedPath = path.join(install.configDir, relPath);
      const uri = toResourceUri(relPath);
      if (!fs.existsSync(emittedPath) || !catalog.resources.has(uri)) continue; // outside this gate's install/catalog intersection

      comparedCount += 1;
      const sourceText = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      const emittedText = fs.readFileSync(emittedPath, 'utf8');
      const servedText = readResource(catalog, uri).text;

      const markersPresentInEmitted = hasMarker(emittedText);
      const markersPresentInServed = hasMarker(servedText);

      // row 48: the two independently-produced surfaces (a real spawned
      // installer vs. the catalog's own composition) must agree on whether
      // this file's markers were stripped.
      assert.equal(
        markersPresentInEmitted,
        markersPresentInServed,
        `${relPath}: composition decision diverged between the real installer (markers present=${markersPresentInEmitted}) and the served catalog (markers present=${markersPresentInServed})`,
      );

      // row 52 replacement: the installer's OBSERVABLE composition behavior
      // (not a re-declared regex) must match shouldCompose's own verdict —
      // composed files never retain markers; declined files are untouched.
      const composedAccordingToPredicate = shouldCompose(relPath);
      const expectedEmittedHasMarker = composedAccordingToPredicate ? false : hasMarker(sourceText);
      assert.equal(
        markersPresentInEmitted,
        expectedEmittedHasMarker,
        `${relPath}: real installer output does not match shouldCompose's verdict (shouldCompose=${composedAccordingToPredicate})`,
      );

      if (composedAccordingToPredicate && hasMarker(sourceText)) markerBearingWorkflowSeen = true;
      if (!composedAccordingToPredicate) nonComposedFileSeen = true;
    }

    assert.ok(comparedCount > 0, 'the comparison set must be non-empty — else the gate proves nothing');
    assert.ok(
      markerBearingWorkflowSeen,
      'the comparison set must include >=1 workflow that actually carries markers in source, else every comparison is a byte-identical no-op',
    );
    assert.ok(
      nonComposedFileSeen,
      'the comparison set must include >=1 file the predicate declines to compose, else a predicate that always returns true would still pass',
    );
  });
});

// ─── row 50 — a marker-documenting non-workflow composes on neither surface ─
//
// No real gsd-core/references/*.md or commands/gsd/*.md file documents the
// `<!-- gsd:section -->` marker syntax as of this change (verified: `grep -rl
// "gsd:section" gsd-core/references/ commands/gsd/` is empty). This test
// therefore uses a SYNTHETIC fixture: an overlay (`buildOverlayRepo`, the
// established technique — see `nonWorkflowMarkdownWithMarkerShapedLineIsNot
// Composed` in `workflow-fragments-emission.install.test.cjs`, which
// pioneered this exact fixture content) that overrides the real, existing
// `gsd-core/references/context-budget.md` leaf with a doc that documents
// marker syntax via a deliberately UNCLOSED marker-shaped example line — so
// if a regression ever ran composeWorkflow over it, parsing would THROW
// loudly (never silently mis-parse), which is what makes this a real
// negative control rather than a fixture that would coincidentally pass
// either way.

describe('a marker-documenting non-workflow composes on neither surface (row 50)', () => {
  test('reference doc content is present verbatim in source, in the real installed tree, and in the catalog served over the same tree', (t) => {
    const nonWorkflowDoc =
      '# Marker syntax\n\nExample (deliberately unfenced and unclosed to prove non-composition):\n\n<!-- gsd:section id="x" when="always" -->\nnever closed on purpose\n';
    const target = 'gsd-core/references/context-budget.md';

    assert.equal(shouldCompose(target), false, 'precondition: a references/ path must never be composed');

    const overlayRepo = buildOverlayRepo({ [target]: nonWorkflowDoc });
    t.after(() => cleanup(overlayRepo));

    const dest = installOverlay(overlayRepo, 'claude');
    t.after(() => cleanup(dest.root));
    assert.equal(
      dest.result.exitCode,
      0,
      `install must succeed: a non-workflow doc's marker-shaped line must never reach composeWorkflow\nstderr: ${dest.result.stderr}`,
    );

    const emittedPath = path.join(dest.configDir, target);
    assert.ok(fs.existsSync(emittedPath), 'emitted context-budget.md is missing');
    assert.equal(
      fs.readFileSync(emittedPath, 'utf8'),
      nonWorkflowDoc,
      'a marker-documenting reference doc must be emitted byte-identical by the real installer (never composed)',
    );

    // Catalog served over the SAME tree the installer just read from (the
    // overlay), not REPO_ROOT — REPO_ROOT has no such fixture on disk.
    const catalog = buildCatalog({ root: overlayRepo });
    const servedText = readResource(catalog, toResourceUri(target)).text;
    assert.equal(
      servedText,
      nonWorkflowDoc,
      'a marker-documenting reference doc must be served byte-identical by the catalog (never composed)',
    );
  });
});

// ─── row 51 — the gate is non-vacuous against a REAL installer regression ──
//
// Simulates the exact regression class this gate exists to catch: a
// composition-scope predicate that diverges reaching the REAL bin/install.js
// emit path — not a hand-duplicated regex living only in this test file (the
// prior defect this rewrite fixes). Overlays
// `gsd-core/bin/lib/mcp-catalog.cjs`'s `shouldCompose` export — the ONE thing
// `bin/install.js` imports from that module (`const { shouldCompose } =
// require('../gsd-core/bin/lib/mcp-catalog.cjs')`) — with one that never
// composes anything, exactly what a reverted or independently-diverged
// inline regex in `bin/install.js` would produce. `composeWorkflow` itself
// is left untouched, so the install still succeeds; it simply never gets
// called for any file.

describe('the parity gate is non-vacuous against a real installer regression (row 51)', () => {
  test('a broken shouldCompose reaching the real bin/install.js produces a detectable installer/catalog divergence', (t) => {
    const brokenPredicateRepo = buildOverlayRepo({
      'gsd-core/bin/lib/mcp-catalog.cjs': 'module.exports = { shouldCompose: () => false };\n',
    });
    t.after(() => cleanup(brokenPredicateRepo));

    const dest = installOverlay(brokenPredicateRepo, 'claude');
    t.after(() => cleanup(dest.root));
    assert.equal(
      dest.result.exitCode,
      0,
      `broken-predicate install must still succeed (composeWorkflow simply never runs)\nstderr: ${dest.result.stderr}`,
    );

    const target = 'gsd-core/workflows/autonomous.md';
    const sourceText = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8');
    assert.ok(
      hasMarker(sourceText),
      'precondition: the fixture workflow must actually carry markers, or this simulation proves nothing',
    );

    const emittedPath = path.join(dest.configDir, target);
    assert.ok(fs.existsSync(emittedPath), 'broken-predicate install is missing autonomous.md');
    const emittedText = fs.readFileSync(emittedPath, 'utf8');

    // The real, non-overlaid catalog is unaffected by the overlay — it still
    // composes autonomous.md and strips its markers.
    const catalog = buildCatalog({ root: REPO_ROOT });
    const servedText = readResource(catalog, toResourceUri(target)).text;

    assert.equal(hasMarker(emittedText), true, 'broken-predicate install unexpectedly composed anyway');
    assert.equal(hasMarker(servedText), false, 'the real, non-overlaid catalog unexpectedly failed to compose');

    // This is row 48's own assertion, run against a REAL spawned installer
    // that regressed exactly the way ADR-1671:309 warns about: it must
    // DIVERGE here, proving row 48 would have gone RED had this shipped.
    assert.notEqual(
      hasMarker(emittedText),
      hasMarker(servedText),
      'a broken installer-side predicate must produce a detectable emitted/served divergence, or row 48 would stay green through this exact regression',
    );
  });
});
