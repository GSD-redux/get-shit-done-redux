'use strict';

/**
 * emitted-sizes.test.cjs — matrix section B (#2931 `.gsd/phase/chore-2931-emitted-byte-caps/50-test-matrix.md`).
 *
 * Covers `buildEmittedSizes` (tests/helpers/install-shared.cjs), the sibling of
 * `buildParityManifest` that measures emitted-artifact BYTE SIZES over the same
 * walk + `<HOME>`/version normalization instead of hashing. B1/B2/B7 exercise it
 * against a real spawn-install (one shared fixture, built once in `before()`);
 * B3-B6 exercise it against small synthetic config trees so the CRLF, multi-byte,
 * `<HOME>`-normalization, and IO-fault behaviors are isolated and fast.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const {
  BUILD_SCRIPT,
  runMinimalInstall,
  buildEmittedSizes,
  buildParityManifest,
} = require('./helpers/install-shared.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI). Build it
// idempotently before the shared real-install fixture, mirroring
// tests/golden-install-tree.test.cjs.
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

// ─── Shared real-install fixture (B1, B2, B7) ─────────────────────────────────
// One windsurf global install, built once and shared read-only across the
// assertions that need a REAL emitted tree — a shared FIXTURE, not shared
// mutable state. Cleaned up in the top-level after().
let fixture = null;

before(() => {
  const { configDir, root } = runMinimalInstall({ runtime: 'windsurf', scope: 'global' });
  fixture = { configDir, root };
});

after(() => {
  if (fixture) cleanup(fixture.root);
});

// ─── Synthetic config-tree helper (B3-B6) ─────────────────────────────────────

/**
 * Build a throwaway config dir under a fresh temp root and populate it with
 * the given `{ relPath: content }` files (content is written as utf8, or as a
 * Buffer if one is passed directly). Returns `{ configDir, root }` where
 * `configDir === root` (no runtime-specific subdirectory layout needed for
 * these synthetic cases).
 */
function makeSyntheticConfig(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-emitted-sizes-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { configDir: root, root };
}

// ─── B1 ────────────────────────────────────────────────────────────────────

test('capturesEmittedBytesFromRealInstall', () => {
  const sizes = buildEmittedSizes(fixture.configDir, fixture.root);
  const keys = Object.keys(sizes);

  assert.ok(keys.length > 0, 'expected at least one emitted artifact');
  for (const rel of keys) {
    assert.strictEqual(typeof sizes[rel], 'number', `${rel}: expected numeric byte count`);
    assert.ok(Number.isInteger(sizes[rel]) && sizes[rel] >= 0, `${rel}: expected a non-negative integer`);
  }
});

// ─── B2 ────────────────────────────────────────────────────────────────────
// The two must never diverge on which files they cover — sizeKeySetMatchesParityManifestKeySet
// is the coverage-parity guard for that.

test('sizeKeySetMatchesParityManifestKeySet', () => {
  const sizes = buildEmittedSizes(fixture.configDir, fixture.root);
  const manifest = buildParityManifest(fixture.configDir, fixture.root);

  assert.deepStrictEqual(Object.keys(sizes), Object.keys(manifest));
});

// ─── B3 ────────────────────────────────────────────────────────────────────

test('countsCrlfIdenticallyToLf', () => {
  const body = 'line one\nline two\nline three\n';
  const crlfConfig = makeSyntheticConfig({ 'artifact.md': body.replace(/\n/g, '\r\n') });
  const lfConfig = makeSyntheticConfig({ 'artifact.md': body });

  try {
    const crlfSizes = buildEmittedSizes(crlfConfig.configDir, crlfConfig.root);
    const lfSizes = buildEmittedSizes(lfConfig.configDir, lfConfig.root);

    assert.strictEqual(crlfSizes['artifact.md'], lfSizes['artifact.md']);
  } finally {
    cleanup(crlfConfig.root);
    cleanup(lfConfig.root);
  }
});

// ─── B4 ────────────────────────────────────────────────────────────────────

test('countsMultiByteUtf8AsBytes', () => {
  // em-dash (—, U+2014) and right-arrow (→, U+2192) are each 3 bytes in UTF-8
  // but 1 UTF-16 code unit — a `.length`-based counter would undercount.
  const content = 'a—b→c';
  const { configDir, root } = makeSyntheticConfig({ 'artifact.md': content });

  try {
    const sizes = buildEmittedSizes(configDir, root);
    assert.strictEqual(sizes['artifact.md'], Buffer.byteLength(content, 'utf8'));
    assert.notStrictEqual(sizes['artifact.md'], content.length, 'byte count must not equal UTF-16 length');
  } finally {
    cleanup(root);
  }
});

// ─── B5 ────────────────────────────────────────────────────────────────────

test('normalizesConfigRootBeforeCounting', () => {
  const { configDir, root } = makeSyntheticConfig({
    // Simulate an `@`-reference embedding the absolute temp root, as a real
    // install's projected agents/commands/workflows do.
    'artifact.md': `see @${root}/gsd-core/CONTEXT.md for details\n`,
  });

  try {
    const sizes = buildEmittedSizes(configDir, root);
    const expectedNormalized = `see @<HOME>/gsd-core/CONTEXT.md for details\n`;

    assert.strictEqual(sizes['artifact.md'], Buffer.byteLength(expectedNormalized, 'utf8'));
    // The raw on-disk byte count (root not collapsed to '<HOME>') must differ
    // whenever the root path is not already exactly 6 characters ('<HOME>' length) —
    // proving the measured count really is post-normalization, not raw disk bytes.
    const rawContent = fs.readFileSync(path.join(configDir, 'artifact.md'));
    if (root.length !== '<HOME>'.length) {
      assert.notStrictEqual(sizes['artifact.md'], rawContent.length);
    }
  } finally {
    cleanup(root);
  }
});

// ─── B6 ────────────────────────────────────────────────────────────────────

test('propagatesReadFailureRatherThanReturningPartialMap', (t) => {
  const { configDir, root } = makeSyntheticConfig({
    'a.md': 'alpha\n',
    'b.md': 'beta\n',
  });

  const original = fs.readFileSync;
  const injected = new Error('injected read failure');
  const mockedReadFileSync = t.mock.method(fs, 'readFileSync', () => {
    throw injected;
  });
  t.after(() => {
    mockedReadFileSync.mock.restore();
    assert.strictEqual(fs.readFileSync, original, 'fs.readFileSync must be restored');
    cleanup(root);
  });

  assert.throws(() => buildEmittedSizes(configDir, root), (err) => err === injected);
});

// ─── B7 ────────────────────────────────────────────────────────────────────
// The highest-value test in this file. buildEmittedSizes must be a SIBLING of
// buildParityManifest, never a replacement folded into it: diffEmitted
// (tests/helpers/emitted-diff.cjs) compares two manifests with
// `before[rel] === after[rel]`, which requires plain STRING hash values. If a
// future refactor merged bytes into buildParityManifest's own return shape
// (e.g. `{ hash, bytes }` objects), every one of the 8,529 emitted paths across
// the 19 runtime manifests would become reference-unequal and the sole merge
// gate would report universal false-positive "modified" drift. This test pins
// the string shape so that regression cannot land silently.

test('parityManifestStillReturnsStringHashValues', () => {
  const manifest = buildParityManifest(fixture.configDir, fixture.root);
  const keys = Object.keys(manifest);

  assert.ok(keys.length > 0, 'expected at least one manifest entry to check');
  for (const rel of keys) {
    assert.strictEqual(typeof manifest[rel], 'string', `${rel}: buildParityManifest value must be a string`);
    assert.match(manifest[rel], /^[0-9a-f]{16}$/, `${rel}: expected a 16-char lowercase hex hash`);
  }
});
