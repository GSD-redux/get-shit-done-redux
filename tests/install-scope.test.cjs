'use strict';

/**
 * Failing-first suite for the Install Scope Module (#2870, ADR-2866).
 *
 * Asserts `resolveScope`'s contract from
 * .gsd/phase/feat-2870-install-scope-module/40-design.md against the test
 * matrix at .gsd/phase/feat-2870-install-scope-module/50-test-matrix.md
 * (rows 1-19; row 20 lands with the bin/install.js call-site migration and
 * is deliberately out of scope here).
 *
 * Every case injects `env` / `home` / `existsSync` — mirroring
 * `runtime-homes.cts`'s `ResolveConfigHomeOpts` shape — instead of touching
 * the real filesystem or the real home directory: no `mkdtempSync`, no
 * `os.homedir()`. The module under test does not exist yet, so requiring it
 * below throws `MODULE_NOT_FOUND`. That is the point: this suite is RED
 * until src/install-scope.cts lands and builds to
 * gsd-core/bin/lib/install-scope.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveScope, isGlobalScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { createRuntimeArtifactInstallPlan } = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');

const FAKE_HOME = '/fake/home';
const NO_EXISTS = () => false;

function fixture(overrides) {
  return { env: {}, home: FAKE_HOME, existsSync: NO_EXISTS, ...overrides };
}

// #2103: `vscode` enters `registry.runtimes` (role:runtime, kept for
// validator / host-integration coverage) but declares
// `configHome.kind === 'none'` — no file-projected config directory exists
// to resolve at all — and it is never CLI-installed (no --vscode flag,
// absent from bin/install.js's `allRuntimes`). This is the same carve-out
// tests/runtime-flags.test.cjs's `NON_INSTALLABLE_RUNTIMES` documents:
// install-scope's global-configHome resolution has nothing to resolve for a
// runtime with no config directory, so it is excluded from the "every
// runtime" sweep below rather than assumed to resolve like every other
// registered runtime. The excluded case itself is asserted directly by
// 'rejects a runtime with no config home' below (design row 13) — it is
// covered, not dropped.
const NON_INSTALLABLE_RUNTIMES = new Set(['vscode']);
const INSTALL_SCOPE_RUNTIME_IDS = Object.keys(registry.runtimes)
  .filter((id) => !NON_INSTALLABLE_RUNTIMES.has(id));

describe('resolveScope', () => {
  // Row 1
  test('resolves claude global settings file', () => {
    const result = resolveScope(fixture({ id: 'global', runtime: 'claude' }));
    assert.strictEqual(result.settingsFile, 'settings.json');
  });

  // Row 2
  test('resolves claude local settings file', () => {
    const result = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project' }));
    assert.strictEqual(result.settingsFile, 'settings.local.json');
  });

  // Row 3
  test('returns null settingsFile for runtimes that declare none', () => {
    const result = resolveScope(fixture({ id: 'global', runtime: 'codex' }));
    assert.strictEqual(result.settingsFile, null);
  });

  // Row 4
  test('resolves for every registered runtime at both scopes', () => {
    assert.ok(INSTALL_SCOPE_RUNTIME_IDS.length > 0, 'registry must contain at least one installable runtime');
    for (const runtime of INSTALL_SCOPE_RUNTIME_IDS) {
      for (const id of ['global', 'local']) {
        const result = resolveScope(fixture({ id, runtime, cwd: '/fake/project' }));
        assert.strictEqual(typeof result.configHome, 'string', `${runtime}/${id}: configHome must be a string`);
        assert.ok(result.configHome.length > 0, `${runtime}/${id}: configHome must be non-empty`);
        assert.ok(
          result.settingsFile === null || typeof result.settingsFile === 'string',
          `${runtime}/${id}: settingsFile must be string or null`,
        );
      }
    }
  });

  // Row 5
  test('global scope requires no consent record', () => {
    const result = resolveScope(fixture({ id: 'global', runtime: 'claude' }));
    assert.strictEqual(result.consentRequired, false);
  });

  // Row 6
  test('local scope requires a consent record', () => {
    const result = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project' }));
    assert.strictEqual(result.consentRequired, true);
  });

  // Row 7 — assert the RELATION, never a literal rank number (unread this
  // phase; Phase 2 may re-base the literal values).
  test('global outranks local in hostPrecedenceRank', () => {
    const globalScope = resolveScope(fixture({ id: 'global', runtime: 'claude' }));
    const localScope = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project' }));
    assert.ok(
      globalScope.hostPrecedenceRank > localScope.hostPrecedenceRank,
      `expected global rank (${globalScope.hostPrecedenceRank}) > local rank (${localScope.hostPrecedenceRank})`,
    );
  });

  // Row 8
  test('explicit config dir overrides descriptor resolution', () => {
    const result = resolveScope(fixture({ id: 'global', runtime: 'claude', explicitDir: '/custom/config/dir' }));
    assert.strictEqual(result.configHome, '/custom/config/dir');
  });

  // Row 9
  test('rejects the consent-vocabulary spelling', () => {
    assert.throws(
      () => resolveScope(fixture({ id: 'project', runtime: 'claude' })),
      (err) => err instanceof TypeError && /global/i.test(err.message) && /local/i.test(err.message),
    );
  });

  // Row 10
  test('rejects case variants', () => {
    assert.throws(
      () => resolveScope(fixture({ id: 'Global', runtime: 'claude' })),
      TypeError,
    );
  });

  // Row 11
  test('rejects empty and missing scope id', () => {
    assert.throws(() => resolveScope(fixture({ id: '', runtime: 'claude' })), TypeError, 'id: empty string');
    assert.throws(() => resolveScope(fixture({ id: undefined, runtime: 'claude' })), TypeError, 'id: undefined');
    const { home, env, existsSync } = fixture({});
    assert.throws(() => resolveScope({ runtime: 'claude', home, env, existsSync }), TypeError, 'id: absent key');
  });

  // Row 12
  test('rejects unknown runtime with the established error contract', () => {
    assert.throws(
      () => resolveScope(fixture({ id: 'global', runtime: 'no-such-runtime' })),
      (err) => err instanceof TypeError && err.message.includes('no-such-runtime'),
    );
  });

  // Design row 13: a runtime whose descriptor has `configHome.kind ===
  // 'none'` — vscode is the only one — has no installable config directory
  // to resolve at all. Same contract as row 9 (unknown runtime): TypeError
  // naming the runtime, one catch shape for callers.
  test('rejects a runtime with no config home', () => {
    assert.throws(
      () => resolveScope(fixture({ id: 'global', runtime: 'vscode' })),
      (err) => err instanceof TypeError
        && err.message === "resolveScope: runtime 'vscode' has no installable config directory (configHome.kind === 'none')",
    );
    assert.throws(
      () => resolveScope(fixture({ id: 'local', runtime: 'vscode' })),
      (err) => err instanceof TypeError
        && err.message === "resolveScope: runtime 'vscode' has no installable config directory (configHome.kind === 'none')",
    );
  });

  // Row 13
  test('rejects non-string scope ids without coercion', () => {
    for (const id of [0, null, {}, ['global']]) {
      assert.throws(
        () => resolveScope(fixture({ id, runtime: 'claude' })),
        TypeError,
        `id=${JSON.stringify(id)} must throw TypeError, not coerce`,
      );
    }
  });

  // Row 14
  test('preserves opencode/kilo config-file precedence', () => {
    const filePath = '/home/x/custom/opencode-config.json';
    const result = resolveScope(fixture({
      id: 'global',
      runtime: 'opencode',
      env: { OPENCODE_CONFIG: filePath },
    }));
    assert.strictEqual(result.configHome, path.dirname(filePath));
  });

  // Row 15
  test('blank env override does not win', () => {
    const expected = path.join(FAKE_HOME, '.claude');
    const empty = resolveScope(fixture({ id: 'global', runtime: 'claude', env: { CLAUDE_CONFIG_DIR: '' } }));
    const whitespace = resolveScope(fixture({ id: 'global', runtime: 'claude', env: { CLAUDE_CONFIG_DIR: '   ' } }));
    assert.strictEqual(empty.configHome, expected);
    assert.strictEqual(whitespace.configHome, expected);
  });

  // Row 16
  test('is pure and does not mutate its input', () => {
    const input = Object.freeze(fixture({ id: 'global', runtime: 'claude' }));
    const first = resolveScope(input);
    const second = resolveScope(input);
    assert.deepStrictEqual(first, second);
  });

  // Row 17
  test('normalizes backslash paths on every platform', () => {
    const result = resolveScope(fixture({ id: 'global', runtime: 'claude', home: 'C:\\Users\\x' }));
    assert.ok(!result.configHome.includes('\\'), `configHome must not contain backslashes: ${result.configHome}`);
    assert.strictEqual(result.configHome, 'C:/Users/x/.claude');
  });

  // Row 18
  test('returned value cannot be corrupted by a caller', () => {
    const input = fixture({ id: 'global', runtime: 'claude' });
    const first = resolveScope(input);
    const originalConfigHome = first.configHome;
    try {
      first.configHome = 'HACKED';
    } catch {
      // A frozen result rejecting the mutation outright is an acceptable
      // defense too — either way, a second resolution must be unaffected.
    }
    const second = resolveScope(input);
    assert.strictEqual(second.configHome, originalConfigHome);
  });

  // Row 19
  test('install-plan imports the shared InstallScope type', () => {
    const globalScope = resolveScope(fixture({ id: 'global', runtime: 'claude' }));
    const localScope = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project' }));
    for (const scope of [globalScope, localScope]) {
      const result = createRuntimeArtifactInstallPlan({
        layout: {
          runtime: 'claude',
          configDir: scope.configHome,
          scope: scope.id,
          kinds: [],
        },
        resolvedProfile: { name: 'core' },
      });
      assert.strictEqual(
        result.ok,
        true,
        `runtime-artifact-install-plan must accept install-scope's '${scope.id}' spelling directly`,
      );
    }
  });

  // Row 16 follow-up: local scope's configHome must be assertable via an
  // injected cwd, never the real process.cwd().
  test('local scope resolves configHome against an injected cwd', () => {
    const first = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project-a' }));
    const second = resolveScope(fixture({ id: 'local', runtime: 'claude', cwd: '/fake/project-b' }));
    assert.notStrictEqual(first.configHome, second.configHome);
    assert.strictEqual(first.configHome, path.join('/fake/project-a', '.claude'));
    assert.strictEqual(second.configHome, path.join('/fake/project-b', '.claude'));
  });
});

describe('isGlobalScope', () => {
  // #2870: the shared boolean projection that replaced four independent
  // inline `scope === 'global'` re-derivations.
  test('returns true only for global', () => {
    assert.strictEqual(isGlobalScope('global'), true);
  });

  test('returns false for local', () => {
    assert.strictEqual(isGlobalScope('local'), false);
  });

  // Parity assertion: isGlobalScope must throw the SAME TypeError contract
  // resolveScope's invalid-id case (Row 9) throws, since both share
  // install-scope.cts's one validator — never a second, divergent one.
  test('throws TypeError for an invalid id, matching resolveScope\'s contract', () => {
    assert.throws(
      () => isGlobalScope('project'),
      (err) => err instanceof TypeError && /global/i.test(err.message) && /local/i.test(err.message),
    );
  });
});
