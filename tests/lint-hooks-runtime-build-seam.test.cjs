'use strict';

/**
 * Tests for `scripts/lint-hooks-runtime-build-seam.cjs` — the CI guard that
 * every `hooks/**` file requiring a compiled `gsd-core/bin/lib/*.cjs` module
 * must also self-heal via `ensureRuntimeBuild()` first (#3582).
 *
 * Mirrors the sibling `lint-*-drift.cjs` test convention (see e.g.
 * `tests/lint-planning-artifact-writer-drift.test.cjs`): pure-function unit
 * tests against in-memory strings for the fast cases, plus an on-disk
 * fixture-tree test (via `scanRepo`) proving the guard genuinely detects a
 * real violating file — "a ratchet that has never been proven to fail is
 * worthless" (CLAUDE.md).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  scanFile,
  scanRepo,
  stripComments,
} = require('../scripts/lint-hooks-runtime-build-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// ─── Case 1: the guard passes clean against the REAL hooks/ tree ───────────

describe('scanRepo — real hooks/ tree', () => {
  test('reports zero violations against the actual hooks/ tree', () => {
    const violations = scanRepo(REPO_ROOT);
    assert.deepStrictEqual(
      violations,
      [],
      `unexpected hooks/ runtime-build-seam violation(s): ${JSON.stringify(violations, null, 2)}`,
    );
  });

  test('the real tree has REAL compiled-lib requires (the detector is not silently inert)', () => {
    // A detector that never matches anything would also report zero
    // violations. Prove it actually found the six #3582 hook files' real
    // gsd-core/bin/lib/*.cjs requires and confirmed each is seam-wired.
    const hookFiles = [
      'gsd-agent-isolation-guard.js',
      'gsd-cursor-subagent-start.js',
      'gsd-statusline.js',
      'gsd-check-update-worker.js',
      'gsd-check-update.js',
      'gsd-update-banner.js',
    ];
    for (const name of hookFiles) {
      const text = fs.readFileSync(path.join(REPO_ROOT, 'hooks', name), 'utf8');
      const { compiledLibRequires, hasSeamRequire, hasSeamCall } = scanFile(text);
      assert.ok(compiledLibRequires.length > 0, `${name}: expected at least one compiled-lib require`);
      assert.ok(hasSeamRequire, `${name}: expected a require of ensure-runtime-build.cjs`);
      assert.ok(hasSeamCall, `${name}: expected an ensureRuntimeBuild(...) call`);
    }
  });
});

// ─── Case 2: pure-function unit tests (in-memory strings) ─────────────────

describe('scanFile — pure detection', () => {
  test('a file with no compiled-lib require has nothing to check', () => {
    const text = "'use strict';\nconst fs = require('fs');\nmodule.exports = {};\n";
    const { compiledLibRequires } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, []);
  });

  test('a compiled-lib require with NO seam require/call is detected', () => {
    const text = [
      "'use strict';",
      "const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
      'module.exports = { runtimes };',
      '',
    ].join('\n');
    const { compiledLibRequires, hasSeamRequire, hasSeamCall } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, ['../gsd-core/bin/lib/capability-registry.cjs']);
    assert.equal(hasSeamRequire, false);
    assert.equal(hasSeamCall, false);
  });

  test('a compiled-lib require WITH a seam require + call is not flagged', () => {
    const text = [
      "'use strict';",
      "const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');",
      'function f() {',
      '  ensureRuntimeBuild();',
      "  const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
      '  return runtimes;',
      '}',
      'module.exports = { f };',
      '',
    ].join('\n');
    const { compiledLibRequires, hasSeamRequire, hasSeamCall } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, ['../gsd-core/bin/lib/capability-registry.cjs']);
    assert.equal(hasSeamRequire, true);
    assert.equal(hasSeamCall, true);
  });

  test('a seam REQUIRE with no CALL still counts as missing (import-only bypass)', () => {
    const text = [
      "'use strict';",
      // Imported but never invoked — must not satisfy the guard.
      "const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');",
      "const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
      'module.exports = { runtimes, ensureRuntimeBuild };',
      '',
    ].join('\n');
    const { hasSeamRequire, hasSeamCall } = scanFile(text);
    assert.equal(hasSeamRequire, true);
    assert.equal(hasSeamCall, false);
  });

  test('a real require() inside a // comment is NOT counted (comment-only mention)', () => {
    const text = [
      "'use strict';",
      "// example: require('../gsd-core/bin/lib/capability-registry.cjs')",
      "const fs = require('fs');",
      '',
    ].join('\n');
    const { compiledLibRequires } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, []);
  });

  // Regression: this repo's own hook comments legitimately spell the glob
  // `gsd-core/bin/lib/*.cjs` inside a `//` line — a `/` immediately followed
  // by `*` forms a bare `/*` token. A naive whole-text
  // `/\*[\s\S]*?\*\//g` block-comment stripper reads that as an OPENING
  // block comment and silently deletes everything up to the next unrelated
  // `*/` later in the file — including real require() lines. Caught while
  // authoring this guard (it ate its own seam require in
  // hooks/gsd-agent-isolation-guard.js); locked here so it cannot regress.
  test('a `//` comment containing a glob like lib/*.cjs does not swallow later real code', () => {
    const text = [
      "'use strict';",
      '// gsd-core/bin/lib/*.cjs (foo.cjs, bar.cjs) are compiled artifacts.',
      "const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');",
      'function f() {',
      '  ensureRuntimeBuild();',
      "  const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
      '  return runtimes;',
      '}',
      '/* a real, later, unrelated block comment */',
      'module.exports = { f };',
      '',
    ].join('\n');
    const stripped = stripComments(text);
    assert.ok(
      stripped.includes("require('../gsd-core/bin/ensure-runtime-build.cjs')"),
      'the seam require must survive comment-stripping',
    );
    assert.ok(stripped.includes('ensureRuntimeBuild();'), 'the seam call must survive comment-stripping');
    const { compiledLibRequires, hasSeamRequire, hasSeamCall } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, ['../gsd-core/bin/lib/capability-registry.cjs']);
    assert.equal(hasSeamRequire, true);
    assert.equal(hasSeamCall, true);
  });

  test('a genuine multi-line block comment is still stripped (no false-positive require inside it)', () => {
    const text = [
      "'use strict';",
      '/**',
      " * Example: require('../gsd-core/bin/lib/capability-registry.cjs') is",
      ' * mentioned here only as documentation prose.',
      ' */',
      "const fs = require('fs');",
      '',
    ].join('\n');
    const { compiledLibRequires } = scanFile(text);
    assert.deepStrictEqual(compiledLibRequires, []);
  });
});

// ─── Case 3: on-disk fixture tree via scanRepo — proves the guard CAN fail ─

describe('scanRepo — on-disk fixture tree (proves the guard is not vacuous)', () => {
  function writeFixtureTree(dir, { withSeam }) {
    const hooksDir = path.join(dir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const badLines = [
      "'use strict';",
      "const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
      'module.exports = { runtimes };',
      '',
    ];
    fs.writeFileSync(path.join(hooksDir, 'bad-hook.js'), badLines.join('\n'));

    const goodLines = withSeam
      ? [
          "'use strict';",
          "const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');",
          'ensureRuntimeBuild();',
          "const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');",
          'module.exports = { runtimes };',
          '',
        ]
      : [
          "'use strict';",
          "const fs = require('fs');",
          'module.exports = { fs };',
          '',
        ];
    fs.writeFileSync(path.join(hooksDir, 'good-hook.js'), goodLines.join('\n'));

    // hooks/dist/ is the generated build-output copy — never scanned, even
    // when it contains an identical un-sealed require.
    const distDir = path.join(hooksDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'bad-hook.js'), badLines.join('\n'));
  }

  test('a fixture hook requiring a compiled module with NO seam is FLAGGED', (t) => {
    const dir = createTempDir('gsd-lint-hooks-seam-');
    t.after(() => cleanup(dir));
    writeFixtureTree(dir, { withSeam: true });

    const violations = scanRepo(dir);
    const files = violations.map((v) => v.file);
    assert.ok(files.includes('hooks/bad-hook.js'), `expected hooks/bad-hook.js flagged, got: ${JSON.stringify(files)}`);
    assert.ok(
      !files.includes('hooks/good-hook.js'),
      `hooks/good-hook.js (seam-wired) must NOT be flagged, got: ${JSON.stringify(files)}`,
    );
    const bad = violations.find((v) => v.file === 'hooks/bad-hook.js');
    assert.deepStrictEqual(bad.compiledLibRequires, ['../gsd-core/bin/lib/capability-registry.cjs']);
    assert.ok(bad.missing.length > 0);
  });

  test('hooks/dist/ (generated build-output copy) is never scanned, even with the same violation', (t) => {
    const dir = createTempDir('gsd-lint-hooks-seam-dist-');
    t.after(() => cleanup(dir));
    writeFixtureTree(dir, { withSeam: true });

    const violations = scanRepo(dir);
    const files = violations.map((v) => v.file);
    assert.ok(
      !files.some((f) => f.startsWith('hooks/dist/')),
      `hooks/dist/ must be excluded from the scan, got: ${JSON.stringify(files)}`,
    );
  });

  test('a fixture tree with NO offending hooks reports zero violations (no false positive)', (t) => {
    const dir = createTempDir('gsd-lint-hooks-seam-clean-');
    t.after(() => cleanup(dir));
    writeFixtureTree(dir, { withSeam: false });
    fs.unlinkSync(path.join(dir, 'hooks', 'bad-hook.js'));

    const violations = scanRepo(dir);
    assert.deepStrictEqual(violations, []);
  });
});
