'use strict';

/**
 * Tests for config-loader.cjs (ADR-857 phase 2e / #885).
 *
 * Covers:
 *   - loadConfig defaults when no config.json file exists
 *   - loadConfig merges file values over defaults
 *   - legacy-key normalization (branching_strategy → git.branching_strategy)
 *   - workstream overlay (root → workstream inheritance)
 *   - workstream-null fallback when workstream config is absent
 *   - unknown-key warning dedup (_warnedUnknownConfigKeys deduplications)
 *   - malformed JSON handling (falls back to defaults)
 *   - shim identity: core.loadConfig === configLoader.loadConfig
 *   - ADVERSARIAL fixtures: empty JSON, unknown keys, dynamic-prefix keys
 *     like agent_skills.__proto__, scalars-where-objects-expected,
 *     missing config file
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const fc = require('fast-check');

// ─── module under test ────────────────────────────────────────────────────────

const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');

const { loadConfig, loadConfigResolved, _resetRuntimeWarningCacheForTests, _deepMergeConfig } = configLoader;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(prefix = 'gsd-cfg-loader-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function writeWorkstreamConfig(tmpDir, wsName, obj) {
  const wsDir = path.join(tmpDir, '.planning', 'workstreams', wsName);
  fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify(obj, null, 2), 'utf-8');
}


// ─── defaults when no config.json ────────────────────────────────────────────

describe('loadConfig — defaults when no config.json', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('returns an object with expected default keys when config.json is absent', () => {
    const config = loadConfig(tmpDir);
    // Structural checks — should have canonical keys from CONFIG_DEFAULTS
    assert.ok('model_profile' in config, 'must have model_profile');
    assert.ok('commit_docs' in config, 'must have commit_docs');
    assert.ok('research' in config, 'must have research');
    assert.ok('branching_strategy' in config, 'must have branching_strategy');
    assert.ok('plan_checker' in config, 'must have plan_checker');
    assert.ok('verifier' in config, 'must have verifier');
    assert.ok('parallelization' in config, 'must have parallelization');
    assert.ok('sub_repos' in config, 'must have sub_repos');
    assert.ok('resolve_model_ids' in config, 'must have resolve_model_ids');
  });

  test('model_profile default is "balanced"', () => {
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'balanced');
  });

  test('config.json present with empty object: agent_skills default is an empty object', () => {
    // agent_skills only appears in the return when a config.json is successfully parsed
    writeConfig(tmpDir, {});
    const config = loadConfig(tmpDir);
    assert.deepEqual(config.agent_skills, {});
  });

  test('config.json present with empty object: model_overrides default is null', () => {
    // model_overrides only appears in the return when a config.json is successfully parsed
    writeConfig(tmpDir, {});
    const config = loadConfig(tmpDir);
    assert.equal(config.model_overrides, null);
  });
});

// ─── file values merge over defaults ─────────────────────────────────────────

describe('loadConfig — file values override defaults', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('model_profile from config.json overrides the default', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'quality');
  });

  test('workflow.research from nested config is returned', () => {
    writeConfig(tmpDir, { workflow: { research: 'deep' } });
    const config = loadConfig(tmpDir);
    assert.equal(config.research, 'deep');
  });

  test('top-level research is returned', () => {
    writeConfig(tmpDir, { research: 'minimal' });
    const config = loadConfig(tmpDir);
    assert.equal(config.research, 'minimal');
  });

  test('mode from config.json is returned', () => {
    writeConfig(tmpDir, { mode: 'autonomous' });
    const config = loadConfig(tmpDir);
    assert.equal(config.mode, 'autonomous');
  });

  test('model_overrides from config.json is returned', () => {
    writeConfig(tmpDir, { model_overrides: { planner: 'claude-opus-4-5' } });
    const config = loadConfig(tmpDir);
    assert.deepEqual(config.model_overrides, { planner: 'claude-opus-4-5' });
  });
});

// ─── legacy-key normalization ─────────────────────────────────────────────────

describe('loadConfig — legacy-key normalization', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('top-level branching_strategy is migrated to git.branching_strategy', () => {
    writeConfig(tmpDir, { branching_strategy: 'milestone' });
    const config = loadConfig(tmpDir);
    assert.equal(config.branching_strategy, 'milestone');
  });

  test('on-disk file has branching_strategy moved under git.* after migration', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ branching_strategy: 'phase' }, null, 2), 'utf-8');
    loadConfig(tmpDir);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(onDisk.git?.branching_strategy, 'phase');
    assert.equal(onDisk.branching_strategy, undefined);
  });
});

// ─── workstream overlay ───────────────────────────────────────────────────────

describe('loadConfig — workstream overlay', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('workstream config overrides root config', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeWorkstreamConfig(tmpDir, 'ws-a', { model_profile: 'quality' });
    const config = loadConfig(tmpDir, { workstream: 'ws-a' });
    assert.equal(config.model_profile, 'quality');
  });

  test('root-only keys are inherited by workstream config', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', research: 'deep' });
    writeWorkstreamConfig(tmpDir, 'ws-b', { mode: 'autonomous' });
    const config = loadConfig(tmpDir, { workstream: 'ws-b' });
    // Root's research should still be visible (inherited)
    assert.equal(config.research, 'deep');
    // Workstream's mode should override
    assert.equal(config.mode, 'autonomous');
  });

  test('workstream-null fallback: root config used when workstream has no config.json', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    // Create workstream directory but no config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-config');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    // loadConfig with missing workstream config.json should fall back to root
    const config = loadConfig(tmpDir, { workstream: 'ws-no-config' });
    assert.equal(config.model_profile, 'budget');
  });
});

// ─── unknown-key warning dedup ────────────────────────────────────────────────

describe('loadConfig — unknown-key warning dedup', () => {
  let tmpDir;
  let originalStderrWrite;
  let stderrLines;

  beforeEach(() => {
    tmpDir = makeTempProject();
    stderrLines = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrLines.push(String(chunk));
      return true;
    };
    // Reset the module-level dedup set so each test starts clean
    if (_resetRuntimeWarningCacheForTests) _resetRuntimeWarningCacheForTests();
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('unknown key produces a warning mentioning the key name', () => {
    writeConfig(tmpDir, { __gsd_unknown_sentinel__: true });
    loadConfig(tmpDir);
    const warnings = stderrLines.filter(l => l.includes('__gsd_unknown_sentinel__'));
    assert.ok(warnings.length >= 1, 'should warn about unknown key');
  });

  test('calling loadConfig twice does not double-emit the same unknown-key warning', () => {
    writeConfig(tmpDir, { __gsd_dedup_test__: true });
    loadConfig(tmpDir);
    loadConfig(tmpDir);
    const warnings = stderrLines.filter(l => l.includes('__gsd_dedup_test__'));
    // Should appear at most once
    assert.ok(warnings.length <= 1, `warning emitted more than once: ${warnings.length} times`);
  });

  // #2674: the two cases above only pass because each picks a key name no other
  // case reuses — so neither can observe whether the documented reset actually
  // runs. _resetRuntimeWarningCacheForTests is documented as resetting
  // "per-process warning state", and this suite's beforeEach calls it expecting
  // exactly that, but it cleared only _warnedConfigKeys and left
  // _warnedUnknownConfigKeys populated. Any later case that reused a key would
  // have its warning silently suppressed by the previous case's leaked state.
  // Asserts on the exported Set rather than stderr prose (CONTRIBUTING.md —
  // Prohibited: Raw Text Matching on Test Outputs).
  test('_resetRuntimeWarningCacheForTests clears the unknown-key dedup set', () => {
    writeConfig(tmpDir, { __gsd_reset_probe__: true });
    loadConfig(tmpDir);
    assert.ok(
      configLoader._warnedUnknownConfigKeys.size > 0,
      'precondition: loading an unknown key must populate the unknown-key dedup set',
    );

    configLoader._resetRuntimeWarningCacheForTests();

    assert.equal(
      configLoader._warnedUnknownConfigKeys.size,
      0,
      'the documented per-process warning-state reset must clear the unknown-key dedup set too',
    );
  });
});

// ─── malformed JSON handling ──────────────────────────────────────────────────

describe('loadConfig — malformed JSON', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('malformed config.json returns defaults without throwing', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '{ invalid json !!', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config === 'object' && config !== null, 'should return an object');
    assert.ok('model_profile' in config, 'should have model_profile key');
  });

  test('empty config.json (empty braces) does not throw and returns defaults', () => {
    writeConfig(tmpDir, {});
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.equal(config.model_profile, 'balanced');
  });
});

// ─── ADVERSARIAL fixtures ─────────────────────────────────────────────────────

describe('loadConfig — adversarial fixtures', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('agent_skills.__proto__ key in config does not pollute Object prototype', () => {
    // Write config with a prototype-pollution candidate key
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    // JSON.stringify won't serialize __proto__ as an own property;
    // write the raw string to simulate an adversarial file.
    fs.writeFileSync(
      configPath,
      '{"agent_skills": {"__proto__": {"polluted": true}}}',
      'utf-8'
    );
    const before = ({}).polluted;
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    const after = ({}).polluted;
    assert.equal(before, after, 'Object prototype must not be polluted');
    // agent_skills should be the parsed value or an empty object — not throw
    assert.ok(typeof config.agent_skills === 'object', 'agent_skills should be an object');
  });

  test('scalars-where-objects-expected: workflow is a string', () => {
    writeConfig(tmpDir, { workflow: 'invalid' });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config === 'object', 'should return an object');
  });

  test('completely empty JSON file (just whitespace) falls back to defaults', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '   ', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok('model_profile' in config);
  });

  test('null JSON value (top-level null) falls back to defaults', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, 'null', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok('model_profile' in config);
  });

  test('deeply nested unknown keys do not throw', () => {
    writeConfig(tmpDir, {
      workflow: {
        research: 'minimal',
        __unknown_nested__: { a: 1, b: { c: 2 } },
      },
    });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.equal(config.research, 'minimal');
  });

  test('dynamic-prefix key agent_skills.* with unusual value type does not throw', () => {
    writeConfig(tmpDir, { agent_skills: { 'my-skill': null } });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config.agent_skills === 'object');
  });

  test('config with only unknown keys returns defaults for known keys', () => {
    writeConfig(tmpDir, { completly_unknown_a: 1, completly_unknown_b: 2 });
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'balanced');
  });
});

// ─── loadConfigResolved — provenance ──────────────────────────────────────────

describe('loadConfigResolved — provenance', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('source is "root" when config.json exists and no workstream requested', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const result = loadConfigResolved(tmpDir);
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, false);
    assert.ok(typeof result.config === 'object', 'config must be an object');
    assert.equal(result.config.model_profile, 'quality');
  });

  test('source is "workstream", degraded:false when workstream config.json present', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeWorkstreamConfig(tmpDir, 'ws-a', { model_profile: 'quality' });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-a' });
    assert.equal(result.source, 'workstream');
    assert.equal(result.degraded, false);
    assert.equal(result.config.model_profile, 'quality');
  });

  test('source is "root", degraded:true when workstream requested but ws config.json absent', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    // Create ws directory without config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-config');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-no-config' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'budget');
  });

  test('source is "builtin-defaults" when .planning exists but config.json is absent', () => {
    // tmpDir already has .planning/ but no config.json
    const result = loadConfigResolved(tmpDir);
    assert.equal(result.source, 'builtin-defaults');
    assert.equal(result.degraded, false);
    assert.ok('model_profile' in result.config);
  });

  test('source is "global-defaults" when no .planning exists but ~/.gsd/defaults.json readable', () => {
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-test-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      const gsdDir = path.join(homeTmp, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ model_profile: 'home-defaults' }), 'utf-8');
      process.env['GSD_HOME'] = homeTmp;
      const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-noplanning-'));
      try {
        const result = loadConfigResolved(noPlanning);
        assert.equal(result.source, 'global-defaults');
        assert.equal(result.degraded, false);
        assert.equal(result.config.model_profile, 'home-defaults');
      } finally {
        cleanup(noPlanning);
      }
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(homeTmp);
    }
  });

  test('source is "builtin-defaults" when no .planning and no global defaults', () => {
    const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-noplanning2-'));
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-nohome-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      // Point GSD_HOME to a directory with no .gsd/defaults.json
      process.env['GSD_HOME'] = homeTmp;
      const result = loadConfigResolved(noPlanning);
      assert.equal(result.source, 'builtin-defaults');
      assert.equal(result.degraded, false);
      assert.ok('model_profile' in result.config);
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(noPlanning);
      cleanup(homeTmp);
    }
  });

  test('back-compat: loadConfig(tmp) deepEquals loadConfigResolved(tmp).config', () => {
    writeConfig(tmpDir, { model_profile: 'quality', research: 'minimal' });
    const fromLoadConfig = loadConfig(tmpDir);
    const { config: fromResolved } = loadConfigResolved(tmpDir);
    assert.deepEqual(fromLoadConfig, fromResolved);
  });

  test('back-compat: loadConfigResolved(descendant) does NOT walk up — returns defaults, not ancestor config', () => {
    // Fix 1: loadConfigResolved must NOT call findProjectRoot internally.
    // Calling from a descendant that has no .planning/ of its own must return
    // defaults (builtin-defaults source), NOT the ancestor's config value.
    writeConfig(tmpDir, { model_profile: 'ancestor-config-should-not-appear' });
    const deepDir = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(deepDir, { recursive: true });
    const result = loadConfigResolved(deepDir);
    // No .planning/ in deepDir → must fall back to defaults, NOT walk up to tmpDir.
    assert.notEqual(result.config.model_profile, 'ancestor-config-should-not-appear',
      'loadConfigResolved must NOT walk up to find ancestor config');
    // The source must be a defaults source (builtin-defaults or global-defaults),
    // NOT "root" (which would imply a config.json was found).
    assert.ok(
      result.source === 'builtin-defaults' || result.source === 'global-defaults',
      `Expected a defaults source, got: ${result.source}`,
    );
  });

  test('Fix 4: loadConfigResolved(tmp, { workstream: "" }) → source:"root"', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    // empty-string ws resolves the root path → source must be "root"
    const result = loadConfigResolved(tmpDir, { workstream: '' });
    assert.equal(result.source, 'root', 'empty-string workstream should yield source:"root"');
    assert.equal(result.degraded, false);
  });

  test('Fix 2a: GSD_WORKSTREAM set to nonexistent workstream (dir absent) → source:"root", degraded:true', () => {
    writeConfig(tmpDir, { model_profile: 'root-value' });
    const origWs = process.env['GSD_WORKSTREAM'];
    try {
      process.env['GSD_WORKSTREAM'] = 'nonexistent-ws';
      // Do NOT create the workstream directory
      const result = loadConfigResolved(tmpDir);
      assert.equal(result.source, 'root', 'nonexistent workstream should fall back to source:"root"');
      assert.equal(result.degraded, true, 'should be degraded when workstream dir is absent');
      assert.equal(result.config.model_profile, 'root-value', 'config should equal root config');
    } finally {
      if (origWs === undefined) delete process.env['GSD_WORKSTREAM'];
      else process.env['GSD_WORKSTREAM'] = origWs;
    }
  });

  test('Fix 2b: options.workstream missing dir → source:"root", degraded:true', () => {
    writeConfig(tmpDir, { model_profile: 'root-val' });
    // workstream dir NOT created
    const result = loadConfigResolved(tmpDir, { workstream: 'missing-ws' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'root-val');
  });

  test('Fix 2c: workstream dir exists but no config.json → source:"root", degraded:true (existing case still works)', () => {
    writeConfig(tmpDir, { model_profile: 'root-val-c' });
    // Create ws dir but no config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-cfg');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-no-cfg' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'root-val-c');
  });
});

// ─── _deepMergeConfig prototype-pollution guard (audit M4) ───────────────────
// The root↔workstream merge once iterated Object.keys(overlay) with no
// __proto__/constructor/prototype guard — while four sibling paths in the same
// file guard them. A config.json with {"__proto__": {...}} could pollute the
// merged object's prototype chain and spoof unset config flags.
describe('_deepMergeConfig — prototype-pollution guard (M4)', () => {
  test('ignores a __proto__ overlay key (no proto pollution, no flag spoofing)', () => {
    // JSON.parse (not an object literal) creates an OWN enumerable "__proto__"
    // key — exactly what a malicious config.json on disk yields.
    const malicious = JSON.parse('{"__proto__": {"injectedFlag": true}}');
    const merged = _deepMergeConfig({ model_profile: 'base' }, malicious);
    assert.equal({}.injectedFlag, undefined, 'global Object.prototype must not be polluted');
    assert.equal(merged.injectedFlag, undefined, 'merged object must not expose the injected flag');
    assert.equal(Object.getPrototypeOf(merged) === Object.prototype, true, 'merged prototype unchanged');
    assert.equal(merged.model_profile, 'base', 'legitimate keys still merge');
  });

  test('ignores constructor/prototype overlay keys too', () => {
    const malicious = JSON.parse('{"constructor": {"x": 1}, "prototype": {"y": 2}}');
    const merged = _deepMergeConfig({ a: 1 }, malicious);
    assert.equal(merged.a, 1);
    // constructor must remain the native Object constructor, not the injected object
    assert.equal(typeof merged.constructor, 'function');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2638-sub-repos-canonical-location.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2638-sub-repos-canonical-location (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2638.
 *
 * loadConfig previously migrated/synced sub_repos to the TOP-LEVEL
 * `parsed.sub_repos`, but the KNOWN_TOP_LEVEL allowlist only recognizes
 * `planning.sub_repos` (per #2561 — canonical location). That asymmetry
 * made loadConfig write a key it then warns is unknown on the next read.
 *
 * Fix: writers target `parsed.planning.sub_repos` and strip any stale
 * top-level copy during the same migration pass.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

function makeSubRepo(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  gitOrThrow(['init'], { cwd: dir });
}

function readConfig(tmpDir) {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8')
  );
}

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2)
  );
}

describe('bug #2638 — sub_repos canonical location', () => {
  let tmpDir;
  let originalCwd;
  let stderrCapture;
  let origStderrWrite;

  beforeEach(() => {
    tmpDir = createTempProject();
    originalCwd = process.cwd();
    stderrCapture = '';
    origStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrCapture += chunk; return true; };
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  test('does not warn when planning.sub_repos is set (no top-level sub_repos)', () => {
    makeSubRepo(tmpDir, 'backend');
    makeSubRepo(tmpDir, 'frontend');
    writeConfig(tmpDir, {
      planning: { sub_repos: ['backend', 'frontend'] },
    });

    loadConfig(tmpDir);

    assert.ok(
      !stderrCapture.includes('unknown config key'),
      `should not warn for planning.sub_repos, got: ${stderrCapture}`
    );
    assert.ok(
      !stderrCapture.includes('sub_repos'),
      `should not mention sub_repos at all, got: ${stderrCapture}`
    );
  });

  test('migrates legacy multiRepo:true into planning.sub_repos (not top-level)', () => {
    makeSubRepo(tmpDir, 'backend');
    makeSubRepo(tmpDir, 'frontend');
    writeConfig(tmpDir, { multiRepo: true });

    loadConfig(tmpDir);

    const after = readConfig(tmpDir);
    assert.deepStrictEqual(
      after.planning?.sub_repos,
      ['backend', 'frontend'],
      'migration should write to planning.sub_repos'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(after, 'sub_repos'),
      false,
      'migration must not leave a top-level sub_repos key'
    );
    assert.strictEqual(after.multiRepo, undefined, 'legacy multiRepo should be removed');

    assert.ok(
      !stderrCapture.includes('unknown config key'),
      `post-migration read should not warn, got: ${stderrCapture}`
    );
  });

  test('filesystem sync writes detected list to planning.sub_repos only', () => {
    makeSubRepo(tmpDir, 'api');
    makeSubRepo(tmpDir, 'web');
    writeConfig(tmpDir, { planning: { sub_repos: ['api'] } });

    loadConfig(tmpDir);

    const after = readConfig(tmpDir);
    assert.deepStrictEqual(after.planning?.sub_repos, ['api', 'web']);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(after, 'sub_repos'),
      false,
      'sync must not create a top-level sub_repos key'
    );
    assert.ok(
      !stderrCapture.includes('unknown config key'),
      `sync should not produce unknown-key warning, got: ${stderrCapture}`
    );
  });

  test('stale top-level sub_repos is stripped on load', () => {
    makeSubRepo(tmpDir, 'backend');
    writeConfig(tmpDir, {
      sub_repos: ['backend'],
      planning: { sub_repos: ['backend'] },
    });

    loadConfig(tmpDir);

    const after = readConfig(tmpDir);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(after, 'sub_repos'),
      false,
      'stale top-level sub_repos should be removed to self-heal legacy installs'
    );
    assert.deepStrictEqual(after.planning?.sub_repos, ['backend']);
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3523-cjs-loadconfig-branching-strategy-warning.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3523-cjs-loadconfig-branching-strategy-warning (consolidation epic #1969 B6 #1975)", () => {
'use strict';

/**
 * Regression tests for #3523 — CJS loadConfig must not emit a false
 * "unknown config key(s)" warning for `branching_strategy` when that key
 * is written at the top level of .planning/config.json.
 *
 * Root cause: KNOWN_TOP_LEVEL in core.cjs was built from VALID_CONFIG_KEYS
 * via k.split('.')[0], which turns 'git.branching_strategy' → 'git', not
 * 'branching_strategy'. So a config with the legacy top-level shape tripped
 * the unknown-key warning even though core.cjs:485 actively reads the value.
 *
 * Fix (option 3 — self-healing): mirror the multiRepo → planning.sub_repos
 * precedent: graft branching_strategy into fileData.git.branching_strategy
 * and delete the top-level key, then persist. The KNOWN_TOP_LEVEL list also
 * gains 'branching_strategy' as a deprecated-still-accepted key so the warning
 * never fires even on the first read before the write-back occurs.
 *
 * Double-emission is also reduced: the warning site is guarded by a
 * module-level Set so repeated loadConfig calls during one CLI invocation
 * don't echo the same line twice.
 *
 * CJS↔SDK contract: the SDK mergeDefaults() already handles the legacy
 * top-level key (PR #3116). This file adds a fixture-level parity check
 * that proves both paths produce the same branching_strategy value.
 *
 * Test strategy: we use `resolve-model` as the minimal CJS entry point that
 * calls loadConfig internally, then assert on stderr emptiness (typed-IR
 * "no warning" pattern from #2687).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, TOOLS_PATH, TEST_ENV_BASE, installSpawnHome } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Run gsd-tools and return { stdout, stderr, status }.
 * Always captures stderr even when exit code is 0.
 */
function runWithStderr(args, cwd, env = {}) {
  const result = runNode([TOOLS_PATH, ...args], {
    cwd,
    // #3532 / #4071: pin GSD_HOME to an empty sandbox so a developer's real
    // ~/.gsd/defaults.json cannot leak into children — once as shadow-key
    // warnings these suites asserted absent, now as merged SETTINGS that would
    // change what they resolve (TEST_ENV_BASE only BLANKS the var; an empty
    // string falls through to the real homedir).
    env: { ...process.env, ...TEST_ENV_BASE, GSD_HOME: installSpawnHome(), ...env },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.exitCode,
  };
}

// ─── Test 1: no warning for legacy top-level branching_strategy ──────────────

describe('bug-3523 — no warning for legacy top-level branching_strategy', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('loadConfig emits no stderr when config.json has top-level branching_strategy', () => {
    tmpDir = createTempProject('gsd-3523-warn-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'phase',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    // resolve-model calls loadConfig internally, triggering KNOWN_TOP_LEVEL check.
    const result = runWithStderr(['resolve-model', 'planner'], tmpDir);

    assert.equal(
      result.stderr.trim(),
      '',
      `loadConfig must not warn about top-level branching_strategy (#3523) — got: ${result.stderr}`
    );
  });

  test('branching_strategy value is still surfaced after loadConfig on legacy shape', () => {
    tmpDir = createTempProject('gsd-3523-value-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'milestone',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    // Trigger loadConfig (which runs the migration and writes git.branching_strategy
    // back to disk), then read it with config-get to verify the value is preserved.
    const triggerResult = runWithStderr(['resolve-model', 'planner'], tmpDir);
    assert.equal(
      triggerResult.stderr.trim(),
      '',
      `No warning should fire on legacy shape (#3523) — got: ${triggerResult.stderr}`
    );

    // After migration write-back, config-get should find git.branching_strategy.
    const result = runWithStderr(['config-get', 'git.branching_strategy', '--raw'], tmpDir);

    assert.equal(
      result.status,
      0,
      `config-get command must succeed — exit status ${result.status}, stderr: ${result.stderr}`
    );
    assert.equal(
      result.stderr.trim(),
      '',
      `No error should fire when reading migrated branching_strategy (#3523) — got: ${result.stderr}`
    );
    assert.equal(
      result.stdout.trim(),
      'milestone',
      `Expected git.branching_strategy to be 'milestone' but got: ${result.stdout}`
    );
  });
});

// ─── Test 2: no duplicated warning (double-emission) ─────────────────────────

describe('bug-3523 — double-emission reduced to single-emission', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('unknown-key warning appears at most once per process invocation', () => {
    // Use a key that IS genuinely unknown (not branching_strategy, which is now
    // fixed) to verify the deduplication guard works for other keys too.
    // We verify that the count of warning lines for a single unknown key is
    // exactly once — not zero and not two — even if loadConfig is invoked twice internally.
    tmpDir = createTempProject('gsd-3523-dedup-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        // intentionally_unknown_key_for_dedup_test: a key that can never be valid
        __gsd3523_dedup_sentinel__: true,
      }, null, 2),
      'utf-8'
    );

    const result = runWithStderr(['resolve-model', 'planner'], tmpDir);

    // allow-test-rule: pending-migration-to-typed-ir [#3090]
    // Counts occurrences of a sentinel substring in the CLI's human-readable
    // stderr warning text — no structured "warning count"/warning-list API is
    // exposed yet; adding one is a production change out of scope here.
    // Tracked under #3090.
    // Count how many times the sentinel key appears in warnings
    const warningLines = result.stderr
      .split('\n')
      .filter(l => l.includes('__gsd3523_dedup_sentinel__'));

    assert.equal(
      warningLines.length,
      1,
      `Unknown-key warning must appear exactly once per process invocation — ` +
      `appeared ${warningLines.length} times. stderr:\n${result.stderr}`
    );
  });
});

// ─── Test 3: on-disk migration (option 3 write-back) ─────────────────────────

describe('bug-3523 — option 3 on-disk migration of branching_strategy', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('after loadConfig, on-disk config.json has branching_strategy under git.*', () => {
    tmpDir = createTempProject('gsd-3523-writeback-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'phase',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    // Trigger loadConfig by running a command.
    runWithStderr(['resolve-model', 'planner'], tmpDir);

    // On-disk file should now have git.branching_strategy and no top-level branching_strategy.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(
      onDisk.git?.branching_strategy,
      'phase',
      'Expected on-disk config.json to have git.branching_strategy = "phase" after migration'
    );
    assert.equal(
      onDisk.branching_strategy,
      undefined,
      'Expected on-disk config.json to have no top-level branching_strategy after migration'
    );
  });

  test('migration does not clobber existing git.branching_strategy', () => {
    // If git.branching_strategy is already set, the top-level value should
    // not overwrite it (nested wins, matching SDK mergeDefaults precedence).
    tmpDir = createTempProject('gsd-3523-no-clobber-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'phase',       // legacy top-level
        git: {
          base_branch: 'main',
          branching_strategy: 'milestone', // canonical nested — must win
        },
      }, null, 2),
      'utf-8'
    );

    // Trigger loadConfig.
    runWithStderr(['resolve-model', 'planner'], tmpDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(
      onDisk.git?.branching_strategy,
      'milestone',
      'canonical git.branching_strategy must not be overwritten by legacy top-level key'
    );
    // top-level key should be removed since it was redundant
    assert.equal(
      onDisk.branching_strategy,
      undefined,
      'top-level branching_strategy should be removed even when git.branching_strategy already set'
    );
  });

  test('workstream load also self-heals legacy root branching_strategy', () => {
    tmpDir = createTempProject('gsd-3523-workstream-root-');
    const rootConfigPath = path.join(tmpDir, '.planning', 'config.json');
    const workstreamDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(workstreamDir, { recursive: true });
    fs.writeFileSync(
      rootConfigPath,
      JSON.stringify({
        branching_strategy: 'phase',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workstreamDir, 'config.json'),
      JSON.stringify({ workflow: { tdd: true } }, null, 2),
      'utf-8'
    );

    const triggerResult = runWithStderr(['resolve-model', 'planner'], tmpDir, {
      GSD_WORKSTREAM: 'alpha',
    });

    assert.equal(
      triggerResult.status,
      0,
      `workstream load command must succeed — exit status ${triggerResult.status}, stderr: ${triggerResult.stderr}`
    );
    assert.equal(
      triggerResult.stderr.trim(),
      '',
      `No warning should fire while migrating root config for a workstream — got: ${triggerResult.stderr}`
    );

    const onDisk = JSON.parse(fs.readFileSync(rootConfigPath, 'utf-8'));
    assert.equal(
      onDisk.git?.branching_strategy,
      'phase',
      'Expected root config.json to persist git.branching_strategy after workstream load'
    );
    assert.equal(
      onDisk.branching_strategy,
      undefined,
      'Expected root config.json to remove top-level branching_strategy after workstream load'
    );

    const rootResult = runWithStderr(['config-get', 'git.branching_strategy'], tmpDir);
    assert.equal(
      rootResult.status,
      0,
      `root config-get command must succeed after workstream migration — exit status ${rootResult.status}, stderr: ${rootResult.stderr}`
    );
    assert.ok(
      rootResult.stdout.includes('phase'),
      `Expected migrated root git.branching_strategy to be 'phase' but got: ${rootResult.stdout}`
    );
  });
});

// ─── Test 4: CJS↔SDK contract parity ────────────────────────────────────────

describe('bug-3523 — CJS↔SDK contract: both agree on legacy branching_strategy fixture', () => {
  /**
   * This is a light-touch contract test: we invoke the CJS path via CLI and
   * compare the branching_strategy value it returns against what the SDK's
   * mergeDefaults would compute for the same fixture.
   *
   * We can't import SDK TypeScript here, so we assert on the CJS output and
   * use a snapshot of expected SDK behavior derived from the mergeDefaults
   * source (sdk/src/config.ts:192-218):
   *   mergeDefaults({ branching_strategy: 'phase', git: { base_branch: 'main' } })
   *   → git.branching_strategy = 'phase'
   */
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('CJS loadConfig surfaces branching_strategy matching SDK mergeDefaults behavior', () => {
    tmpDir = createTempProject('gsd-3523-parity-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    // The fixture that the SDK's mergeDefaults handles correctly (PR #3116).
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'phase',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    // SDK mergeDefaults produces: git.branching_strategy = 'phase'
    // CJS loadConfig must produce the same. Trigger loadConfig first (migration
    // writes git.branching_strategy to disk), then verify with config-get.
    const triggerResult = runWithStderr(['resolve-model', 'planner'], tmpDir);
    assert.equal(
      triggerResult.stderr.trim(),
      '',
      `No warning must fire on a standard legacy fixture — got: ${triggerResult.stderr}`
    );

    // After the migration write-back, config-get must find git.branching_strategy = 'phase',
    // matching what the SDK's mergeDefaults would compute.
    const result = runWithStderr(['config-get', 'git.branching_strategy'], tmpDir);

    assert.equal(
      result.status,
      0,
      `config-get command must succeed — exit status ${result.status}, stderr: ${result.stderr}`
    );
    assert.equal(
      result.stderr.trim(),
      '',
      `No error when reading post-migration git.branching_strategy — got: ${result.stderr}`
    );
    assert.ok(
      result.stdout.includes('phase'),
      `CJS must agree with SDK: git.branching_strategy = 'phase' for legacy fixture. ` +
      `Got: ${result.stdout}`
    );
  });
});
  });
}

// ─── #1880: corrupt is not absent (ADR-1411 amendment) ────────────────────────

describe("loadConfigResolved — corrupt config is distinguishable from absent", () => {
  let tmpDir;
  let stderrLines;
  let originalStderrWrite;

  beforeEach(() => {
    tmpDir = makeTempProject();
    stderrLines = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
    configLoader._resetRuntimeWarningCacheForTests();
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  const configPath = (d) => path.join(d, ".planning", "config.json");
  const R = configLoader.CONFIG_REASON;

  // The repro from the issue: absent and malformed were byte-identical.
  test("absent config resolves not_configured and is NOT degraded", () => {
    const res = configLoader.loadConfigResolved(tmpDir);
    assert.equal(res.degraded, false, "a missing config is legitimate absence");
    assert.equal(res.reason, R.NOT_CONFIGURED);
    assert.equal(res.reason, "not_configured", "enum value is the wire contract");
  });

  test("malformed config is degraded with reason config_unparseable", () => {
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget",}', "utf-8");
    const res = configLoader.loadConfigResolved(tmpDir);
    assert.equal(res.reason, R.CONFIG_UNPARSEABLE,
      "a trailing comma must not read as \"no config here\"");
    assert.equal(res.degraded, true, "corruption is a degraded resolution");
  });

  test("absent and malformed no longer produce the same resolution", () => {
    const absent = configLoader.loadConfigResolved(tmpDir);
    configLoader._resetRuntimeWarningCacheForTests();
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget",}', "utf-8");
    const corrupt = configLoader.loadConfigResolved(tmpDir);
    assert.notEqual(absent.reason, corrupt.reason,
      "the whole defect: these two were indistinguishable");
    assert.notEqual(absent.degraded, corrupt.degraded);
  });

  test("unreadable config is degraded with reason config_unreadable", (t) => {
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget"}', "utf-8");
    // Deterministic IO fault via fs monkeypatch, restored in t.after() — never
    // chmod 0o000, which root bypasses (CLAUDE.md cross-platform IO rule).
    const realRead = fs.readFileSync;
    t.after(() => { fs.readFileSync = realRead; });
    fs.readFileSync = (f, ...rest) => {
      if (String(f).endsWith("config.json")) {
        const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e;
      }
      return realRead(f, ...rest);
    };
    const res = configLoader.loadConfigResolved(tmpDir);
    assert.equal(res.reason, R.CONFIG_UNREADABLE);
    assert.equal(res.degraded, true);
  });

  // The wiring clause: loadConfig returns .config alone to ~51 call sites, so
  // without a diagnostic the reason field is unreachable to nearly every consumer.
  test("the plain loadConfig path still surfaces the cause on stderr", () => {
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget",}', "utf-8");
    configLoader.loadConfig(tmpDir);
    assert.equal(configLoader._warnedUnusableConfig.size, 1,
      "a loadConfig caller must still get a signal it can act on");
  });

  test("the diagnostic is deduplicated across repeat loads", () => {
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget",}', "utf-8");
    configLoader.loadConfig(tmpDir);
    configLoader.loadConfig(tmpDir);
    configLoader.loadConfig(tmpDir);
    assert.equal(configLoader._warnedUnusableConfig.size, 1, "keyed on path+errno, warned once");
  });

  // Regression: found by isolated review of the first cut of this fix. The
  // success path returned early WITHOUT consulting configFault, so a corrupt
  // ROOT config whose workstream override happened to parse reported
  // degraded:false / resolved — the same silent-discard defect this issue
  // exists to close, reappearing for any project that uses workstreams.
  test("a corrupt ROOT config still degrades when the workstream config parses", () => {
    const wsDir = path.join(tmpDir, ".planning", "workstreams", "ws-a");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"budget",}', "utf-8");
    fs.writeFileSync(path.join(wsDir, "config.json"), '{"mode":"autonomous"}', "utf-8");
    const res = configLoader.loadConfigResolved(tmpDir, { workstream: "ws-a" });
    assert.equal(res.reason, R.CONFIG_UNPARSEABLE,
      "the root config was discarded — that must not report as a clean resolve");
    assert.equal(res.degraded, true);
  });

  // Regression: reason was computed from the root+workstream MERGE, so an empty
  // workstream file inheriting a non-empty root reported "resolved" despite
  // carrying no settings of its own.
  test("an empty workstream file inheriting a non-empty root is configured_empty", () => {
    const wsDir = path.join(tmpDir, ".planning", "workstreams", "ws-b");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(configPath(tmpDir), '{"model_profile":"quality"}', "utf-8");
    fs.writeFileSync(path.join(wsDir, "config.json"), "{}", "utf-8");
    const res = configLoader.loadConfigResolved(tmpDir, { workstream: "ws-b" });
    assert.equal(res.reason, R.CONFIGURED_EMPTY,
      "emptiness is a property of the file read, not of the merged result");
    assert.equal(res.degraded, false, "an empty file is not corruption");
  });

  // Found by the property test below: valid JSON that is not an OBJECT parsed
  // "ok", then threw downstream, and the outer catch reported not_configured —
  // a present file indistinguishable from an absent one, the exact defect this
  // issue closes. Shape is now validated at the read seam (ADR-227).
  for (const body of ["0", '"a string"', "[]", "null", "true"]) {
    test(`valid JSON that is not an object is unusable, not absent: ${body}`, () => {
      fs.writeFileSync(configPath(tmpDir), body, "utf-8");
      const res = configLoader.loadConfigResolved(tmpDir);
      assert.equal(res.reason, R.CONFIG_UNPARSEABLE,
        "a present-but-unusable file must never report as not_configured");
      assert.equal(res.degraded, true);
    });
  }

  // Property test (CONTRIBUTING.md: parsers require >=1 fast-check property).
  // The classification is total and mutually exclusive: any byte string is
  // exactly one of resolved/configured_empty (parses) or config_unparseable.
  test("classification is total and never reports a corrupt file as absent", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        configLoader._resetRuntimeWarningCacheForTests();
        fs.writeFileSync(configPath(tmpDir), body, "utf-8");
        const res = configLoader.loadConfigResolved(tmpDir);
        let parses = true;
        try { const v = JSON.parse(body); parses = v !== null && typeof v === "object" && !Array.isArray(v); }
        catch { parses = false; }
        // The invariant that matters: a file that is PRESENT is never reported
        // as not_configured, whatever its bytes.
        assert.notEqual(res.reason, R.NOT_CONFIGURED);
        if (!parses) assert.equal(res.reason, R.CONFIG_UNPARSEABLE);
        return true;
      }),
      { numRuns: 200, seed: 1880 },
    );
  });

  // Contract markers required by scripts/lint-resolution-provenance.cjs:
  // configured_empty and not_configured must stay distinguishable.
  test("an empty config object is configured_empty, not not_configured", () => {
    fs.writeFileSync(configPath(tmpDir), "{}", "utf-8");
    const res = configLoader.loadConfigResolved(tmpDir);
    assert.equal(res.reason, R.CONFIGURED_EMPTY,
      "configured_empty and not_configured must be distinguishable (ADR-1411 rule 3)");
    assert.equal(res.reason, "configured_empty", "enum value is the wire contract");
    assert.equal(res.degraded, false, "an empty file is not corruption");
  });
});

// ─── #2997: phase_id_convention survives config resolution ─────────────────

describe('#2997: phase_id_convention is not silently dropped on a clean read', () => {
  const { createTempDir } = require('./helpers.cjs');
  const cfgPath = (dir) => path.join(dir, '.planning', 'config.json');

  test('setting phase_id_convention in config.json survives into the resolved config', () => {
    const tmpDir = createTempDir('gsd-2997-');
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(cfgPath(tmpDir), JSON.stringify({ phase_id_convention: 'milestone-prefixed' }), 'utf-8');
      const res = loadConfigResolved(tmpDir);
      assert.equal(res.degraded, false, 'read must report as non-degraded');
      assert.equal(res.config.phase_id_convention, 'milestone-prefixed',
        `phase_id_convention must survive resolution; got: ${JSON.stringify(res.config.phase_id_convention)}`);
    } finally { cleanup(tmpDir); }
  });

  test('phase_id_convention set to null round-trips correctly', () => {
    const tmpDir = createTempDir('gsd-2997-null-');
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(cfgPath(tmpDir), JSON.stringify({ phase_id_convention: null }), 'utf-8');
      const res = loadConfigResolved(tmpDir);
      assert.equal(res.config.phase_id_convention, null,
        'null phase_id_convention must round-trip as null');
    } finally { cleanup(tmpDir); }
  });

  test('phase_id_convention absent → null in resolved config (no false default)', () => {
    const tmpDir = createTempDir('gsd-2997-absent-');
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(cfgPath(tmpDir), JSON.stringify({ commit_docs: true }), 'utf-8');
      const res = loadConfigResolved(tmpDir);
      assert.equal(res.config.phase_id_convention, null,
        'absent phase_id_convention must resolve to null, not undefined');
    } finally { cleanup(tmpDir); }
  });
});

// ─── #4071: ~/.gsd/defaults.json is merged per key under a project config ─────
//
// Before #4071 the mere EXISTENCE of a project .planning/config.json — not a
// per-key collision — made every key ~/.gsd/defaults.json sets inert for
// runtime resolution: Branch A opened the file only to feed the #3532
// "shadowed keys" warning and discarded the values. These cases pin the
// per-key merge (project → global → builtin) and the retirement of that
// warning. The canary drives BOTH branches from the same global file and
// asserts Branch A's answer equals Branch D's — the issue's acceptance
// criterion verbatim — with an anti-vacuity check that the shared answer is
// the sentinel, not a builtin default the two branches happen to agree on.

// Every key the global file contributes, mirrored from the implementation's
// export so the list cannot drift silently in either direction (parity test
// below). `parallelization` is listed but exercised on its own: Branch A
// normalizes `{ enabled }` to a boolean while Branch D returns the raw value,
// a pre-existing shape difference this fix does not change.
const GLOBAL_KEYS_HONORED_UNDER_PROJECT = [
  'model_profile', 'commit_docs', 'research', 'plan_checker', 'verifier',
  'nyquist_validation', 'post_planning_gaps', 'research_before_questions', 'parallelization', 'text_mode',
  'resolve_model_ids', 'context_window', 'subagent_timeout', 'model_overrides',
  'models', 'granularity', 'granularities', 'planning', 'dynamic_routing',
  'effort', 'fast_mode', 'agent_skills', 'response_language', 'runtime',
  'model_profile_overrides', 'model_policy',
];

describe('#4071 global defaults merge per key under a project config', () => {
  const { TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');
  const { runNode, runGit } = require('./helpers/process-seam.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  let tmpDir;
  let bareDir;
  let gsdHome;
  let stderrLines;
  let originalStderrWrite;
  let originalGsdHome;

  beforeEach(() => {
    tmpDir = makeTempProject('gsd-4071-project-');
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4071-bare-'));
    gsdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4071-home-'));
    stderrLines = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
    originalGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
    if (_resetRuntimeWarningCacheForTests) _resetRuntimeWarningCacheForTests();
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    if (tmpDir) cleanup(tmpDir);
    if (bareDir) cleanup(bareDir);
    if (gsdHome) cleanup(gsdHome);
    tmpDir = bareDir = gsdHome = null;
  });

  function writeGlobalDefaults(obj) {
    fs.mkdirSync(path.join(gsdHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(gsdHome, '.gsd', 'defaults.json'),
      JSON.stringify(obj, null, 2),
    );
  }

  /** The issue's instrument: `resolve-model` routes through loadConfigResolved; `config-get` does not. */
  function resolveModelRaw(cwd) {
    const result = runNode([TOOLS_PATH, 'resolve-model', 'gsd-planner', '--cwd', cwd, '--raw'], {
      cwd,
      env: { ...process.env, ...TEST_ENV_BASE, GSD_HOME: gsdHome },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { stdout: (result.stdout || '').trim(), stderr: result.stderr || '', status: result.exitCode };
  }

  test('regression: a global model_profile is honored when the project config is silent on it', () => {
    writeConfig(tmpDir, { granularity: 'standard' });
    writeGlobalDefaults({ model_profile: 'budget' });
    const resolution = loadConfigResolved(tmpDir);
    assert.equal(resolution.source, 'root');
    assert.equal(resolution.degraded, false);
    assert.equal(resolution.config['model_profile'], 'budget');
    assert.equal(resolution.config['granularity'], 'standard', 'the project key is still read');
  });

  test('regression: resolve-model honors the global model_profile identically with and without a project config', () => {
    writeConfig(tmpDir, { granularity: 'standard' });
    const noGlobal = resolveModelRaw(tmpDir);
    assert.equal(noGlobal.status, 0, noGlobal.stderr);
    writeGlobalDefaults({ model_profile: 'budget' });
    const withProject = resolveModelRaw(tmpDir);
    const withoutProject = resolveModelRaw(bareDir);
    assert.equal(withProject.status, 0, withProject.stderr);
    assert.equal(withoutProject.status, 0, withoutProject.stderr);
    assert.equal(withProject.stdout, withoutProject.stdout,
      'a project config that does not set model_profile must not change what the global profile resolves to');
    assert.notEqual(withProject.stdout, noGlobal.stdout,
      'anti-vacuity: the global profile must actually move the answer off the builtin default');
    assert.ok(!withProject.stderr.includes('#3532'), `retired warning still emitted: ${withProject.stderr}`);
  });

  test('project key wins on collision (unchanged)', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeGlobalDefaults({ model_profile: 'quality', model_overrides: { 'gsd-executor': 'haiku' } });
    const { config } = loadConfigResolved(tmpDir);
    assert.equal(config['model_profile'], 'balanced');
    assert.deepEqual(config['model_overrides'], { 'gsd-executor': 'haiku' }, 'a key only the global file sets is preserved');
  });

  // Presence, not truthiness, decides a collision: a falsy project value must
  // still beat a truthy global one, and keep its historical `|| null` coercion.
  // (Caught by the pre-create adversarial review of the first draft.)
  test('falsy project values win collisions on the || keys and keep their null coercion', () => {
    writeConfig(tmpDir, { fast_mode: false, dynamic_routing: false, response_language: '' });
    writeGlobalDefaults({ fast_mode: true, dynamic_routing: { enabled: true }, response_language: 'French' });
    const { config } = loadConfigResolved(tmpDir);
    assert.equal(config['fast_mode'], null);
    assert.equal(config['dynamic_routing'], null);
    assert.equal(config['response_language'], null);
  });

  // Every `|| null` / `|| {}` key routes through the same presence test — a
  // key that regresses to a plain `||` lets `false` lose to a truthy global.
  const OR_KEYS = ['model_overrides', 'models', 'granularities', 'planning', 'dynamic_routing', 'runtime',
    'model_profile_overrides', 'model_policy', 'effort', 'fast_mode', 'agent_skills', 'response_language'];
  for (const key of OR_KEYS) {
    test(`canary: present-but-false project "${key}" beats a truthy global value`, () => {
      writeConfig(tmpDir, { [key]: false });
      writeGlobalDefaults({ [key]: `gsd-4071-global-${key}` });
      const { config } = loadConfigResolved(tmpDir);
      assert.deepEqual(config[key], key === 'agent_skills' ? {} : null,
        `project false must win for "${key}" and keep its historical coercion`);
    });
  }

  // Round-1 review (Major): an explicit project `null` counts as UNSET — the
  // contract CONFIGURATION.md states — so it must fall through to the
  // global projection exactly as an absent key does, on every `||`-routed key
  // and on the hand-rolled `granularity`. Before the fix the `!== undefined`
  // presence test admitted `null` as "set", the `|| fallback` arm coerced it,
  // and a correctly-projected global value was silently dropped: the #4071
  // defect class re-entered through `null` instead of through "a project
  // config exists". The `??`-routed keys never had this gap.
  const NULL_IS_UNSET_KEYS = [...OR_KEYS, 'granularity'];
  for (const key of NULL_IS_UNSET_KEYS) {
    test(`null-is-unset: an explicit project null "${key}" falls through to the global value`, () => {
      writeConfig(tmpDir, { [key]: null });
      writeGlobalDefaults({ [key]: `gsd-4071-global-${key}` });
      assert.deepEqual(loadConfigResolved(tmpDir).config[key], `gsd-4071-global-${key}`,
        `project null must read as unset for "${key}" and honor the global value`);
    });
  }

  // Self-found sibling of the round-1 Major (defect class: a `!== undefined`
  // presence test in front of the global-defaults tier): `commit_docs`
  // returned an explicit project `null` verbatim, short-circuiting the
  // gitignore, global AND builtin tiers. It is on the documented resolution
  // set, so `null` counts as unset here too.
  test('null-is-unset: an explicit project null commit_docs falls through to the global value', () => {
    writeConfig(tmpDir, { commit_docs: null });
    writeGlobalDefaults({ commit_docs: false }); // builtin is true — false is the anti-vacuity sentinel
    assert.equal(loadConfigResolved(tmpDir).config['commit_docs'], false);
  });

  // Round review (self-found, pre-push): the flat/nested read returns a
  // top-level `null` BEFORE consulting the `planning.commit_docs` alias, so
  // treating that null as unset must retry the alias — otherwise a nested
  // explicit opt-out is skipped and the chain lands on the builtin `true`.
  test('null-is-unset: a top-level null commit_docs does not shadow the nested planning.commit_docs alias', () => {
    writeConfig(tmpDir, { commit_docs: null, planning: { commit_docs: false } });
    writeGlobalDefaults({ commit_docs: true });
    assert.equal(loadConfigResolved(tmpDir).config['commit_docs'], false);
  });

  test('null-is-unset: an explicit project null commit_docs with no global file resolves to the builtin', () => {
    writeConfig(tmpDir, { commit_docs: null });
    assert.equal(loadConfigResolved(tmpDir).config['commit_docs'], configLoader.CONFIG_DEFAULTS.commit_docs);
  });

  // Round review (pre-push, refuted claim): `get()` returns a present flat
  // value BEFORE consulting the nested alias, so a legacy flat `null` shadowed
  // an explicit nested spelling. Pre-#4071 that null fell to the BUILTIN; with
  // the global tier behind it, a machine-wide value could now defeat an
  // explicit nested project value — strictly worse. A flat `null` yields to
  // an explicitly-set nested alias, on every alias-carrying resolution key.
  const NESTED_ALIAS_KEYS = {
    research: ['workflow', 'research'], plan_checker: ['workflow', 'plan_check'],
    verifier: ['workflow', 'verifier'], nyquist_validation: ['workflow', 'nyquist_validation'],
    post_planning_gaps: ['workflow', 'post_planning_gaps'], text_mode: ['workflow', 'text_mode'],
    subagent_timeout: ['workflow', 'subagent_timeout'], commit_docs: ['planning', 'commit_docs'],
  };
  for (const [flat, [section, field]] of Object.entries(NESTED_ALIAS_KEYS)) {
    test(`null-is-unset: a null legacy flat "${flat}" does not shadow an explicit nested ${section}.${field}`, () => {
      writeConfig(tmpDir, { [flat]: null, [section]: { [field]: `gsd-4071-nested-${flat}` } });
      writeGlobalDefaults({ [flat]: `gsd-4071-global-${flat}` });
      assert.equal(loadConfigResolved(tmpDir).config[flat], `gsd-4071-nested-${flat}`,
        `the explicit nested ${section}.${field} must win over a null flat "${flat}" and over the global value`);
    });
  }

  test('_getConfigValueNullAsUnset: a flat null with no nested value set is still returned as null (shape unchanged)', () => {
    const n = { section: 'workflow', field: 'research' };
    assert.equal(configLoader._getConfigValueNullAsUnset({ research: null }, 'research', n), null);
    assert.equal(configLoader._getConfigValueNullAsUnset({ research: null, workflow: {} }, 'research', n), null);
    assert.equal(configLoader._getConfigValueNullAsUnset({ research: null, workflow: { research: false } }, 'research', n), false);
    assert.equal(configLoader._getConfigValueNullAsUnset({ research: false, workflow: { research: true } }, 'research', n), false, 'a set flat value still wins');
    // The generic reader is untouched: outside the resolution set a flat null still wins.
    assert.equal(configLoader._getConfigValue({ research: null, workflow: { research: false } }, 'research', n), null);
  });

  // Pre-push round review: the null-is-unset rule is scoped to the resolution
  // set. `max_prompt_tokens: null` is a documented explicit value ("no trim",
  // planning-config.md), so its flat spelling must keep winning over the
  // nested alias exactly as before this PR.
  test('null-is-unset is scoped: a flat max_prompt_tokens null still wins over the nested alias', () => {
    writeConfig(tmpDir, { max_prompt_tokens: null, review: { max_prompt_tokens: 1234 } });
    const { config } = loadConfigResolved(tmpDir);
    assert.equal(config['review']['max_prompt_tokens'], null, 'the flat explicit null ("no trim") must not be overridden by the nested value');
  });

  test('null-is-unset: with no global file an explicit project null keeps its historical coercion', () => {
    writeConfig(tmpDir, { model_overrides: null, granularity: null, agent_skills: null, response_language: null });
    const { config } = loadConfigResolved(tmpDir);
    assert.equal(config['model_overrides'], null);
    assert.equal(config['granularity'], null);
    assert.deepEqual(config['agent_skills'], {});
    assert.equal(config['response_language'], null);
  });

  test('a project nested spelling still wins over a global flat one', () => {
    writeConfig(tmpDir, { workflow: { research: false } });
    writeGlobalDefaults({ research: true });
    assert.equal(loadConfigResolved(tmpDir).config['research'], false);
  });

  test('present-but-empty project config honors the global file', () => {
    writeConfig(tmpDir, {});
    writeGlobalDefaults({ model_profile: 'quality' });
    assert.equal(loadConfigResolved(tmpDir).config['model_profile'], 'quality');
  });

  test('the #3532 shadowed-keys warning is retired: nothing is shadowed any more', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeGlobalDefaults({ model_overrides: { 'gsd-executor': 'haiku' }, model_profile: 'quality' });
    loadConfigResolved(tmpDir);
    assert.equal(stderrLines.length, 0, `unexpected stderr: ${stderrLines.join('')}`);
  });

  test('no global file: builtin defaults and the null/empty shapes are unchanged', () => {
    writeConfig(tmpDir, {});
    const { config } = loadConfigResolved(tmpDir);
    assert.equal(config['model_profile'], configLoader.CONFIG_DEFAULTS.model_profile);
    assert.equal(config['model_overrides'], null);
    assert.equal(config['granularity'], null);
    assert.deepEqual(config['agent_skills'], {});
    assert.equal(stderrLines.length, 0, `unexpected stderr: ${stderrLines.join('')}`);
  });

  test('unusable global file under a project config: warned once, project keys still applied, resolution degraded', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    fs.mkdirSync(path.join(gsdHome, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(gsdHome, '.gsd', 'defaults.json'), '{not json');
    const resolution = loadConfigResolved(tmpDir);
    assert.equal(resolution.config['model_profile'], 'balanced');
    assert.equal(resolution.source, 'root');
    assert.equal(resolution.degraded, true, 'the global settings were dropped — that is what degraded names');
    assert.equal(resolution.reason, configLoader.CONFIG_REASON.CONFIG_UNPARSEABLE);
    const warned = () => stderrLines.filter(l => l.includes('defaults.json') && l.includes('NOT applied')).length;
    assert.equal(warned(), 1, `expected one unusable-file warning, got: ${stderrLines.join('')}`);
    loadConfigResolved(tmpDir);
    assert.equal(warned(), 1, 'the warning is deduped across calls');
  });

  test('commit_docs: a gitignored .planning/ still wins over a global true', () => {
    const init = runGit(['init', '-q'], { cwd: tmpDir, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(init.exitCode, 0, `git init failed: ${init.stderr}`);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/\n');
    writeConfig(tmpDir, {});
    writeGlobalDefaults({ commit_docs: true });
    assert.equal(loadConfigResolved(tmpDir).config['commit_docs'], false);
  });

  test('parallelization: a global { enabled } object normalizes under a project config', () => {
    const builtin = configLoader.CONFIG_DEFAULTS.parallelization;
    const flipped = !builtin;
    writeConfig(tmpDir, {});
    writeGlobalDefaults({ parallelization: { enabled: flipped } });
    assert.equal(loadConfigResolved(tmpDir).config['parallelization'], flipped);
  });

  // Typed-IR parity canary: every key the global file contributes must
  // resolve to the same value whether or not a (silent) project config
  // exists — the issue's acceptance criterion — and that value must be the
  // sentinel, so agreement on a builtin default cannot pass vacuously.
  for (const key of GLOBAL_KEYS_HONORED_UNDER_PROJECT) {
    if (key === 'parallelization') continue;
    test(`canary: global "${key}" resolves identically with and without a project config`, () => {
      const sentinel = `gsd-4071-${key}`;
      writeConfig(tmpDir, {});
      writeGlobalDefaults({ [key]: sentinel });
      const withProject = loadConfigResolved(tmpDir);
      const withoutProject = loadConfigResolved(bareDir);
      assert.equal(withProject.source, 'root');
      assert.equal(withoutProject.source, 'global-defaults');
      assert.deepEqual(withProject.config[key], withoutProject.config[key],
        `global "${key}" must resolve the same under a project config as without one`);
      assert.equal(withProject.config[key], sentinel, `anti-vacuity: global "${key}" must reach the resolved config`);
    });
  }

  // The nested aliases Branch D honors (`workflow.post_planning_gaps`, and
  // `workflow.research_before_questions` since #3894) are honored under a
  // project config too, through the same builder.
  for (const key of ['post_planning_gaps', 'research_before_questions']) {
    test(`canary: nested global workflow.${key} is honored under a project config`, () => {
      const sentinel = `gsd-4071-nested-${key}`;
      writeConfig(tmpDir, {});
      writeGlobalDefaults({ workflow: { [key]: sentinel } });
      assert.equal(loadConfigResolved(tmpDir).config[key], sentinel);
    });
  }

  test('research_before_questions: the project nested key surfaces through this loader and wins', () => {
    writeConfig(tmpDir, { workflow: { research_before_questions: 'from-project' } });
    writeGlobalDefaults({ research_before_questions: 'from-global' });
    assert.equal(loadConfigResolved(tmpDir).config['research_before_questions'], 'from-project');
  });

  // List parity, both directions: the implementation's exported list must
  // equal this file's expected list, and the shared builder must project
  // every key in it — a key one grows without the other goes silently
  // unhonored on one branch.
  test('GLOBAL_DEFAULTS_RESOLUTION_KEYS parity with the expected honored set', () => {
    const exported = configLoader.GLOBAL_DEFAULTS_RESOLUTION_KEYS.slice().sort();
    const expected = GLOBAL_KEYS_HONORED_UNDER_PROJECT.slice().sort();
    assert.deepEqual(exported, expected,
      `resolution-key list drifted: exported=${JSON.stringify(exported)} expected=${JSON.stringify(expected)}`);
  });

  test('_globalDefaultsBaseCfg projects every resolution key', () => {
    const projected = configLoader._globalDefaultsBaseCfg({});
    for (const key of configLoader.GLOBAL_DEFAULTS_RESOLUTION_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(projected, key), `builder must project "${key}"`);
    }
  });
});

// ─── Regressions — #3760: a non-object section must not be expanded or written ──
//
// The loader is the surface that actually WRITES: a non-empty `normalizations`
// array marks the config dirty and `platformWriteSync` persists it. Before the
// fix a config holding `{"git":"main","branching_strategy":"none"}` came back
// from `normalizeLegacyKeys` as `{"git":{"0":"m","1":"a","2":"i","3":"n",...}}`
// and that object was written to the user's file — the original `"main"` was
// unrecoverable afterwards.
//
// The loader's own multiRepo branches carried a second, quieter form of the
// same defect: `if (!fileData.planning) fileData.planning = {}` treats a
// non-empty STRING as an already-present section, so the next line
// (`fileData.planning['sub_repos'] = detected`) threw a strict-mode TypeError.
// That throw was swallowed by the enclosing catch, which discarded the entire
// configuration and fell back to defaults — the ADR-1411 silent-fallback
// failure, reached from an input the user can trivially write by hand.

describe('regressions — #3760 loader never expands or persists a non-object section', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempProject('gsd-3760-loader-');
    _resetRuntimeWarningCacheForTests();
  });

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  function readRawConfig() {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8');
  }

  test('loadConfig leaves a string git section untouched on disk', () => {
    writeConfig(tmpDir, { git: 'main', branching_strategy: 'none' });
    const before = readRawConfig();

    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });

    assert.equal(readRawConfig(), before, 'the config file must not be rewritten with an expanded section');
    // The loader projects `git.branching_strategy` to a flat top-level key, so the
    // legacy value the migration declined to move is still what resolution sees.
    assert.equal(config.branching_strategy, 'none', 'the legacy value must still resolve');
  });

  test('loadConfig leaves a string planning section untouched on disk', () => {
    writeConfig(tmpDir, { planning: 'docs', sub_repos: ['a'] });
    const before = readRawConfig();

    assert.doesNotThrow(() => { loadConfig(tmpDir); });

    assert.equal(readRawConfig(), before);
    assert.equal(JSON.parse(readRawConfig()).planning, 'docs');
  });

  test('loadConfig does not discard the config when multiRepo meets a string planning section', () => {
    // Pre-fix the loader threw a TypeError assigning sub_repos onto the string,
    // and the enclosing catch discarded the user's entire config. It also
    // consumed `multiRepo` and wrote the file back with no diagnostic at all.
    fs.mkdirSync(path.join(tmpDir, 'sub', '.git'), { recursive: true });
    writeConfig(tmpDir, { planning: 'docs', multiRepo: true, model_profile: 'balanced' });
    const before = readRawConfig();

    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });

    assert.equal(
      config.model_profile, 'balanced',
      'an unrelated user setting must survive — a swallowed TypeError would have reverted it to the default',
    );
    assert.equal(
      readRawConfig(), before,
      'nothing migrated, so the file must be byte-identical — planning intact AND multiRepo still present',
    );
  });

  test('multiRepo still migrates normally when the planning section is usable', () => {
    // Negative space: refusing on a bad section must not break the good path.
    fs.mkdirSync(path.join(tmpDir, 'sub', '.git'), { recursive: true });
    writeConfig(tmpDir, { multiRepo: true });

    assert.doesNotThrow(() => { loadConfig(tmpDir); });

    assert.deepEqual(JSON.parse(readRawConfig()).planning.sub_repos, ['sub']);
    assert.equal(JSON.parse(readRawConfig()).multiRepo, undefined, 'the marker is consumed once honored');
  });

  test('loadConfigResolved reports a usable resolution and writes no expanded section', () => {
    writeConfig(tmpDir, { git: 'main', branching_strategy: 'none' });
    const before = readRawConfig();

    let resolution;
    assert.doesNotThrow(() => { resolution = loadConfigResolved(tmpDir); });

    assert.equal(readRawConfig(), before);
    assert.equal(resolution.source, 'root', 'a present, parseable config still resolves from the project');
    assert.equal(resolution.degraded, false);
  });

  test('a refused section emits exactly one deduplicated diagnostic, and a repeat emits none', () => {
    // The loader is where the out-of-band diagnostic has to live: loadConfig
    // returns `.config` alone, so an in-band `skipped` record would be unreachable
    // to nearly every caller (ADR-1411: "a reason no caller reads is an
    // unreachable field"). Asserted on the typed emission counter, never by
    // scraping stderr prose.
    const {
      _resetUnusableInputWarningsForTests,
      _unusableInputEmissionCountForTests,
    } = require('../gsd-core/bin/lib/unusable-input.cjs');

    function emissionsDuring(fn) {
      const before = _unusableInputEmissionCountForTests();
      const original = process.stderr.write;
      process.stderr.write = () => true;
      try { fn(); } finally { process.stderr.write = original; }
      return _unusableInputEmissionCountForTests() - before;
    }

    _resetUnusableInputWarningsForTests();
    writeConfig(tmpDir, { git: 'main', branching_strategy: 'none' });

    const first = emissionsDuring(() => { loadConfig(tmpDir); });
    assert.equal(first, 1, 'the operator must be told once');

    const second = emissionsDuring(() => { loadConfig(tmpDir); });
    assert.equal(second, 0, 'the ADR-1411 dedup guard must suppress the repeat');
  });

  test('an already-canonical config is still migrated normally', () => {
    // Negative space: the guard must not suppress a legitimate hoist.
    writeConfig(tmpDir, { git: { remote: 'origin' }, branching_strategy: 'none' });

    const config = loadConfig(tmpDir);
    // Assert on the FILE for the section shape (the loader flattens `git.*` into
    // top-level keys, so the resolved object has no `git` to inspect) and on the
    // resolved value for the projection.
    const onDisk = JSON.parse(readRawConfig());
    assert.equal(onDisk.git.branching_strategy, 'none', 'a well-formed section must still receive the hoisted key');
    assert.equal(onDisk.git.remote, 'origin', 'existing section keys must be preserved');
    assert.equal(onDisk.branching_strategy, undefined, 'the stale top-level key is consumed');
    assert.equal(config.branching_strategy, 'none', 'the hoisted value still resolves');
  });
});

// ─── #3894: workflow.research_before_questions resolves from global defaults ──

describe('#3894 research_before_questions global-defaults forwarding', () => {
  test('nested workflow.research_before_questions in ~/.gsd/defaults.json resolves', () => {
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894-home-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      const gsdDir = path.join(homeTmp, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      // The reporter's exact shape: same nesting as the forwarded
      // workflow.post_planning_gaps, one resolves and one did not.
      fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
        workflow: { post_planning_gaps: true, research_before_questions: true },
      }), 'utf-8');
      process.env['GSD_HOME'] = homeTmp;
      const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894-noplanning-'));
      try {
        const result = loadConfigResolved(noPlanning);
        assert.equal(result.config.post_planning_gaps, true, 'control: the already-forwarded key resolves');
        assert.equal(
          result.config.research_before_questions, true,
          '#3894: same file, same nesting — the quick-path key must resolve too, not just post_planning_gaps'
        );
      } finally {
        cleanup(noPlanning);
      }
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(homeTmp);
    }
  });

  test('flat top-level research_before_questions in ~/.gsd/defaults.json also resolves (Branch D alias parity)', () => {
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894b-home-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      const gsdDir = path.join(homeTmp, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ research_before_questions: true }), 'utf-8');
      process.env['GSD_HOME'] = homeTmp;
      const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894b-noplanning-'));
      try {
        const result = loadConfigResolved(noPlanning);
        assert.equal(result.config.research_before_questions, true);
      } finally {
        cleanup(noPlanning);
      }
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(homeTmp);
    }
  });

  test('unset resolves to the documented default (false), never undefined', () => {
    const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894c-'));
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3894c-home-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      process.env['GSD_HOME'] = homeTmp; // no .gsd/defaults.json — builtin defaults
      const result = loadConfigResolved(noPlanning);
      assert.equal(result.config.research_before_questions, false, 'CANONICAL_CONFIG_DEFAULTS.workflow.research_before_questions is false');
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(homeTmp);
      cleanup(noPlanning);
    }
  });
});
