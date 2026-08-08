'use strict';

/**
 * TDD tests for installer migration 009:
 * 2026-08-07-pi-retire-reserved-hooks-dir (#3023)
 *
 * pi reserves `hooks/` as its own deprecated extension directory and warns on
 * every startup whenever the path exists — its `checkDeprecatedExtensionDirs()`
 * fires on mere existence, not on the directory having contents. GSD used to
 * install its shared hook bundle at exactly that reserved path; the fix moved
 * the install target to `gsd-hooks/`, but an EXISTING pi install that upgrades
 * still has the old `hooks/` tree on disk. This migration retires it: managed
 * files are removed (or backed up if locally modified), unmanifested files are
 * preserved, and the directory itself (plus `hooks/lib/`) is removed only once
 * it is genuinely empty, via the shared `remove-empty-dir` action.
 *
 * Coverage:
 *   1. only manifested, unmodified files under hooks/         -> directory gone
 *   2. a manifested file locally modified                     -> backed up, not silently deleted
 *   3. an unmanifested user file under hooks/                 -> file AND parent directory preserved
 *   4. hooks/lib/ manifested + unmodified                      -> lib/ pruned too
 *   5. claude install with a populated hooks/                  -> completely untouched (independence)
 *   6. running the migration twice on case 1                   -> second run is a clean no-op, no throw
 *   7. a symlink under hooks/ pointing outside configDir        -> not followed, not deleted through
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const migration = require('../gsd-core/bin/lib/installer-migrations/009-pi-retire-reserved-hooks-dir.cjs');

const {
  classifyArtifact: realClassifyArtifact,
  readInstallManifest,
  planInstallerMigrations,
  applyInstallerMigrationPlan,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

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
        version: '1.9.2',
        timestamp: '2026-08-07T00:00:00.000Z',
        mode: 'full',
        files,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function hashOf(root, relPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relPath))).digest('hex');
}

function makePlanCtx(configDir, runtime = 'pi') {
  const manifest = readInstallManifest(configDir);
  return {
    configDir,
    runtime,
    classifyArtifact: (relPath) => realClassifyArtifact(configDir, relPath, manifest),
  };
}

function runFullMigration(configDir, runtime = 'pi') {
  const plan = planInstallerMigrations({
    configDir,
    runtime,
    scope: 'global',
    migrations: [migration],
  });
  assert.deepEqual(plan.blocked, [], 'no action should ever require a prompt or be blocked as unknown');
  if (plan.actions.length === 0) return plan;
  applyInstallerMigrationPlan({ configDir, plan });
  return plan;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('migration 009 metadata', () => {
  test('exports a single migration object with the required authoring fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(typeof migration.id, 'string');
    assert.equal(migration.id, '2026-08-07-pi-retire-reserved-hooks-dir');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(typeof migration.introducedIn, 'string');
    assert.deepEqual(migration.runtimes, ['pi']);
    assert.ok(migration.scopes.includes('global'));
    assert.ok(migration.scopes.includes('local'));
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });
});

// ---------------------------------------------------------------------------
// 1. Only manifested, unmodified files -> directory gone
// ---------------------------------------------------------------------------

describe('migration 009: fully managed hooks/ tree', () => {
  test('removes manifested unmodified files and then the emptied hooks/ directory', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/gsd-write-guard.js', '// managed hook\n');
    writeFile(dir, 'hooks/gsd-statusline.js', '// managed hook\n');
    writeManifest(dir, {
      'hooks/gsd-write-guard.js': hashOf(dir, 'hooks/gsd-write-guard.js'),
      'hooks/gsd-statusline.js': hashOf(dir, 'hooks/gsd-statusline.js'),
    });

    runFullMigration(dir);

    assert.equal(fs.existsSync(path.join(dir, 'hooks')), false, 'the emptied hooks/ directory must be removed');
  });

  test('plan() alone does not mutate disk (planning is pure)', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/gsd-write-guard.js', '// managed hook\n');
    writeManifest(dir, { 'hooks/gsd-write-guard.js': hashOf(dir, 'hooks/gsd-write-guard.js') });

    migration.plan(makePlanCtx(dir));
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'gsd-write-guard.js')), 'plan() must never remove anything itself');
  });

  test('emits no actions when hooks/ is already absent (fresh post-#3023 install, idempotent)', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeManifest(dir, {});
    const actions = migration.plan(makePlanCtx(dir));
    assert.deepEqual(actions, []);
  });
});

// ---------------------------------------------------------------------------
// 2. Locally modified managed file -> backed up, not silently deleted
// ---------------------------------------------------------------------------

describe('migration 009: locally modified managed file', () => {
  test('backs up a modified hooks/gsd-write-guard.js instead of silently deleting it', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/gsd-write-guard.js', '// user-patched managed hook\n');
    // Manifest records a DIFFERENT hash -> managed-modified.
    writeManifest(dir, { 'hooks/gsd-write-guard.js': 'a'.repeat(64) });

    const plan = planInstallerMigrations({ configDir: dir, runtime: 'pi', scope: 'global', migrations: [migration] });
    const fileAction = plan.actions.find((a) => a.relPath === 'hooks/gsd-write-guard.js');
    assert.ok(fileAction, 'expected an action for the modified file');
    assert.equal(fileAction.type, 'backup-and-remove');

    const result = applyInstallerMigrationPlan({ configDir: dir, plan });
    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'gsd-write-guard.js')), false, 'the live modified copy is removed');

    const journal = JSON.parse(fs.readFileSync(path.join(dir, result.journalRelPath), 'utf8'));
    const journaledFileAction = journal.actions.find((a) => a.relPath === 'hooks/gsd-write-guard.js');
    assert.ok(journaledFileAction, 'expected the file action in the journal');
    assert.ok(journaledFileAction.backupRelPath, 'expected a recorded backup path');
    assert.equal(
      fs.existsSync(path.join(dir, journaledFileAction.backupRelPath)),
      true,
      'the modified file must be recoverable from its backup',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, journaledFileAction.backupRelPath), 'utf8'),
      '// user-patched managed hook\n',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Unmanifested user file -> file AND parent directory preserved
// ---------------------------------------------------------------------------

describe('migration 009: unmanifested user file under hooks/', () => {
  test('preserves an unknown hooks/my-own.js and the hooks/ directory that holds it', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/my-own.js', '// hand-placed by the user\n');
    writeManifest(dir, {});

    const actions = migration.plan(makePlanCtx(dir));
    const targeted = actions.map((a) => a.relPath);
    assert.ok(!targeted.includes('hooks/my-own.js'), 'unknown files are preserved (never removed or backed up)');

    runFullMigration(dir);

    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'my-own.js')), true, 'the unmanaged file must survive');
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), true, 'a non-empty hooks/ directory must survive');
  });
});

// ---------------------------------------------------------------------------
// 4. hooks/lib/ manifested + unmodified -> lib/ pruned too
// ---------------------------------------------------------------------------

describe('migration 009: hooks/lib/ subdirectory', () => {
  test('prunes hooks/lib/ before hooks/ itself when both become empty', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/lib/git-cmd.js', '// managed lib helper\n');
    writeManifest(dir, { 'hooks/lib/git-cmd.js': hashOf(dir, 'hooks/lib/git-cmd.js') });

    const actions = migration.plan(makePlanCtx(dir));
    const dirActionRelPaths = actions.filter((a) => a.type === 'remove-empty-dir').map((a) => a.relPath);
    assert.deepEqual(dirActionRelPaths, ['hooks/lib', 'hooks'], 'hooks/lib must be planned before hooks itself');

    runFullMigration(dir);

    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'lib')), false, 'hooks/lib/ must be pruned');
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), false, 'hooks/ must be pruned once lib/ is gone');
  });
});

// ---------------------------------------------------------------------------
// 5. claude install with a populated hooks/ -> completely untouched
// ---------------------------------------------------------------------------

describe('migration 009: runtime independence', () => {
  test('never touches a claude install even with the same on-disk shape (guard fires first)', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/gsd-write-guard.js', '// live claude hook\n');
    writeFile(dir, 'hooks/lib/git-cmd.js', '// live claude lib helper\n');
    writeManifest(dir, {
      'hooks/gsd-write-guard.js': hashOf(dir, 'hooks/gsd-write-guard.js'),
      'hooks/lib/git-cmd.js': hashOf(dir, 'hooks/lib/git-cmd.js'),
    });

    // Direct plan() call with an explicit non-pi runtime: the guard must be
    // the first thing plan() checks, ahead of even looking at the filesystem.
    assert.deepEqual(migration.plan(makePlanCtx(dir, 'claude')), []);

    // And through the full planner, which also filters by migration.runtimes.
    const plan = planInstallerMigrations({ configDir: dir, runtime: 'claude', scope: 'global', migrations: [migration] });
    assert.equal(plan.actions.length, 0);

    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'gsd-write-guard.js')), true);
    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'lib', 'git-cmd.js')), true);
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), true);
  });
});

// ---------------------------------------------------------------------------
// 6. Running the migration twice -> second run is a clean no-op, no throw
// ---------------------------------------------------------------------------

describe('migration 009: idempotency', () => {
  test('a second run after the directory is already gone is a clean no-op', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'hooks/gsd-write-guard.js', '// managed hook\n');
    writeManifest(dir, { 'hooks/gsd-write-guard.js': hashOf(dir, 'hooks/gsd-write-guard.js') });

    runFullMigration(dir);
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), false);

    let secondPlan;
    assert.doesNotThrow(() => {
      secondPlan = planInstallerMigrations({ configDir: dir, runtime: 'pi', scope: 'global', migrations: [migration] });
    });
    assert.deepEqual(secondPlan.actions, [], 'a second plan against an already-migrated install must be empty');
    assert.doesNotThrow(() => {
      applyInstallerMigrationPlan({ configDir: dir, plan: secondPlan });
    });
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), false);
  });
});

// ---------------------------------------------------------------------------
// 7. A symlink under hooks/ pointing outside configDir -> not followed, not
//    deleted through
// ---------------------------------------------------------------------------

describe('migration 009: symlink safety', () => {
  test('never follows or removes through a symlink planted under hooks/', (t) => {
    const dir = createTempDir('gsd-migration-009-');
    t.after(() => cleanup(dir));
    const outside = createTempDir('gsd-migration-009-outside-');
    t.after(() => cleanup(outside));

    const secretPath = path.join(outside, 'secret.txt');
    fs.writeFileSync(secretPath, 'do not touch\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    const linkPath = path.join(dir, 'hooks', 'escape.js');
    fs.symlinkSync(secretPath, linkPath);
    writeManifest(dir, {});

    const actions = migration.plan(makePlanCtx(dir));
    assert.ok(
      !actions.some((a) => a.relPath === 'hooks/escape.js'),
      'a symlink entry must never be planned for removal, backup, or classification',
    );

    runFullMigration(dir);

    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, 'the symlink itself must survive untouched');
    assert.equal(fs.existsSync(secretPath), true, 'the external target must never be removed through the link');
    assert.equal(fs.readFileSync(secretPath, 'utf8'), 'do not touch\n');
    // The symlink keeps hooks/ non-empty, so the directory itself must also survive.
    assert.equal(fs.existsSync(path.join(dir, 'hooks')), true);
  });
});
