'use strict';

/**
 * golden-install-tree.test.cjs — file-set snapshot layer (#2267 Phase 2).
 *
 * Companion to tests/golden-install-parity.test.cjs. That harness hashes file
 * CONTENT (catches a byte changing); this harness snapshots only the SORTED
 * LIST of emitted relative paths (catches a file appearing/disappearing).
 * Because it carries no hashes, a legitimate content-only change produces NO
 * diff here at all, and a file being added/removed produces a small, clean,
 * reviewable diff instead of hash noise. Both harnesses reuse the exact same
 * exclusion set (buildParityManifest, tests/helpers/install-shared.cjs,
 * #2266) via buildInstallTree, so the two can never diverge on which files
 * they cover.
 *
 * ## UPDATE mode
 *
 * Run with UPDATE_INSTALL_TREE=1 to (re-)capture fixtures:
 *   UPDATE_INSTALL_TREE=1 node --test tests/golden-install-tree.test.cjs
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { RUNTIME_META, runMinimalInstall, BUILD_SCRIPT, buildInstallTree } = require('./helpers/install-shared.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI). The scoped
// CI test lane does not run build:hooks, so a real install there emits no hooks/
// dir — making the harness report "removed (N) hooks/…". Build it idempotently
// here so the harness is lane-independent (mirrors golden-install-parity.test.cjs).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

const UPDATE = process.env.UPDATE_INSTALL_TREE === '1';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'install-tree');

// buildInstallTree (tests/helpers/install-shared.cjs) reuses buildParityManifest's
// exact exclusion constants (VOLATILE_FILES, HOOK_CONFIG_FILES,
// HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES) — see that module for the full
// rationale behind each exclusion.

// Ensure the fixture directory exists (needed for UPDATE mode)
if (UPDATE) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
}

function diffTree(actual, fixture) {
  const fixtureSet = new Set(fixture);
  const actualSet = new Set(actual);
  const added = actual.filter((p) => !fixtureSet.has(p));
  const removed = fixture.filter((p) => !actualSet.has(p));
  return { added, removed };
}

const runtimes = Object.keys(RUNTIME_META);

for (const runtime of runtimes) {
  test(`install tree — ${runtime}`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
      return;
    }
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    let actual;
    try {
      actual = buildInstallTree(configDir, root);
    } finally {
      cleanup(root);
    }

    const fixturePath = path.join(FIXTURE_DIR, `${runtime}.json`);

    if (UPDATE) {
      fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      process.stdout.write(`  [UPDATE] ${runtime}: wrote ${actual.length} paths → ${fixturePath}\n`);
      return;
    }

    // Assert mode: compare against golden fixture
    if (!fs.existsSync(fixturePath)) {
      assert.fail(
        `Install-tree fixture missing for runtime '${runtime}': ${fixturePath}\n` +
        'Run "npm run gen:install-tree" to generate the fixtures (or, for humans, UPDATE_INSTALL_TREE=1 node --test tests/golden-install-tree.test.cjs).'
      );
    }

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const { added, removed } = diffTree(actual, fixture);

    if (added.length > 0 || removed.length > 0) {
      const lines = [`Install-tree mismatch for runtime '${runtime}':`];
      if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
      if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
      lines.push('If the change is intentional, run "npm run gen:install-tree" to regenerate the fixtures (works without node --test; humans may also use UPDATE_INSTALL_TREE=1 node --test).');
      assert.deepEqual(actual, fixture, lines.join('\n'));
    }
  });
}

// #2086 (EoS/claude): claude is the reference host and the ONLY runtime with a
// distinct LOCAL "legacy flat-commands" layout (commands/gsd-*.md + agents/gsd-*.md).
// The loop above snapshots the GLOBAL skills layout; this snapshots the LOCAL
// commands/agents layout's file set too (mirrors golden-install-parity.test.cjs).
test('install tree — claude (local legacy layout)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
    return;
  }
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
  let actual;
  try {
    actual = buildInstallTree(configDir, root);
  } finally {
    cleanup(root);
  }

  const fixturePath = path.join(FIXTURE_DIR, 'claude-local.json');

  if (UPDATE) {
    fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    process.stdout.write(`  [UPDATE] claude-local: wrote ${actual.length} paths → ${fixturePath}\n`);
    return;
  }

  if (!fs.existsSync(fixturePath)) {
    assert.fail(
      `Install-tree fixture missing for claude-local: ${fixturePath}\n` +
      'Run "npm run gen:install-tree" to generate the fixtures (or, for humans, UPDATE_INSTALL_TREE=1 node --test tests/golden-install-tree.test.cjs).',
    );
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { added, removed } = diffTree(actual, fixture);
  if (added.length || removed.length) {
    const lines = ['Install-tree mismatch for claude-local:'];
    if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
    if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
    lines.push('If the change is intentional, run "npm run gen:install-tree" to regenerate the fixtures (works without node --test; humans may also use UPDATE_INSTALL_TREE=1 node --test).');
    assert.deepEqual(actual, fixture, lines.join('\n'));
  }
});
