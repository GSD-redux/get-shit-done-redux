// docs-guard-exempt: docs/installer-migrations.md is cited only in a comment; never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  applyInstallerMigrationPlan,
  classifyArtifact,
  discoverInstallerMigrations,
  INSTALL_STATE_NAME,
  migrationChecksum,
  planInstallerMigrations,
  readInstallState,
  runInstallerMigrations,
  writeInstallState,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');
const firstTimeBaselineMigration = require('../gsd-core/bin/lib/installer-migrations/000-first-time-baseline.cjs');
const opencodeBaselineCommandsDirMigration = require('../gsd-core/bin/lib/installer-migrations/005-opencode-baseline-commands-dir.cjs');

function createTempInstall() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-installer-migrations-'));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup predates helpers.cjs; name collision prevents import
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify({
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

function migrationRecord(overrides = {}) {
  return {
    id: '2026-05-11-remove-old-hook',
    title: 'Remove retired hook',
    description: 'Remove retired hook',
    introducedIn: '1.50.0',
    scopes: ['global', 'local'],
    destructive: true,
    plan: () => [
      {
        type: 'remove-managed',
        relPath: 'hooks/old-hook.js',
        reason: 'retired hook',
        ownershipEvidence: 'test fixture manifest-managed hook',
      },
    ],
    ...overrides,
  };
}

function legacyCodexHook(configDir) {
  return {
    hooks: [
      {
        type: 'command',
        command: `node "${path.join(configDir, 'hooks', 'gsd-check-update.js')}"`,
      },
    ],
  };
}

function userHook(command) {
  return {
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
}

test('records a first-time baseline while preserving user-owned artifacts', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'gsd-core/workflows/plan.md', 'managed workflow\n');
    writeFile(configDir, 'gsd-core/USER-PROFILE.md', 'user profile\n');
    writeManifest(configDir, {
      'gsd-core/workflows/plan.md': sha256('managed workflow\n'),
    });

    const result = runInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      migrations: [firstTimeBaselineMigration],
      baselineScan: true,
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-first-time-baseline-scan']);
    assert.equal(fs.readFileSync(path.join(configDir, 'gsd-core/workflows/plan.md'), 'utf8'), 'managed workflow\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'gsd-core/USER-PROFILE.md'), 'utf8'), 'user profile\n');

    assert.deepEqual(
      result.plan.actions.map((action) => ({
        type: action.type,
        relPath: action.relPath,
        classification: action.classification,
      })),
      [
        {
          type: 'record-baseline',
          relPath: 'gsd-core/workflows/plan.md',
          classification: 'managed-pristine',
        },
        {
          type: 'baseline-preserve-user',
          relPath: 'gsd-core/USER-PROFILE.md',
          classification: 'user-owned',
        },
      ]
    );
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), [
      '2026-05-11-first-time-baseline-scan',
    ]);
  } finally {
    cleanup(configDir);
  }
});

test('preserves unknown files discovered in known install surfaces by default', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/custom-user-hook.js', 'user hook\n');
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      migrations: [firstTimeBaselineMigration],
      baselineScan: true,
      now: () => '2026-05-11T00:00:01.000Z',
    });

    assert.deepEqual(result.blocked, undefined);
    assert.deepEqual(
      result.plan.actions.map((action) => ({
        type: action.type,
        relPath: action.relPath,
        classification: action.classification,
      })),
      [
        {
          type: 'baseline-preserve-user',
          relPath: 'hooks/custom-user-hook.js',
          classification: 'unknown',
        },
      ]
    );
    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/custom-user-hook.js'), 'utf8'), 'user hook\n');
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), [
      '2026-05-11-first-time-baseline-scan',
    ]);
  } finally {
    cleanup(configDir);
  }
});

test('preserves user-owned skill files during baseline without hashing their content', (t) => {
  const configDir = createTempInstall();
  const originalOpenSync = fs.openSync;
  t.after(() => {
    fs.openSync = originalOpenSync;
    cleanup(configDir);
  });

  writeFile(configDir, 'skills/custom-user-skill/SKILL.md', 'user skill\n');
  writeManifest(configDir, {});
  const userSkillPath = path.join(configDir, 'skills/custom-user-skill/SKILL.md');
  fs.openSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(userSkillPath)) {
      throw new Error('user-owned skill content should not be hashed during baseline');
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };

  const result = runInstallerMigrations({
    configDir,
    runtime: 'claude',
    scope: 'global',
    migrations: [firstTimeBaselineMigration],
    baselineScan: true,
    now: () => '2026-05-11T00:00:01.000Z',
  });

  assert.deepEqual(
    result.plan.actions.map((action) => ({
      type: action.type,
      relPath: action.relPath,
      classification: action.classification,
      currentHash: action.currentHash,
    })),
    [
      {
        type: 'baseline-preserve-user',
        relPath: 'skills/custom-user-skill/SKILL.md',
        classification: 'user-owned',
        currentHash: null,
      },
    ]
  );
});

test('blocks stale GSD-looking baseline artifacts for explicit user choice', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/gsd-retired-hook.js', 'old gsd hook\n');
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      migrations: [firstTimeBaselineMigration],
      baselineScan: true,
      now: () => '2026-05-11T00:00:02.000Z',
    });

    assert.deepEqual(result.appliedMigrationIds, []);
    assert.equal(result.journalRelPath, null);
    assert.equal(fs.existsSync(path.join(configDir, INSTALL_STATE_NAME)), false);
    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/gsd-retired-hook.js'), 'utf8'), 'old gsd hook\n');
    assert.deepEqual(
      result.blocked.map((action) => ({
        type: action.type,
        relPath: action.relPath,
        classification: action.classification,
        choices: action.choices,
      })),
      [
        {
          type: 'prompt-user',
          relPath: 'hooks/gsd-retired-hook.js',
          classification: 'stale-gsd-looking',
          choices: ['keep', 'remove'],
        },
      ]
    );
  } finally {
    cleanup(configDir);
  }
});

test('records known generated agent artifacts so profile cleanup can remove them', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'agents/gsd-executor.md', 'old generated agent\n');
    writeFile(configDir, 'agents/gsd-executor.toml', 'old generated agent config\n');
    writeFile(configDir, 'agents/gsd-local-experiment.md', 'user experiment\n');
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'codex',
      scope: 'global',
      migrations: [firstTimeBaselineMigration],
      baselineScan: true,
      now: () => '2026-05-11T00:00:03.000Z',
    });

    assert.deepEqual(
      result.plan.actions.map((action) => ({
        type: action.type,
        relPath: action.relPath,
        classification: action.classification,
      })),
      [
        {
          type: 'record-baseline',
          relPath: 'agents/gsd-executor.md',
          classification: 'unknown',
        },
        {
          type: 'record-baseline',
          relPath: 'agents/gsd-executor.toml',
          classification: 'unknown',
        },
        {
          type: 'prompt-user',
          relPath: 'agents/gsd-local-experiment.md',
          classification: 'stale-gsd-looking',
        },
      ]
    );
    assert.deepEqual(result.blocked.map((action) => action.relPath), ['agents/gsd-local-experiment.md']);
    assert.equal(fs.readFileSync(path.join(configDir, 'agents/gsd-executor.md'), 'utf8'), 'old generated agent\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'agents/gsd-executor.toml'), 'utf8'), 'old generated agent config\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'agents/gsd-local-experiment.md'), 'utf8'), 'user experiment\n');
  } finally {
    cleanup(configDir);
  }
});

// ---------------------------------------------------------------------------
// Migration 005: OpenCode commands/ (plural) baseline scan (#2329 follow-up)
//
// 000-first-time-baseline.cts's RUNTIME_SURFACES.opencode is a shipped,
// immutable body that still only names the legacy singular `command/`
// directory (see docs/installer-migrations.md#state-files). These tests
// pin migration 005's widened scan of the plural `commands/` surface.
// ---------------------------------------------------------------------------

test('baselines pre-existing OpenCode commands/ files: managed, unknown, and stale-GSD-looking', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'commands/gsd-plan-phase.md', 'managed command\n');
    writeFile(configDir, 'commands/my-custom-command.md', 'user command\n');
    writeFile(configDir, 'commands/gsd-retired-command.md', 'stale gsd-looking file, not in manifest\n');
    writeManifest(configDir, {
      'commands/gsd-plan-phase.md': sha256('managed command\n'),
    });

    const result = runInstallerMigrations({
      configDir,
      runtime: 'opencode',
      scope: 'global',
      migrations: [opencodeBaselineCommandsDirMigration],
      baselineScan: true,
      now: () => '2026-07-17T00:00:00.000Z',
    });

    assert.deepEqual(
      result.plan.actions.map((action) => ({
        type: action.type,
        relPath: action.relPath,
        classification: action.classification,
      })),
      [
        {
          type: 'record-baseline',
          relPath: 'commands/gsd-plan-phase.md',
          classification: 'managed-pristine',
        },
        {
          type: 'baseline-preserve-user',
          relPath: 'commands/my-custom-command.md',
          classification: 'unknown',
        },
        {
          type: 'prompt-user',
          relPath: 'commands/gsd-retired-command.md',
          classification: 'stale-gsd-looking',
        },
      ]
    );
    // The stale-GSD-looking file blocks the plan (needs explicit user choice),
    // so nothing was applied and no install state was written yet.
    assert.deepEqual(result.appliedMigrationIds, []);
    assert.equal(fs.existsSync(path.join(configDir, INSTALL_STATE_NAME)), false);
    // Every file on disk is untouched — baseline-preserve-user/record-baseline/
    // prompt-user are all non-mutating classification actions.
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/gsd-plan-phase.md'), 'utf8'), 'managed command\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/my-custom-command.md'), 'utf8'), 'user command\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/gsd-retired-command.md'), 'utf8'), 'stale gsd-looking file, not in manifest\n');
  } finally {
    cleanup(configDir);
  }
});

test('OpenCode commands/ baseline is idempotent — a second run does not re-plan already-applied files', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'commands/gsd-plan-phase.md', 'managed command\n');
    writeFile(configDir, 'commands/my-custom-command.md', 'user command\n');
    writeManifest(configDir, {
      'commands/gsd-plan-phase.md': sha256('managed command\n'),
    });

    const first = runInstallerMigrations({
      configDir,
      runtime: 'opencode',
      scope: 'global',
      migrations: [opencodeBaselineCommandsDirMigration],
      baselineScan: true,
      now: () => '2026-07-17T00:00:01.000Z',
    });
    assert.deepEqual(first.appliedMigrationIds, ['2026-07-17-opencode-baseline-commands-dir']);
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), [
      '2026-07-17-opencode-baseline-commands-dir',
    ]);

    // Second run: the migration id is now applied, so it must never re-run,
    // regardless of what baselineScan is passed.
    const second = runInstallerMigrations({
      configDir,
      runtime: 'opencode',
      scope: 'global',
      migrations: [opencodeBaselineCommandsDirMigration],
      baselineScan: true,
      now: () => '2026-07-17T00:00:02.000Z',
    });
    assert.deepEqual(second.appliedMigrationIds, []);
    assert.deepEqual(second.plan.actions, []);
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), [
      '2026-07-17-opencode-baseline-commands-dir',
    ]);
    // Files remain untouched across both runs.
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/gsd-plan-phase.md'), 'utf8'), 'managed command\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/my-custom-command.md'), 'utf8'), 'user command\n');
  } finally {
    cleanup(configDir);
  }
});

test('OpenCode commands/ baseline migration is scoped to opencode and never plans for Kilo', () => {
  const configDir = createTempInstall();
  try {
    // Kilo's descriptor keeps the singular `command/` dir; a `commands/` (plural)
    // directory here would be unrelated to Kilo's install surface. This proves the
    // migration's `runtimes: ['opencode']` scoping keeps Kilo installs untouched.
    writeFile(configDir, 'commands/gsd-plan-phase.md', 'managed command\n');
    writeFile(configDir, 'command/gsd-plan-phase.md', 'kilo managed command\n');
    writeManifest(configDir, {
      'commands/gsd-plan-phase.md': sha256('managed command\n'),
      'command/gsd-plan-phase.md': sha256('kilo managed command\n'),
    });

    const result = runInstallerMigrations({
      configDir,
      runtime: 'kilo',
      scope: 'global',
      migrations: [opencodeBaselineCommandsDirMigration],
      baselineScan: true,
      now: () => '2026-07-17T00:00:03.000Z',
    });

    // migrationMatchesContext filters this migration out entirely for kilo
    // (runtimes: ['opencode']) before plan() is ever invoked: it is not
    // "pending", produces zero actions, is never applied, and no install-state
    // file is written for this run at all.
    assert.deepEqual(result.plan.actions, []);
    assert.deepEqual(result.appliedMigrationIds, []);
    assert.equal(fs.existsSync(path.join(configDir, INSTALL_STATE_NAME)), false);
    assert.equal(fs.readFileSync(path.join(configDir, 'commands/gsd-plan-phase.md'), 'utf8'), 'managed command\n');
    assert.equal(fs.readFileSync(path.join(configDir, 'command/gsd-plan-phase.md'), 'utf8'), 'kilo managed command\n');
  } finally {
    cleanup(configDir);
  }
});

test('regression (#2329 follow-up): pre-existing unmanifested commands/gsd-*.md is no longer silently destroyed', () => {
  const configDir = createTempInstall();
  try {
    // Simulates a pre-existing, non-GSD file sitting under OpenCode's commands/
    // directory before GSD's first-ever migration-tracked run against this
    // configDir (no manifest, no install state yet).
    writeFile(configDir, 'commands/gsd-retired-plan.md', 'pre-existing file, not GSD-written\n');

    // Full default migration set (all shipped migrations, including 000 AND 005),
    // matching production: bin/install.js calls runInstallerMigrations with no
    // explicit `migrations` override.
    const result = runInstallerMigrations({
      configDir,
      runtime: 'opencode',
      scope: 'global',
      baselineScan: true,
      now: () => '2026-07-17T00:00:04.000Z',
    });

    // Before this fix, RUNTIME_SURFACES.opencode omitted `commands/`, so this file
    // was invisible to every migration and ordinary materialization would delete it
    // unconditionally with a clean exit. Now it is caught and blocks the install
    // pending an explicit user choice — the same protection the legacy `command/`
    // surface already had.
    assert.deepEqual(result.appliedMigrationIds, []);
    assert.ok(Array.isArray(result.blocked) && result.blocked.length > 0, 'expected a blocked prompt-user action');
    const blockedForFile = result.blocked.find((action) => action.relPath === 'commands/gsd-retired-plan.md');
    assert.ok(blockedForFile, 'expected commands/gsd-retired-plan.md to be blocked pending user choice');
    assert.equal(blockedForFile.type, 'prompt-user');
    assert.equal(blockedForFile.migrationId, '2026-07-17-opencode-baseline-commands-dir');
    // The file itself was never touched — migrations only classify, they do not
    // mutate disk.
    assert.equal(
      fs.readFileSync(path.join(configDir, 'commands/gsd-retired-plan.md'), 'utf8'),
      'pre-existing file, not GSD-written\n'
    );
  } finally {
    cleanup(configDir);
  }
});

test('plans a pending migration against an unchanged managed file', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord(),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.deepEqual(plan.pendingMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.equal(plan.blocked.length, 0);
    assert.equal(plan.actions.length, 1);
    assert.deepEqual(
      {
        migrationId: plan.actions[0].migrationId,
        type: plan.actions[0].type,
        relPath: plan.actions[0].relPath,
        reason: plan.actions[0].reason,
        classification: plan.actions[0].classification,
        originalHash: plan.actions[0].originalHash,
        currentHash: plan.actions[0].currentHash,
      },
      {
        migrationId: '2026-05-11-remove-old-hook',
        type: 'remove-managed',
        relPath: 'hooks/old-hook.js',
        reason: 'retired hook',
        classification: 'managed-pristine',
        originalHash: sha256('managed hook\n'),
        currentHash: sha256('managed hook\n'),
      }
    );
    assert.match(plan.actions[0].migrationChecksum, /^sha256:/);
  } finally {
    cleanup(configDir);
  }
});

test('plans backup before removal for a modified managed file', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'user changed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord(),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.equal(plan.blocked.length, 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'backup-and-remove');
    assert.equal(plan.actions[0].classification, 'managed-modified');
    assert.equal(plan.actions[0].originalHash, sha256('managed hook\n'));
    assert.equal(plan.actions[0].currentHash, sha256('user changed hook\n'));
    assert.equal(plan.actions[0].backupRelPath, null);
  } finally {
    cleanup(configDir);
  }
});

test('blocks removal of unknown files by preserving them by default', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/custom-user-hook.js', 'user hook\n');
    writeManifest(configDir, {});

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord({
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/custom-user-hook.js',
              reason: 'retired hook',
              ownershipEvidence: 'test fixture asks to retire a matching hook path',
            },
          ],
        }),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'preserve-user');
    assert.equal(plan.actions[0].requestedType, 'remove-managed');
    assert.equal(plan.actions[0].classification, 'unknown');
    assert.deepEqual(plan.blocked, [plan.actions[0]]);
  } finally {
    cleanup(configDir);
  }
});

test('fails closed when install state JSON is malformed', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  fs.writeFileSync(path.join(configDir, INSTALL_STATE_NAME), '{ not json\n', 'utf8');

  assert.throws(
    () => readInstallState(configDir),
    /invalid installer migration state JSON/
  );
});

test('computes each migration checksum once per planned migration', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  writeFile(configDir, 'hooks/first.js', 'first hook\n');
  writeFile(configDir, 'hooks/second.js', 'second hook\n');
  writeManifest(configDir, {
    'hooks/first.js': sha256('first hook\n'),
    'hooks/second.js': sha256('second hook\n'),
  });
  let checksumReads = 0;
  const migration = {
    ...migrationRecord({
      id: '2026-05-11-remove-two-hooks',
      title: 'Remove two retired hooks',
      description: 'Remove retired hooks',
      plan: () => [
        {
          type: 'remove-managed',
          relPath: 'hooks/first.js',
          reason: 'retired hook',
          ownershipEvidence: 'test fixture manifest-managed hook',
        },
        {
          type: 'remove-managed',
          relPath: 'hooks/second.js',
          reason: 'retired hook',
          ownershipEvidence: 'test fixture manifest-managed hook',
        },
      ],
    }),
    get checksum() {
      checksumReads += 1;
      return 'sha256:precomputed';
    },
  };

  const plan = planInstallerMigrations({
    configDir,
    migrations: [migration],
    scope: 'global',
  });

  assert.equal(plan.actions.length, 2);
  assert.equal(checksumReads, 1);
});

test('tolerates an applied-migration checksum drift instead of aborting the upgrade', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  // A migration that a prior release recorded as applied under a DIFFERENT body,
  // so the stored checksum no longer matches the current computed checksum.
  const migration = migrationRecord({ id: '2026-05-11-remove-old-hook' });
  writeInstallState(configDir, {
    schemaVersion: 1,
    appliedMigrations: [
      {
        id: '2026-05-11-remove-old-hook',
        appliedAt: '2026-01-01T00:00:00.000Z',
        journal: null,
        checksum: 'sha256:stale-pre-1-3-0-value',
      },
    ],
  });

  // Planning must NOT throw, must skip the already-applied migration, and must
  // surface the drift on the plan for downstream reconciliation.
  let plan;
  assert.doesNotThrow(() => {
    plan = planInstallerMigrations({
      configDir,
      migrations: [migration],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });
  });
  assert.deepEqual(plan.pendingMigrationIds, []);
  assert.equal(plan.actions.length, 0);
  assert.ok(Array.isArray(plan.checksumDrift));
  const drift = plan.checksumDrift.find((d) => d.id === '2026-05-11-remove-old-hook');
  assert.ok(drift, 'expected checksum drift to be reported for the applied migration');
  assert.equal(drift.storedChecksum, 'sha256:stale-pre-1-3-0-value');
  assert.match(drift.currentChecksum, /^sha256:/);
  assert.notEqual(drift.currentChecksum, drift.storedChecksum);
});

test('classifies large files without loading the whole file through readFileSync', (t) => {
  const configDir = createTempInstall();
  const originalReadFileSync = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
    cleanup(configDir);
  });

  const relPath = 'skills/gsd-large/SKILL.md';
  const fullPath = path.join(configDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Buffer.alloc(1024 * 1024 + 1, 'a'));

  fs.readFileSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(fullPath)) {
      throw new Error('large file should be streamed for hashing');
    }
    return originalReadFileSync.call(fs, filePath, ...args);
  };

  const artifact = classifyArtifact(configDir, relPath, { files: {} });

  assert.equal(artifact.classification, 'unknown');
  assert.match(artifact.currentHash, /^[0-9a-f]{64}$/);
});

test('applies an unblocked plan with a journal and install-state update', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord(),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    const result = applyInstallerMigrationPlan({
      configDir,
      plan,
      now: () => '2026-05-11T00:00:01.000Z',
    });

    assert.equal(fs.existsSync(path.join(configDir, 'hooks/old-hook.js')), false);
    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.match(
      result.journalRelPath,
      /^gsd-migration-journal\/2026-05-11T00-00-01-000Z-[0-9a-f]+\.json$/
    );

    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    assert.deepEqual(journal.appliedMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.equal(journal.actions[0].relPath, 'hooks/old-hook.js');

    const state = readInstallState(configDir);
    assert.deepEqual(state.appliedMigrations.map((entry) => entry.id), ['2026-05-11-remove-old-hook']);
    assert.match(state.appliedMigrations[0].checksum, /^sha256:/);
  } finally {
    cleanup(configDir);
  }
});

test('uses unique journal paths for applies that share a timestamp', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  writeFile(configDir, 'hooks/first.js', 'first hook\n');
  writeFile(configDir, 'hooks/second.js', 'second hook\n');
  writeManifest(configDir, {
    'hooks/first.js': sha256('first hook\n'),
    'hooks/second.js': sha256('second hook\n'),
  });
  const now = () => '2026-05-11T00:00:09.000Z';

  const first = applyInstallerMigrationPlan({
    configDir,
    plan: {
      blocked: [],
      actions: [{
        migrationId: 'first-migration',
        migrationChecksum: 'sha256:first',
        type: 'remove-managed',
        relPath: 'hooks/first.js',
        reason: 'first',
        classification: 'managed-pristine',
        originalHash: sha256('first hook\n'),
        currentHash: sha256('first hook\n'),
      }],
    },
    now,
  });
  const second = applyInstallerMigrationPlan({
    configDir,
    plan: {
      blocked: [],
      actions: [{
        migrationId: 'second-migration',
        migrationChecksum: 'sha256:second',
        type: 'remove-managed',
        relPath: 'hooks/second.js',
        reason: 'second',
        classification: 'managed-pristine',
        originalHash: sha256('second hook\n'),
        currentHash: sha256('second hook\n'),
      }],
    },
    now,
  });

  assert.notEqual(first.journalRelPath, second.journalRelPath);
  assert.equal(fs.existsSync(path.join(configDir, first.journalRelPath)), true);
  assert.equal(fs.existsSync(path.join(configDir, second.journalRelPath)), true);
});

test('stores modified-file backups under the unique migration run journal', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  writeFile(configDir, 'hooks/old-hook.js', 'user changed hook\n');
  writeManifest(configDir, {
    'hooks/old-hook.js': sha256('managed hook\n'),
  });

  const plan = planInstallerMigrations({
    configDir,
    migrations: [
      migrationRecord(),
    ],
    scope: 'global',
    now: () => '2026-05-11T00:00:00.000Z',
  });

  const result = applyInstallerMigrationPlan({
    configDir,
    plan,
    now: () => '2026-05-11T00:00:10.000Z',
  });
  const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
  const backupRelPath = journal.actions[0].backupRelPath;

  assert.match(backupRelPath, /^gsd-migration-journal\/2026-05-11T00-00-10-000Z-[0-9a-f]+-backups\/hooks\/old-hook\.js$/);
  assert.equal(fs.readFileSync(path.join(configDir, backupRelPath), 'utf8'), 'user changed hook\n');
});

test('successful migration rollback removes run-scoped backup directories', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  writeFile(configDir, 'hooks/old-hook.js', 'user changed hook\n');
  writeManifest(configDir, {
    'hooks/old-hook.js': sha256('managed hook\n'),
  });

  const plan = planInstallerMigrations({
    configDir,
    migrations: [
      migrationRecord(),
    ],
    scope: 'global',
  });

  const result = applyInstallerMigrationPlan({
    configDir,
    plan,
    now: () => '2026-05-11T00:00:11.000Z',
  });

  result.rollback();

  assert.equal(fs.readFileSync(path.join(configDir, 'hooks/old-hook.js'), 'utf8'), 'user changed hook\n');
  assert.equal(fs.existsSync(path.join(configDir, result.journalRelPath)), false);
  assert.equal(
    fs.readdirSync(path.join(configDir, 'gsd-migration-journal')).some((name) => name.includes('backups')),
    false
  );
});

test('refuses to run migrations while another installer owns the migration lock', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));
  fs.writeFileSync(path.join(configDir, 'gsd-install-migration.lock'), 'held by test\n', 'utf8');

  assert.throws(
    () => runInstallerMigrations({
      configDir,
      migrations: [],
      lockTimeoutMs: 0,
    }),
    /installer migration lock is held/
  );
});

test('reports lock release failures after migration work completes', (t) => {
  const configDir = createTempInstall();
  const originalUnlinkSync = fs.unlinkSync;
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
    cleanup(configDir);
  });

  // The release closure uses fs.unlinkSync (not fs.rmSync) so that EPERM is
  // NOT silently swallowed on Windows (#3670). Mock unlinkSync to simulate
  // a Windows NTFS EPERM condition when the lock file is removed.
  fs.unlinkSync = (targetPath) => {
    if (path.basename(String(targetPath)) === 'gsd-install-migration.lock') {
      throw new Error('simulated lock unlink failure');
    }
    return originalUnlinkSync.call(fs, targetPath);
  };

  assert.throws(
    () => runInstallerMigrations({
      configDir,
      migrations: [],
    }),
    /failed to release installer migration lock/
  );
});

test('rollback handle restores files and install state after a successful apply', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: 'already-applied',
          appliedAt: '2026-05-10T00:00:00.000Z',
          journal: 'gsd-migration-journal/prior.json',
        },
      ],
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord({
          id: '2026-05-11-remove-old-hook',
          title: 'Remove retired hook',
          description: 'Remove retired hook',
          introducedIn: '1.50.0',
          scopes: ['global'],
          destructive: true,
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/old-hook.js',
              reason: 'retired hook',
              ownershipEvidence: 'test fixture manifest-managed hook',
            },
          ],
        }),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    const result = applyInstallerMigrationPlan({
      configDir,
      plan,
      now: () => '2026-05-11T00:00:01.000Z',
    });

    result.rollback();

    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/old-hook.js'), 'utf8'), 'managed hook\n');
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), ['already-applied']);
    assert.equal(fs.existsSync(path.join(configDir, result.journalRelPath)), false);
  } finally {
    cleanup(configDir);
  }
});

test('rolls back touched files and leaves state unchanged when apply fails', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = {
      pendingMigrationIds: ['2026-05-11-remove-old-hook'],
      blocked: [],
      actions: [
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'remove-managed',
          relPath: 'hooks/old-hook.js',
          reason: 'retired hook',
          classification: 'managed-pristine',
          originalHash: sha256('managed hook\n'),
          currentHash: sha256('managed hook\n'),
        },
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'unsupported-test-action',
          relPath: 'hooks/other.js',
          reason: 'force failure',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        },
      ],
    };

    assert.throws(
      () => applyInstallerMigrationPlan({
        configDir,
        plan,
        now: () => '2026-05-11T00:00:02.000Z',
      }),
      /unsupported migration action type/
    );

    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/old-hook.js'), 'utf8'), 'managed hook\n');
    assert.deepEqual(readInstallState(configDir).appliedMigrations, []);
    assert.equal(
      fs.existsSync(path.join(configDir, 'gsd-migration-journal')) &&
        fs.readdirSync(path.join(configDir, 'gsd-migration-journal')).some((name) =>
          name.startsWith('2026-05-11T00-00-02-000Z')
        ),
      false
    );
  } finally {
    cleanup(configDir);
  }
});

test('cleans rollback and backup artifacts when migration apply fails', (t) => {
  const configDir = createTempInstall();
  t.after(() => cleanup(configDir));

  writeFile(configDir, 'hooks/old-hook.js', 'user changed hook\n');
  writeManifest(configDir, {
    'hooks/old-hook.js': sha256('managed hook\n'),
  });
  const plan = {
    blocked: [],
    actions: [
      {
        migrationId: '2026-05-11-remove-old-hook',
        migrationChecksum: 'sha256:remove',
        type: 'backup-and-remove',
        relPath: 'hooks/old-hook.js',
        reason: 'retired hook',
        classification: 'managed-modified',
        originalHash: sha256('managed hook\n'),
        currentHash: sha256('user changed hook\n'),
      },
      {
        migrationId: '2026-05-11-remove-old-hook',
        migrationChecksum: 'sha256:remove',
        type: 'unsupported-test-action',
        relPath: 'hooks/other.js',
        reason: 'force failure',
        classification: 'managed-pristine',
        originalHash: null,
        currentHash: null,
      },
    ],
  };

  assert.throws(
    () => applyInstallerMigrationPlan({
      configDir,
      plan,
      now: () => '2026-05-11T00:00:12.000Z',
    }),
    /unsupported migration action type/
  );

  assert.equal(fs.readFileSync(path.join(configDir, 'hooks/old-hook.js'), 'utf8'), 'user changed hook\n');
  assert.equal(
    fs.existsSync(path.join(configDir, 'gsd-migration-journal')) &&
      fs.readdirSync(path.join(configDir, 'gsd-migration-journal')).some((name) =>
        name.startsWith('2026-05-11T00-00-12-000Z')
      ),
    false
  );
});

test('reports rollback restore failures instead of swallowing them', () => {
  const configDir = createTempInstall();
  const originalCopyFileSync = fs.copyFileSync;
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = {
      blocked: [],
      actions: [
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'remove-managed',
          relPath: 'hooks/old-hook.js',
          reason: 'retired hook',
          classification: 'managed-pristine',
          originalHash: sha256('managed hook\n'),
          currentHash: sha256('managed hook\n'),
        },
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'unsupported-test-action',
          relPath: 'hooks/other.js',
          reason: 'force failure',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        },
      ],
    };

    fs.copyFileSync = (src, dest) => {
      if (/2026-05-11T00-00-04-000Z-[0-9a-f]+-rollback/.test(String(src))) {
        throw new Error('simulated rollback copy failure');
      }
      return originalCopyFileSync(src, dest);
    };

    assert.throws(
      () => applyInstallerMigrationPlan({
        configDir,
        plan,
        now: () => '2026-05-11T00:00:04.000Z',
      }),
      (error) => {
        assert.match(error.message, /rollback incomplete/);
        assert.equal(error.rollbackFailures.length, 1);
        assert.equal(error.rollbackFailures[0].relPath, 'hooks/old-hook.js');
        return true;
      }
    );
  } finally {
    fs.copyFileSync = originalCopyFileSync;
    cleanup(configDir);
  }
});

test('rejects executable preserve-user actions because preservation blocks non-interactive apply', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    assert.throws(
      () => applyInstallerMigrationPlan({
        configDir,
        plan: {
          blocked: [],
          actions: [
            {
              migrationId: '2026-05-11-preserve-user',
              type: 'preserve-user',
              relPath: 'hooks/custom-user-hook.js',
              reason: 'unknown user hook',
              classification: 'unknown',
              originalHash: null,
              currentHash: sha256('user hook\n'),
            },
          ],
        },
      }),
      /unsupported migration action type: preserve-user/
    );
  } finally {
    cleanup(configDir);
  }
});

test('keeps prior install state intact when a state write fails mid-write', () => {
  const configDir = createTempInstall();
  const originalWriteFileSync = fs.writeFileSync;
  try {
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [{ id: 'already-safe', appliedAt: '2026-05-11T00:00:00.000Z' }],
    });

    fs.writeFileSync = (filePath, content, ...rest) => {
      if (path.basename(filePath).startsWith(`${INSTALL_STATE_NAME}.tmp-`)) {
        throw new Error('simulated temp state write failure');
      }
      return originalWriteFileSync(filePath, content, ...rest);
    };

    assert.throws(
      () => writeInstallState(configDir, {
        schemaVersion: 1,
        appliedMigrations: [{ id: 'new-migration', appliedAt: '2026-05-11T00:00:01.000Z' }],
      }),
      /simulated temp state write failure/
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  try {
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), ['already-safe']);
  } finally {
    cleanup(configDir);
  }
});

test('skips migration records already present in install state', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: '2026-05-11-remove-old-hook',
          appliedAt: '2026-05-11T00:00:00.000Z',
          journal: 'gsd-migration-journal/prior.json',
        },
      ],
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord({
          plan: () => {
            throw new Error('already-applied migration planner must not run');
          },
        }),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:03.000Z',
    });

    assert.deepEqual(plan.pendingMigrationIds, []);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.blocked, []);
  } finally {
    cleanup(configDir);
  }
});

test('marks zero-action pending migrations as applied', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      migrations: [
        migrationRecord({
          id: '2026-05-11-noop-cleanup',
          title: 'No-op cleanup',
          description: 'No-op cleanup',
          destructive: false,
          plan: () => [],
        }),
      ],
      scope: 'global',
      now: () => '2026-05-11T00:00:06.000Z',
    });

    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-noop-cleanup']);
    assert.equal(result.journalRelPath, null);
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), [
      '2026-05-11-noop-cleanup',
    ]);
  } finally {
    cleanup(configDir);
  }
});

test('surfaces checksum drift for an already-applied migration without aborting', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: '2026-05-11-remove-old-hook',
          checksum: 'sha256:old-definition',
          appliedAt: '2026-05-11T00:00:00.000Z',
          journal: 'gsd-migration-journal/prior.json',
        },
      ],
    });

    let plan;
    assert.doesNotThrow(() => {
      plan = planInstallerMigrations({
        configDir,
        migrations: [
          migrationRecord({
            checksum: 'sha256:new-definition',
            plan: () => [],
          }),
        ],
        scope: 'global',
      });
    });
    assert.deepEqual(plan.pendingMigrationIds, []);
    assert.ok(Array.isArray(plan.checksumDrift));
    const drift = plan.checksumDrift.find((d) => d.id === '2026-05-11-remove-old-hook');
    assert.ok(drift, 'expected drift entry for the applied migration');
    assert.equal(drift.storedChecksum, 'sha256:old-definition');
    assert.equal(drift.currentChecksum, 'sha256:new-definition');
  } finally {
    cleanup(configDir);
  }
});

test('ignores checksum drift for applied migrations outside the active runtime scope', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: '2026-05-11-codex-only',
          checksum: 'sha256:old-definition',
          appliedAt: '2026-05-11T00:00:00.000Z',
          journal: 'gsd-migration-journal/prior.json',
        },
      ],
    });

    const plan = planInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      migrations: [
        migrationRecord({
          id: '2026-05-11-codex-only',
          title: 'Codex-only migration',
          description: 'Codex-only migration',
          checksum: 'sha256:new-definition',
          runtimes: ['codex'],
          scopes: ['global'],
          plan: () => {
            throw new Error('out-of-scope migration planner must not run');
          },
        }),
      ],
    });

    assert.deepEqual(plan.pendingMigrationIds, []);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.blocked, []);
  } finally {
    cleanup(configDir);
  }
});

test('discovers migration records from a directory in filename order', () => {
  const configDir = createTempInstall();
  try {
    const migrationsDir = path.join(configDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, '002-second.cjs'),
      "module.exports = { id: 'second', title: 'Second', description: 'second', introducedIn: '1.50.0', scopes: ['global', 'local'], destructive: false, plan: () => [] };\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(migrationsDir, '001-first.cjs'),
      "module.exports = { id: 'first', title: 'First', description: 'first', introducedIn: '1.50.0', scopes: ['global', 'local'], destructive: false, plan: () => [] };\n",
      'utf8'
    );

    const migrations = discoverInstallerMigrations({ migrationsDir });

    assert.deepEqual(migrations.map((migration) => migration.id), ['first', 'second']);
  } finally {
    cleanup(configDir);
  }
});

test('rejects migration actions that escape the install root', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    assert.throws(
      () => planInstallerMigrations({
        configDir,
        migrations: [
          migrationRecord({
            id: '2026-05-11-bad-path',
            title: 'Bad path',
            description: 'Bad path',
            plan: () => [
              {
                type: 'remove-managed',
                relPath: 'hooks/../../outside.js',
                reason: 'bad path',
                ownershipEvidence: 'test fixture manifest-managed hook',
              },
            ],
          }),
        ],
        scope: 'global',
      }),
      /relPath must stay inside configDir/
    );
  } finally {
    cleanup(configDir);
  }
});

test('rejects migration actions that normalize to the install root', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    for (const relPath of ['.', 'hooks/..']) {
      assert.throws(
        () => planInstallerMigrations({
          configDir,
          migrations: [
            migrationRecord({
              id: `2026-05-11-bad-path-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
              title: 'Bad path',
              description: 'Bad path',
              plan: () => [
                {
                  type: 'remove-managed',
                  relPath,
                  reason: 'bad path',
                  ownershipEvidence: 'test fixture manifest-managed hook',
                },
              ],
            }),
          ],
          scope: 'global',
        }),
        /relPath must stay inside configDir/
      );
    }
  } finally {
    cleanup(configDir);
  }
});

test('runs discovered installer migrations against manifest-managed legacy orphan files', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/statusline.js', 'legacy managed hook\n');
    writeFile(configDir, 'hooks/custom.js', 'custom hook\n');
    writeManifest(configDir, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    const result = runInstallerMigrations({
      configDir,
      scope: 'global',
      now: () => '2026-05-11T00:00:05.000Z',
    });

    assert.equal(fs.existsSync(path.join(configDir, 'hooks/statusline.js')), false);
    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/custom.js'), 'utf8'), 'custom hook\n');
    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-legacy-orphan-files']);
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), ['2026-05-11-legacy-orphan-files']);
  } finally {
    cleanup(configDir);
  }
});

test('backs up modified legacy orphan files before removing them', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/statusline.js', 'user modified legacy hook\n');
    writeManifest(configDir, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: discoverInstallerMigrations({
        migrationsDir: path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'installer-migrations'),
      }),
      scope: 'global',
      now: () => '2026-05-11T00:00:05.000Z',
    });
    const action = plan.actions.find((item) => item.relPath === 'hooks/statusline.js');

    assert.equal(action.type, 'backup-and-remove');

    const result = runInstallerMigrations({
      configDir,
      scope: 'global',
      now: () => '2026-05-11T00:00:05.000Z',
    });
    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    const backupRelPath = journal.actions.find((item) => item.relPath === 'hooks/statusline.js').backupRelPath;

    assert.equal(fs.existsSync(path.join(configDir, 'hooks/statusline.js')), false);
    assert.equal(fs.readFileSync(path.join(configDir, backupRelPath), 'utf8'), 'user modified legacy hook\n');
  } finally {
    cleanup(configDir);
  }
});

test('runs a Codex legacy hooks.json cleanup migration without removing user hooks', () => {
  const configDir = createTempInstall();
  try {
    writeFile(
      configDir,
      'hooks.json',
      JSON.stringify({
        SessionStart: [
          legacyCodexHook(configDir),
          userHook('node "/Users/example/bin/user-hook.js"'),
          userHook('node "/Users/example/bin/gsd-check-update.js"'),
        ],
      }, null, 2)
    );
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'codex',
      scope: 'global',
      now: () => '2026-05-11T00:00:06.000Z',
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(configDir, 'hooks.json'), 'utf8'));
    const commands = hooksJson.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);

    assert.deepEqual(commands, [
      'node "/Users/example/bin/user-hook.js"',
      'node "/Users/example/bin/gsd-check-update.js"',
    ]);
    assert.ok(result.appliedMigrationIds.includes('2026-05-11-codex-legacy-hooks-json'));
  } finally {
    cleanup(configDir);
  }
});

test('preserves unrelated empty hooks.json structure while pruning legacy Codex hooks', () => {
  const configDir = createTempInstall();
  try {
    writeFile(
      configDir,
      'hooks.json',
      JSON.stringify({
        SessionStart: [
          legacyCodexHook(configDir),
          { hooks: [] },
          { metadata: null },
        ],
      }, null, 2)
    );
    writeManifest(configDir, {});

    runInstallerMigrations({
      configDir,
      runtime: 'codex',
      scope: 'global',
      now: () => '2026-05-11T00:00:06.000Z',
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(configDir, 'hooks.json'), 'utf8'));

    assert.deepEqual(hooksJson.SessionStart, [
      { hooks: [] },
      { metadata: null },
    ]);
  } finally {
    cleanup(configDir);
  }
});

test('skips runtime-specific migration records for other runtimes', () => {
  const configDir = createTempInstall();
  try {
    writeFile(
      configDir,
      'hooks.json',
      JSON.stringify({
        SessionStart: [legacyCodexHook(configDir)],
      }, null, 2)
    );
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      now: () => '2026-05-11T00:00:07.000Z',
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(configDir, 'hooks.json'), 'utf8'));
    assert.equal(hooksJson.SessionStart[0].hooks[0].command, `node "${path.join(configDir, 'hooks', 'gsd-check-update.js')}"`);
    assert.equal(result.appliedMigrationIds.includes('2026-05-11-codex-legacy-hooks-json'), false);
  } finally {
    cleanup(configDir);
  }
});

// ---------------------------------------------------------------------------
// Checksum-baseline guardrail (issue #670)
//
// Shipped installer-migration bodies are immutable: editing a released body
// breaks the stored checksum for any user who has already applied that
// migration, which was the root cause of issue #670.
//
// This test locks every shipped migration to its committed checksum so that CI
// catches accidental body edits. When you INTENTIONALLY change the behaviour
// of a migration you must add a NEW fix-forward migration id instead; if for
// some extraordinary reason you truly need to update an existing baseline, add
// the new checksum here with a comment explaining why.
//
// Mechanism: compute each migration's checksum directly via the exported
// migrationChecksum() (scope-independent) and assert it matches the committed
// baseline. This is simpler and more robust than the previous plan()-based
// approach because it doesn't depend on runtime/scope filtering.
// ---------------------------------------------------------------------------
test('shipped installer-migration checksums are locked to a committed baseline (issue #670 guardrail)', () => {
  // Committed baseline — update ONLY when adding a new migration or performing an
  // extraordinary intentional body change (add a comment explaining why). Editing a
  // shipped migration body breaks the stored checksum for everyone who already applied
  // it (root cause of #670) — add a NEW fix-forward migration id instead.
  const EXPECTED_CHECKSUMS = {
    '2026-05-11-first-time-baseline-scan':
      'sha256:4ec58d35b30dbf39cc56e3972146086d8d31861ecd800cf0b37a7aa94fe74c2a',
    '2026-05-11-legacy-orphan-files':
      'sha256:e492698748a2436a12a55f0940f539b9bf651d8ffcac6f60cd856a6dabd6788c',
    '2026-05-11-codex-legacy-hooks-json':
      'sha256:5ce55294aa02f25758f604a569c899a6d2d060299189f5f447f68d8033157058',
    '2026-06-02-rename-get-shit-done-to-gsd-core':
      'sha256:3a9f1d97f64097fb313203d19c6d93a187a38df61dd299afa5eef73e16124e95',
    // Migration 004: prune stale gsd-pristine/get-shit-done/ snapshots (#934) // gsd-allow-legacy-name
    '2026-06-09-prune-stale-pristine-get-shit-done': // gsd-allow-legacy-name
      'sha256:6555dd044659276fbc204e81793cd92c5315d54e7316bcdd82d2c98d15a7e9e8',
    // Migration 005 (NEW, added here per this test's own sanctioned "adding a new
    // migration" case — not a shipped-body edit): baseline OpenCode's commands/
    // (plural) directory during the first-time scan. #2329 moved OpenCode command
    // materialization from legacy command/ to commands/, but 000's RUNTIME_SURFACES
    // is a shipped, immutable body that still only names command/, so this
    // fix-forward migration widens the scanned surface without touching 000.
    '2026-07-17-opencode-baseline-commands-dir':
      'sha256:0f6080b5f9b75fb5adbe9664a71152e23a5336813453b0a77e4df6fd483ad38e',
    // Migration 006 (NEW, added here per this test's own sanctioned "adding a new
    // migration" case — not a shipped-body edit): retire pi's stale
    // extensions/gsd.cjs. #2470 renamed the installed extension to
    // extensions/gsd.js because pi's isExtensionFile() auto-discovery accepts
    // only .ts/.js and silently skips everything else; without this migration the
    // old path drops out of the manifest and uninstall can never remove it.
    '2026-07-20-pi-extension-cjs-to-js':
      'sha256:185fa926ae24d83cbdd95c31a9ad2cc8d123e176ad543669b3b0ed75e6ca6f4a',
    // Migration 007 (NEW, added here per this test's own sanctioned "adding a new
    // migration" case — not a shipped-body edit): retire the pre-#2544
    // {"type":"commonjs"} marker at the runtime config root. #2544 moved that
    // marker into the directories GSD fills, so without this an upgraded install
    // keeps both and the config root stays pinned to CommonJS. Ownership is proven
    // by exact content match rather than the manifest — the config-root marker was
    // never manifest-recorded — so the action declares its own classification.
    '2026-07-28-retire-config-root-commonjs-marker':
      'sha256:8f2140cbe8f2dd8f7dfd52a0f6957c5edfe966c52d7e6e4d74ec7366930e0e1d',
    // Migration 008: retire Cursor's duplicate commands/ surface (#2644).
    '2026-07-29-cursor-retire-commands-surface':
      'sha256:d0b2b812a3f752650f2518b48280f74a5937c80ec8412bac493382dfa3db083f',
    // Migration 009 (NEW, added here per this test's own sanctioned "adding a new
    // migration" case — not a shipped-body edit): retire pi's reserved hooks/
    // directory now that the shared hook bundle installs at gsd-hooks/ instead
    // (#3023). pi warns on hooks/'s mere existence regardless of contents, so an
    // upgraded install must have both the legacy files AND the emptied directory
    // itself retired via the new remove-empty-dir action.
    '2026-08-07-pi-retire-reserved-hooks-dir':
      'sha256:34264415b00e15e5a1691eae3db9bd24dca11e5c04d78358420a7a8adf115f9e',
    // Migration 010 (NEW, added here per this test's own sanctioned "adding a new
    // migration" case): retire Antigravity's configHome skills/agents surfaces
    // (#3738). Antigravity scans ~/.gemini/config for global discovery, so
    // pre-#3738 artifacts sat in a dir the runtime never read; since #3738 both
    // kinds install under the .gemini/config home override and this migration
    // converges upgraded installs. Global scope only — local .agents is live.
    '2026-08-26-antigravity-retire-confighome-artifacts':
      'sha256:52764c43418accdc26c89482b1a46bf9ebcde1c1d9a80e302971a7b068a3be3c',
  };

  const { DEFAULT_MIGRATIONS_DIR, migrationChecksum: computeChecksum } = require('../gsd-core/bin/lib/installer-migrations.cjs');
  const migrations = discoverInstallerMigrations({ migrationsDir: DEFAULT_MIGRATIONS_DIR });
  const discoveredIds = new Set(migrations.map((m) => m.id));

  // No stale baseline entries.
  for (const id of Object.keys(EXPECTED_CHECKSUMS)) {
    assert.ok(discoveredIds.has(id),
      `EXPECTED_CHECKSUMS has a stale entry for '${id}' — that migration no longer exists; remove it`);
  }
  // Every discovered migration has a committed baseline entry.
  for (const id of discoveredIds) {
    assert.ok(Object.prototype.hasOwnProperty.call(EXPECTED_CHECKSUMS, id),
      `new migration '${id}' has no committed checksum baseline — add it to EXPECTED_CHECKSUMS in tests/installer-migrations.test.cjs`);
  }
  // Core lock: each shipped migration's current checksum must match its committed baseline,
  // computed directly (scope-independent).
  for (const m of migrations) {
    assert.strictEqual(computeChecksum(m), EXPECTED_CHECKSUMS[m.id],
      `'${m.id}' body changed — its checksum drifted from the committed baseline; ` +
      `add a NEW fix-forward migration id instead of editing a shipped migration body, ` +
      `or intentionally update the baseline in EXPECTED_CHECKSUMS`);
  }
});

test('reconciles a drifted applied-migration checksum into install state on apply', () => {
  const configDir = createTempInstall();
  try {
    // Set up: one already-applied migration with a stale checksum, one pending migration
    // that will produce an action (so applyInstallerMigrationPlan writes state).
    const alreadyAppliedMigration = migrationRecord({
      id: '2026-05-11-already-applied-with-drift',
      title: 'Already applied with drift',
      description: 'Already applied with drift',
      scopes: ['global'],
      destructive: false,
      plan: () => [],
    });
    const pendingMigration = migrationRecord({
      id: '2026-05-11-pending-to-trigger-apply',
      title: 'Pending migration',
      description: 'Pending migration',
      scopes: ['global'],
      destructive: true,
      plan: () => [
        {
          type: 'remove-managed',
          relPath: 'hooks/old-hook.js',
          reason: 'retiring hook',
          ownershipEvidence: 'test fixture manifest-managed hook',
        },
      ],
    });

    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    // Seed install state: alreadyAppliedMigration recorded with a STALE checksum.
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: alreadyAppliedMigration.id,
          appliedAt: '2026-01-01T00:00:00.000Z',
          journal: null,
          checksum: 'sha256:stale-old',
        },
      ],
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [alreadyAppliedMigration, pendingMigration],
      scope: 'global',
      now: () => '2026-05-11T00:00:00.000Z',
    });

    // The already-applied migration should appear in checksumDrift.
    const drift = plan.checksumDrift.find((d) => d.id === alreadyAppliedMigration.id);
    assert.ok(drift, 'expected checksumDrift entry for the already-applied migration');
    assert.equal(drift.storedChecksum, 'sha256:stale-old');

    // Apply the plan (the pending migration has an action, so this writes state).
    applyInstallerMigrationPlan({
      configDir,
      plan,
      now: () => '2026-05-11T00:00:01.000Z',
    });

    // Re-read install state and assert the stale checksum was reconciled.
    const stateAfter = readInstallState(configDir);
    const reconciledEntry = stateAfter.appliedMigrations.find(
      (entry) => entry.id === alreadyAppliedMigration.id
    );
    assert.ok(reconciledEntry, 'expected the already-applied entry to still be in install state');
    const expectedChecksum = migrationChecksum(alreadyAppliedMigration);
    assert.strictEqual(
      reconciledEntry.checksum,
      expectedChecksum,
      `expected checksum to be reconciled to current value (${expectedChecksum}), not the stale 'sha256:stale-old'`
    );
    assert.notEqual(reconciledEntry.checksum, 'sha256:stale-old',
      'stale checksum must not remain after apply');
  } finally {
    cleanup(configDir);
  }
});


// ---------------------------------------------------------------------------
// remove-empty-dir action type (introduced with migration 009, #3023)
//
// Deliberately WEAKER than a recursive removal primitive: fs.rmdirSync only,
// never fs.rmSync / {recursive:true} / {force:true}. A non-empty directory is
// left in place as a successful no-op, not an error.
// ---------------------------------------------------------------------------
{
  const { test, mock } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  const {
    applyInstallerMigrationPlan,
    evaluateRemoveEmptyDir,
  } = require('../gsd-core/bin/lib/installer-migrations.cjs');
  const { cleanup, createTempDir } = require('./helpers.cjs');

  test('evaluateRemoveEmptyDir removes a genuinely empty directory', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));
    const target = path.join(configDir, 'hooks');
    fs.mkdirSync(target);

    assert.equal(evaluateRemoveEmptyDir(configDir, target), 'removed');
    assert.equal(fs.existsSync(target), false);
  });

  test('evaluateRemoveEmptyDir leaves a non-empty directory in place (planned-but-skipped, not an error)', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));
    const target = path.join(configDir, 'hooks');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'still-here.js'), '// user file\n', 'utf8');

    assert.equal(evaluateRemoveEmptyDir(configDir, target), 'skipped-not-empty');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(path.join(target, 'still-here.js')), true);
  });

  test('evaluateRemoveEmptyDir refuses a symlinked directory (never follows it)', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));
    const realElsewhere = createTempDir('gsd-remove-empty-dir-elsewhere-');
    t.after(() => cleanup(realElsewhere));
    const linkPath = path.join(configDir, 'hooks');
    fs.symlinkSync(realElsewhere, linkPath, 'dir');

    assert.equal(evaluateRemoveEmptyDir(configDir, linkPath), 'left-in-place');
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, 'the symlink itself must survive untouched');
    assert.equal(fs.existsSync(realElsewhere), true, 'the real target directory must never be removed through the link');
  });

  test('evaluateRemoveEmptyDir refuses a target outside configDir', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));
    const outside = createTempDir('gsd-remove-empty-dir-outside-');
    t.after(() => cleanup(outside));

    assert.equal(evaluateRemoveEmptyDir(configDir, outside), 'left-in-place');
    assert.equal(fs.existsSync(outside), true);
  });

  test('evaluateRemoveEmptyDir refuses to remove configDir itself', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));

    assert.equal(evaluateRemoveEmptyDir(configDir, configDir), 'left-in-place');
    assert.equal(fs.existsSync(configDir), true);
  });

  test('evaluateRemoveEmptyDir treats an already-absent directory as a clean no-op', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    t.after(() => cleanup(configDir));
    const target = path.join(configDir, 'hooks');
    assert.equal(fs.existsSync(target), false);

    let outcome;
    assert.doesNotThrow(() => { outcome = evaluateRemoveEmptyDir(configDir, target); });
    assert.equal(outcome, 'missing');
  });

  test('evaluateRemoveEmptyDir degrades an EACCES from rmdirSync without throwing', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-');
    const target = path.join(configDir, 'hooks');
    fs.mkdirSync(target);

    mock.method(fs, 'rmdirSync', () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });
    // Registered BEFORE the cleanup hook below — node:test runs `t.after`
    // callbacks in REGISTRATION order, so this guarantees fs.rmdirSync is
    // restored before cleanup() ever runs. That ordering is load-bearing on
    // Node 22 (not Node 24): Node 22's recursive `fs.rmSync` still falls
    // through to the JS rimraf implementation (internal/fs/rimraf.js), which
    // calls the PUBLIC `fs.rmdirSync` this test mocks; Node 24's native
    // recursive-rm implementation never touches it. With cleanup's `t.after`
    // registered FIRST (as it was), cleanup() ran while the mock was still
    // active on Node 22 — `fs.rmSync` threw the injected EACCES, that
    // exception aborted the test's remaining `after` hooks before
    // `mock.restoreAll()` could run, and the still-mocked `fs.rmdirSync` then
    // poisoned `cleanup()` for every later test in this file for the rest of
    // the Node 22 process (the node22-only "failed running afterEach/after
    // hook" cascade across the Codex/migration-008/T3 tests below). Verified
    // by reproducing both orderings against `node:22` and `node:24` directly.
    t.after(() => mock.restoreAll());
    t.after(() => cleanup(configDir));

    let outcome;
    assert.doesNotThrow(() => { outcome = evaluateRemoveEmptyDir(configDir, target); });
    assert.equal(outcome, 'left-in-place');
    assert.equal(fs.existsSync(target), true, 'directory must survive a failed rmdirSync');
  });

  test('applyInstallerMigrationPlan wires remove-empty-dir through to journal + disk removal', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-apply-');
    t.after(() => cleanup(configDir));
    const target = path.join(configDir, 'hooks');
    fs.mkdirSync(target);

    const result = applyInstallerMigrationPlan({
      configDir,
      plan: {
        blocked: [],
        actions: [{
          migrationId: '2026-08-07-pi-retire-reserved-hooks-dir',
          migrationChecksum: 'sha256:test',
          type: 'remove-empty-dir',
          relPath: 'hooks',
          reason: 'retired reserved directory',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        }],
      },
      now: () => '2026-08-07T00:00:00.000Z',
    });

    assert.equal(fs.existsSync(target), false);
    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    assert.equal(journal.actions.length, 1);
    assert.equal(journal.actions[0].status, 'removed');
    assert.equal(journal.actions[0].type, 'remove-empty-dir');
  });

  test('applyInstallerMigrationPlan leaves a non-empty remove-empty-dir target on disk and journals it', (t) => {
    const configDir = createTempDir('gsd-remove-empty-dir-apply-');
    t.after(() => cleanup(configDir));
    const target = path.join(configDir, 'hooks');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'user-file.js'), '// preserved\n', 'utf8');

    const result = applyInstallerMigrationPlan({
      configDir,
      plan: {
        blocked: [],
        actions: [{
          migrationId: '2026-08-07-pi-retire-reserved-hooks-dir',
          migrationChecksum: 'sha256:test',
          type: 'remove-empty-dir',
          relPath: 'hooks',
          reason: 'retired reserved directory',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        }],
      },
      now: () => '2026-08-07T00:00:01.000Z',
    });

    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(path.join(target, 'user-file.js')), true);
    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    assert.equal(journal.actions[0].status, 'skipped-not-empty');
  });
}

// ---------------------------------------------------------------------------
// Cursor duplicate commands-surface retirement (#2644)
// ---------------------------------------------------------------------------

{
  const cursorCommandsMigration = require('../gsd-core/bin/lib/installer-migrations/008-cursor-retire-commands-surface.cjs');

  test('migration 008 plans only manifest-managed gsd-*.md command files', (t) => {
    const configDir = createTempInstall();
    t.after(() => cleanup(configDir));
    writeFile(configDir, 'commands/gsd-help.md', '# help\n');
    writeFile(configDir, 'commands/gsd-custom.md', '# custom\n');
    writeFile(configDir, 'commands/not-gsd.md', '# other\n');

    const actions = cursorCommandsMigration.plan({
      configDir,
      classifyArtifact(relPath) {
        if (relPath === 'commands/gsd-help.md') return { classification: 'managed-pristine' };
        return { classification: 'unknown' };
      },
    });

    assert.deepEqual(actions.map((action) => [action.type, action.relPath]), [
      ['remove-managed', 'commands/gsd-help.md'],
    ]);
  });

  test('migration 008 backs up a modified managed command and preserves an unknown neighbor', (t) => {
    const configDir = createTempInstall();
    t.after(() => cleanup(configDir));
    writeFile(configDir, 'commands/gsd-help.md', '# locally modified help\n');
    writeFile(configDir, 'commands/gsd-custom.md', '# user command\n');
    writeManifest(configDir, {
      'commands/gsd-help.md': sha256('# original generated help\n'),
    });

    const result = runInstallerMigrations({
      configDir, runtime: 'cursor', scope: 'global', migrations: [cursorCommandsMigration],
      now: () => '2026-07-29T00:00:00.000Z',
    });

    assert.equal(result.plan.actions[0].type, 'backup-and-remove');
    assert.ok(!fs.existsSync(path.join(configDir, 'commands', 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(configDir, 'commands', 'gsd-custom.md')),
      'unmanifested user command must be preserved');
    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    assert.equal(
      fs.readFileSync(path.join(configDir, journal.actions[0].backupRelPath), 'utf8'),
      '# locally modified help\n',
    );
  });

  test('migration 008 is scoped to Cursor for both global and local installs', (t) => {
    for (const scope of ['global', 'local']) {
      const configDir = createTempInstall();
      t.after(() => cleanup(configDir));
      writeFile(configDir, 'commands/gsd-help.md', '# help\n');
      writeManifest(configDir, { 'commands/gsd-help.md': sha256('# help\n') });
      const result = runInstallerMigrations({
        configDir, runtime: 'cursor', scope, migrations: [cursorCommandsMigration],
        now: () => `2026-07-29T00:00:0${scope === 'global' ? '0' : '1'}.000Z`,
      });
      assert.ok(!fs.existsSync(path.join(configDir, 'commands', 'gsd-help.md')),
        `${scope} Cursor install must retire the duplicate command`);
      assert.deepEqual(result.appliedMigrationIds, ['2026-07-29-cursor-retire-commands-surface']);
    }
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3357-codex-legacy-hooks-json-migration.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3357-codex-legacy-hooks-json-migration (consolidation epic #1969 B5 #1974)", () => {
/**
 * Regression test for bug #3357.
 *
 * Older Codex installs carried legacy GSD SessionStart commands in hooks.json.
 * Current install keeps the managed SessionStart hook in hooks.json (single
 * representation per layer) and strips stale managed entries before writing
 * exactly one canonical managed command.
 *
 * Bug #1348 (addendum): reconcileCodexHooksJsonEvent must always write the
 * canonical nested { "hooks": { "<Event>": [...] } } shape — never top-level
 * event keys — mirroring reconcileCursorHooksJson.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const installModule = require('../bin/install.js');
const { readInstallState } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { install, parseTomlToObject } = installModule;
const { reconcileCodexHooksJsonEvent } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything, even
// run in beforeEach on a fresh worktree. See tests/helpers/timeouts.cjs for
// the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function withCodexHome(codexHome, fn) {
  const previousCodexHome = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now install to $HOME/.agents/skills
  // (os.homedir()-relative, independent of CODEX_HOME). Sandbox HOME (and
  // USERPROFILE) to codexHome so in-process installs never write to the
  // developer/CI machine's real home directory.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  try {
    return fn();
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function legacyGsdHook(codexHome) {
  return {
    hooks: [{
      type: 'command',
      command: `node "${path.join(codexHome, 'hooks', 'gsd-check-update.js')}"`,
    }],
  };
}

function userHook() {
  return {
    hooks: [{
      type: 'command',
      command: 'node "/Users/example/bin/user-hook.js"',
    }],
  };
}

function tomlGsdHookCount(codexHome) {
  const parsed = parseTomlToObject(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  const sessionStart = parsed.hooks?.SessionStart ?? [];
  return sessionStart
    .flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : [])
    .filter((hook) => typeof hook.command === 'string' && hook.command.includes('gsd-check-update'))
    .length;
}

describe('#3357 — Codex install removes legacy GSD hooks.json entries', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      throwIfFailed(
        runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
        `node ${BUILD_HOOKS_SCRIPT}`,
      );
    }
    tmpRoot = createTempDir('gsd-3357-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    delete installModule.__codexSchemaValidator;
    cleanup(tmpRoot);
  });

  test('rewrites hooks.json to one managed SessionStart hook when file only had legacy managed entry', () => {
    fs.writeFileSync(
      path.join(codexHome, 'hooks.json'),
      JSON.stringify({ SessionStart: [legacyGsdHook(codexHome)] }, null, 2),
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #1348: output must be nested { hooks: { SessionStart: [...] } }, not top-level
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      'hooks.json must use nested { hooks: { ... } } shape (bug #1348)',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      'hooks.json must NOT have a top-level SessionStart key (bug #1348)',
    );
    const commands = hooksJson.hooks.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);
    const managed = commands.filter((cmd) => typeof cmd === 'string' && cmd.includes('gsd-check-update'));
    assert.equal(managed.length, 1);
    assert.equal(tomlGsdHookCount(codexHome), 0);
  });

  test('preserves user hooks.json entries while removing the legacy GSD hook', () => {
    const userOwnedSameBasenameHook = {
      hooks: [{
        type: 'command',
        command: 'node "/Users/example/bin/gsd-check-update.js"',
      }],
    };
    fs.writeFileSync(
      path.join(codexHome, 'hooks.json'),
      JSON.stringify({ SessionStart: [legacyGsdHook(codexHome), userHook(), userOwnedSameBasenameHook] }, null, 2),
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #1348: output must be nested { hooks: { SessionStart: [...] } }, not top-level
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      'hooks.json must use nested { hooks: { ... } } shape (bug #1348)',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      'hooks.json must NOT have a top-level SessionStart key (bug #1348)',
    );
    const commands = hooksJson.hooks.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);
    const managed = commands.filter((cmd) => typeof cmd === 'string' && cmd.includes('gsd-check-update'));
    assert.equal(commands.includes('node "/Users/example/bin/user-hook.js"'), true);
    assert.equal(commands.includes('node "/Users/example/bin/gsd-check-update.js"'), true);
    assert.equal(managed.length, 2);
    assert.equal(tomlGsdHookCount(codexHome), 0);
  });

  test('restores migrated hooks.json and install state when later Codex validation fails', () => {
    const before = JSON.stringify({ SessionStart: [legacyGsdHook(codexHome)] }, null, 2);
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), before);

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'forced migration rollback test',
    });

    assert.throws(
      () => withCodexHome(codexHome, () => install(true, 'codex')),
      /forced migration rollback test/
    );

    assert.equal(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'), before);
    assert.equal(
      readInstallState(codexHome).appliedMigrations.some((entry) => entry.id === '2026-05-11-codex-legacy-hooks-json'),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// #1348 — reconcileCodexHooksJsonEvent must always write canonical nested shape
// ---------------------------------------------------------------------------

describe('#1348 — reconcileCodexHooksJsonEvent canonical nested shape', { concurrency: false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-1348-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) Fresh/absent hooks.json: register → { "hooks": { "SessionStart": [...] } }
  test('(a) fresh/absent hooks.json writes nested { hooks: { SessionStart: [...] } } shape', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    assert.ok(!fs.existsSync(hooksJsonPath), 'precondition: hooks.json must not exist');

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must be created');
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));

    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      `Expected nested { hooks: { ... } } shape; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      Array.isArray(hooksJson.hooks.SessionStart) && hooksJson.hooks.SessionStart.length > 0,
      `Expected hooks.hooks.SessionStart to be a non-empty array; got: ${JSON.stringify(hooksJson)}`,
    );
  });

  // (b) Legacy migration: seed top-level { "SessionStart": [<user>] }, register →
  //   nested hooks.SessionStart contains BOTH migrated user entry AND managed entry
  test('(b) legacy top-level shape: user entries migrate into hooks.SessionStart alongside managed entry', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const userEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/my-hook.js"' }] };
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify({ SessionStart: [userEntry] }, null, 2),
    );

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));

    // Canonical nested shape
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      `Expected nested { hooks: { ... } } shape; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );

    // User entry was migrated under hooks.SessionStart (not dropped)
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      allCommands.includes('node "/Users/alice/my-hook.js"'),
      `User entry must be preserved under hooks.SessionStart; commands: ${JSON.stringify(allCommands)}`,
    );

    // Managed entry is also present
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, 'Exactly one managed entry must be present under hooks.SessionStart');
  });

  // (c-i) Dedup: re-registering the same managed command does not duplicate it
  test('(c-i) re-registering managed command produces exactly one managed entry', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, 'Re-register must yield exactly one managed entry');
  });

  // (c-ii) Removal: user entries remain under hooks, managed entry is gone
  test('(c-ii) removing managed hook leaves user entry under hooks.SessionStart', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const userEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/my-hook.js"' }] };
    // Seed already-nested file with both user + managed
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });
    // Now manually seed a user entry into the existing nested file
    const seeded = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    seeded.hooks.SessionStart = [userEntry, ...seeded.hooks.SessionStart];
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(seeded, null, 2));

    // Remove managed
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: null });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    // User entry must still be under hooks.SessionStart
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      allCommands.includes('node "/Users/alice/my-hook.js"'),
      `User entry must remain after managed removal; commands: ${JSON.stringify(allCommands)}`,
    );
    // No managed entry
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 0, 'No managed entry must remain after removal');
  });

  // (c-iii) Removal from absent file does NOT materialize { "hooks": {} }
  test('(c-iii) removing from absent hooks.json does not write a spurious empty { "hooks": {} }', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    assert.ok(!fs.existsSync(hooksJsonPath), 'precondition: hooks.json must not exist');

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: null });

    assert.ok(
      !fs.existsSync(hooksJsonPath),
      'hooks.json must NOT be created when removing from absent file (no spurious { "hooks": {} })',
    );
  });

  // (d) Mixed nested + top-level shape: { "hooks": { "PreToolUse": [...] }, "SessionStart": [...] }
  // The stray top-level event array must be lifted into hooks and merged; no top-level key survives.
  test('(d) mixed nested + top-level shape: stray top-level event array is lifted and merged', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const existingNestedEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/pre-tool.js"' }] };
    const userTopLevelEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/session-start.js"' }] };

    // Seed a mixed-shape file: nested PreToolUse AND top-level SessionStart
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify(
        {
          hooks: { PreToolUse: [existingNestedEntry] },
          SessionStart: [userTopLevelEntry],
        },
        null,
        2,
      ),
    );

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));

    // No stray top-level SessionStart key
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );

    // hooks.SessionStart contains the migrated user entry AND exactly one managed entry
    assert.ok(
      Array.isArray(hooksJson.hooks.SessionStart),
      `hooks.hooks.SessionStart must be an array; got: ${JSON.stringify(hooksJson)}`,
    );
    const sessionCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      sessionCommands.includes('node "/Users/alice/session-start.js"'),
      `Migrated user entry must be present in hooks.SessionStart; commands: ${JSON.stringify(sessionCommands)}; full: ${JSON.stringify(hooksJson)}`,
    );
    const managedCount = sessionCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, `Exactly one managed entry must be present in hooks.SessionStart; commands: ${JSON.stringify(sessionCommands)}`);

    // hooks.PreToolUse is untouched
    assert.ok(
      Array.isArray(hooksJson.hooks.PreToolUse) && hooksJson.hooks.PreToolUse.length === 1,
      `hooks.hooks.PreToolUse must be preserved with one entry; got: ${JSON.stringify(hooksJson.hooks.PreToolUse)}`,
    );
    const preToolCommands = hooksJson.hooks.PreToolUse
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      preToolCommands.includes('node "/Users/alice/pre-tool.js"'),
      `Existing nested PreToolUse entry must be preserved; commands: ${JSON.stringify(preToolCommands)}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3670-cursor-local-install-migration-lock.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3670-cursor-local-install-migration-lock (consolidation epic #1969 B5 #1974)", () => {
/**
 * Regression tests for issue #3670: --cursor --local install self-deadlocks
 * on gsd-install-migration.lock.
 *
 * Root cause: On Windows, `fs.rmSync(lockPath, { force: true })` in the lock
 * release closure silently swallows EPERM errors that NTFS returns when a
 * recently-closed file descriptor's handle has not yet been fully released by
 * the OS. The lock file is left on disk. The next `runInstallerMigrations`
 * call in the same install() invocation hits EEXIST, spins for
 * DEFAULT_LOCK_TIMEOUT_MS (30 s), then throws "installer migration lock is
 * held". There is also no stale-PID reclamation: if the lock names the
 * current process's PID, the helper should reclaim rather than spin.
 *
 * Windows wall-clock deadlock repro depends on Docker matrix Windows runners.
 * These tests reproduce the failure modes via mock-injected fs faults on any
 * platform (macOS/Linux/Windows). They fail deterministically WITHOUT the fix
 * and pass WITH it.
 *
 * Test plan:
 *   T1 (same-process re-entry / stale-PID reclamation — primary regression)
 *      Pre-seed the lock file with {pid: process.pid, ...}. Verify that a
 *      runInstallerMigrations call reclaims the lock and succeeds rather than
 *      spinning 30 s and throwing.
 *
 *   T2 (dead-PID reclamation — cross-invocation stale lock)
 *      Pre-seed the lock file with a PID known to be dead. Verify that acquire
 *      reclaims rather than throws.
 *
 *   T3 (silent rmSync swallow / Windows EPERM simulation)
 *      Inject a fault that makes fs.rmSync throw EPERM for the lock file only
 *      (simulating Windows NTFS delete-pending). Verify that the lock file IS
 *      removed by an alternative path (or that the error propagates) — i.e.
 *      verify that the fix does not silently leave the lock on disk.
 *
 *   T4 (counter-test: normal single acquire/release round-trip still works)
 *      No pre-seeded lock. One runInstallerMigrations call. Must succeed and
 *      leave no lock file behind.
 *
 *   T5 (counter-test: genuinely-held live lock still surfaces an error)
 *      Pre-seed lock with a live PID (process.pid) AND simulate a lock that
 *      has been "truly acquired" (fd still open). With lockTimeoutMs: 0 and a
 *      truly un-reclaimable lock, must still throw with a useful message naming
 *      the holder PID. (This guards against over-reclamation.)
 *
 * @see https://github.com/open-gsd/gsd-core/issues/3670
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  INSTALL_MIGRATION_LOCK_NAME,
  runInstallerMigrations,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3670-'));
}

function lockPath(dir) {
  return path.join(dir, INSTALL_MIGRATION_LOCK_NAME);
}

function writeLockFile(dir, pid, acquiredAt) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    lockPath(dir),
    JSON.stringify({ pid, acquiredAt: acquiredAt || new Date().toISOString() }) + '\n',
    'utf8'
  );
}

/**
 * Find a PID that is guaranteed to be dead on this host.
 * We probe a set of high candidate PIDs (far outside the running set) and
 * pick the first one for which process.kill(pid, 0) throws ESRCH.
 * Falls back to 99999 if the probe loop exhausts (extremely unlikely).
 */
function findDeadPid() {
  // Avoid process.pid ± small numbers — those could be live siblings.
  for (let candidate = 600000; candidate < 700000; candidate += 1000) {
    try {
      process.kill(candidate, 0);
      // Still alive (or permission denied but exists) — try next
    } catch (err) {
      if (err.code === 'ESRCH') return candidate;
    }
  }
  return 99999; // fallback: extremely unlikely to be a live PID
}

// ---------------------------------------------------------------------------
// T1: Same-process re-entry — stale lock with current process.pid reclaimed
// ---------------------------------------------------------------------------
test('T1: reclaims stale lock that names the current process PID (same-process re-entry)', (t) => {
  const configDir = createTempDir();
  t.after(() => cleanup(configDir));

  // Pre-seed lock file with the CURRENT process's PID — exactly what happens
  // on Windows when rmSync swallows EPERM after the first runInstallerMigrations
  // call releases (or fails to release) the lock.
  writeLockFile(configDir, process.pid);

  // Without the fix: this would spin for lockTimeoutMs then throw.
  // With the fix: detects own PID → reclaims → succeeds.
  // lockTimeoutMs: 200 (fail fast so the test doesn't hang for 30 s without fix)
  const result = runInstallerMigrations({
    configDir,
    migrations: [],
    lockTimeoutMs: 200,
  });

  assert.ok(result, 'runInstallerMigrations must return a result object');
  // Lock file must be removed after the call completes.
  assert.equal(
    fs.existsSync(lockPath(configDir)),
    false,
    'lock file must not remain on disk after successful runInstallerMigrations'
  );
});

// ---------------------------------------------------------------------------
// T2: Dead-PID reclamation — cross-invocation stale lock
// ---------------------------------------------------------------------------
test('T2: reclaims stale lock whose PID is no longer alive', (t) => {
  const configDir = createTempDir();
  t.after(() => cleanup(configDir));

  const deadPid = findDeadPid();
  writeLockFile(configDir, deadPid);

  const result = runInstallerMigrations({
    configDir,
    migrations: [],
    lockTimeoutMs: 200,
  });

  assert.ok(result, 'runInstallerMigrations must return a result object');
  assert.equal(
    fs.existsSync(lockPath(configDir)),
    false,
    'lock file must not remain on disk after stale-PID reclamation'
  );
});

// ---------------------------------------------------------------------------
// T3: Windows EPERM simulation — unlinkSync failure surfaces (not silently swallowed)
// ---------------------------------------------------------------------------
test('T3: lock release does not silently leave lock file on disk when unlink fails (Windows EPERM simulation)', (t) => {
  const configDir = createTempDir();
  const originalUnlinkSync = fs.unlinkSync;

  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
    cleanup(configDir);
  });

  // The fix uses fs.unlinkSync (not fs.rmSync with { force: true }) in the
  // release closure. Inject EPERM on the lock file to simulate the Windows
  // NTFS condition where the recently-closed handle has not been fully
  // released by the OS.
  //
  // The fix's contract: EPERM must NOT be silently swallowed.
  // Either (a) the error propagates as a releaseError, or (b) some alternative
  // deletion path succeeds. Silent-swallow (no error + file still exists) is
  // the failure condition we guard against.
  let unlinkCallCount = 0;
  fs.unlinkSync = function faultInjectUnlinkSync(targetPath) {
    const isLock = path.basename(String(targetPath)) === INSTALL_MIGRATION_LOCK_NAME;
    if (isLock) {
      unlinkCallCount++;
      // Simulate Windows EPERM (file handle not fully released by OS)
      const err = Object.assign(
        new Error('EPERM: operation not permitted, unlink ' + targetPath),
        { code: 'EPERM' }
      );
      throw err;
    }
    return originalUnlinkSync.call(fs, targetPath);
  };

  // With the fix: unlinkSync throws EPERM → releaseError is thrown by the
  // release closure → runInstallerMigrations throws releaseError.
  // With the buggy code (rmSync + force:true): EPERM was swallowed silently,
  // no error thrown, lock file left on disk.
  //
  // Assert: if the call succeeds (no throw), the lock file must be gone.
  // If the call throws, the error message must reference the lock.
  let threw = false;
  let thrownError = null;
  try {
    runInstallerMigrations({
      configDir,
      migrations: [],
      lockTimeoutMs: 500,
    });
  } catch (err) {
    threw = true;
    thrownError = err;
  }

  if (threw) {
    // Acceptable: error surfaced. Verify it's lock-related (not a bug elsewhere).
    assert.match(
      thrownError.message,
      /lock/i,
      'thrown error must reference the lock file'
    );
  } else {
    // If no error was thrown, the lock file must have been removed by some
    // alternative path (not left silently on disk).
    assert.equal(
      fs.existsSync(lockPath(configDir)),
      false,
      'if unlinkSync EPERM is encountered but no error thrown, lock file must still be removed'
    );
  }

  // Sanity: the fault injection was actually triggered.
  assert.ok(unlinkCallCount > 0, 'unlinkSync must have been called for the lock file at least once');
});

// ---------------------------------------------------------------------------
// T4: Counter-test — normal single acquire/release round-trip still works
// ---------------------------------------------------------------------------
test('T4: normal (non-recursive) runInstallerMigrations acquires and releases lock correctly', (t) => {
  const configDir = createTempDir();
  t.after(() => cleanup(configDir));

  // No pre-seeded lock. Standard happy path.
  const result = runInstallerMigrations({
    configDir,
    migrations: [],
  });

  assert.ok(result, 'runInstallerMigrations must return a result');
  assert.equal(
    fs.existsSync(lockPath(configDir)),
    false,
    'lock file must be cleaned up after normal completion'
  );
});

// ---------------------------------------------------------------------------
// T5: Counter-test — unreclaimable live lock must surface a bounded error
// ---------------------------------------------------------------------------
// This test guards against over-reclamation: if the reclaim-unlink fails
// (e.g. Windows EPERM on a live open handle), the fix must NOT spin
// indefinitely — it must fall through to the timeout path and throw.
//
// Conditions forced by this test:
//   1. Lock file contains the CURRENT process.pid (triggers isSameProcess branch).
//   2. fs.unlinkSync is mocked to throw EPERM for the lock file (reclaim fails).
//   3. lockTimeoutMs: 200 — timeout must fire within a short wall-clock window.
//
// Expected outcome: throws with /installer migration lock is held/ within
// ~200ms. SUCCESS (no throw) is NOT acceptable here — that would mean the fix
// over-reclaimed a lock that it couldn't actually remove.
test('T5: unreclaimable same-PID lock throws bounded error (reclaim-unlink failure falls through to timeout)', (t) => {
  const configDir = createTempDir();
  const originalUnlinkSync = fs.unlinkSync;

  t.after(() => {
    mock.restoreAll();
    fs.unlinkSync = originalUnlinkSync;
    cleanup(configDir);
  });

  // Pre-seed lock file with the CURRENT process's PID.
  // This triggers the isSameProcess reclamation path inside acquireInstallerMigrationLock.
  writeLockFile(configDir, process.pid);

  // Mock unlinkSync to throw EPERM for the lock file only.
  // This simulates Windows NTFS refusing to delete a file with an open handle.
  // With the fix: reclaim-unlink fails → reclaimed=false → falls through to
  //   the timeout check → throws "installer migration lock is held" after ≤200ms.
  // Without the fix (original code): unlink throws but continue runs anyway →
  //   spins indefinitely, never reaches the timeout check → deadlock.
  mock.method(fs, 'unlinkSync', function faultInjectUnlinkSync(targetPath) {
    const isLock = path.basename(String(targetPath)) === INSTALL_MIGRATION_LOCK_NAME;
    if (isLock) {
      const err = Object.assign(
        new Error('EPERM: operation not permitted, unlink ' + targetPath),
        { code: 'EPERM' }
      );
      throw err;
    }
    return originalUnlinkSync.call(fs, targetPath);
  });

  assert.throws(
    () => runInstallerMigrations({
      configDir,
      migrations: [],
      lockTimeoutMs: 200,
    }),
    (err) => {
      assert.match(err.message, /installer migration lock is held/, 'error must name the held lock');
      return true;
    },
    'must throw "installer migration lock is held" when reclaim-unlink fails — not spin indefinitely'
  );
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/installer-migrations/001-legacy-orphan-files.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:installer-migrations/001-legacy-orphan-files (consolidation epic #1969 B5 #1974)", () => {
'use strict';

/**
 * Characterization tests for the 001-legacy-orphan-files installer migration.
 * Locks the migration metadata shape and plan() logic (managed-pristine and
 * managed-modified classification paths; unmanaged artifacts are skipped).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../gsd-core/bin/lib/installer-migrations/001-legacy-orphan-files.cjs');

describe('migration metadata', () => {
  test('exports a single migration object with required fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(migration.id, '2026-05-11-legacy-orphan-files');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(migration.introducedIn, '1.50.0');
    assert.ok(Array.isArray(migration.scopes));
    assert.ok(migration.scopes.includes('global'));
    assert.ok(migration.scopes.includes('local'));
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });
});

describe('migration.plan()', () => {
  function makeClassifier(classification) {
    return { classifyArtifact: () => ({ classification }) };
  }

  test('returns remove-managed action for managed-pristine artifact', () => {
    const actions = migration.plan(makeClassifier('managed-pristine'));
    assert.equal(actions.length, 2); // two files in LEGACY_ORPHAN_FILES
    for (const action of actions) {
      assert.equal(action.type, 'remove-managed');
      assert.equal(typeof action.relPath, 'string');
      assert.equal(typeof action.reason, 'string');
      assert.equal(typeof action.ownershipEvidence, 'string');
    }
  });

  test('returns backup-and-remove action for managed-modified artifact', () => {
    const actions = migration.plan(makeClassifier('managed-modified'));
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.equal(action.type, 'backup-and-remove');
    }
  });

  test('returns no actions for unmanaged artifact', () => {
    const actions = migration.plan(makeClassifier('unmanaged'));
    assert.deepStrictEqual(actions, []);
  });

  test('relPaths match the two legacy orphan hook files', () => {
    const actions = migration.plan(makeClassifier('managed-pristine'));
    const relPaths = actions.map((a) => a.relPath).sort();
    assert.deepStrictEqual(relPaths, [
      'hooks/gsd-notify.sh',
      'hooks/statusline.js',
    ]);
  });

  test('plan handles mixed classifications per file', () => {
    let callCount = 0;
    const ctx = {
      classifyArtifact: (_relPath) => {
        callCount++;
        // first call: managed-pristine; second call: unmanaged
        return { classification: callCount === 1 ? 'managed-pristine' : 'unmanaged' };
      },
    };
    const actions = migration.plan(ctx);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'remove-managed');
  });
});
  });
}

// ---------------------------------------------------------------------------
// Symlinked managed path: backup must never dereference (#2470 security review)
// ---------------------------------------------------------------------------
//
// `fs.copyFileSync` follows symlinks. Before this hardening, a managed path
// replaced by a link would have had the LINK TARGET's bytes copied into the
// journal's backup tree — e.g. a `gsd.cjs` symlinked at a private key would
// land that key's contents under gsd-migration-journal/. Nothing GSD installs
// is ever a symlink, so the faithful snapshot is the link itself.

{
  const { describe, test } = require('node:test');
  describe('symlinked managed path is snapshotted as a link, never dereferenced', () => {
  const piExtensionMigration = require('../gsd-core/bin/lib/installer-migrations/006-pi-extension-cjs-to-js.cjs');
  const SECRET = 'TOP-SECRET-PRIVATE-KEY-MATERIAL\n';

  test('backup-and-remove on a symlinked managed file copies the link, not the referent', (t) => {
    const configDir = createTempInstall();
    const secretDir = createTempInstall();
    try {
      const secretPath = path.join(secretDir, 'id_rsa');
      fs.writeFileSync(secretPath, SECRET, 'utf8');

      const linkPath = path.join(configDir, 'extensions', 'gsd.cjs');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.symlinkSync(secretPath, linkPath);
      } catch {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }

      // Manifest records the path as managed with a hash that cannot match the
      // referent -> classification 'managed-modified' -> backup-and-remove.
      writeManifest(configDir, { 'extensions/gsd.cjs': sha256('the original extension\n') });

      const result = runInstallerMigrations({
        configDir,
        runtime: 'pi',
        scope: 'global',
        migrations: [piExtensionMigration],
        now: () => '2026-07-20T00:00:00.000Z',
      });

      const backupAction = result.plan.actions.find((a) => a.type === 'backup-and-remove');
      assert.ok(backupAction, 'expected a backup-and-remove action for the modified managed file');

      // The referent is untouched and still holds its content.
      assert.ok(fs.existsSync(secretPath), 'symlink target must survive');
      assert.equal(fs.readFileSync(secretPath, 'utf8'), SECRET, 'symlink target content must be unchanged');

      // The link itself is gone from the install tree.
      assert.equal(
        fs.lstatSync(linkPath, { throwIfNoEntry: false }),
        undefined,
        'the symlink at the managed path must be removed',
      );

      // Nothing anywhere under configDir may contain the referent's bytes.
      const leaked = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue; // a link is fine; its content is not copied
          if (entry.isDirectory()) { walk(full); continue; }
          let body;
          try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (body.includes('TOP-SECRET')) leaked.push(path.relative(configDir, full));
        }
      };
      walk(configDir);
      assert.deepEqual(leaked, [], `symlink referent content leaked into: ${leaked.join(', ')}`);
    } finally {
      cleanup(configDir);
      cleanup(secretDir);
    }
  });

  test('a regular managed file is still backed up by content (no behavior change)', (t) => {
    const configDir = createTempInstall();
    t.after(() => cleanup(configDir));

    writeFile(configDir, 'extensions/gsd.cjs', 'locally patched extension\n');
    writeManifest(configDir, { 'extensions/gsd.cjs': sha256('the original extension\n') });

    const result = runInstallerMigrations({
      configDir,
      runtime: 'pi',
      scope: 'global',
      migrations: [piExtensionMigration],
      now: () => '2026-07-20T00:00:00.000Z',
    });

    const backupAction = result.plan.actions.find((a) => a.type === 'backup-and-remove');
    assert.ok(backupAction, 'expected backup-and-remove for the locally patched file');

    // The PLAN carries backupRelPath: null — the concrete backup location is
    // chosen during apply and recorded in the journal, so read it from there.
    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    const journalled = journal.actions.find((a) => a.backupRelPath);
    assert.ok(journalled, 'apply must record the backup path in the journal for the user');
    const backupPath = path.join(configDir, journalled.backupRelPath);
    assert.equal(
      fs.readFileSync(backupPath, 'utf8'),
      'locally patched extension\n',
      'a real file must still be backed up by content so the user can recover it',
    );
    assert.ok(!fs.existsSync(path.join(configDir, 'extensions', 'gsd.cjs')));
  });

  // In-flight failure recovery: when a later step of the SAME apply() attempt
  // throws, the catch block replays the rollback snapshots it already took.
  // Those snapshots are themselves symlinks, so a raw copy there dereferences
  // and writes the referent's bytes back to the LIVE install path — worse than
  // the journal-tree leak, because it is user-visible at a predictable path.
  //
  // The failure is injected by monkeypatching fs.rmSync (restored in finally)
  // rather than by chmod/permission tricks: deterministic, root- and
  // OS-independent. The delete of the managed path is allowed to SUCCEED and
  // then throws once, modelling a later step failing after the delete. That
  // ordering is load-bearing: if the live path still existed, the pre-fix
  // copyFileSync would hit a same-file collision and throw instead of leaking,
  // and this test would pass against the very bug it exists to catch.
  test('apply failure after a symlinked snapshot does not leak the referent into the live tree', (t) => {
    const configDir = createTempInstall();
    const secretDir = createTempInstall();
    const realRmSync = fs.rmSync;
    try {
      const secretPath = path.join(secretDir, 'id_rsa');
      fs.writeFileSync(secretPath, SECRET, 'utf8');

      const linkPath = path.join(configDir, 'extensions', 'gsd.cjs');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.symlinkSync(secretPath, linkPath);
      } catch {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      writeManifest(configDir, { 'extensions/gsd.cjs': sha256('the original extension\n') });

      let fired = false;
      fs.rmSync = function patched(target, options) {
        const result = realRmSync.call(fs, target, options);
        if (!fired && path.resolve(String(target)) === path.resolve(linkPath)) {
          fired = true;
          throw new Error('injected post-delete failure');
        }
        return result;
      };

      assert.throws(() => runInstallerMigrations({
        configDir,
        runtime: 'pi',
        scope: 'global',
        migrations: [piExtensionMigration],
        now: () => '2026-07-20T00:00:00.000Z',
      }), /injected post-delete failure/, 'the injected failure must propagate, not be swallowed');

      fs.rmSync = realRmSync;

      // The referent is untouched...
      assert.ok(fs.existsSync(secretPath));
      assert.equal(fs.readFileSync(secretPath, 'utf8'), SECRET);

      // ...the managed path is restored as a LINK, not a dereferenced copy...
      const restored = fs.lstatSync(linkPath, { throwIfNoEntry: false });
      assert.ok(restored, 'failure recovery must restore the managed path');
      assert.ok(
        restored.isSymbolicLink(),
        'restored path must be a symlink — a regular file here means the referent was dereferenced into the live tree',
      );

      // ...and its bytes appear nowhere under the install tree.
      const leaked = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { walk(full); continue; }
          let body;
          try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (body.includes('TOP-SECRET')) leaked.push(path.relative(configDir, full));
        }
      };
      walk(configDir);
      assert.deepEqual(leaked, [], `referent content leaked into: ${leaked.join(', ')}`);
    } finally {
      fs.rmSync = realRmSync;
      cleanup(configDir);
      cleanup(secretDir);
    }
  });

  test('rollback() restores a symlinked managed path as a link, not a dereferenced copy', (t) => {
    const configDir = createTempInstall();
    const secretDir = createTempInstall();
    try {
      const targetPath = path.join(secretDir, 'id_rsa');
      fs.writeFileSync(targetPath, SECRET, 'utf8');

      const linkPath = path.join(configDir, 'extensions', 'gsd.cjs');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.symlinkSync(targetPath, linkPath);
      } catch {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      writeManifest(configDir, { 'extensions/gsd.cjs': sha256('the original extension\n') });

      const result = runInstallerMigrations({
        configDir,
        runtime: 'pi',
        scope: 'global',
        migrations: [piExtensionMigration],
        now: () => '2026-07-20T00:00:00.000Z',
      });
      assert.equal(fs.lstatSync(linkPath, { throwIfNoEntry: false }), undefined, 'link removed by apply');

      result.rollback();

      const restored = fs.lstatSync(linkPath, { throwIfNoEntry: false });
      assert.ok(restored, 'rollback must restore the managed path');
      assert.ok(restored.isSymbolicLink(), 'restored path must be a symlink, not a dereferenced copy');
      assert.equal(fs.readlinkSync(linkPath), targetPath, 'restored link must point at the original target');
      assert.equal(fs.readFileSync(targetPath, 'utf8'), SECRET, 'target content must be untouched throughout');
    } finally {
      cleanup(configDir);
      cleanup(secretDir);
    }
  });
});
}
