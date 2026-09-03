'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.throws(() => finishInstall(null, null, null, false, 'cline', false, root, {
      configuredEntrypoints: [{ runtime: 'cline', configPath: path.join(root, 'config'), scriptPath: path.join(root, 'missing.js') }],
    }), /Configured entrypoint validation failed/);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some(line => line.includes('Done!')), false);
});

test('configured entrypoint validation aggregates file and interpreter failures without execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
