/**
 * Regression test for #1860: detectConfigDir in gsd-check-update.js should
 * prioritize .claude over .config/opencode so that Claude Code sessions
 * don't report false "update available" warnings when an older OpenCode
 * install exists alongside a newer Claude Code install.
 *
 * All coverage here is BEHAVIORAL: it spawns the real hook (as a `node -e`
 * child, with `child_process.spawn` stubbed) and observes the resolved
 * config-dir paths it hands to its background worker via env vars. Nothing
 * in this file reads hooks/gsd-check-update.js source — the hook has no
 * exports (it runs entirely on require), so its only outward, in-process
 * observable effect is the one spawn() call it makes to launch its worker.
 * That spawn's env carries GSD_GLOBAL_VERSION_FILE / GSD_PROJECT_VERSION_FILE,
 * which is deliberately borrowed as the observation seam here (Hyrum's Law:
 * this is an implementation detail, not a contract) rather than a real
 * subprocess launch, since the actual worker touches the network.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const CHECK_UPDATE_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update.js');

// ─── Probe harness ──────────────────────────────────────────────────────────
//
// Builds a `node -e` wrapper (assembled via array .join('\n'), never a
// multi-line template literal — CONTRIBUTING.md's fixture-string convention)
// that stubs child_process.spawn BEFORE requiring the real hook, so the
// hook's actual detectConfigDir() logic runs untouched while the worker
// launch itself is captured instead of executed. Emits exactly one JSON line
// so the test parses structured data, never regex/substring-matches stdout.

function buildProbeSource(hookPath) {
  return [
    "'use strict';",
    'let spawned = false;',
    'let capturedEnv = null;',
    "const cp = require('child_process');",
    'cp.spawn = function stubSpawn(command, args, opts) {',
    '  spawned = true;',
    '  capturedEnv = (opts && opts.env) || null;',
    '  return { unref: function () {} };',
    '};',
    `require(${JSON.stringify(hookPath)});`,
    'const result = {',
    '  spawned: spawned,',
    '  global: capturedEnv ? capturedEnv.GSD_GLOBAL_VERSION_FILE : null,',
    '  project: capturedEnv ? capturedEnv.GSD_PROJECT_VERSION_FILE : null,',
    '  cache: capturedEnv ? capturedEnv.GSD_CACHE_FILE : null,',
    '};',
    'process.stdout.write(JSON.stringify(result) + "\\n");',
  ].join('\n');
}

/**
 * Run the probe against a fake HOME/cwd and return the parsed
 * { spawned, global, project, cache } envelope.
 *
 * @param {object} opts
 * @param {string} opts.homeDir - fake HOME/USERPROFILE for this run.
 * @param {string} opts.cwd - fake cwd (project base) for this run.
 * @param {object} [opts.envOverrides] - applied after HOME/USERPROFILE and
 *   after CLAUDE_CONFIG_DIR is deleted, so a row can reintroduce it.
 */
function probe({ homeDir, cwd, envOverrides = {} }) {
  const childEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete childEnv.CLAUDE_CONFIG_DIR;
  Object.assign(childEnv, envOverrides);

  const result = runNode(['-e', buildProbeSource(CHECK_UPDATE_PATH)], {
    cwd,
    env: childEnv,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  assert.equal(
    result.outcome,
    OUTCOME.EXITED,
    `probe process did not exit cleanly (outcome=${result.outcome}); stderr:\n${result.stderr}`
  );
  assert.equal(
    result.exitCode,
    0,
    `probe process exited non-zero; stderr:\n${result.stderr}`
  );

  const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (cause) {
    throw new Error(
      `probe: could not parse probe stdout as JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause }
    );
  }

  if (parsed.spawned !== true) {
    throw new Error(
      "probe: hooks/gsd-check-update.js no longer calls child_process.spawn() to launch " +
      "its background worker. This harness's OBSERVATION POINT (reading detectConfigDir's " +
      "resolved paths off the spawn() env) has moved and needs to be re-anchored on " +
      'whatever now carries the resolved config-dir paths — this is NOT evidence that ' +
      "detectConfigDir's precedence/search-order logic regressed."
    );
  }
  return parsed;
}

function configDirOf(versionFile) {
  assert.ok(
    typeof versionFile === 'string' && versionFile.length > 0,
    'expected the probe to report a version-file path'
  );
  return path.dirname(path.dirname(versionFile));
}

function assertConfigDir(actualVersionFile, expectedDir, message) {
  const actual = configDirOf(actualVersionFile).replace(/\\/g, '/');
  const expected = expectedDir.replace(/\\/g, '/');
  assert.equal(actual, expected, message);
}

function writeVersionFile(configDir) {
  const versionDir = path.join(configDir, 'gsd-core');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'VERSION'), '1.0.0\n');
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

describe('detectConfigDir runtime behavior (#1860)', () => {
  let tmpHome;
  let tmpProject;

  beforeEach(() => {
    // realpathSync'd immediately: process.cwd() inside the spawned child
    // resolves symlinks (macOS resolves a temp dir through /private), while
    // os.homedir()'s env-var passthrough does not. Resolving both bases once,
    // up front, and using ONLY the resolved string everywhere downstream
    // (as HOME/cwd for the spawn AND to build every expected path) makes
    // resolving an already-resolved path a no-op on both sides, so the two
    // mechanisms can never disagree — instead of patching the divergence
    // back together at each assertion.
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-home-')));
    tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-project-')));
  });

  afterEach(() => {
    cleanup(tmpHome);
    cleanup(tmpProject);
  });

  test('#1860: returns .claude when both .claude and .config/opencode hold VERSION', () => {
    writeVersionFile(path.join(tmpHome, '.config', 'opencode'));
    writeVersionFile(path.join(tmpHome, '.claude'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.claude'),
      '.claude must win over .config/opencode when both hold VERSION (#1860)'
    );
  });

  test('falls back to .config/opencode when only it holds VERSION', () => {
    writeVersionFile(path.join(tmpHome, '.config', 'opencode'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.config', 'opencode'),
      'expected .config/opencode when it is the only dir with a VERSION file'
    );
  });

  test('falls back to <home>/.claude when nothing holds VERSION and no env override', () => {
    const result = probe({ homeDir: tmpHome, cwd: tmpProject });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.claude'),
      'expected the bare .claude fallback tail when no candidate dir has a VERSION file'
    );
  });

  test('CLAUDE_CONFIG_DIR with a valid VERSION short-circuits the search order', (t) => {
    const envDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-envdir-')));
    t.after(() => cleanup(envDir));
    writeVersionFile(envDir);
    writeVersionFile(path.join(tmpHome, '.claude'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject, envOverrides: { CLAUDE_CONFIG_DIR: envDir } });

    assertConfigDir(
      result.global,
      envDir,
      'CLAUDE_CONFIG_DIR must win outright when its own VERSION file exists'
    );
  });

  test('CLAUDE_CONFIG_DIR without a VERSION file does not short-circuit the search', (t) => {
    const envDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-envdir-')));
    t.after(() => cleanup(envDir));
    writeVersionFile(path.join(tmpHome, '.claude'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject, envOverrides: { CLAUDE_CONFIG_DIR: envDir } });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.claude'),
      'CLAUDE_CONFIG_DIR must be ignored (falling through to the search array) when it has no VERSION file'
    );
  });

  test('CLAUDE_CONFIG_DIR without a VERSION file anywhere falls back to the env dir itself', (t) => {
    const envDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-envdir-')));
    t.after(() => cleanup(envDir));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject, envOverrides: { CLAUDE_CONFIG_DIR: envDir } });

    assertConfigDir(
      result.global,
      envDir,
      'the `return envDir || path.join(baseDir, ".claude")` tail must return the env dir, ' +
      'not the bare .claude fallback, when CLAUDE_CONFIG_DIR is set but nothing has a VERSION file'
    );
  });

  test('CLAUDE_CONFIG_DIR set to an empty string is treated as unset', () => {
    writeVersionFile(path.join(tmpHome, '.claude'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject, envOverrides: { CLAUDE_CONFIG_DIR: '' } });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.claude'),
      'an empty-string CLAUDE_CONFIG_DIR is falsy and must not be treated as a real override'
    );
  });

  // ─── Adjacent-pair ordering (behavioral replacement for the deleted static
  //     array-order grep) ─────────────────────────────────────────────────

  const ADJACENT_PAIRS = [
    ['.claude', '.gemini'],
    ['.gemini', '.config/kilo'],
    ['.config/kilo', '.kilo'],
    ['.kilo', '.config/opencode'],
    ['.config/opencode', '.opencode'],
  ];

  for (const [winner, loser] of ADJACENT_PAIRS) {
    test(`search order: ${winner} wins over ${loser} (#1860 ordering)`, () => {
      writeVersionFile(path.join(tmpHome, winner));
      writeVersionFile(path.join(tmpHome, loser));

      const result = probe({ homeDir: tmpHome, cwd: tmpProject });

      assertConfigDir(
        result.global,
        path.join(tmpHome, winner),
        `${winner} must be searched before ${loser}`
      );
    });
  }

  test('an empty .claude directory (no VERSION file) is not a match — the file is the predicate', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    writeVersionFile(path.join(tmpHome, '.config', 'opencode'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.config', 'opencode'),
      'an existing .claude dir with no gsd-core/VERSION file must not satisfy the search — ' +
      'fs.existsSync(VERSION) is the predicate, not directory existence'
    );
  });

  test('global (home) and project (cwd) resolve independently, each against its own base', () => {
    writeVersionFile(path.join(tmpHome, '.claude'));
    writeVersionFile(path.join(tmpProject, '.config', 'opencode'));

    const result = probe({ homeDir: tmpHome, cwd: tmpProject });

    assertConfigDir(
      result.global,
      path.join(tmpHome, '.claude'),
      'global resolution must be independent of the project (cwd) fixture state'
    );
    assertConfigDir(
      result.project,
      path.join(tmpProject, '.config', 'opencode'),
      'project resolution must be independent of the home (global) fixture state'
    );
  });
});
