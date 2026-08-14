'use strict';

/**
 * The per-install `.gsd-runtime` marker rung in the CANONICAL runtime
 * resolver (`resolveRuntime`, src/runtime-slash.cts).
 *
 * Why this exists: `resolveRuntime` resolved `GSD_RUNTIME > config.runtime >
 * 'claude'`, and `config-new-project` writes NO `runtime` key — so on a real
 * non-Claude install with a default project config, every one of the ~71
 * consumers of this resolver silently believed it was on Claude. The install
 * already writes `<install>/gsd-core/.gsd-runtime`; only `model-resolver.cts`
 * consulted it, and only for tier-alias resolution.
 *
 * The rung now lives in the one canonical resolver, and the marker read moved
 * to `runtime-slash.cts` with `model-resolver` importing it, so there is a
 * single marker read and a single cache rather than two that can drift.
 *
 * These tests drive REAL installs and the REAL shipped CLI. A unit test over
 * the exported helper alone is not enough: it still passes if a consumer is
 * reverted to a marker-blind path, which is the regression that matters.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempProject, cleanup, installSpawnEnv } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Run a real `bin/install.js --<runtime> --global` into a temp config dir and
 * return that dir. Spawned through the process seam and the install isolation
 * seam so ambient GSD_HOME / runtime-location vars cannot leak in.
 */
function realInstall(t, runtime) {
  const installDir = createTempDir(`gsd-marker-${runtime}-`);
  t.after(() => cleanup(installDir));

  // GSD_TEST_MODE (set above) makes bin/install.js a no-op that still exits 0.
  // It MUST be cleared for the child, or these tests "pass" against an install
  // that never wrote anything.
  const env = installSpawnEnv({ HOME: installDir, USERPROFILE: installDir });
  delete env.GSD_TEST_MODE;

  const res = runNode(
    [path.join(__dirname, '..', 'bin', 'install.js'), `--${runtime}`, '--global', '--config-dir', installDir],
    { env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  assert.equal(res.outcome, 'exited', `install --${runtime} did not complete: ${res.outcome}`);
  assert.equal(res.exitCode, 0, `install --${runtime} failed: ${res.stderr || res.stdout}`);

  const marker = path.join(installDir, 'gsd-core', '.gsd-runtime');
  assert.equal(fs.existsSync(marker), true, `install --${runtime} wrote no .gsd-runtime marker — the rung under test does not exist`);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), runtime, 'marker must name the installed runtime');
  return installDir;
}

/** A project whose config carries NO `runtime` key — what config-new-project writes. */
function neutralProject(t) {
  const dir = createTempProject('gsd-marker-proj-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
  return dir;
}

/** Query the SHIPPED CLI of a given install, with GSD_RUNTIME deliberately unset. */
function query(installDir, cwd, args) {
  const env = { ...process.env, HOME: installDir, USERPROFILE: installDir };
  delete env.GSD_RUNTIME;   // production does not set it; only tests do
  const res = runNode(
    [path.join(installDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), ...args],
    { cwd, env, timeoutMs: PROBE_TIMEOUT_MS },
  );
  assert.equal(res.outcome, 'exited', `query ${args.join(' ')} did not complete: ${res.outcome}`);
  return res;
}

describe('per-install .gsd-runtime marker is consulted by the canonical resolver', () => {
  test('the resolver itself falls through config.runtime to the install marker', (t) => {
    const installDir = realInstall(t, 'qwen');
    const proj = neutralProject(t);

    // Drive the INSTALLED lib, not the source tree: the marker is resolved
    // relative to the module's own directory, so it follows the install.
    const env = { ...process.env, HOME: installDir, USERPROFILE: installDir };
    delete env.GSD_RUNTIME;
    const res = runNode(
      ['-e', `const rs=require(${JSON.stringify(path.join(installDir, 'gsd-core', 'bin', 'lib', 'runtime-slash.cjs'))});process.stdout.write(rs.resolveRuntime(process.cwd()))`],
      { cwd: proj, env, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(res.outcome, 'exited', `resolver probe did not complete: ${res.outcome}`);
    assert.equal(
      res.stdout.trim(),
      'qwen',
      'a qwen install with a runtime-neutral config resolved as claude — every consumer of this resolver then believes it is on Claude',
    );
  });

  test('an explicit config.runtime still outranks the marker', (t) => {
    const installDir = realInstall(t, 'qwen');
    const proj = createTempProject('gsd-marker-explicit-');
    t.after(() => cleanup(proj));
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));

    const env = { ...process.env, HOME: installDir, USERPROFILE: installDir };
    delete env.GSD_RUNTIME;
    const res = runNode(
      ['-e', `const rs=require(${JSON.stringify(path.join(installDir, 'gsd-core', 'bin', 'lib', 'runtime-slash.cjs'))});process.stdout.write(rs.resolveRuntime(process.cwd()))`],
      { cwd: proj, env, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(res.stdout.trim(), 'cursor', 'the project config must outrank the install marker');
  });

  // The rung is in the canonical resolver, so it must reach consumers that have
  // nothing to do with why it was added. `dispatch-should-flatten` is the
  // discriminating one: claude answers `true`, cursor answers `false`. A
  // marker-blind resolver reports claude's answer on a cursor install.
  test('a NON-isolation consumer sees the installed runtime, not claude', (t) => {
    const installDir = realInstall(t, 'cursor');
    const proj = neutralProject(t);

    const res = query(installDir, proj, ['query', 'dispatch-should-flatten', '--raw']);
    assert.equal(res.exitCode, 0, `dispatch-should-flatten failed: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      'false',
      'a cursor install with a runtime-neutral config answered claude\'s `true` — the marker rung is not reaching consumers beyond the one it was added for',
    );
  });

  // #3364 review: the rung in `resolveRuntime` fixes every consumer that calls
  // it, and still left init broken — init reports through
  // `resolveReportedRuntime`, a DIFFERENT ladder that goes explicit > host
  // detection > default and never touched the marker. It feeds
  // checkAgentsInstalled, so a Kimi install with a neutral project config
  // reported agent_runtime "claude" and every agent missing, because Kimi's
  // layout was read as Claude's. #3364 names agent-install checks among the
  // consumers it exists to fix, so this ladder is in scope.
  test('init reports the installed runtime, not claude, on a marker-only install', (t) => {
    const installDir = realInstall(t, 'kimi');
    const proj = neutralProject(t);

    const res = query(installDir, proj, ['init', 'quick', 'marker rung reporting', '--raw']);
    assert.equal(res.exitCode, 0, `init quick failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(
      parsed.agent_runtime,
      'kimi',
      'init reported claude on a kimi install — the marker reaches resolveRuntime but not the reported-runtime ladder, so agent-install checks inspect the wrong layout',
    );
  });

  // The companion invariant: a LIVE session signal must still outrank the
  // marker. The marker says what this tree was installed for; an exported
  // CODEX_HOME says what the user is running right now.
  test('host detection still outranks the marker in the reported ladder', (t) => {
    const installDir = realInstall(t, 'kimi');
    const proj = neutralProject(t);

    // CODEX_SANDBOX is a bare session-env signal (CODEX_SESSION_ENV_SIGNALS).
    // CODEX_HOME would NOT do: that branch additionally probes for a
    // config.toml under it, which a kimi install tree does not have, so it
    // would fall through to the marker and the test would pass vacuously.
    const env = { ...process.env, HOME: installDir, USERPROFILE: installDir, CODEX_SANDBOX: '1' };
    delete env.GSD_RUNTIME;
    const res = runNode(
      [path.join(installDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'init', 'quick', 'session signal wins', '--raw'],
      { cwd: proj, env, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(res.exitCode, 0, `init quick failed: ${res.stderr}`);
    assert.equal(
      JSON.parse(res.stdout).agent_runtime,
      'codex',
      'an exported CODEX_HOME is a current-session signal and must outrank the install marker',
    );
  });

  // Review Minor (#3382): the two degenerate marker states were relied on but
  // never pinned. Both must fall through to the pre-marker behavior rather than
  // throw or resolve to garbage — a marker rung that can crash the resolver is
  // worse than the bug it fixes, since ~71 consumers sit on this call.
  test('an unrecognized runtime string in the marker behaves exactly like the other rungs', (t) => {
    const installDir = realInstall(t, 'qwen');
    const proj = neutralProject(t);
    fs.writeFileSync(path.join(installDir, 'gsd-core', '.gsd-runtime'), 'notarealruntime-v9\n');

    const probe = (extraEnv, cwd) => {
      const env = { ...process.env, HOME: installDir, USERPROFILE: installDir, ...extraEnv };
      if (!('GSD_RUNTIME' in extraEnv)) delete env.GSD_RUNTIME;
      const res = runNode(
        ['-e', `const rs=require(${JSON.stringify(path.join(installDir, 'gsd-core', 'bin', 'lib', 'runtime-slash.cjs'))});process.stdout.write(rs.resolveRuntime(process.cwd()))`],
        { cwd, env, timeoutMs: PROBE_TIMEOUT_MS },
      );
      assert.equal(res.outcome, 'exited', `resolver probe did not complete: ${res.outcome}`);
      return res.stdout.trim();
    };

    // The repo deliberately tolerates unknown/future runtime names — see
    // runtime-name-policy.cts ("unknown / future runtimes -> AGENTS.md, safe
    // cross-agent default"), and `resolveRuntimeNameFromCandidates` returns
    // `canonicalizeRuntimeName(x) || x`. So the contract worth pinning is NOT
    // "reject unknown names" — it is that the marker rung applies the SAME
    // policy as the two explicit rungs above it. A marker rung that invented
    // stricter validation than GSD_RUNTIME/config would be its own defect.
    const viaMarker = probe({}, proj);
    const viaEnv = probe({ GSD_RUNTIME: 'notarealruntime-v9' }, neutralProject(t));
    assert.equal(viaMarker, 'notarealruntime-v9', 'the marker rung must pass an unknown name through, as its siblings do');
    assert.equal(
      viaMarker,
      viaEnv,
      'the marker rung must treat an unrecognized runtime name exactly as GSD_RUNTIME does — one name policy, not two',
    );
  });

  test('a marker path that is a DIRECTORY (EISDIR) falls through instead of throwing', (t) => {
    const installDir = realInstall(t, 'qwen');
    const proj = neutralProject(t);
    // Replace the marker file with a directory — readFileSync then throws EISDIR.
    const markerPath = path.join(installDir, 'gsd-core', '.gsd-runtime');
    fs.unlinkSync(markerPath);
    fs.mkdirSync(markerPath, { recursive: true });

    const env = { ...process.env, HOME: installDir, USERPROFILE: installDir };
    delete env.GSD_RUNTIME;
    const res = runNode(
      ['-e', `const rs=require(${JSON.stringify(path.join(installDir, 'gsd-core', 'bin', 'lib', 'runtime-slash.cjs'))});process.stdout.write(rs.resolveRuntime(process.cwd()))`],
      { cwd: proj, env, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(res.outcome, 'exited', `an EISDIR marker crashed the resolver instead of falling through: ${res.outcome}`);
    assert.equal(res.stdout.trim(), 'claude', 'an unreadable marker must fall through to the default');
  });

  test('model-resolver and runtime-slash share ONE marker read', () => {
    // The read moved to runtime-slash; model-resolver imports it. Two
    // implementations with two caches is the divergence shape this avoids.
    const rs = require('../gsd-core/bin/lib/runtime-slash.cjs');
    const mr = require('../gsd-core/bin/lib/model-resolver.cjs');
    assert.equal(typeof rs.readInstallRuntimeMarker, 'function', 'runtime-slash must own the marker read');
    assert.equal(
      typeof mr._setInstallRuntimeMarkerForTests,
      'function',
      'model-resolver must keep re-exporting the seams its existing tests use',
    );
    // Setting through model-resolver's seam must be visible to runtime-slash —
    // proof they share one cache rather than each holding their own.
    mr._setInstallRuntimeMarkerForTests('kimi');
    try {
      assert.equal(
        rs.readInstallRuntimeMarker(),
        'kimi',
        'the two modules hold separate marker caches — they can now disagree about the runtime',
      );
    } finally {
      mr._resetInstallRuntimeMarkerCacheForTests();
    }
  });
});
