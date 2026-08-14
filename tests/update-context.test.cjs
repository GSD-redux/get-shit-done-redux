'use strict';
process.env.GSD_TEST_MODE = '1';

// Issue #498 (candidate 3): resolveUpdateContext ports update.md's ~280-line
// get_installed_version bash into a pure, injected-fs function. It returns the
// same 4-field contract the workflow emits: { installedVersion, scope, runtime,
// gsdDir }. The fs is injected (exists/readFile) so the precedence cascade is
// finally testable without a live multi-runtime install.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nodeFs = require('node:fs');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const { cleanup } = require('./helpers.cjs');
const { resolveUpdateContext } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'),
);

// Normalize a path to a platform-agnostic key: resolve to absolute, then
// lowercase forward-slash form. This makes the fake fs match the resolver's
// path.join/path.resolve lookups on Windows (backslash + drive letter) as well
// as POSIX, so these unit tests are not OS-coupled.
function normKey(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

// Build an injected fs from a map of absolute path -> contents. Marker files
// (VERSION, workflows/update.md) just need to "exist".
function fakeFs(files) {
  const set = new Map();
  for (const [k, v] of Object.entries(files)) set.set(normKey(k), v);
  return {
    exists: (p) => set.has(normKey(p)),
    readFile: (p) => { const k = normKey(p); return set.has(k) ? set.get(k) : null; },
  };
}

// Compare resolved-dir results without coupling to OS path style.
function sameDir(a, b) { return normKey(a) === normKey(b); }

const HOME = '/home/u';
const CWD = '/work/proj';

function ver(dir) { return `${dir}/gsd-core/VERSION`; }
function marker(dir) { return `${dir}/gsd-core/workflows/update.md`; }

describe('resolveUpdateContext: scope cascade', () => {
  test('GLOBAL claude install under $HOME/.claude', () => {
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.installedVersion, '1.40.0');
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'claude');
    assert.ok(sameDir(r.gsdDir, `${HOME}/.claude`), `gsdDir was ${r.gsdDir}`);
  });

  test('LOCAL install under ./.claude takes priority over global', () => {
    const fs = fakeFs({
      [ver(`${CWD}/.claude`)]: '1.39.0\n', [marker(`${CWD}/.claude`)]: 'x',
      [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.39.0');
    assert.ok(sameDir(r.gsdDir, `${CWD}/.claude`), `gsdDir was ${r.gsdDir}`);
  });

  test('cwd === home does NOT misdetect as LOCAL (dedup)', () => {
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: HOME, env: {}, fs });
    assert.equal(r.scope, 'GLOBAL');
  });

  test('runtime detected but VERSION missing -> 0.0.0, keep scope/runtime', () => {
    const fs = fakeFs({ [marker(`${HOME}/.codex`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.installedVersion, '0.0.0');
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'codex');
  });

  test('no install anywhere -> UNKNOWN / claude / empty gsdDir', () => {
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: fakeFs({}) });
    assert.deepEqual(r, { installedVersion: '0.0.0', scope: 'UNKNOWN', runtime: 'claude', gsdDir: '' });
  });
});

describe('resolveUpdateContext: runtime probing + env overrides', () => {
  test('opencode global under $HOME/.config/opencode', () => {
    const dir = `${HOME}/.config/opencode`;
    const fs = fakeFs({ [ver(dir)]: '1.40.0\n', [marker(dir)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.runtime, 'opencode');
    assert.ok(sameDir(r.gsdDir, dir), `gsdDir was ${r.gsdDir}`);
  });

  test('CLAUDE_CONFIG_DIR env override locates a custom global dir', () => {
    const custom = '/opt/claude-home';
    const fs = fakeFs({ [ver(custom)]: '1.40.0\n', [marker(custom)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: { CLAUDE_CONFIG_DIR: custom }, fs });
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'claude');
    assert.ok(sameDir(r.gsdDir, custom), `gsdDir was ${r.gsdDir}`);
  });

  test('preferredConfigDir fast-path: trusts a validated custom dir as GLOBAL', () => {
    const custom = '/opt/gsd-x';
    const fs = fakeFs({ [ver(custom)]: '1.41.0\n', [marker(custom)]: 'x' });
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs,
      preferredConfigDir: custom, preferredRuntime: 'kilo',
    });
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'kilo');
    assert.ok(sameDir(r.gsdDir, custom), `gsdDir was ${r.gsdDir}`);
    assert.equal(r.installedVersion, '1.41.0');
  });
});

describe('gsd-tools update-context (CLI): emits the JSON contract', () => {
  test('--config-dir fixture resolves to the documented 4-field JSON', () => {
    const tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uc-'));
    try {
      nodeFs.mkdirSync(path.join(tmp, 'gsd-core', 'workflows'), { recursive: true });
      nodeFs.writeFileSync(path.join(tmp, 'gsd-core', 'VERSION'), '1.42.0\n');
      nodeFs.writeFileSync(path.join(tmp, 'gsd-core', 'workflows', 'update.md'), 'x');
      const r = runNode(
        [GSD_TOOLS, 'update-context', '--config-dir', tmp, '--runtime', 'kilo', '--json'],
        { env: { ...process.env, GSD_TEST_MODE: '1' }, timeoutMs: PROBE_TIMEOUT_MS },
      );
      throwIfFailed(r, 'gsd-tools update-context --json');
      const ctx = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(ctx).sort(), ['gsdDir', 'installedVersion', 'runtime', 'scope']);
      assert.equal(ctx.installedVersion, '1.42.0');
      assert.equal(ctx.scope, 'GLOBAL');
      assert.equal(ctx.runtime, 'kilo');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('resolveUpdateContext: parity with the old inline bash (adversarial-review)', () => {
  test('preferredConfigDir with a leading ~/ is expanded before the fast path', () => {
    // The old inline bash ran `expand_home "$PREFERRED_CONFIG_DIR"` first, so a
    // custom --config-dir like ~/custom-gsd must resolve, not fall to UNKNOWN.
    const fs = fakeFs({
      [ver(`${HOME}/custom-gsd`)]: '1.41.0\n',
      [marker(`${HOME}/custom-gsd`)]: 'x',
    });
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs, preferredConfigDir: '~/custom-gsd',
    });
    assert.equal(r.installedVersion, '1.41.0');
    assert.equal(r.scope, 'GLOBAL');
    assert.ok(sameDir(r.gsdDir, `${HOME}/custom-gsd`), `gsdDir was ${r.gsdDir}`);
  });

  test('a VERSION-only dir (no update.md marker) is NOT trusted as a real version', () => {
    // The old cascade required BOTH VERSION and the update.md marker before
    // trusting the version; a partial dir falls to 0.0.0 but keeps scope.
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n' }); // marker absent
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.installedVersion, '0.0.0', 'VERSION-only dir must not be trusted');
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'claude');
    assert.ok(sameDir(r.gsdDir, `${HOME}/.claude`), `gsdDir was ${r.gsdDir}`);
  });

  test('fast path also requires the marker: VERSION-only preferredConfigDir -> 0.0.0', () => {
    // The "trust = VERSION + marker" rule is consistent across every path, not
    // just the cascade. A custom --config-dir with VERSION but no marker is a
    // partial install: keep the dir/scope, report 0.0.0.
    const custom = '/opt/gsd-partial';
    const fs = fakeFs({ [ver(custom)]: '1.41.0\n' }); // marker absent
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs, preferredConfigDir: custom, preferredRuntime: 'kilo',
    });
    assert.equal(r.installedVersion, '0.0.0', 'VERSION-only fast path must not be trusted');
    assert.equal(r.scope, 'GLOBAL');
    assert.ok(sameDir(r.gsdDir, custom), `gsdDir was ${r.gsdDir}`);
  });

  test('partial install with cwd===home does NOT misdetect as LOCAL (fallback dedup)', () => {
    // Same same-path dedup the trusted path uses must apply to the 0.0.0
    // fallback: a VERSION-only ~/.claude probed from cwd===home is GLOBAL.
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n' }); // marker absent
    const r = resolveUpdateContext({ home: HOME, cwd: HOME, env: {}, fs });
    assert.equal(r.installedVersion, '0.0.0');
    assert.equal(r.scope, 'GLOBAL', 'cwd===home partial must be GLOBAL, not LOCAL');
    assert.ok(sameDir(r.gsdDir, `${HOME}/.claude`), `gsdDir was ${r.gsdDir}`);
  });
});
