// docs-guard-exempt: docs/installer-migrations.md is cited only in comments as design rationale; never read.
'use strict';

/**
 * TDD tests for installer migration 006:
 * 2026-07-20-pi-extension-cjs-to-js (#2470)
 *
 * #2470 renamed pi's installed native extension from `extensions/gsd.cjs` to
 * `extensions/gsd.js`, because pi's own auto-discovery filter
 * (`isExtensionFile()` in @earendil-works/pi-coding-agent) accepts only `.ts`
 * and `.js` and silently skips everything else. Installs made before that fix
 * still carry the stale, permanently-inert `extensions/gsd.cjs`; the installer
 * writes the new `.js` alongside it and would otherwise orphan the old file
 * forever (it drops out of the manifest, so uninstall never removes it).
 *
 * This migration retires the stale copy. Coverage follows the matrix in
 * docs/installer-migrations.md#authoring-workflow:
 *   1. metadata / authoring-guard conformance
 *   2. stale file absent            -> empty plan (idempotent, fresh installs)
 *   3. stale file managed-pristine  -> remove-managed
 *   4. stale file managed-modified  -> backup-and-remove (never silent delete)
 *   5. stale file unknown           -> NO action (never remove unowned files)
 *   6. the replacement gsd.js and neighbouring user files are never touched
 *   7. runtime scoping: pi only
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../gsd-core/bin/lib/installer-migrations/006-pi-extension-cjs-to-js.cjs');

const {
  classifyArtifact: realClassifyArtifact,
  readInstallManifest,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');

const STALE_REL = 'extensions/gsd.cjs';
const CURRENT_REL = 'extensions/gsd.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migration-006-test-'));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in migration test; no helpers import available
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify(
      {
        version: '1.7.0',
        timestamp: '2026-07-20T00:00:00.000Z',
        mode: 'full',
        files,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function makePlanCtx(configDir) {
  const manifest = readInstallManifest(configDir);
  return {
    configDir,
    classifyArtifact: (relPath) => realClassifyArtifact(configDir, relPath, manifest),
  };
}

/** sha256 hash in the manifest's own format, so a file reads as pristine. */
function hashOf(root, relPath) {
  const crypto = require('node:crypto');
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, relPath)))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Metadata
// ---------------------------------------------------------------------------

describe('migration 006 metadata', () => {
  test('exports a single migration object with the required authoring fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(typeof migration.id, 'string');
    assert.ok(migration.id.length > 0, 'id must be non-empty');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(typeof migration.introducedIn, 'string');
    assert.ok(Array.isArray(migration.scopes), 'scopes must be an array');
    assert.ok(migration.scopes.includes('global'), 'scopes must include global');
    assert.ok(migration.scopes.includes('local'), 'scopes must include local');
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });

  test('is scoped to pi only (no other runtime installs this artifact)', () => {
    assert.ok(Array.isArray(migration.runtimes), 'runtimes must be an explicit array');
    assert.deepEqual(migration.runtimes, ['pi']);
  });

  test('id carries the expected date prefix and names the retired artifact', () => {
    assert.ok(
      migration.id.startsWith('2026-07-20-'),
      `id should start with the date prefix, got: ${migration.id}`,
    );
    assert.match(migration.id, /pi-extension/);
  });
});

// ---------------------------------------------------------------------------
// 2-5. plan() behaviour by classification
// ---------------------------------------------------------------------------

describe('migration 006 plan()', () => {
  test('emits no actions when the stale extension is absent (fresh install, idempotent)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    writeFile(dir, CURRENT_REL, '// current extension\n');
    writeManifest(dir, { [CURRENT_REL]: hashOf(dir, CURRENT_REL) });

    const actions = migration.plan(makePlanCtx(dir));
    assert.deepEqual(actions, [], 'no stale file -> no actions');
  });

  test('emits remove-managed for a pristine manifest-managed stale extension', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    writeFile(dir, STALE_REL, '// stale pre-#2470 extension\n');
    writeManifest(dir, { [STALE_REL]: hashOf(dir, STALE_REL) });

    const actions = migration.plan(makePlanCtx(dir));
    assert.equal(actions.length, 1, `expected exactly one action, got ${JSON.stringify(actions)}`);
    assert.equal(actions[0].type, 'remove-managed');
    assert.equal(actions[0].relPath, STALE_REL);
    assert.ok(
      typeof actions[0].ownershipEvidence === 'string' && actions[0].ownershipEvidence.length > 0,
      'destructive actions require ownershipEvidence (authoring guard)',
    );
    assert.ok(
      typeof actions[0].reason === 'string' && actions[0].reason.length > 0,
      'action must carry a human-readable reason for dry-run output',
    );
  });

  test('emits backup-and-remove when the user locally modified the stale extension', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    writeFile(dir, STALE_REL, '// stale pre-#2470 extension\n');
    // Manifest records a DIFFERENT hash -> managed-modified.
    writeManifest(dir, { [STALE_REL]: 'a'.repeat(64) });

    const actions = migration.plan(makePlanCtx(dir));
    assert.equal(actions.length, 1);
    assert.equal(
      actions[0].type,
      'backup-and-remove',
      'a locally patched managed file must be backed up, never silently deleted',
    );
    assert.equal(actions[0].relPath, STALE_REL);
    assert.ok(actions[0].ownershipEvidence);
  });

  test('emits NO action for an unknown (non-manifest) gsd.cjs — never remove unowned files', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    // File present but absent from the manifest -> classification 'unknown'.
    writeFile(dir, STALE_REL, '// hand-placed by the user\n');
    writeManifest(dir, {});

    const actions = migration.plan(makePlanCtx(dir));
    assert.deepEqual(
      actions,
      [],
      'unknown files are preserved (docs/installer-migrations.md#ownership)',
    );
  });

  test('never targets the replacement extension or neighbouring user files', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    writeFile(dir, STALE_REL, '// stale\n');
    writeFile(dir, CURRENT_REL, '// current\n');
    writeFile(dir, 'extensions/my-own-extension.js', '// user-authored\n');
    writeManifest(dir, {
      [STALE_REL]: hashOf(dir, STALE_REL),
      [CURRENT_REL]: hashOf(dir, CURRENT_REL),
    });

    const actions = migration.plan(makePlanCtx(dir));
    const targeted = actions.map((a) => a.relPath);
    assert.deepEqual(targeted, [STALE_REL]);
    assert.ok(!targeted.includes(CURRENT_REL), 'must not remove the replacement extension');
    assert.ok(
      !targeted.includes('extensions/my-own-extension.js'),
      "must not touch a user's own extension sitting in the same directory",
    );
  });

  test('plan() does not mutate disk (planning is pure)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    writeFile(dir, STALE_REL, '// stale\n');
    writeManifest(dir, { [STALE_REL]: hashOf(dir, STALE_REL) });

    migration.plan(makePlanCtx(dir));
    assert.ok(
      fs.existsSync(path.join(dir, STALE_REL)),
      'plan() must not remove anything — the executor owns mutation',
    );
  });
});
