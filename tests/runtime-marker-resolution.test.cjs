'use strict';

/**
 * #3897 rung 2 — the per-install `.gsd-runtime` marker rung in the CANONICAL
 * runtime resolver (`resolveRuntime`, src/runtime-slash.cts).
 *
 * MINED FROM PR #3382 (closed, unmerged — "Closing unmerged — not on the
 * merits."): that PR's `tests/runtime-marker-resolution.test.cjs` drove real
 * `bin/install.js` installs end-to-end (6 tests). This file reuses its
 * fixture/seam CONTRACT — `readInstallRuntimeMarker`, `_setInstallRuntimeMarkerForTests`,
 * `_resetInstallRuntimeMarkerCacheForTests` exported from the canonical owner
 * `runtime-slash.cts`, the same `neutralProject` shape (a `.planning/config.json`
 * with NO `runtime` key, matching what `config-new-project` actually writes),
 * and the "marker rung sits between config and the default" precedence — but
 * exercises it at the resolver-unit level (in-process, monkeypatched `fs`)
 * rather than through full spawned installs, per the test-matrix's rung-2
 * automation note ("unit on the resolution ladder + the cache; integration
 * for the hooks' delegation").
 *
 * Today (before #3897 rung 2 lands) `src/runtime-slash.cts` exports no marker
 * reader and no test seams at all — `resolveRuntime` is a one-liner over
 * `resolveExplicitRuntime(...) ?? 'claude'`. Every test below therefore fails
 * at `assertMarkerSeamExists` first, which is the correct RED: the rung does
 * not exist yet.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const RUNTIME_SLASH_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-slash.cjs');
const RUNTIME_NAME_POLICY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs');
const AGENT_ISOLATION_GUARD_PATH = path.join(__dirname, '..', 'hooks', 'gsd-agent-isolation-guard.js');
const CURSOR_SUBAGENT_START_PATH = path.join(__dirname, '..', 'hooks', 'gsd-cursor-subagent-start.js');

/** A project whose config carries NO `runtime` key — what config-new-project writes. */
function neutralProject(t) {
  const dir = createTempProject('gsd-marker-proj-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
  return dir;
}

/** Fresh require of the built lib, bypassing require() cache so each test sees current disk state. */
function requireRuntimeSlash() {
  delete require.cache[require.resolve(RUNTIME_SLASH_PATH)];
  return require(RUNTIME_SLASH_PATH);
}

/**
 * Guard clause every test opens with: the marker rung's seam surface must
 * exist on the CANONICAL owner before any scenario can be exercised. On the
 * current tree this assertion itself is the RED — `runtime-slash.cjs` has no
 * marker reader and no test seams.
 */
function assertMarkerSeamExists(rs) {
  assert.equal(
    typeof rs.readInstallRuntimeMarker,
    'function',
    'runtime-slash.cjs must export readInstallRuntimeMarker — the canonical marker reader (#3897 rung 2) does not exist yet',
  );
  assert.equal(
    typeof rs._setInstallRuntimeMarkerForTests,
    'function',
    'runtime-slash.cjs must export _setInstallRuntimeMarkerForTests — the test seam for the marker rung does not exist yet',
  );
  assert.equal(
    typeof rs._resetInstallRuntimeMarkerCacheForTests,
    'function',
    'runtime-slash.cjs must export _resetInstallRuntimeMarkerCacheForTests',
  );
}

/** Run `fn` with `overrides` applied to process.env, restoring exactly what was there before. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('per-install .gsd-runtime marker rung in the canonical resolver (#3897 rung 2)', () => {
  test('T3 installMarkerResolvesWhenEnvAndConfigAbsent_3897', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    rs._setInstallRuntimeMarkerForTests('codex');
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    assert.equal(
      rs.resolveRuntime(proj),
      'codex',
      'no env, no config.runtime, marker says codex (R3) — resolveRuntime must consult the marker instead of falling straight to claude',
    );
  });

  test('T1 envRuntimeOutranksConfigAndMarker', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    const proj = neutralProject(t);
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
    rs._setInstallRuntimeMarkerForTests('gemini');
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    withEnv({ GSD_RUNTIME: 'codex' }, () => {
      assert.equal(rs.resolveRuntime(proj), 'codex', 'GSD_RUNTIME must outrank both config.runtime and the install marker');
    });
  });

  test('T2 configOutranksInstallMarker', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    const proj = neutralProject(t);
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
    delete process.env.GSD_RUNTIME;
    rs._setInstallRuntimeMarkerForTests('codex');
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    assert.equal(rs.resolveRuntime(proj), 'cursor', 'config.runtime must outrank the install marker');
  });

  test('T4 noSignalsFallsBackToClaude', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    rs._setInstallRuntimeMarkerForTests(null);
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    assert.equal(rs.resolveRuntime(proj), 'claude', 'with no env, no config.runtime and no marker, the default is unchanged');
  });

  test('T5 emptyMarkerFallsThrough', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('.gsd-runtime')) return '   \n\t  ';
      return originalReadFileSync(p, enc);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      rs._resetInstallRuntimeMarkerCacheForTests();
    });

    assert.equal(
      rs.readInstallRuntimeMarker(),
      null,
      'a whitespace-only marker file must resolve to null (trimmed to empty), not an empty-string runtime name',
    );

    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    assert.equal(rs.resolveRuntime(proj), 'claude', 'an empty marker must fall through to claude');
  });

  test('T6 unreadableMarkerNeverThrows', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    const originalReadFileSync = fs.readFileSync;
    // IO failure injected by monkeypatching fs, never chmod (root bypasses
    // mode bits — a chmod test would pass with zero coverage in root CI).
    fs.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('.gsd-runtime')) {
        const err = new Error('EACCES: permission denied, open .gsd-runtime');
        err.code = 'EACCES';
        throw err;
      }
      return originalReadFileSync(p, enc);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      rs._resetInstallRuntimeMarkerCacheForTests();
    });

    assert.doesNotThrow(
      () => rs.readInstallRuntimeMarker(),
      'an EACCES marker read must never throw out of readInstallRuntimeMarker — a hook that throws breaks the session (N4)',
    );
    assert.equal(rs.readInstallRuntimeMarker(), null);

    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    let result;
    assert.doesNotThrow(() => {
      result = rs.resolveRuntime(proj);
    });
    assert.equal(result, 'claude', 'an unreadable marker must fall through to claude, never crash the caller');
  });

  test('T7 unknownMarkerNameIsNormalizedNotTrusted', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    rs._setInstallRuntimeMarkerForTests('NotARealRuntime-V9');
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    const viaMarker = rs.resolveRuntime(proj);
    const viaEnv = withEnv({ GSD_RUNTIME: 'NotARealRuntime-V9' }, () => rs.resolveRuntime(neutralProject(t)));

    assert.equal(
      viaMarker,
      viaEnv,
      'the marker rung must apply the SAME resolveRuntimeNameFromCandidates normalization GSD_RUNTIME does (N1) — one name policy, not two',
    );
    assert.notEqual(
      viaMarker,
      'NotARealRuntime-V9',
      'the raw marker string must never be returned verbatim — it must be routed through normalization like the env rung',
    );
  });

  test('T8 hostileMarkerContentIsInert', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    const hostile = 'codex\n../../etc/passwd ';
    const seenPaths = [];
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
      seenPaths.push(String(p));
      if (typeof p === 'string' && p.endsWith('.gsd-runtime')) return hostile;
      return originalReadFileSync(p, enc);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      rs._resetInstallRuntimeMarkerCacheForTests();
    });

    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    let result;
    assert.doesNotThrow(() => {
      result = rs.resolveRuntime(proj);
    }, 'hostile marker content (newline, path traversal, control char) must never throw');
    assert.equal(typeof result, 'string');

    for (const seen of seenPaths) {
      assert.ok(
        !seen.includes('etc/passwd') && !seen.includes(' '),
        `the hostile marker VALUE must never be used to construct a filesystem path to read — saw a read for ${JSON.stringify(seen)}`,
      );
    }

    const viaEnv = withEnv({ GSD_RUNTIME: hostile }, () => rs.resolveRuntime(neutralProject(t)));
    assert.equal(
      result,
      viaEnv,
      'hostile marker content must normalize identically to the same string arriving via GSD_RUNTIME — no special-cased bypass for the marker rung',
    );
  });

  test('T9 markerIsReadOncePerProcess', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    let reads = 0;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('.gsd-runtime')) {
        reads++;
        return 'codex';
      }
      return originalReadFileSync(p, enc);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      rs._resetInstallRuntimeMarkerCacheForTests();
    });

    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    rs.resolveRuntime(proj);
    rs.resolveRuntime(proj);
    rs.resolveRuntime(proj);

    assert.equal(reads, 1, 'the marker file must be read at most once per process — later calls must hit the cache');
  });

  test('T10 cacheSeamResetsBetweenTests', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    let reads = 0;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('.gsd-runtime')) {
        reads++;
        return 'codex';
      }
      return originalReadFileSync(p, enc);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      rs._resetInstallRuntimeMarkerCacheForTests();
    });

    const proj = neutralProject(t);
    delete process.env.GSD_RUNTIME;
    rs.resolveRuntime(proj);
    assert.equal(reads, 1);

    rs._resetInstallRuntimeMarkerCacheForTests();
    rs.resolveRuntime(proj);
    assert.equal(reads, 2, 'resetting the cache seam must force a fresh read on the next call');
  });

  test('T12 hooksDelegateToTheSingleOwner', (t) => {
    const rs = requireRuntimeSlash();
    assertMarkerSeamExists(rs);
    rs._resetInstallRuntimeMarkerCacheForTests();
    t.after(() => rs._resetInstallRuntimeMarkerCacheForTests());

    delete require.cache[require.resolve(AGENT_ISOLATION_GUARD_PATH)];
    delete require.cache[require.resolve(CURSOR_SUBAGENT_START_PATH)];
    const guard = require(AGENT_ISOLATION_GUARD_PATH);
    const cursorHook = require(CURSOR_SUBAGENT_START_PATH);
    const { resolveRuntimeNameFromCandidates } = require(RUNTIME_NAME_POLICY_PATH);

    const proj = neutralProject(t);
    const configPath = path.join(proj, '.planning', 'config.json');
    delete process.env.GSD_RUNTIME;

    // Set the CANONICAL seam only — no disk write. A hook that still owns its
    // own private reader/cache (today's state, #3566) will never observe this
    // in-memory value; it will fall through to its own disk read or the
    // ~/.gsd/defaults.json rung instead.
    rs._setInstallRuntimeMarkerForTests('gemini');
    const identity = guard.resolveRuntimeIdentity(proj, configPath, resolveRuntimeNameFromCandidates);
    assert.equal(
      identity.runtimeId,
      'gemini',
      'hooks/gsd-agent-isolation-guard.js must resolve the marker through the single canonical owner (runtime-slash.cts), not its own private reader/cache',
    );
    assert.equal(identity.confident, true);

    // Cursor hook's surface has no direct runtimeId getter — observe delegation
    // through its isolation verdict instead. 'claude' is a known registry
    // entry whose dispatch.isolation is 'harness-worktree'
    // (capability-registry.cjs); a hook still reading its own (empty, dev-tree)
    // disk marker would answer as if no marker existed at all.
    rs._setInstallRuntimeMarkerForTests('claude');
    const isolation = cursorHook.resolveFallbackIsolation(proj, configPath);
    assert.equal(
      isolation,
      'harness-worktree',
      'hooks/gsd-cursor-subagent-start.js must resolve the marker through the single canonical owner too',
    );
  });
});
