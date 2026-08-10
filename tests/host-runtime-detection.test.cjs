'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Unit tests for host-runtime-detection.cjs (#3245, epic #2313 Phase 5).
 *
 * Requires the COMPILED artifact:
 * ../gsd-core/bin/lib/host-runtime-detection.cjs
 *
 * detectHostRuntime is a pure, injected-deps function; resolveReportedRuntime
 * layers the explicit GSD_RUNTIME/config.json precedence (via runtime-slash's
 * resolveExplicitRuntime) above the host-detection rung. Neither writes to
 * disk (#2297).
 */

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { createTempProject, cleanup } = require('./helpers.cjs');

const LIB_DIR = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

const {
  CODEX_SESSION_ENV_SIGNALS,
  CODEX_CONFIG_HOME_ENV,
  CODEX_CONFIG_MARKER,
  detectHostRuntime,
  resolveReportedRuntime,
} = require(path.join(LIB_DIR, 'host-runtime-detection.cjs'));

const { resolveRuntime, resolveExplicitRuntime } = require(path.join(LIB_DIR, 'runtime-slash.cjs'));

const updateContext = require(path.join(LIB_DIR, 'update-context.cjs'));

const NONE_RESULT = { runtime: null, source: 'none', signal: null };

/**
 * Returns a fileExists spy pre-seeded with a set of "existing" paths. Every
 * probed path is recorded (normalized, backslash -> forward-slash) on
 * `.calls`, so a test can assert both the return value AND exactly which
 * paths were probed (needed for the negative-probe assertion at #13).
 */
function spyFileExists(existingPaths = []) {
  const normalized = new Set(existingPaths.map((p) => String(p).replace(/\\/g, '/')));
  const spy = (p) => {
    const key = String(p).replace(/\\/g, '/');
    spy.calls.push(key);
    return normalized.has(key);
  };
  spy.calls = [];
  return spy;
}

/** Write `<dir>/.planning/config.json` with a raw (possibly non-JSON) string. */
function writeConfig(dir, rawString) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), rawString);
}

// ─── detectHostRuntime ───────────────────────────────────────────────────

describe('detectHostRuntime', () => {
  test('CODEX_SANDBOX detects a codex session', () => {
    const result = detectHostRuntime({ env: { CODEX_SANDBOX: 'seatbelt' }, fileExists: () => false });
    assert.deepStrictEqual(result, { runtime: 'codex', source: 'session-env', signal: 'CODEX_SANDBOX' });
  });

  test('network-disabled sandbox var detects a codex session', () => {
    const result = detectHostRuntime({
      env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' },
      fileExists: () => false,
    });
    assert.deepStrictEqual(result, {
      runtime: 'codex',
      source: 'session-env',
      signal: 'CODEX_SANDBOX_NETWORK_DISABLED',
    });
  });

  test('CODEX_HOME with config.toml detects codex', () => {
    const home = path.join(os.tmpdir(), 'fake-codex-home');
    const spy = spyFileExists([path.join(home, 'config.toml')]);
    const result = detectHostRuntime({ env: { CODEX_HOME: home }, fileExists: spy });
    assert.deepStrictEqual(result, { runtime: 'codex', source: 'config-home', signal: 'CODEX_HOME' });
  });

  test('session signal outranks the config-home rung', () => {
    const home = path.join(os.tmpdir(), 'fake-codex-home');
    const spy = spyFileExists([path.join(home, 'config.toml')]);
    const result = detectHostRuntime({
      env: { CODEX_SANDBOX: 'seatbelt', CODEX_HOME: home },
      fileExists: spy,
    });
    assert.strictEqual(result.source, 'session-env');
    assert.deepStrictEqual(result, { runtime: 'codex', source: 'session-env', signal: 'CODEX_SANDBOX' });
  });

  test('no signal resolves to no detection', () => {
    const result = detectHostRuntime({ env: {}, fileExists: () => false });
    assert.deepStrictEqual(result, NONE_RESULT);
  });

  test('empty env value is not a signal', () => {
    const result = detectHostRuntime({ env: { CODEX_SANDBOX: '' }, fileExists: () => false });
    assert.deepStrictEqual(result, NONE_RESULT);
  });

  test('whitespace-only env value is not a signal', () => {
    const result = detectHostRuntime({ env: { CODEX_SANDBOX: '   ' }, fileExists: () => false });
    assert.deepStrictEqual(result, NONE_RESULT);
  });

  test('CODEX_HOME without config.toml is not a codex root', () => {
    const home = path.join(os.tmpdir(), 'fake-codex-home-empty');
    const spy = spyFileExists([]);
    const result = detectHostRuntime({ env: { CODEX_HOME: home }, fileExists: spy });
    assert.deepStrictEqual(result, NONE_RESULT);
    assert.deepStrictEqual(spy.calls, [path.join(home, 'config.toml').replace(/\\/g, '/')]);
  });

  test('nonexistent CODEX_HOME degrades to no detection', () => {
    const home = path.join(os.tmpdir(), 'gsd-nonexistent-codex-home-' + Date.now());
    const result = detectHostRuntime({ env: { CODEX_HOME: home }, fileExists: () => false });
    assert.deepStrictEqual(result, NONE_RESULT);
  });

  test('CODEX_HOME pointing at a file degrades to no detection', (t) => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-home-file-')), 'not-a-dir');
    fs.writeFileSync(tmpFile, 'not a codex home\n');
    t.after(() => cleanup(path.dirname(tmpFile)));
    // No `fileExists` override: exercises the real fs.existsSync default.
    assert.doesNotThrow(() => {
      const result = detectHostRuntime({ env: { CODEX_HOME: tmpFile } });
      assert.deepStrictEqual(result, NONE_RESULT);
    });
  });

  test('empty CODEX_HOME is unset', () => {
    const result = detectHostRuntime({ env: { CODEX_HOME: '' }, fileExists: () => true });
    assert.deepStrictEqual(result, NONE_RESULT);
  });

  test('a throwing fileExists degrades rather than propagating', () => {
    const throwingFileExists = () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    };
    assert.doesNotThrow(() => {
      const result = detectHostRuntime({ env: { CODEX_HOME: '/some/codex/home' }, fileExists: throwingFileExists });
      assert.deepStrictEqual(result, NONE_RESULT);
    });
  });

  test('the default codex home is never probed', () => {
    // Every machine that has ever run Codex has ~/.codex/config.toml, so
    // probing the DEFAULT home unconditionally would misreport a plain
    // Claude session as codex just because Codex was installed at some
    // point. Detection must require an explicit CODEX_HOME.
    const defaultMarker = path.join(os.homedir(), '.codex', 'config.toml');
    const spy = spyFileExists([defaultMarker]);
    const result = detectHostRuntime({ env: {}, fileExists: spy });
    assert.strictEqual(result.runtime, null);
    assert.ok(
      spy.calls.every((p) => !p.includes('/.codex/')),
      `expected no probe of the default ~/.codex root, got: ${JSON.stringify(spy.calls)}`,
    );
  });

  test('detection never writes shared defaults or any file (#2297)', (t) => {
    const writeFileMock = mock.method(fs, 'writeFileSync', () => {});
    const appendFileMock = mock.method(fs, 'appendFileSync', () => {});
    const mkdirMock = mock.method(fs, 'mkdirSync', () => {});
    t.after(() => {
      writeFileMock.mock.restore();
      appendFileMock.mock.restore();
      mkdirMock.mock.restore();
    });

    detectHostRuntime({ env: {}, fileExists: () => false });
    detectHostRuntime({ env: { CODEX_SANDBOX: 'seatbelt' }, fileExists: () => false });
    detectHostRuntime({ env: { CODEX_HOME: '/some/codex/home' }, fileExists: () => true });

    assert.strictEqual(writeFileMock.mock.callCount(), 0);
    assert.strictEqual(appendFileMock.mock.callCount(), 0);
    assert.strictEqual(mkdirMock.mock.callCount(), 0);
  });

  test('signal table is frozen and locked', () => {
    assert.strictEqual(Object.isFrozen(CODEX_SESSION_ENV_SIGNALS), true);
    assert.deepStrictEqual(
      [...CODEX_SESSION_ENV_SIGNALS].sort(),
      ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'],
    );
  });
});

// ─── resolveReportedRuntime precedence ──────────────────────────────────

describe('resolveReportedRuntime: precedence', () => {
  function withProject(t) {
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    const tmpDir = createTempProject();
    t.after(() => {
      cleanup(tmpDir);
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
    });
    return tmpDir;
  }

  test('env runtime wins with no other signal', (t) => {
    const tmpDir = withProject(t);
    const result = resolveReportedRuntime(tmpDir, { env: { GSD_RUNTIME: 'opencode' } });
    assert.strictEqual(result, 'opencode');
  });

  test('GSD_RUNTIME outranks config and detection', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, JSON.stringify({ runtime: 'claude' }));
    const result = resolveReportedRuntime(tmpDir, {
      env: { GSD_RUNTIME: 'opencode', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' },
    });
    assert.strictEqual(result, 'opencode');
  });

  test('env alias normalizes before detection can fire', (t) => {
    const tmpDir = withProject(t);
    const result = resolveReportedRuntime(tmpDir, { env: { GSD_RUNTIME: 'codex-cli' } });
    assert.strictEqual(result, 'codex');
  });

  test('invalid GSD_RUNTIME falls through to config', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, JSON.stringify({ runtime: 'kimi' }));
    const result = resolveReportedRuntime(tmpDir, { env: { GSD_RUNTIME: '   ' } });
    assert.strictEqual(result, 'kimi');
  });

  test('explicit config runtime outranks detection (#2517 preserved)', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, JSON.stringify({ runtime: 'claude' }));
    const result = resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } });
    assert.strictEqual(result, 'claude');
  });

  test('explicit codex config unchanged', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, JSON.stringify({ runtime: 'codex' }));
    const result = resolveReportedRuntime(tmpDir, { env: {} });
    assert.strictEqual(result, 'codex');
  });

  test('no signal resolves to the claude default', (t) => {
    const tmpDir = withProject(t);
    const result = resolveReportedRuntime(tmpDir, { env: {} });
    assert.strictEqual(result, 'claude');
  });

  test('missing config file still detects', (t) => {
    const tmpDir = withProject(t);
    const result = resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } });
    assert.strictEqual(result, 'codex');
  });

  test('malformed config json falls through to detection', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, '{ this is not json');
    const result = resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } });
    assert.strictEqual(result, 'codex');
  });

  test('non-object config json is not a runtime source', (t) => {
    const tmpDir = withProject(t);
    const rawBodies = ['0', '"str"', '[]', 'null', 'true', ''];
    for (const raw of rawBodies) {
      writeConfig(tmpDir, raw);
      assert.strictEqual(
        resolveReportedRuntime(tmpDir, { env: {} }),
        'claude',
        `raw config body ${JSON.stringify(raw)} unexpectedly acted as a runtime source (no signal)`,
      );
      assert.strictEqual(
        resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } }),
        'codex',
        `raw config body ${JSON.stringify(raw)} unexpectedly blocked detection`,
      );
    }
  });

  test('crlf config json is unaffected', (t) => {
    const tmpDir = withProject(t);
    const crlfConfig = ['{', '  "runtime": "kimi"', '}'].join('\r\n');
    writeConfig(tmpDir, crlfConfig);
    const result = resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } });
    assert.strictEqual(result, 'kimi');
  });

  test('windows-shaped CODEX_HOME joins portably', (t) => {
    const tmpDir = withProject(t);
    const windowsHome = 'C:\\Users\\me\\.codex';
    const spy = spyFileExists([path.join(windowsHome, 'config.toml')]);
    const result = resolveReportedRuntime(tmpDir, {
      env: { CODEX_HOME: windowsHome },
      fileExists: spy,
    });
    assert.strictEqual(result, 'codex');
  });

  test('detection never mutates the project config', (t) => {
    const tmpDir = withProject(t);
    writeConfig(tmpDir, JSON.stringify({ runtime: 'claude' }));
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const before = fs.readFileSync(configPath);
    resolveReportedRuntime(tmpDir, { env: { CODEX_SANDBOX: 'seatbelt' } });
    const after = fs.readFileSync(configPath);
    assert.deepStrictEqual(before, after);
  });

  test('default deps match injected deps', (t) => {
    const tmpDir = withProject(t);
    const savedCodexSandbox = process.env.CODEX_SANDBOX;
    process.env.CODEX_SANDBOX = 'seatbelt';
    t.after(() => {
      if (savedCodexSandbox === undefined) delete process.env.CODEX_SANDBOX;
      else process.env.CODEX_SANDBOX = savedCodexSandbox;
    });

    const viaDefaultDeps = resolveReportedRuntime(tmpDir);
    const viaInjectedDeps = resolveReportedRuntime(tmpDir, { env: process.env });
    assert.strictEqual(viaDefaultDeps, 'codex');
    assert.strictEqual(viaDefaultDeps, viaInjectedDeps);
  });
});

// ─── runtime-slash frozen contract ──────────────────────────────────────

describe('runtime-slash: frozen contract (#3245 extraction must not move it)', () => {
  test('resolveRuntime contract is unchanged by the extraction', (t) => {
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    t.after(() => {
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
    });

    assert.strictEqual(resolveRuntime(undefined), 'claude');
    assert.strictEqual(resolveRuntime(null), 'claude');
    assert.strictEqual(
      resolveRuntime(path.join(os.tmpdir(), 'gsd-nonexistent-project-' + Date.now())),
      'claude',
    );

    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    assert.strictEqual(resolveRuntime(tmpDir), 'claude');

    writeConfig(tmpDir, JSON.stringify({ runtime: 'opencode' }));
    assert.strictEqual(resolveRuntime(tmpDir), 'opencode');

    process.env.GSD_RUNTIME = 'kimi';
    assert.strictEqual(resolveRuntime(tmpDir), 'kimi');
  });

  test('resolveRuntime ignores a codex session signal', (t) => {
    // Detection is deliberately NOT wired into resolveRuntime — only
    // resolveReportedRuntime's separate ladder consults it — so command-style
    // emission (formatGsdSlash et al.) does not move (ADR-2313 scope boundary).
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    const savedCodexSandbox = process.env.CODEX_SANDBOX;
    delete process.env.GSD_RUNTIME;
    process.env.CODEX_SANDBOX = 'seatbelt';
    t.after(() => {
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
      if (savedCodexSandbox === undefined) delete process.env.CODEX_SANDBOX;
      else process.env.CODEX_SANDBOX = savedCodexSandbox;
    });

    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    assert.strictEqual(resolveRuntime(tmpDir), 'claude');
  });

  test('explicit claude is distinguishable from the default', (t) => {
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    t.after(() => {
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
    });

    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    assert.strictEqual(resolveExplicitRuntime(tmpDir), null);

    writeConfig(tmpDir, JSON.stringify({ runtime: 'claude' }));
    assert.strictEqual(resolveExplicitRuntime(tmpDir), 'claude');
  });
});

// ─── Generative-fix-divergence parity with inferPreferredRuntime ────────

describe('parity with update-context.cjs:inferPreferredRuntime (generative-fix-divergence guard)', () => {
  // Two surfaces independently encode "what indicates Codex" —
  // inferPreferredRuntime (update.md's version-detection ladder) and
  // detectHostRuntime (init's agent_runtime rung). This pins them to agree
  // on the CODEX_HOME signal so a future edit to one cannot silently diverge
  // from the other.
  test('codex signal parity with inferPreferredRuntime', () => {
    const dir = path.join(os.tmpdir(), 'not-a-real-codex-home');
    const env = { CODEX_HOME: dir };

    const inferred = updateContext.inferPreferredRuntime({
      fs: { exists: () => false, readFile: () => null },
      env,
      preferredConfigDir: '',
    });
    assert.strictEqual(inferred, 'codex');

    const spy = spyFileExists([path.join(dir, 'config.toml')]);
    const detected = detectHostRuntime({ env, fileExists: spy });
    assert.strictEqual(detected.runtime, 'codex');
  });

  test('config.toml is the shared codex marker filename', () => {
    const dir = path.join(os.tmpdir(), 'preferred-config-dir');
    const marker = path.join(dir, CODEX_CONFIG_MARKER);

    const inferred = updateContext.inferPreferredRuntime({
      fs: { exists: (p) => p === marker, readFile: () => null },
      env: {},
      preferredConfigDir: dir,
    });
    assert.strictEqual(inferred, 'codex');
    assert.strictEqual(CODEX_CONFIG_MARKER, 'config.toml');
  });
});

// ─── Properties ──────────────────────────────────────────────────────────

describe('detectHostRuntime: properties', () => {
  const FC_OPTS = { numRuns: 200, seed: 32452843, verbose: true };

  test('property — no signal key implies no detection', () => {
    const excludedKeys = new Set([...CODEX_SESSION_ENV_SIGNALS, CODEX_CONFIG_HOME_ENV]);
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !excludedKeys.has(k)),
          fc.string(),
        ),
        (env) => {
          const result = detectHostRuntime({ env, fileExists: () => false });
          assert.deepStrictEqual(result, NONE_RESULT);
        },
      ),
      FC_OPTS,
    );
  });

  test('property — any non-empty signal value detects codex', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CODEX_SESSION_ENV_SIGNALS),
        fc.string().filter((s) => s.trim() !== ''),
        (key, value) => {
          const result = detectHostRuntime({ env: { [key]: value }, fileExists: () => false });
          assert.deepStrictEqual(result, { runtime: 'codex', source: 'session-env', signal: key });
        },
      ),
      FC_OPTS,
    );
  });
});
