'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helpers = require('./helpers.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { finishInstall } = require('../bin/install.js');

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
  // #2665: finishInstall calls writeNonClaudeDefaults(runtime) in-process before
  // the entrypoint assertion throws; sandbox HOME (+ USERPROFILE for os.homedir()
  // on Windows) and config-location env so that an ambient CLAUDE_CONFIG_DIR/etc
  // cannot redirect the write to a live config dir.
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

test('configured entrypoint validation aggregates file and interpreter failures without execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-'));
  t.after(() => helpers.cleanup(root));
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);

  const result = hooksSurface.validateConfiguredEntrypoints([
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: path.join(root, 'missing.js') },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: directory },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: __filename, interpreterCandidates: ['missing-node'] },
  ], {
    resolveExecutableBinary: () => null,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'missing'],
    ['script', 'wrong-file-type'],
    ['interpreter', 'unresolved-interpreter'],
  ]);
});


test('runtime config writers expose the exact configured entrypoints they emit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-writers-'));
  t.after(() => helpers.cleanup(root));
  const sourceRoot = path.join(__dirname, '..');

  const codexRoot = path.join(root, 'codex');
  fs.mkdirSync(codexRoot, { recursive: true });
  const codex = hooksSurface.ensureCodexHooksJsonSessionStart(codexRoot, {
    absoluteRunner: JSON.stringify(process.execPath),
  });
  assert.deepEqual(codex.configuredEntrypoints, [{
    runtime: 'codex',
    configPath: path.join(codexRoot, 'hooks.json'),
    scriptPath: path.join(codexRoot, 'hooks', 'gsd-check-update.js'),
    interpreterCandidates: [process.execPath],
    platform: process.platform,
  }]);

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
