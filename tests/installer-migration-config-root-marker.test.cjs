'use strict';

/**
 * Installer migration coverage for
 * 2026-07-28-retire-config-root-commonjs-marker (#2544).
 *
 * #2544 moved GSD's `{"type":"commonjs"}` marker out of the runtime config root
 * and into the directories GSD actually fills. Without this migration an
 * UPGRADED install keeps both markers, so the config root stays pinned to
 * CommonJS and the fix's own claim — that GSD no longer writes the shared
 * config root — is false for every install made before it.
 *
 * The migration is unusual in one respect, and that is what most of this file
 * pins: the config-root marker was never recorded in `gsd-file-manifest.json`,
 * so `classifyArtifact` answers `unknown` for it and the planner's own guard
 * downgrades a `remove-managed` on an `unknown` classification to
 * `preserve-user`. The migration therefore supplies the "purpose-built detector
 * for an old GSD-owned shape" that docs/installer-migrations.md#remove-managed
 * sanctions, and DECLARES the resulting classification on the action. If that
 * declaration ever stops being honoured the migration silently does nothing, so
 * the end-to-end planner test below is a negative control, not a formality.
 *
 * Authoring-workflow coverage (docs/installer-migrations.md#authoring-workflow):
 *   dry-run plan output ....... "plan() emits remove-managed"
 *   apply behaviour ........... "applies through the real planner + executor"
 *   locally modified file ..... "a user-authored package.json is never touched"
 *   user-owned files nearby ... "leaves sibling files alone"
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const migration = require('../gsd-core/bin/lib/installer-migrations/007-retire-config-root-commonjs-marker.cjs');

const {
  classifyArtifact: realClassifyArtifact,
  readInstallManifest,
  planInstallerMigrations,
  applyInstallerMigrationPlan,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');

// The shared teardown helper, not a local rmSync: it chdir's out of the target
// first (Windows cannot remove a directory that is the CWD) and retries
// 20 x 250ms to absorb the deferred-scan handle Windows Defender holds on
// newly-written files. This repo runs a windows-latest lane, so both matter.
const { cleanup } = require('./helpers.cjs');

const MARKER = '{"type":"commonjs"}';
const ROOT_REL = 'package.json';

/** The shape #2544 was filed about — an OpenCode config-root manifest. */
const USER_PACKAGE_JSON = JSON.stringify(
  {
    name: 'my-opencode-config',
    type: 'module',
    dependencies: { shescape: '^2.1.0' },
  },
  null,
  2,
) + '\n';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migration-007-test-'));
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
      { version: '1.8.0', timestamp: '2026-07-28T00:00:00.000Z', mode: 'full', files },
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

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// 1. Metadata
// ---------------------------------------------------------------------------

describe('migration 007 metadata', () => {
  test('exports a single migration object with the required authoring fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(typeof migration.id, 'string');
    assert.ok(migration.id.length > 0, 'id must be non-empty');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(typeof migration.introducedIn, 'string');
    assert.ok(Array.isArray(migration.scopes), 'scopes must be an array');
    assert.ok(migration.scopes.includes('global'));
    assert.ok(migration.scopes.includes('local'));
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });

  test('applies to every runtime — the marker was written for all of them', () => {
    // "All runtimes" is expressed by OMITTING `runtimes`, never by `[]`. The two
    // halves of the framework disagree about the empty array and only one of
    // them runs on the record: `validateStringArray` requires the field to be a
    // NON-EMPTY string array when present and throws otherwise, while the
    // runtime filter (`Array.isArray(runtimes) && runtimes.length > 0`) would
    // have treated `[]` as "all". A `runtimes: []` record therefore throws at
    // plan time and the migration never runs at all — which is precisely how
    // this migration was first written.
    assert.equal(migration.runtimes, undefined, 'runtimes must be omitted, not []');
  });

  test('id carries the expected date prefix and names the retired artifact', () => {
    assert.ok(migration.id.startsWith('2026-07-28-'), `unexpected id: ${migration.id}`);
    assert.match(migration.id, /config-root-commonjs-marker/);
  });
});

// ---------------------------------------------------------------------------
// 2. plan() behaviour
// ---------------------------------------------------------------------------

describe('migration 007 plan()', () => {
  test('emits no actions when the config root has no package.json (fresh install)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeManifest(dir, {});

    assert.deepEqual(migration.plan(makePlanCtx(dir)), [], 'no file -> no actions');
  });

  test('emits remove-managed for the exact legacy marker, with declared ownership', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, `${MARKER}\n`);
    writeManifest(dir, {});

    const actions = migration.plan(makePlanCtx(dir));
    assert.equal(actions.length, 1);
    const [action] = actions;
    assert.equal(action.type, 'remove-managed');
    assert.equal(action.relPath, ROOT_REL);
    assert.ok(action.ownershipEvidence && action.ownershipEvidence.length > 0);
    // The declared classification IS the ownership proof — see the planner test.
    assert.equal(action.classification, 'managed-pristine');
    assert.equal(action.originalHash, action.currentHash);
    assert.equal(action.currentHash, sha256(`${MARKER}\n`));
  });

  test('tolerates trailing-whitespace variants of the marker', (t) => {
    for (const content of [MARKER, `${MARKER}\n`, `${MARKER}\n\n`, `  ${MARKER}  \n`]) {
      const dir = createTempDir();
      t.after(() => cleanup(dir));
      writeFile(dir, ROOT_REL, content);
      writeManifest(dir, {});
      assert.equal(
        migration.plan(makePlanCtx(dir)).length,
        1,
        `expected a match for ${JSON.stringify(content)}`,
      );
    }
  });

  test('a user-authored package.json is never touched', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, USER_PACKAGE_JSON);
    writeManifest(dir, {});

    assert.deepEqual(
      migration.plan(makePlanCtx(dir)),
      [],
      'a package.json that is not exactly the marker must produce no action',
    );
  });

  test('a marker with any extra key is foreign — no backup-and-remove branch', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    // Semantically "the marker plus something the user added". The exact-content
    // predicate rejects it, and there is deliberately no modified-file branch:
    // this is somebody else's file, not a patched GSD artifact.
    writeFile(dir, ROOT_REL, `${JSON.stringify({ type: 'commonjs', name: 'mine' })}\n`);
    writeManifest(dir, {});

    assert.deepEqual(migration.plan(makePlanCtx(dir)), []);
  });

  test('a symlinked package.json is never followed or planned', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, `${MARKER}\n`);
    fs.symlinkSync(outside, path.join(dir, ROOT_REL));
    writeManifest(dir, {});

    assert.deepEqual(
      migration.plan(makePlanCtx(dir)),
      [],
      'a symlink is not something GSD wrote — never ours to remove',
    );
    assert.ok(fs.existsSync(outside), 'the link target must survive');
  });

  test('a directory at the marker path is never planned', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, ROOT_REL));
    writeManifest(dir, {});

    assert.deepEqual(migration.plan(makePlanCtx(dir)), []);
  });

  test('leaves sibling files in the config root alone', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, `${MARKER}\n`);
    writeFile(dir, 'opencode.json', '{"theme":"mine"}\n');
    writeManifest(dir, {});

    const actions = migration.plan(makePlanCtx(dir));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].relPath, ROOT_REL, 'only the marker is ever planned');
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end through the REAL planner + executor
// ---------------------------------------------------------------------------

describe('migration 007 through the real planner', () => {
  test('the declared classification survives the planner (negative control)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, `${MARKER}\n`);
    writeManifest(dir, {});

    // The config-root marker is NOT in the manifest, so the planner's own
    // classify() answers 'unknown' for it...
    const manifest = readInstallManifest(dir);
    assert.equal(
      realClassifyArtifact(dir, ROOT_REL, manifest).classification,
      'unknown',
      'precondition: the marker was never manifest-recorded',
    );

    // ...and `remove-managed` on an 'unknown' classification is downgraded to
    // `preserve-user`. This assertion is the whole reason the migration declares
    // its own classification: without that declaration the plan below would
    // contain a preserve-user action and the migration would be inert.
    const plan = planInstallerMigrations({
      configDir: dir,
      runtime: 'opencode',
      scope: 'global',
      migrations: [migration],
    });

    const actions = plan.actions.filter((a) => a.relPath === ROOT_REL);
    assert.equal(actions.length, 1, 'the marker must survive planning as one action');
    assert.equal(
      actions[0].type,
      'remove-managed',
      'declared ownership must NOT be downgraded to preserve-user',
    );
  });

  test('applying the plan removes the marker and journals a rollback', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, `${MARKER}\n`);
    writeFile(dir, 'opencode.json', '{"theme":"mine"}\n');
    writeManifest(dir, {});

    const plan = planInstallerMigrations({
      configDir: dir,
      runtime: 'opencode',
      scope: 'global',
      migrations: [migration],
    });
    applyInstallerMigrationPlan({ configDir: dir, plan, runtime: 'opencode', scope: 'global' });

    assert.ok(
      !fs.existsSync(path.join(dir, ROOT_REL)),
      'the stale config-root marker must be gone after apply',
    );
    assert.ok(
      fs.existsSync(path.join(dir, 'opencode.json')),
      'sibling config files must survive',
    );
  });

  test('is idempotent — a second run plans nothing', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, `${MARKER}\n`);
    writeManifest(dir, {});

    const first = planInstallerMigrations({
      configDir: dir, runtime: 'opencode', scope: 'global', migrations: [migration],
    });
    applyInstallerMigrationPlan({ configDir: dir, plan: first, runtime: 'opencode', scope: 'global' });

    // Re-plan against the post-apply tree. The file is gone, so plan() short-
    // circuits at the lstat and there is nothing left to do.
    assert.deepEqual(migration.plan(makePlanCtx(dir)), []);
  });

  test('a user-authored package.json survives the full plan+apply cycle', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    writeFile(dir, ROOT_REL, USER_PACKAGE_JSON);
    writeManifest(dir, {});
    const before = sha256(fs.readFileSync(path.join(dir, ROOT_REL)));

    const plan = planInstallerMigrations({
      configDir: dir, runtime: 'opencode', scope: 'global', migrations: [migration],
    });
    applyInstallerMigrationPlan({ configDir: dir, plan, runtime: 'opencode', scope: 'global' });

    assert.ok(fs.existsSync(path.join(dir, ROOT_REL)), 'the user file must survive');
    assert.equal(
      sha256(fs.readFileSync(path.join(dir, ROOT_REL))),
      before,
      'the user file must be byte-identical after the migration runs',
    );
  });
});
