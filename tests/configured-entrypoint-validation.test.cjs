'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helpers = require('./helpers.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { install, finishInstall } = require('../bin/install.js');

test('configured entrypoint validation exposes an aggregate typed boundary', () => {
  assert.equal(
    typeof hooksSurface.validateConfiguredEntrypoints,
    'function',
    'the Runtime Hooks Surface must export configured-entrypoint validation',
  );
});

test('finishInstall rejects an invalid configured entrypoint before Done output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-finish-'));
  t.after(() => helpers.cleanup(root));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  // #2665/#4249: finishInstall asserts configured entrypoints before any of its
  // own writes now, but still sandbox HOME (+ USERPROFILE for os.homedir() on
  // Windows) and config-location env defensively, so a future reordering that
  // reintroduces a pre-assertion write can never redirect it to a live config dir.
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const restoreConfigLocationEnv = helpers.scrubConfigLocationEnv();
  try {
    assert.throws(() => finishInstall(null, null, null, false, 'cline', false, root, {
      configuredEntrypoints: [{ runtime: 'cline', configPath: path.join(root, 'config'), scriptPath: path.join(root, 'missing.js') }],
    }), /Configured entrypoint validation failed/);
  } finally {
    console.log = originalLog;
    restoreConfigLocationEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
  assert.equal(logs.some(line => line.includes('Done!')), false);
});

test('a hook already registered under a stale command is still tracked for validation on re-install (#4154 Blocker)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-stale-'));
  t.after(() => helpers.cleanup(root));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const restoreConfigLocationEnv = helpers.scrubConfigLocationEnv();
  try {
    const first = install(true, 'claude');
    assert.ok(first.settingsPath, 'a fresh global install must produce a settings path');
    finishInstall(first.settingsPath, first.settings, first.statuslineCommand, false, 'claude', true, first.configDir, {
      configuredEntrypoints: first.configuredEntrypoints,
    });

    // Simulate an entry registered by an older installer under a DIFFERENT
    // node install (e.g. an nvm switch, #4087/#4098/#4137): same real
    // scriptPath under <configDir>/hooks/ (that never changes across
    // installer versions) and still shaped as the modern runtime-resolving
    // chain (rewriteLegacyManagedNodeHookCommands deliberately never touches
    // an already-current-format entry — #3662), but baked with a node path
    // this install would never produce. `hasGsdUpdateHook` still finds it and
    // applySettingsJsonHooks takes its register-only-if-absent branch on the
    // next install (never rewriting it).
    const onDisk = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8'));
    const staleEntry = (onDisk.hooks.SessionStart || []).find(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-check-update.js'))
    );
    assert.ok(staleEntry, 'a fresh install must register the check-update hook');
    const staleCommand = hooksSurface.buildHookCommand(first.configDir, 'gsd-check-update.js', {
      execPath: '/old/nvm/pinned/node',
      platform: process.platform,
      runtime: 'claude',
    });
    for (const h of staleEntry.hooks) {
      if (h.command && h.command.includes('gsd-check-update.js')) {
        h.command = staleCommand;
      }
    }
    fs.writeFileSync(first.settingsPath, JSON.stringify(onDisk, null, 2));

    const second = install(true, 'claude');
    const trackedNames = (second.configuredEntrypoints || []).map(entry => path.basename(entry.scriptPath));
    assert.ok(
      trackedNames.includes('gsd-check-update.js'),
      `a hook already registered under a stale command must still be tracked for validation, got: ${trackedNames.join(', ')}`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    restoreConfigLocationEnv();
  }
});

test('configured entrypoint validation aggregates file and interpreter failures without execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-'));
  t.after(() => helpers.cleanup(root));
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);

  const unreadablePath = path.join(root, 'unreadable.js');
  const notExecutablePath = path.join(root, 'not-executable.js');

  const result = hooksSurface.validateConfiguredEntrypoints([
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: path.join(root, 'missing.js') },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: directory },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: __filename, interpreterCandidates: ['missing-node'] },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: unreadablePath },
    // #4249: no interpreterCandidates means this entry is invoked directly via
    // its own shebang (e.g. Cline's PreToolUse hook) — must itself be +x.
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: notExecutablePath },
  ], {
    resolveExecutableBinary: () => null,
    statSync: (p) => {
      if (p === unreadablePath) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.statSync(p === notExecutablePath ? __filename : p);
    },
    accessSync: (p, mode) => {
      if (p === notExecutablePath) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.accessSync(p, mode);
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'missing'],
    ['script', 'wrong-file-type'],
    ['interpreter', 'unresolved-interpreter'],
    ['script', 'unreadable'],
    ['script', 'not-executable'],
  ]);
});


test('runtime config writers expose the exact configured entrypoints they emit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-writers-'));
  t.after(() => helpers.cleanup(root));
  const sourceRoot = path.join(__dirname, '..');

  const codexRoot = path.join(root, 'codex');
  // On win32, ensureCodexHooksJsonSessionStart writes a .cmd shim under
  // <codexRoot>/hooks/; the real installer only calls this once that dir
  // (and gsd-check-update.js) already exist, so create it here too.
  fs.mkdirSync(path.join(codexRoot, 'hooks'), { recursive: true });
  const codex = hooksSurface.ensureCodexHooksJsonSessionStart(codexRoot, {
    absoluteRunner: JSON.stringify(process.execPath),
  });
  // win32 emits two entries (the .cmd shim plus the underlying script);
  // every other platform emits the script alone — assert the shape common
  // to both rather than a platform-fixed array.
  assert.ok(codex.configuredEntrypoints.length >= 1);
  assert.ok(codex.configuredEntrypoints.every(entry => entry.runtime === 'codex'
    && entry.configPath === path.join(codexRoot, 'hooks.json')
    && entry.platform === process.platform));
  assert.ok(codex.configuredEntrypoints.some(
    entry => path.basename(entry.scriptPath) === 'gsd-check-update.js'
      && Array.isArray(entry.interpreterCandidates)
      && entry.interpreterCandidates.length === 1,
  ));

  const cursorRoot = path.join(root, 'cursor');
  const cursor = hooksSurface.writeCursorHooksJson(cursorRoot, sourceRoot, {
    managedHookEvents: ['sessionStart'],
  });
  assert.deepEqual(
    cursor.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)),
    ['gsd-cursor-session-start.js'],
  );
  assert.ok(cursor.configuredEntrypoints.every(entry => entry.configPath === cursor.hooksJsonPath));

  const windsurfRoot = path.join(root, 'windsurf');
  const windsurf = hooksSurface.writeWindsurfHooksJson(windsurfRoot, sourceRoot);
  assert.deepEqual(
    windsurf.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)).sort(),
    ['gsd-windsurf-pre-command.js', 'gsd-windsurf-pre-write.js'],
  );

  const kimiRoot = path.join(root, 'kimi');
  fs.cpSync(path.join(sourceRoot, 'hooks'), path.join(kimiRoot, 'hooks'), { recursive: true });
  const kimiConfig = path.join(root, 'kimi-config.toml');
  const kimi = hooksSurface.writeKimiHooksToml(kimiConfig, kimiRoot, {
    hookOpts: { runtime: 'kimi' },
  });
  assert.equal(kimi.configuredEntrypoints.length, kimi.entryCount);
  assert.ok(kimi.configuredEntrypoints.every(entry => entry.configPath === kimiConfig));

  const clineRoot = path.join(root, 'cline');
  const cline = hooksSurface.writeClineArtifacts(clineRoot, false);
  assert.deepEqual(
    cline.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)),
    ['PreToolUse'],
  );
  // #4249: Cline's hook self-executes via shebang — no interpreterCandidates
  // to check, so validateConfiguredEntrypoints must check its execute bit.
  assert.ok(!('interpreterCandidates' in cline.configuredEntrypoints[0]));

  const portable = [];
  assert.ok(hooksSurface.buildHookCommand(root, 'gsd-context-monitor.js', {
    runtime: 'claude',
    portableHooks: true,
    configPath: path.join(root, 'settings.json'),
    configuredEntrypoints: portable,
  }));
  assert.deepEqual(
    portable.map(entry => path.basename(entry.scriptPath)),
    ['gsd-node-runner.sh', 'gsd-context-monitor.js'],
  );
});
