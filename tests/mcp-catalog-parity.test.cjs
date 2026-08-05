'use strict';

/**
 * Failing-first parity tests — the ADR-1671:309 (`DEFECT.GENERATIVE-FIX`)
 * requirement for issue #3072 (epic #1671 Phase B),
 * `.gsd/phase/feat-3072-mcp-served-catalog/40-design.md` "The parity
 * assertion".
 *
 * Covers 50-test-matrix.md rows 48-52: for every servable file over the
 * REAL content tree, the catalog's served text must equal what
 * `bin/install.js`'s composition stage produces from the same source, using
 * the SAME exported `shouldCompose` predicate both sides call (never a
 * second, hand-duplicated regex — that duplication IS the generative-fix
 * divergence this gate exists to catch).
 *
 * Two anti-vacuity guards (rows 49-50) and one executable divergence
 * simulation (row 51) prove the gate itself is not a vacuous byte-identical
 * no-op: F2 (`40-design.md`) notes an unmarked document composes
 * byte-identical BY CONSTRUCTION, so a parity set containing only
 * marker-free files would pass even with a broken predicate.
 *
 * No source-grep (CONTRIBUTING.md): the real `.md` files here are passed as
 * DATA into `composeWorkflow`/`shouldCompose` — never read back and matched
 * for literal substrings — and every assertion compares typed/structured
 * results, not rendered prose.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { buildCatalog, readResource, shouldCompose } = require('../gsd-core/bin/lib/mcp-catalog.cjs');
const { composeWorkflow } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

// Mirrors bin/install.js:7731's pre-refactor inline regex EXACTLY (comment
// there: "Scoped to gsd-core/workflows/ ONLY ... Path is normalized
// UNCONDITIONALLY ... checked as a path-segment match"). Row 52 asserts
// `shouldCompose` classifies real repo paths identically to this regex, so
// the coming install.js refactor (swap the regex for the shared predicate)
// is behavior-preserving.
const OLD_INSTALL_SCOPE_RE = /(?:^|\/)gsd-core\/workflows\//;

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

// ─── row 48 ──────────────────────────────────────────────────────────────

describe('the parity gate — real content tree', () => {
  test('served content matches the installer composition stage (row 48)', () => {
    const catalog = buildCatalog({ root: REPO_ROOT });
    const relPaths = realParitySet();
    assert.ok(relPaths.length > 0, 'the real parity set must be non-empty');

    for (const relPath of relPaths) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      const installStageText = shouldCompose(relPath) ? composeWorkflow(raw, { sourcePath: relPath }) : raw;
      const catalogText = readResource(catalog, toResourceUri(relPath)).text;
      assert.equal(catalogText, installStageText, `parity mismatch for ${relPath}`);
    }
  });

  // ─── row 49: anti-vacuity — a marker-bearing workflow must be in the set ──

  test('parity set includes a marker-bearing workflow (row 49)', () => {
    const catalog = buildCatalog({ root: REPO_ROOT });
    const target = 'gsd-core/workflows/autonomous.md';

    const raw = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8');
    assert.notEqual(
      composeWorkflow(raw, { sourcePath: target }),
      raw,
      'precondition: the fixture workflow must actually carry markers, or this row proves nothing'
    );

    const uris = [...catalog.resources.keys()];
    assert.ok(
      uris.includes(toResourceUri(target)),
      'the parity set must contain at least one workflow that actually carries markers, else every comparison is a byte-identical no-op'
    );
  });

  // ─── row 50: anti-vacuity — a non-composed file must be in the set ────────

  test('parity set includes a non-composed file (row 50)', () => {
    const catalog = buildCatalog({ root: REPO_ROOT });
    const uris = [...catalog.resources.keys()];
    assert.ok(
      uris.some((u) => u.startsWith('gsd://references/')),
      'the parity set must contain at least one file the predicate says NOT to compose, else a predicate that always returns true would still pass'
    );
    assert.equal(shouldCompose('gsd-core/references/whatever.md'), false, 'a references/ path must never be composed');
  });
});

// ─── row 51: predicate divergence simulation ────────────────────────────────

describe('the parity gate is non-vacuous (row 51)', () => {
  test('parity fails if the predicate stops discriminating', (t) => {
    const root = createTempDir('mcp-catalog-parity-divergence-');
    t.after(() => cleanup(root));

    fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(root, 'gsd-core', 'references'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gsd-core', 'workflows', 'plain.md'), 'a plain workflow, no markers\n');

    // A reference doc that DOCUMENTS marker syntax with an unfenced example
    // (the F1 defect class) — composing it for real visibly changes bytes,
    // which is exactly what a predicate that "stops discriminating" (always
    // returns true) would wrongly do to it.
    const documentsMarkerSyntax = [
      '# How markers work',
      '',
      '<!-- gsd:section id="example" when="always" -->',
      'example body',
      '<!-- /gsd:section -->',
      '',
    ].join('\n');
    const refRelPath = 'gsd-core/references/documents-markers.md';
    fs.writeFileSync(path.join(root, refRelPath), documentsMarkerSyntax);

    const catalog = buildCatalog({ root });
    const correctText = readResource(catalog, toResourceUri(refRelPath)).text;
    assert.equal(correctText, documentsMarkerSyntax, 'precondition: the correct predicate must serve this reference verbatim');

    // Simulate a predicate that stopped discriminating: force composition
    // regardless of `shouldCompose`'s real verdict, as the parity loop in
    // row 48 would if `shouldCompose` were replaced by `() => true`.
    const alwaysTruePredicateText = composeWorkflow(documentsMarkerSyntax, { sourcePath: refRelPath });

    assert.notEqual(
      alwaysTruePredicateText,
      correctText,
      'a predicate that stops discriminating must make the parity comparison actually diverge, or the anti-vacuity guard proves nothing'
    );
  });
});

// ─── row 52: bin/install.js uses the shared predicate ───────────────────────

describe('bin/install.js uses the shared predicate', () => {
  test('shouldCompose classifies real repo paths identically to install.js pre-refactor regex (row 52)', () => {
    const relPaths = realParitySet();
    assert.ok(relPaths.length > 0);
    for (const relPath of relPaths) {
      assert.equal(
        shouldCompose(relPath),
        OLD_INSTALL_SCOPE_RE.test(relPath),
        `shouldCompose must classify ${relPath} identically to bin/install.js's inline scoping regex`
      );
    }
  });
});
