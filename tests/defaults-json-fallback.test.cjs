/**
 * GSD Tools Tests — ~/.gsd/defaults.json fallback (#1683)
 *
 * When .planning/ does not exist (pre-project context), loadConfig() should
 * consult ~/.gsd/defaults.json before returning hardcoded defaults.
 * When .planning/ exists but config.json is missing, hardcoded defaults are used.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

/** Create a bare temp dir (no .planning/) to simulate pre-project context */
function createBareTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-'));
}

describe('loadConfig ~/.gsd/defaults.json fallback (#1683)', () => {
  test('pre-project, no defaults.json → hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();
    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
    assert.strictEqual(config.research, true);
    assert.strictEqual(config.subagent_timeout, 300000);
  });

  test('pre-project, defaults.json exists → merges with hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();

    // Create ~/.gsd/defaults.json under fake GSD_HOME
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    // Values from defaults.json
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.context_window, 1000000);
    // Hardcoded defaults for keys not in defaults.json
    assert.strictEqual(config.research, true);
    assert.strictEqual(config.subagent_timeout, 300000);
    assert.strictEqual(config.parallelization, true);
  });

  test('.planning/ exists but no config.json → hardcoded defaults (not defaults.json)', (t) => {
    const tmpDir = createBareTmpDir();
    // Create .planning/ without config.json
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });

    // Create defaults.json — should NOT be consulted
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    // Hardcoded defaults — NOT defaults.json values
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
  });

  test('project config exists → project config wins', (t) => {
    const tmpDir = createBareTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'budget' })
    );

    // Also write defaults.json with a different value
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'budget');
    // #4071: a key only the global file sets is preserved from it — the
    // project config wins on COLLISION, not by existing. This line pinned the
    // old wholesale drop (builtin 200000) as intended behavior; it was not.
    assert.strictEqual(config.context_window, 1000000);
  });

  test('defaults.json with unknown keys → unknown keys NOT passed through', (t) => {
    const tmpDir = createBareTmpDir();

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({
        model_profile: 'quality',
        unknown_key: 'should_not_appear',
        another_unknown: 42,
      })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.unknown_key, undefined);
    assert.strictEqual(config.another_unknown, undefined);
  });

  test('defaults.json with invalid JSON → returns hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), '{ not valid json !!!');

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
  });

  // ─── #2069: global-defaults must forward model_policy / model_profile_overrides / runtime ─
  // The _globalBaseCfg whitelist in Branch D of loadConfigResolved previously omitted these
  // three keys, so they were silently dropped from ~/.gsd/defaults.json while the identical
  // keys in a project's .planning/config.json were honored. The tests below are fail-first:
  // each asserts the global path forwards its key, mirroring the project-config parity test.

  test('#2069 defaults.json model_policy → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const policy = { provider: 'anthropic', budget: 'high' };

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_policy: policy })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.deepStrictEqual(config.model_policy, policy);
  });

  test('#2069 defaults.json model_profile_overrides → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const overrides = { claude: { planner: { model: 'claude-opus-4-5' } } };

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile_overrides: overrides })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.deepStrictEqual(config.model_profile_overrides, overrides);
  });

  test('#2069 defaults.json runtime → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const runtime = 'codex';

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ runtime })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.runtime, runtime);
  });

  test('#2069 defaults.json parity: model_policy / model_profile_overrides / runtime survive identically to project-config path', (t) => {
    // Identical values in ~/.gsd/defaults.json (no .planning/) vs .planning/config.json (no defaults.json)
    // must produce identical config.<key> for each of the three previously-dropped keys. A future
    // regression breaking shape-parity for just one key — e.g. changing the project path to
    // `parsed['runtime'] ?? null` — would slip a single-key test, so all three are asserted here.
    const policy = { provider: 'anthropic', budget: 'low' };
    const overrides = { claude: { planner: { model: 'claude-opus-4-5' } } };
    const runtime = 'codex';

    // Global path: ~/.gsd/defaults.json only, no .planning/
    const globalDir = createBareTmpDir();
    const globalGsdDir = path.join(globalDir, '.gsd');
    fs.mkdirSync(globalGsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalGsdDir, 'defaults.json'),
      JSON.stringify({ model_policy: policy, model_profile_overrides: overrides, runtime })
    );

    process.env.GSD_HOME = globalDir;
    const globalConfig = loadConfig(globalDir);
    delete process.env.GSD_HOME;
    t.after(() => { cleanup(globalDir); });

    // Project path: .planning/config.json only, no defaults.json
    const projectDir = createBareTmpDir();
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ model_policy: policy, model_profile_overrides: overrides, runtime })
    );

    // GSD_HOME pointing somewhere with no defaults.json so the project path is the sole source.
    const emptyHome = createBareTmpDir();
    process.env.GSD_HOME = emptyHome;
    const projectConfig = loadConfig(projectDir);
    delete process.env.GSD_HOME;
    t.after(() => { cleanup(projectDir); cleanup(emptyHome); });

    assert.deepStrictEqual(globalConfig.model_policy, projectConfig.model_policy);
    assert.deepStrictEqual(globalConfig.model_profile_overrides, projectConfig.model_profile_overrides);
    assert.strictEqual(globalConfig.runtime, projectConfig.runtime);
  });
});
