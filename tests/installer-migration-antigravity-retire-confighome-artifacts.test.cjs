'use strict';

/**
 * TDD tests for installer migration 010:
 * 2026-08-26-antigravity-retire-confighome-artifacts (#3738)
 *
 * Antigravity scans ~/.gemini/config/{skills,agents} for machine-local
 * discovery; the configHome (~/.gemini/antigravity{,-ide,-cli}) is not
 * scanned, so pre-#3738 installs placed skills and agents where the runtime
 * silently ignored them. Since #3738 the global layout installs both kinds
 * under the .gemini/config home override. This migration converges an
 * existing install: managed files under the configHome's skills/ and agents/
 * are removed (or backed up if locally modified), unmanifested files are
 * preserved, and now-empty container directories are retired. GLOBAL scope
 * only — the local .agents workspace surface is live and must be untouched.
 *
 * Coverage:
 *   1. only manifested, unmodified skills/ + agents/       -> both trees gone
 *   2. a manifested skill locally modified                  -> backed up, not silently deleted
 *   3. an unmanifested user agent (non-gsd AND gsd-prefixed) -> file AND parent directory preserved
 *   4. a non-gsd-prefixed entry under skills/               -> untouched, skills/ preserved
 *   5. claude install with a populated skills/              -> completely untouched (independence)
 *   6. local scope                                           -> no actions at all
 *   7. running the migration twice on case 1                 -> second run is a clean no-op
 *   8. a symlink under skills/ pointing outside configDir    -> not followed, not deleted through
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const migration = require('../gsd-core/bin/lib/installer-migrations/010-antigravity-retire-confighome-artifacts.cjs');

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
        version: '1.11.0',
        timestamp: '2026-08-26T00:00:00.000Z',
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

function makePlanCtx(configDir, runtime = 'antigravity', scope = 'global') {
  const manifest = readInstallManifest(configDir);
  return {
    configDir,
    runtime,
    scope,
    classifyArtifact: (relPath) => realClassifyArtifact(configDir, relPath, manifest),
  };
}

function runFullMigration(configDir, runtime = 'antigravity', scope = 'global') {
  const plan = planInstallerMigrations({
    configDir,
    runtime,
    scope,
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

describe('migration 010 metadata', () => {
  test('exports a single migration object with the required authoring fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(typeof migration.id, 'string');
    assert.equal(migration.id, '2026-08-26-antigravity-retire-confighome-artifacts');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(typeof migration.introducedIn, 'string');
    assert.deepEqual(migration.runtimes, ['antigravity']);
    assert.deepEqual(migration.scopes, ['global']);
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });
});

// ---------------------------------------------------------------------------
// 1. Only manifested, unmodified files -> both trees gone
// ---------------------------------------------------------------------------

describe('migration 010: fully managed configHome skills/ + agents/', () => {
  test('removes manifested unmodified files and then the emptied directories', (t) => {
    const dir = createTempDir('gsd-migration-010-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/gsd-help/SKILL.md', '# help\n');
    writeFile(dir, 'skills/gsd-plan/refs/a.md', '# a\n');
    writeFile(dir, 'agents/gsd-executor.md', '# executor\n');
    writeManifest(dir, {
      'skills/gsd-help/SKILL.md': hashOf(dir, 'skills/gsd-help/SKILL.md'),
      'skills/gsd-plan/refs/a.md': hashOf(dir, 'skills/gsd-plan/refs/a.md'),
      'agents/gsd-executor.md': hashOf(dir, 'agents/gsd-executor.md'),
    });

    const plan = runFullMigration(dir);

    assert.ok(plan.actions.some(a => a.type === 'remove-managed' && a.relPath === 'skills/gsd-help/SKILL.md'));
    assert.ok(plan.actions.some(a => a.type === 'remove-managed' && a.relPath === 'agents/gsd-executor.md'));
    assert.ok(!fs.existsSync(path.join(dir, 'skills')), 'emptied skills/ directory must be removed');
    assert.ok(!fs.existsSync(path.join(dir, 'agents')), 'emptied agents/ directory must be removed');
  });

  test('second run on the converged install is a clean no-op', (t) => {
    const dir = createTempDir('gsd-migration-010-idempotent-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/gsd-help/SKILL.md', '# help\n');
    writeManifest(dir, {
      'skills/gsd-help/SKILL.md': hashOf(dir, 'skills/gsd-help/SKILL.md'),
    });
    runFullMigration(dir);

    const plan = runFullMigration(dir);
    assert.deepEqual(plan.actions, [], 'nothing left to retire');
  });
});

// ---------------------------------------------------------------------------
// 2. A manifested file locally modified -> backed up, not silently deleted
// ---------------------------------------------------------------------------

describe('migration 010: locally modified manifested skill', () => {
  test('backs up the modified file before removing it', (t) => {
    const dir = createTempDir('gsd-migration-010-modified-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/gsd-help/SKILL.md', '# user-patched managed skill\n');
    // Manifest records a DIFFERENT hash -> managed-modified.
    writeManifest(dir, { 'skills/gsd-help/SKILL.md': 'a'.repeat(64) });

    const plan = planInstallerMigrations({ configDir: dir, runtime: 'antigravity', scope: 'global', migrations: [migration] });
    const fileAction = plan.actions.find((a) => a.relPath === 'skills/gsd-help/SKILL.md');
    assert.ok(fileAction, 'expected an action for the modified file');
    assert.equal(fileAction.type, 'backup-and-remove');

    const result = applyInstallerMigrationPlan({ configDir: dir, plan });
    assert.equal(fs.existsSync(path.join(dir, 'skills/gsd-help/SKILL.md')), false, 'the live modified copy is removed');

    const journal = JSON.parse(fs.readFileSync(path.join(dir, result.journalRelPath), 'utf8'));
    const journaledFileAction = journal.actions.find((a) => a.relPath === 'skills/gsd-help/SKILL.md');
    assert.ok(journaledFileAction, 'expected the file action in the journal');
    assert.ok(journaledFileAction.backupRelPath, 'expected a recorded backup path');
    assert.equal(
      fs.existsSync(path.join(dir, journaledFileAction.backupRelPath)),
      true,
      'the modified file must be recoverable from its backup',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, journaledFileAction.backupRelPath), 'utf8'),
      '# user-patched managed skill\n',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Unmanifested user files -> preserved, parent dir preserved
// ---------------------------------------------------------------------------

describe('migration 010: unmanifested files under retired surfaces', () => {
  test('preserves an unmanifested gsd-prefixed user agent and the agents/ dir', (t) => {
    const dir = createTempDir('gsd-migration-010-unknown-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'agents/gsd-my-own.md', '# user-written\n');
    writeManifest(dir, {});

    const plan = runFullMigration(dir);

    assert.ok(fs.existsSync(path.join(dir, 'agents/gsd-my-own.md')), 'unmanifested file preserved');
    assert.ok(fs.existsSync(path.join(dir, 'agents')), 'parent dir preserved while it holds a user file');
    assert.ok(!plan.actions.some(a => a.relPath === 'agents/gsd-my-own.md'), 'no action planned against an unknown file');
  });
});

// ---------------------------------------------------------------------------
// 4. Non-gsd entries untouched
// ---------------------------------------------------------------------------

describe('migration 010: non-gsd entries under skills/', () => {
  test('never walks or removes non-gsd-prefixed entries', (t) => {
    const dir = createTempDir('gsd-migration-010-nongsd-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/user-skill/SKILL.md', '# user skill\n');
    writeManifest(dir, {
      'skills/user-skill/SKILL.md': hashOf(dir, 'skills/user-skill/SKILL.md'),
    });

    runFullMigration(dir);

    assert.ok(fs.existsSync(path.join(dir, 'skills/user-skill/SKILL.md')), 'non-gsd entry untouched even when manifested');
    assert.ok(fs.existsSync(path.join(dir, 'skills')), 'skills/ preserved while it holds a non-gsd entry');
  });
});

// ---------------------------------------------------------------------------
// 5. Independence: another runtime is never touched
// ---------------------------------------------------------------------------

describe('migration 010: runtime independence', () => {
  test('a claude configDir with a populated skills/ tree is completely untouched', (t) => {
    const dir = createTempDir('gsd-migration-010-claude-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/gsd-help/SKILL.md', '# help\n');
    writeFile(dir, 'agents/gsd-executor.md', '# executor\n');
    writeManifest(dir, {
      'skills/gsd-help/SKILL.md': hashOf(dir, 'skills/gsd-help/SKILL.md'),
      'agents/gsd-executor.md': hashOf(dir, 'agents/gsd-executor.md'),
    });

    const plan = runFullMigration(dir, 'claude');

    assert.deepEqual(plan.actions, [], 'claude never produces retirement actions');
    assert.ok(fs.existsSync(path.join(dir, 'skills/gsd-help/SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'agents/gsd-executor.md')));
  });
});

// ---------------------------------------------------------------------------
// 6. Local scope -> no actions (the .agents workspace surface is live)
// ---------------------------------------------------------------------------

describe('migration 010: local scope is out of scope', () => {
  test('plans no actions for a local-scope install even with gsd artifacts present', (t) => {
    const dir = createTempDir('gsd-migration-010-local-');
    t.after(() => cleanup(dir));

    writeFile(dir, 'skills/gsd-help/SKILL.md', '# help\n');
    writeManifest(dir, {
      'skills/gsd-help/SKILL.md': hashOf(dir, 'skills/gsd-help/SKILL.md'),
    });

    const ctx = makePlanCtx(dir, 'antigravity', 'local');
    assert.deepEqual(migration.plan(ctx), [], 'local scope must never retire these surfaces');
  });
});

// ---------------------------------------------------------------------------
// 7. Symlink escape is not followed
// ---------------------------------------------------------------------------

describe('migration 010: symlinked entries are not followed', () => {
  test('a symlinked gsd- dir under skills/ pointing outside configDir is not traversed', (t) => {
    const outside = createTempDir('gsd-migration-010-outside-');
    t.after(() => cleanup(outside));
    const dir = createTempDir('gsd-migration-010-symlink-');
    t.after(() => cleanup(dir));

    writeFile(outside, 'SKILL.md', '# outside\n');
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'skills/gsd-link'));

    const ctx = makePlanCtx(dir);
    const actions = migration.plan(ctx);

    assert.ok(!actions.some(a => a.relPath.includes('gsd-link')), 'no action planned through the symlink');
    assert.ok(fs.existsSync(outside), 'the symlink target is untouched');
  });
});
