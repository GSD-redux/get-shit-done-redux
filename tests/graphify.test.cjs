'use strict';

// Tests for graphify.cjs — status and build describe blocks.
// Split from the consolidated 2336-LOC file. Refs #3761.
//
// Migrated to typed-IR (#2974): execGraphify now returns a typed
// `reason` field (GRAPHIFY_REASON enum) alongside exitCode/stdout/stderr.
// Tests assert on result.reason instead of grepping stderr for failure
// phrases like 'not found' or 'timed out'.

/**
 * Tests for gsd-core/bin/lib/graphify.cjs
 *
 * Covers: tri-state gate (TEST-03 — isCapabilityActive cutover, Phase 3),
 * graceful degradation (TEST-04), subprocess helper (FOUND-04),
 * presence detection (FOUND-02), version checking (FOUND-03),
 * and disabled response (FOUND-01).
 */

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { createTempProject, createTempDir, cleanup } = require('./helpers.cjs');

const {
  disabledResponse,
  execGraphify,
  GRAPHIFY_REASON,
  checkGraphifyInstalled,
  checkGraphifyVersion,
  graphifyStatus,
  // Build (Phase 3)
  graphifyBuild,
  writeSnapshot,
} = require('../gsd-core/bin/lib/graphify.cjs');

const {
  enableGraphify,
  writeGraphJson,
  SAMPLE_GRAPH,
} = require('./helpers/graphify.cjs');

// ─── Shared fixture: surfaced-config-dir ─────────────────────────────────────
//
// Positive-path tests (graphifyStatus + graphifyBuild) call enableGraphify()
// (config leg only) and assert non-disabled outcomes. With the tri-state gate
// (isCapabilityActive), a non-disabled outcome ALSO requires graphify to be
// installed+surfaced in the runtime config dir. Without this fixture those
// tests were ambient-dependent: they passed only on machines where graphify
// happened to be surfaced in the real ~/.claude.
//
// Fix: before each positive-path test, point CLAUDE_CONFIG_DIR at a tmp dir
// containing a full-profile .gsd-surface.json with graphify surfaced, and
// clear GSD_RUNTIME / GSD_WORKSTREAM / GSD_PROJECT for hermeticity.
// An EMPTY tmp config dir (no .gsd-surface.json) also works — the resolver
// defaults to 'full' profile → all surfaced — but we write the file explicitly
// so the fixture intent is visible and independent of default-resolution logic.

/** Create a tmp config dir with graphify surfaced (full profile, no disabled clusters). */
function makeSurfacedConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-graphify-surface-cfg-'));
  fs.writeFileSync(
    path.join(dir, '.gsd-surface.json'),
    JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

/**
 * Save the env vars that the surfaced-config fixture overrides.
 * Returns an object whose .restore() method returns the env to its original state.
 */
function saveSurfacedEnv() {
  const saved = {
    GSD_RUNTIME: process.env.GSD_RUNTIME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
    GSD_PROJECT: process.env.GSD_PROJECT,
  };
  return {
    restore() {
      if (saved.GSD_RUNTIME === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = saved.GSD_RUNTIME;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
      if (saved.GSD_WORKSTREAM === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved.GSD_WORKSTREAM;
      if (saved.GSD_PROJECT === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = saved.GSD_PROJECT;
    },
  };
}

// ─── status describe ─────────────────────────────────────────────────────────

// Require capability-state to assert gate parity in regression tests below.
const { isCapabilityActive } = require('../gsd-core/bin/lib/capability-state.cjs');

describe('status', () => {
  // ─── Tri-state gate (Phase 3 cutover from isGraphifyEnabled → isCapabilityActive) ──
  //
  // The old config-only gate (isGraphifyEnabled) checked ONLY graphify.enabled in
  // config.json. The new tri-state gate (isCapabilityActive) requires the capability
  // to be installed AND surfaced AND config-enabled.
  //
  // FAIL-FIRST PROOF (what would fail against the OLD isGraphifyEnabled code):
  //   Scenario: graphify installed+surfaced on the runtime, graphify.enabled=true in config.
  //   Old code: isGraphifyEnabled(planningDir) → true → status returns non-disabled.
  //   New code: isCapabilityActive('graphify', cwd) → depends on surface+install.
  //   The "gate-parity" test below would FAIL on old code because graphifyStatus used
  //   isGraphifyEnabled (config-only), which diverges from isCapabilityActive when
  //   the surface/install dimension differs from config. Specifically:
  //     - On a machine where graphify is NOT surfaced but config-enabled:
  //       OLD: isGraphifyEnabled=true → not disabled (BUG)
  //       NEW: isCapabilityActive=false → disabled (CORRECT)
  //     - The "returns disabled when graphify.enabled is false" test STILL PASSES under
  //       old code (config check is a subset of the new check) — it's the POSITIVE case
  //       that breaks.
  //
  // With the NEW gate (isCapabilityActive), graphify commands delegate entirely to
  // isCapabilityActive, so graphifyStatus outcome === isCapabilityActive outcome.
  describe('tri-state graphify gate (isCapabilityActive cutover)', () => {
    let tmpDir;
    let planningDir;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    // REGRESSION (Phase 3): graphify gate outcome must exactly match isCapabilityActive.
    // Old gate (isGraphifyEnabled) was config-only; new gate is tri-state.
    // This test would fail on old code in any environment where isCapabilityActive
    // disagrees with the config-only check (e.g., surfaced+installed but config-absent).
    test('graphifyStatus gate outcome matches isCapabilityActive (regression — Phase 3)', () => {
      // No graphify.enabled in config: isCapabilityActive resolves from install+surface.
      const capabilityActive = isCapabilityActive('graphify', tmpDir);
      const result = graphifyStatus(tmpDir);
      if (capabilityActive) {
        // Surface+install active → command must proceed (not disabled).
        assert.ok(
          !result.disabled,
          'graphifyStatus must not return disabled when isCapabilityActive=true',
        );
      } else {
        // Not active → command must return disabled.
        assert.strictEqual(
          result.disabled,
          true,
          'graphifyStatus must return disabled when isCapabilityActive=false',
        );
      }
    });

    // Config-disabled → isCapabilityActive returns false → command disabled (preserved).
    test('graphifyStatus returns disabled when graphify.enabled is false', () => {
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ graphify: { enabled: false } }),
        'utf8'
      );
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.disabled, true,
        'graphifyStatus must return disabled when graphify.enabled=false');
    });

    // Config-enabled and capability active → command proceeds (not disabled).
    test('graphifyStatus is not disabled when config-enabled and isCapabilityActive=true', () => {
      enableGraphify(planningDir);
      const capabilityActive = isCapabilityActive('graphify', tmpDir);
      // Only assert when the capability is truly active in this environment.
      // On a machine without graphify surfaced, isCapabilityActive=false even with
      // config-enabled — this is the correct new behavior.
      if (capabilityActive) {
        const result = graphifyStatus(tmpDir);
        assert.ok(!result.disabled,
          'graphifyStatus must not return disabled when graphify is fully active');
      }
      // When capabilityActive=false (not surfaced), disabled is the correct outcome.
      // No assertion needed — the regression test above covers it.
    });

    // ── TEST-03-HERMETIC ────────────────────────────────────────────────────────
    //
    // FAIL-FIRST PROOF (what would fail against the OLD isGraphifyEnabled code):
    //   Scenario: graphify installed (full profile → '*' sentinel) + config-enabled=true,
    //   but graphify NOT surfaced (disabled cluster in .gsd-surface.json).
    //
    //   OLD gate (isGraphifyEnabled): checks ONLY graphify.enabled in config.json.
    //     → graphify.enabled=true → isGraphifyEnabled=true → graphifyStatus NOT disabled → BUG.
    //
    //   NEW gate (isCapabilityActive): requires installed AND surfaced AND config-enabled.
    //     → installed=true, surfaced=false → isCapabilityActive=false → graphifyStatus disabled → CORRECT.
    //
    // Fixture layout:
    //   CLAUDE_CONFIG_DIR → tmpConfigDir/
    //     .gsd-surface.json  → full profile, disabledClusters:["graphify"]
    //     (no .gsd-profile   → defaults to 'full' → installedSkills='*' → installed=true)
    //   tmpProjectDir/
    //     .planning/config.json → {"graphify":{"enabled":true}}
    //
    // The test is HERMETIC: it controls all three tri-state dimensions via fixture
    // files and the CLAUDE_CONFIG_DIR env var, so the outcome is independent of
    // any real ~/.claude configuration in the host environment.
    describe('hermetic: graphify installed + config-enabled but NOT surfaced → disabled', () => {
      let tmpConfigDir;
      let tmpProjectDir;
      let prevClaudeConfigDir;
      let prevGsdWorkstream;
      let prevGsdProject;

      beforeEach(() => {
        tmpConfigDir = createTempDir('gsd-graphify-surface-test-config-');
        tmpProjectDir = createTempDir('gsd-graphify-surface-test-project-');

        // Fixture: .gsd-surface.json — full profile with graphify cluster disabled.
        // The 'graphify' key in disabledClusters maps to ["graphify"] via
        // capability-registry.cjs capabilityClusters, removing the 'graphify' skill
        // stem from the surfaced set. All other skills remain surfaced.
        // No .gsd-profile written → readActiveProfile returns null → defaults to 'full'
        // → resolveProfile returns '*' sentinel → installedSkills='*' → installed=true.
        const surfaceState = {
          baseProfile: 'full',
          disabledClusters: ['graphify'],
          explicitAdds: [],
          explicitRemoves: [],
        };
        fs.writeFileSync(
          path.join(tmpConfigDir, '.gsd-surface.json'),
          JSON.stringify(surfaceState, null, 2) + '\n',
          'utf8',
        );

        // Fixture: project config — graphify.enabled=true.
        // This is the config dimension that the OLD gate (isGraphifyEnabled) would
        // have returned true for, causing the BUG. The new gate ignores config when
        // installed && surfaced is false.
        const planningDirForFixture = path.join(tmpProjectDir, '.planning');
        fs.mkdirSync(planningDirForFixture, { recursive: true });
        fs.writeFileSync(
          path.join(planningDirForFixture, 'config.json'),
          JSON.stringify({ graphify: { enabled: true } }),
          'utf8',
        );

        // Save and override env vars for hermeticity.
        // CLAUDE_CONFIG_DIR controls which config dir getGlobalConfigDir('claude') resolves.
        prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        prevGsdWorkstream = process.env.GSD_WORKSTREAM;
        prevGsdProject = process.env.GSD_PROJECT;
        process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
        // Clear GSD_WORKSTREAM/GSD_PROJECT — ambient values redirect planningDir()
        // causing STATE.md reads from an unrelated location (hermeticity regression #872).
        delete process.env.GSD_WORKSTREAM;
        delete process.env.GSD_PROJECT;
      });

      afterEach(() => {
        // Restore env vars before cleanup so that cleanup() rmSync calls use
        // the original env (no silent planningDir redirection from leftover vars).
        if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
        if (prevGsdWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
        else process.env.GSD_WORKSTREAM = prevGsdWorkstream;
        if (prevGsdProject === undefined) delete process.env.GSD_PROJECT;
        else process.env.GSD_PROJECT = prevGsdProject;

        cleanup(tmpConfigDir);
        cleanup(tmpProjectDir);
      });

      // Negative case: installed + NOT surfaced + config-enabled → NOT active, command disabled.
      // This is the KEY BUG-FIX branch. OLD isGraphifyEnabled would return true here (BUG).
      // NEW isCapabilityActive returns false (CORRECT), forcing graphifyStatus to return disabled.
      test('isCapabilityActive returns false when installed + NOT surfaced + config-enabled=true (TEST-03-HERMETIC)', () => {
        const active = isCapabilityActive('graphify', tmpProjectDir);
        assert.strictEqual(
          active,
          false,
          'isCapabilityActive must return false when graphify is installed and config-enabled but NOT surfaced — ' +
          'OLD isGraphifyEnabled would return true here (config-only check) which is the bug this test guards against',
        );
      });

      test('graphifyStatus returns disabled when installed + NOT surfaced + config-enabled=true (TEST-03-HERMETIC)', () => {
        // Old isGraphifyEnabled(planningDir) → true (graphify.enabled=true in config) → NOT disabled (BUG).
        // New isCapabilityActive('graphify', cwd) → false (not surfaced) → disabled (CORRECT).
        const result = graphifyStatus(tmpProjectDir);
        assert.strictEqual(
          result.disabled,
          true,
          'graphifyStatus must return disabled when graphify is installed and config-enabled but NOT surfaced — ' +
          'surface state must gate the command regardless of config-enabled value',
        );
        assert.ok(
          typeof result.message === 'string' && result.message.length > 0,
          'disabled response must include a non-empty message with enable instructions',
        );
      });

      // Positive control: same config-dir but now WITH graphify surfaced.
      // This confirms the fixture itself is sound — the two tests above must see
      // divergent outcomes from the same project config, controlled only by surface state.
      test('graphifyStatus is NOT disabled when installed + SURFACED + config-enabled=true (positive control)', () => {
        // Re-write .gsd-surface.json with graphify surfaced (disabledClusters empty).
        const surfaceStateOn = {
          baseProfile: 'full',
          disabledClusters: [],
          explicitAdds: [],
          explicitRemoves: [],
        };
        fs.writeFileSync(
          path.join(tmpConfigDir, '.gsd-surface.json'),
          JSON.stringify(surfaceStateOn, null, 2) + '\n',
          'utf8',
        );

        const active = isCapabilityActive('graphify', tmpProjectDir);
        assert.strictEqual(
          active,
          true,
          'isCapabilityActive must return true when graphify is installed, surfaced, and config-enabled=true',
        );

        const result = graphifyStatus(tmpProjectDir);
        assert.strictEqual(
          result.disabled,
          undefined,
          'graphifyStatus must NOT return disabled when graphify is installed, surfaced, and config-enabled=true — ' +
          'got disabled:' + JSON.stringify(result.disabled),
        );
      });
    });
    // ── end TEST-03-HERMETIC ────────────────────────────────────────────────────
  });

  describe('disabledResponse', () => {
    test('returns disabled:true with enable instructions', () => {
      const result = disabledResponse();
      assert.strictEqual(result.disabled, true);
      assert.ok(result.message.includes('gsd-tools config-set graphify.enabled true'));
    });
  });

  describe('graphifyStatus', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic by
    // ensuring graphify is surfaced in the runtime config dir. Without this,
    // tests depending on enableGraphify() pass only on machines where the
    // ambient ~/.claude has graphify surfaced (ambient-dependent = flaky).
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      // Set up hermetic surfaced config dir: graphify surfaced, runtime=claude.
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;          // use 'claude' default
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
    });

    // STAT-01: returns disabled response when not enabled
    test('returns disabled response when not enabled', () => {
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.disabled, true);
    });

    // STAT-02: returns exists:false when no graph.json
    test('returns exists:false when no graph.json (STAT-02)', () => {
      enableGraphify(planningDir);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.exists, false);
      assert.ok(result.message.includes('No graph built yet'));
    });

    // STAT-01: returns status with counts when graph exists
    test('returns status with counts when graph exists (STAT-01)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.node_count, 5);
      assert.strictEqual(result.edge_count, 5);
      assert.strictEqual(typeof result.last_build, 'string');
      assert.strictEqual(typeof result.stale, 'boolean');
      assert.strictEqual(typeof result.age_hours, 'number');
    });

    // STAT-01: reports hyperedge_count
    test('reports hyperedge_count', () => {
      enableGraphify(planningDir);
      const graphWithHyperedges = {
        ...SAMPLE_GRAPH,
        hyperedges: [{ id: 'h1', nodes: ['n1', 'n2', 'n3'], label: 'auth_flow' }],
      };
      writeGraphJson(planningDir, graphWithHyperedges);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.hyperedge_count, 1);
    });

    // LINKS-02: status edge_count must read graph.links when graph.edges is absent
    test('reports correct edge_count when graph uses links key (LINKS-02)', () => {
      enableGraphify(planningDir);
      const graphWithLinks = {
        nodes: SAMPLE_GRAPH.nodes,
        links: SAMPLE_GRAPH.edges,
        hyperedges: [],
      };
      writeGraphJson(planningDir, graphWithLinks);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.edge_count, 5, 'edge_count must equal links array length');
    });
  });
});

// ─── build describe ──────────────────────────────────────────────────────────

describe('build', () => {
  describe('execGraphify', () => {
    afterEach(() => {
      mock.restoreAll();
    });

    test('returns structured output on success', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '{"nodes": 42}',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = execGraphify('/tmp', ['build']);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, '{"nodes": 42}');
      assert.strictEqual(result.stderr, '');
    });

    test('returns exitCode 127 when graphify not on PATH', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT' },
        signal: null,
      }));

      const result = execGraphify('/tmp', ['build']);
      assert.strictEqual(result.exitCode, 127);
      // Migrated #2974: assert on the typed `reason` field instead of
      // grepping stderr for 'not found'.
      assert.strictEqual(result.reason, GRAPHIFY_REASON.ENOENT);
    });

    test('returns exitCode 124 on timeout', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: 'partial',
        stderr: '',
        // Real spawnSync timeouts set error.code === 'ETIMEDOUT'; the
        // timeout verdict keys on that, because SIGTERM alone is also
        // produced by an external kill and is unreliable on Windows.
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM',
      }));

      const result = execGraphify('/tmp', ['build']);
      assert.strictEqual(result.exitCode, 124);
      // Migrated #2974: typed reason instead of stderr grep.
      assert.strictEqual(result.reason, GRAPHIFY_REASON.TIMEOUT);
      assert.strictEqual(result.timeout_ms, 30000);
    });

    test('an externally-delivered SIGTERM is not reported as a timeout', () => {
      // Before the shared isSpawnTimeout predicate was adopted, this shape
      // (SIGTERM with no error.code) was misclassified as a timeout.
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: undefined,
        signal: 'SIGTERM',
      }));

      const result = execGraphify('/tmp', ['build']);
      assert.notStrictEqual(result.exitCode, 124);
      assert.notStrictEqual(result.reason, GRAPHIFY_REASON.TIMEOUT);
    });

    test('passes PYTHONUNBUFFERED=1 in env', () => {
      let captured;
      mock.method(childProcess, 'spawnSync', (_cmd, _args, opts) => {
        captured = opts;
        return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
      });

      execGraphify('/tmp', ['build']);
      assert.strictEqual(captured.env.PYTHONUNBUFFERED, '1');
    });

    test('uses 30000ms default timeout', () => {
      let captured;
      mock.method(childProcess, 'spawnSync', (_cmd, _args, opts) => {
        captured = opts;
        return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
      });

      execGraphify('/tmp', ['build']);
      assert.strictEqual(captured.timeout, 30000);
    });

    test('allows timeout override', () => {
      let captured;
      mock.method(childProcess, 'spawnSync', (_cmd, _args, opts) => {
        captured = opts;
        return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
      });

      execGraphify('/tmp', ['build'], { timeout: 60000 });
      assert.strictEqual(captured.timeout, 60000);
    });

    test('trims stdout and stderr whitespace', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '  hello  \n',
        stderr: '  warn  \n',
        error: undefined,
        signal: null,
      }));

      const result = execGraphify('/tmp', ['build']);
      assert.strictEqual(result.stdout, 'hello');
      assert.strictEqual(result.stderr, 'warn');
    });
  });

  describe('checkGraphifyInstalled', () => {
    afterEach(() => {
      mock.restoreAll();
    });

    test('returns installed:true when graphify is on PATH', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: 'Usage: graphify...',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyInstalled();
      assert.strictEqual(result.installed, true);
    });

    test('returns installed:false with install instructions when not on PATH', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT' },
        signal: null,
      }));

      const result = checkGraphifyInstalled();
      assert.strictEqual(result.installed, false);
      assert.ok(result.message.includes('uv pip install graphifyy && graphify install'));
    });

    test('uses --help not --version for detection', () => {
      let capturedArgs;
      mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        capturedArgs = args;
        return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
      });

      checkGraphifyInstalled();
      assert.deepStrictEqual(capturedArgs, ['--help']);
    });
  });

  describe('checkGraphifyVersion', () => {
    afterEach(() => {
      mock.restoreAll();
    });

    test('returns compatible:true for version 0.4.0', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '0.4.0\n',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.version, '0.4.0');
      assert.strictEqual(result.compatible, true);
      assert.strictEqual(result.warning, null);
    });

    test('returns compatible:true for version 0.9.5', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '0.9.5\n',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.version, '0.9.5');
      assert.strictEqual(result.compatible, true);
    });

    test('returns compatible:false for version 0.3.0', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '0.3.0\n',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.compatible, false);
      assert.ok(result.warning.includes('outside tested range'));
    });

    test('returns compatible:false for version 1.0.0', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: '1.0.0\n',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.compatible, false);
      assert.ok(result.warning.includes('outside tested range'));
    });

    test('handles python3 not found', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT' },
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.version, null);
      assert.ok(result.warning.includes('Could not determine'));
    });

    test('handles unparseable version string', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: 'unknown\n',
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = checkGraphifyVersion();
      assert.strictEqual(result.compatible, null);
      assert.ok(result.warning.includes('Could not parse'));
    });

    test('tries graphify --version first before python3', () => {
      const calls = [];
      mock.method(childProcess, 'spawnSync', (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
      });

      checkGraphifyVersion();
      assert.strictEqual(calls.length, 1, 'exactly one spawnSync call — no python3 fallback');
      assert.strictEqual(calls[0].cmd, 'graphify');
      assert.ok(calls[0].args.includes('--version'), 'graphify called with --version');
      const python3Calls = calls.filter(c => c.cmd === 'python3');
      assert.strictEqual(python3Calls.length, 0, 'no python3 fallback when graphify --version succeeds');
    });

    test('falls back to python3 importlib.metadata when graphify --version fails', () => {
      const calls = [];
      mock.method(childProcess, 'spawnSync', (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'graphify') {
          return { status: 1, stdout: '', stderr: 'unknown option', error: undefined, signal: null };
        }
        // python3 fallback
        return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
      });

      const result = checkGraphifyVersion();
      assert.strictEqual(result.version, '0.4.3');
      assert.strictEqual(result.compatible, true);
      assert.ok(calls.length >= 2, 'at least two spawnSync calls (graphify attempt + python3 fallback)');
      assert.strictEqual(calls[0].cmd, 'graphify', 'graphify call precedes python3 fallback');
      assert.ok(calls[0].args.includes('--version'), 'graphify --version attempted first');
      const lastCall = calls[calls.length - 1];
      assert.strictEqual(lastCall.cmd, 'python3', 'python3 fallback fires last');
      assert.ok(lastCall.args.some(arg => arg.includes('importlib.metadata')));
    });
  });

  describe('graphifyBuild', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic.
    // See graphifyStatus describe block for the rationale.
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      enableGraphify(planningDir);
      // Set up hermetic surfaced config dir: graphify surfaced, runtime=claude.
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
      mock.restoreAll();
    });

    test('returns disabled response when graphify not enabled', () => {
      const tmpDir2 = createTempProject();
      const result = graphifyBuild(tmpDir2);
      assert.strictEqual(result.disabled, true);
      cleanup(tmpDir2);
    });

    test('returns error when graphify not installed', () => {
      mock.method(childProcess, 'spawnSync', () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT' },
        signal: null,
      }));

      const result = graphifyBuild(tmpDir);
      assert.ok(result.error);
      assert.ok(result.error.includes('not installed') || result.error.includes('pip install'));
    });

    test('returns spawn_agent action on successful pre-flight', () => {
      mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        if (args && args[0] === '--help') {
          return { status: 0, stdout: 'Usage', stderr: '', error: undefined, signal: null };
        }
        // version check via python3
        return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
      });

      const result = graphifyBuild(tmpDir);
      assert.strictEqual(result.action, 'spawn_agent');
      assert.ok(result.graphs_dir);
      assert.ok(result.graphify_out);
      assert.strictEqual(result.timeout_seconds, 300);
      assert.strictEqual(result.version, '0.4.3');
      assert.strictEqual(result.version_warning, null);
      assert.deepStrictEqual(result.artifacts, ['graph.json', 'graph.html', 'GRAPH_REPORT.md']);
    });

    test('creates .planning/graphs/ directory if missing', () => {
      mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        if (args && args[0] === '--help') {
          return { status: 0, stdout: 'Usage', stderr: '', error: undefined, signal: null };
        }
        return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
      });

      const graphsDir = path.join(planningDir, 'graphs');
      assert.strictEqual(fs.existsSync(graphsDir), false);

      graphifyBuild(tmpDir);
      assert.strictEqual(fs.existsSync(graphsDir), true);
    });

    test('reads graphify.build_timeout from config', () => {
      // Write config with custom timeout
      const configPath = path.join(planningDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.graphify.build_timeout = 600;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        if (args && args[0] === '--help') {
          return { status: 0, stdout: 'Usage', stderr: '', error: undefined, signal: null };
        }
        return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
      });

      const result = graphifyBuild(tmpDir);
      assert.strictEqual(result.timeout_seconds, 600);
    });

    test('includes version warning when outside tested range', () => {
      mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        if (args && args[0] === '--help') {
          return { status: 0, stdout: 'Usage', stderr: '', error: undefined, signal: null };
        }
        return { status: 0, stdout: '1.2.0\n', stderr: '', error: undefined, signal: null };
      });

      const result = graphifyBuild(tmpDir);
      assert.strictEqual(result.action, 'spawn_agent');
      assert.ok(result.version_warning);
      assert.ok(result.version_warning.includes('outside tested range'));
    });
  });

  describe('writeSnapshot', () => {
    let tmpDir;
    let planningDir;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('writes snapshot from existing graph.json', () => {
      const graphData = {
        nodes: [{ id: 'A', label: 'Node A' }, { id: 'B', label: 'Node B' }],
        edges: [{ source: 'A', target: 'B', label: 'relates' }],
      };
      writeGraphJson(planningDir, graphData);

      const result = writeSnapshot(tmpDir);
      assert.strictEqual(result.saved, true);
      assert.strictEqual(result.node_count, 2);
      assert.strictEqual(result.edge_count, 1);
      assert.ok(result.timestamp);

      // Verify file was actually written
      const snapshotPath = path.join(planningDir, 'graphs', '.last-build-snapshot.json');
      assert.strictEqual(fs.existsSync(snapshotPath), true);

      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.strictEqual(snapshot.version, 1);
      assert.strictEqual(snapshot.nodes.length, 2);
      assert.strictEqual(snapshot.edges.length, 1);
      assert.ok(snapshot.timestamp);
    });

    test('returns error when graph.json does not exist', () => {
      // graphs directory exists but no graph.json
      fs.mkdirSync(path.join(planningDir, 'graphs'), { recursive: true });

      const result = writeSnapshot(tmpDir);
      assert.ok(result.error);
      assert.ok(result.error.includes('not parseable'));
    });

    test('returns error when graph.json is invalid JSON', () => {
      const graphsDir = path.join(planningDir, 'graphs');
      fs.mkdirSync(graphsDir, { recursive: true });
      fs.writeFileSync(path.join(graphsDir, 'graph.json'), 'not valid json{{{', 'utf8');

      const result = writeSnapshot(tmpDir);
      assert.ok(result.error);
      assert.ok(result.error.includes('not parseable'));
    });

    test('handles graph.json with empty nodes and edges', () => {
      writeGraphJson(planningDir, { nodes: [], edges: [] });

      const result = writeSnapshot(tmpDir);
      assert.strictEqual(result.saved, true);
      assert.strictEqual(result.node_count, 0);
      assert.strictEqual(result.edge_count, 0);
    });

    test('handles graph.json missing nodes/edges keys gracefully', () => {
      writeGraphJson(planningDir, { metadata: { tool: 'graphify' } });

      const result = writeSnapshot(tmpDir);
      assert.strictEqual(result.saved, true);
      assert.strictEqual(result.node_count, 0);
      assert.strictEqual(result.edge_count, 0);
    });

    test('overwrites existing snapshot on rebuild', () => {
      // Write initial graph and snapshot
      writeGraphJson(planningDir, {
        nodes: [{ id: 'A' }],
        edges: [],
      });
      writeSnapshot(tmpDir);

      // Write updated graph with more nodes
      writeGraphJson(planningDir, {
        nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        edges: [{ source: 'A', target: 'B' }],
      });

      const result = writeSnapshot(tmpDir);
      assert.strictEqual(result.saved, true);
      assert.strictEqual(result.node_count, 3);
      assert.strictEqual(result.edge_count, 1);

      // Verify file reflects latest data
      const snapshotPath = path.join(planningDir, 'graphs', '.last-build-snapshot.json');
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.strictEqual(snapshot.nodes.length, 3);
    });
  });
});
