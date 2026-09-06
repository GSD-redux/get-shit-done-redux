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
const { RUNTIME_DIRS, inferPreferredRuntime, resolveUpdateContext } = require(
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

test('unknown preferred config does not infer Claude', () => {
  assert.equal(inferPreferredRuntime({ fs: fakeFs({}), env: {}, preferredConfigDir: '/opt/unknown' }), '');
});

test('known runtime directories infer their table runtime without config markers', () => {
  for (const [runtime, relativeDir] of RUNTIME_DIRS) {
    const preferredConfigDir = path.resolve(HOME, relativeDir);
    assert.equal(
      inferPreferredRuntime({ fs: fakeFs({}), env: {}, preferredConfigDir }),
      runtime,
      preferredConfigDir,
    );
  }
});

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

  test('no install anywhere -> UNKNOWN / empty runtime / empty gsdDir', () => {
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: fakeFs({}) });
    assert.deepEqual(r, { installedVersion: '0.0.0', scope: 'UNKNOWN', runtime: '', gsdDir: '' });
    assert.deepEqual(
      resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: fakeFs({}) }),
      r,
      'unresolved resolution must remain deterministic',
    );
  });

  test('multiple installs honor an explicit preferred runtime', () => {
    const claude = `${HOME}/.claude`;
    const codex = `${HOME}/.codex`;
    const fs = fakeFs({
      [ver(claude)]: '1.40.0\n', [marker(claude)]: 'x',
      [ver(codex)]: '1.41.0\n', [marker(codex)]: 'x',
    });
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs, preferredRuntime: 'codex',
    });
    assert.equal(r.runtime, 'codex');
    assert.equal(r.scope, 'GLOBAL');
    assert.ok(sameDir(r.gsdDir, codex), `gsdDir was ${r.gsdDir}`);
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

  test('preferredConfigDir fast-path: unknown dir with no preferredRuntime resolves runtime empty (#4153)', () => {
    const custom = '/opt/custom-gsd';
    const fs = fakeFs({ [ver(custom)]: '1.0.0\n', [marker(custom)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs, preferredConfigDir: custom });
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, '', 'a dir matching no RUNTIME_DIRS suffix, marker, or env must fail closed, not default to claude');
  });

  // #4197: the dedup at line 88 above ("cwd === home does NOT misdetect as
  // LOCAL") only ever exercised the slow path, so the fast path added for #498
  // could drop the guarantee without failing anything. These three rows put the
  // same invariant on the fast path, and pin that fixing it did not simply make
  // every fast-path answer GLOBAL.
  test('cwd === home does NOT misdetect as LOCAL on the preferredConfigDir fast path (#4197)', () => {
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const r = resolveUpdateContext({
      home: HOME, cwd: HOME, env: {}, fs,
      preferredConfigDir: `${HOME}/.claude`, preferredRuntime: 'claude',
    });
    assert.equal(r.scope, 'GLOBAL',
      'a global install is GLOBAL wherever the shell is sitting; LOCAL here makes /gsd-update ' +
      'run the installer with --local against it');
  });

  test('scope is independent of cwd for a validated global install (#4197)', () => {
    // The invariant the reproduction states: identical inputs differing ONLY in
    // cwd must not disagree. Both calls go through the FAST path, so this
    // compares two cwd values within it — it says nothing about the slow path's
    // own dedup, which the line-88 row covers (Codex review of this PR).
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const at = (cwd) => resolveUpdateContext({
      home: HOME, cwd, env: {}, fs,
      preferredConfigDir: `${HOME}/.claude`, preferredRuntime: 'claude',
    }).scope;

    assert.equal(at(HOME), at(CWD), 'cwd must not change the scope of the same install');
    assert.equal(at(HOME), 'GLOBAL');
  });

  test('an env-directed global elsewhere leaves $HOME/.claude LOCAL, even at home (#4197)', () => {
    // Codex review of this PR caught this as a regression in the first cut of
    // the fix. Comparing the preferred dir against the home-relative PATHNAME
    // called this GLOBAL; comparing it against the SELECTED global candidate
    // keeps it LOCAL, which is what the slow path has always answered here.
    //
    // The shape is a supported install layout: CLAUDE_CONFIG_DIR points the
    // global install at /opt/claude-global, and the user ALSO has a real
    // project-local install in a project that happens to be $HOME. Reporting
    // GLOBAL would send update.md's run_update at /opt/claude-global and leave
    // the install the operator is actually sitting in untouched.
    const globalDir = '/opt/claude-global';
    const fs = fakeFs({
      [ver(`${HOME}/.claude`)]: '1.39.0\n', [marker(`${HOME}/.claude`)]: 'x',
      [ver(globalDir)]: '1.40.0\n', [marker(globalDir)]: 'x',
    });
    const r = resolveUpdateContext({
      home: HOME, cwd: HOME, env: { CLAUDE_CONFIG_DIR: globalDir }, fs,
      preferredConfigDir: `${HOME}/.claude`, preferredRuntime: 'claude',
    });

    assert.equal(r.scope, 'LOCAL',
      'with the global install directed elsewhere by CLAUDE_CONFIG_DIR, a config dir under ' +
      '$HOME is a genuine project-local install and must stay LOCAL');
    assert.equal(r.installedVersion, '1.39.0', 'the preferred dir stays the selected install');
  });

  test('the fast path and the cascade agree when an env candidate IS the preferred dir (#4197)', () => {
    // The other side of sharing one global resolver, and a behaviour change the
    // PR discloses: previously the fast path ignored env candidates entirely,
    // so a preferred dir that is ALSO the env-directed global answered LOCAL
    // while the cascade answered GLOBAL for the same input. One resolver, one
    // answer.
    const dir = `${CWD}/.claude`;
    const fs = fakeFs({ [ver(dir)]: '1.41.0\n', [marker(dir)]: 'x' });
    const fast = resolveUpdateContext({
      home: HOME, cwd: CWD, env: { CLAUDE_CONFIG_DIR: dir }, fs,
      preferredConfigDir: dir, preferredRuntime: 'claude',
    });
    const cascade = resolveUpdateContext({
      home: HOME, cwd: CWD, env: { CLAUDE_CONFIG_DIR: dir }, fs,
    });

    assert.equal(fast.scope, cascade.scope,
      'the same install must not be LOCAL through the fast path and GLOBAL through the cascade');
    assert.equal(fast.scope, 'GLOBAL',
      'an env-directed install IS the global one, whatever its pathname');
  });

  test('a genuine project-local install still reports LOCAL on the fast path (#4197)', () => {
    // Non-vacuity control for the two rows above: the home-relative guard must
    // reject ONLY the cwd === home case, not the fast path's LOCAL arm as such.
    const local = `${CWD}/.claude`;
    const fs = fakeFs({ [ver(local)]: '1.39.0\n', [marker(local)]: 'x' });
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs,
      preferredConfigDir: local, preferredRuntime: 'claude',
    });
    assert.equal(r.scope, 'LOCAL',
      'a config dir under a cwd that is NOT home is a real project-local install');
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
