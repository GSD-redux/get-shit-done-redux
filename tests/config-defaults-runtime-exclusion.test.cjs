// allow-test-rule: source-text-is-the-product (see #2840)
// ~/.gsd/defaults.json is machine-wide. The `runtime` key is host-specific
// (written by whichever installer ran last). It must NOT be copied into project
// configs — on a machine with 2+ runtimes, it poisons every new project.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

describe('#2840 — runtime from defaults.json must not poison project config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('cfg-runtime-');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('runtime key in defaults.json is NOT copied into the new project config', () => {
    // Create ~/.gsd/defaults.json with a runtime key + a legitimate key
    fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'defaults.json'),
      JSON.stringify({ runtime: 'codex', model_profile: 'opus' }),
    );

    const result = runGsdTools('config-ensure-section', tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    // runtime must NOT be in the project config — it's host-specific.
    assert.ok(
      !('runtime' in config),
      `runtime must not be copied from defaults.json into the project config; got: ${JSON.stringify({ runtime: config.runtime })}`,
    );
    // Other defaults must still be copied.
    assert.strictEqual(
      config.model_profile,
      'opus',
      'legitimate defaults (model_profile) must still be copied from defaults.json',
    );
  });

  test('defaults.json without a runtime key works normally', () => {
    fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'defaults.json'),
      JSON.stringify({ model_profile: 'haiku' }),
    );

    const result = runGsdTools('config-ensure-section', tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    assert.strictEqual(config.model_profile, 'haiku');
    assert.ok(!('runtime' in config), 'runtime should not appear when defaults.json lacks it');
  });
});
