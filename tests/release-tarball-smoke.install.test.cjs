// allow-test-rule: integration-test-input
// The script under test (scripts/release-tarball-smoke.cjs) is the system
// under test. We exercise it via its exported pure function, not by reading
// source text. The tarball fixture is produced by npm pack in before().

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir, runNpm, isolatedNpmEnv } = require('./helpers.cjs');
const { SMOKE, runSmoke, CHILD_TIMEOUT_MS } = require('../scripts/release-tarball-smoke.cjs');

const smokeMsg = (label, result) =>
  `${label}: code=${result.code} details=${JSON.stringify(result.details)}`;

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));

// ─── runSmoke install timeout must clear a slow-host cold install (#2335) ────
// Regression: runSmoke()'s internal `npm install -g` used CHILD_TIMEOUT_MS,
// which was 120 s on non-Windows while before()'s pack+install used 600 s. A
// cold-cache install of the 1499-file tarball takes 3–6 min on a slow bench, so
// the per-test installs (B/C/D/E) fired SIGTERM at 120 s and returned a spurious
// INSTALL_FAILED (`spawnSync npm ETIMEDOUT`, empty stdout/stderr) on cartographer
// while passing on faster holodeck — a host-dependent false failure, not a flake.
// The ceiling is now a single exported constant shared by both surfaces; this
// pins it at/above the documented 600 s slow-host floor on EVERY platform, so a
// reintroduced 120 s (or a Windows-only 600 s) fails here instead of on a bench.
describe('release-tarball-smoke: install timeout ceiling', () => {
  test('CHILD_TIMEOUT_MS clears the 600 s slow-host cold-install floor', () => {
    assert.ok(
      Number.isInteger(CHILD_TIMEOUT_MS) && CHILD_TIMEOUT_MS >= 600_000,
      `CHILD_TIMEOUT_MS must be >= 600000ms for cartographer-class hosts; got ${CHILD_TIMEOUT_MS}`,
    );
  });

  test('the ceiling is platform-uniform — no host slower than the CI matrix is left under-provisioned', () => {
    // The slow-host reality (cold disk, constrained CPU) is not OS-specific, so
    // the constant must not be gated behind `process.platform`. A single numeric
    // constant satisfies this by construction; this guards against a future
    // reintroduction of a per-platform ternary that under-provisions Linux/macOS.
    assert.equal(typeof CHILD_TIMEOUT_MS, 'number');
    assert.ok(CHILD_TIMEOUT_MS >= 600_000);
  });
});

describe('release-tarball-smoke', () => {
  // Shared fixture state: pack the tarball once, install it once, reuse for all tests.
  let packDir;
  let installPrefix;
  let tarballPath;
  // fixtureDir for lifecycle / init tests; created once in before(), cleaned in after().
  let fixtureDir;

  before(async () => {
    // Pack once into a temp dir.
    packDir = createTempDir('gsd-smoke-pack-');
    installPrefix = createTempDir('gsd-smoke-prefix-');
    fixtureDir = createTempDir('gsd-smoke-fixture-');

    // npm pack + npm install -g on a large tarball (1499 files, ~10 MB) can take
    // 3–6 minutes on slow Docker hosts (cold disk, constrained CPU). The runNpm
    // default timeout of 180 s is sufficient on fast machines but insufficient on
    // cartographer-class hosts. Share the smoke script's CHILD_TIMEOUT_MS ceiling
    // so before() (pack+install) and runSmoke()'s per-test installs cannot diverge
    // — divergence was the #2335-run defect: before() had 600 s, runSmoke had 120 s
    // on Linux, so the per-test installs alone timed out on cartographer.
    const SLOW_HOST_TIMEOUT = CHILD_TIMEOUT_MS;

    const packOutput = runNpm(
      ['pack', '--pack-destination', packDir],
      { cwd: path.join(__dirname, '..'), timeout: SLOW_HOST_TIMEOUT },
    );

    // npm pack prints the filename as the last line of stdout.
    const lines = packOutput.split(/\r?\n/).filter(Boolean);
    const tgzName = lines[lines.length - 1];
    tarballPath = path.join(packDir, tgzName);
    if (!fs.existsSync(tarballPath)) {
      const found = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (!found) throw new Error(`npm pack produced no .tgz in ${packDir}; output: ${packOutput}`);
      tarballPath = path.join(packDir, found);
    }

    // Install once into installPrefix. All tests share this install.
    runNpm(['install', '-g', '--prefix', installPrefix, tarballPath], { timeout: SLOW_HOST_TIMEOUT });
  });

  after(() => {
    cleanup(packDir);
    cleanup(installPrefix);
    cleanup(fixtureDir);
  });

  // ── Test A — happy path ────────────────────────────────────────────────────
  test('A: happy path — installed version matches package.json', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('A', result));
    assert.equal(result.details.version, pkg.version, smokeMsg('A', result));
  });

  // ── Test B — version mismatch detected ────────────────────────────────────
  test('B: version mismatch detected — returns VERSION_MISMATCH', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: '99.99.99',
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.VERSION_MISMATCH, smokeMsg('B', result));
  });

  // ── Test C — happy lifecycle ───────────────────────────────────────────────
  // Verifies that the installed package has all expected command .md files and
  // that each command resolves a workflow .md file that also exists.
  // Also verifies that `gsd-core --local --claude` (init) succeeds in
  // the fixtureDir and creates the expected .claude/ directories.
  test('C: happy lifecycle — command + workflow files resolve OK', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'discuss-phase', 'plan-phase'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('C', result));

    // Each non-init command must be in lifecycleResolved with both paths populated
    const resolved = result.details.lifecycleResolved;
    assert.ok(Array.isArray(resolved));

    for (const entry of resolved) {
      assert.ok(
        typeof entry.commandPath === 'string' && entry.commandPath.length > 0,
        `expected commandPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.commandPath) && fs.statSync(entry.commandPath).isFile(),
        `commandPath must be an existing file: ${entry.commandPath}`,
      );
      assert.ok(
        typeof entry.workflowPath === 'string' && entry.workflowPath.length > 0,
        `expected workflowPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.workflowPath) && fs.statSync(entry.workflowPath).isFile(),
        `workflowPath must be an existing file: ${entry.workflowPath}`,
      );
    }
  });

  // ── Test D — missing command detected ─────────────────────────────────────
  // Passes a nonexistent command name; expects the smoke to detect the missing
  // command .md file and return COMMAND_FILE_MISSING with the right details.
  test('D: missing command detected — returns COMMAND_FILE_MISSING', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'nonexistent-phase-xyz'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.COMMAND_FILE_MISSING, smokeMsg('D', result));
    assert.equal(result.details.command, 'nonexistent-phase-xyz', smokeMsg('D', result));
    assert.ok(typeof result.details.path === 'string' && result.details.path.length > 0, smokeMsg('D', result));
  });

  // ── Test E — workflow-body checks run (informational) ─────────────────────
  // Asserts that the workflow-body scanning machinery ran (structural assertion).
  // Does NOT assert colonLeakCount is zero — when those issues are fixed, this
  // test continues to pass unchanged.
  test('E: workflow-body checks run — scan counts are present integers', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: [],
      npmEnv: isolatedNpmEnv(),
    });

    // Structural: the scan ran and populated the counters
    assert.ok(
      Number.isInteger(result.details.workflowsScanned) && result.details.workflowsScanned >= 1,
      smokeMsg('E', result),
    );
    assert.ok(
      Number.isInteger(result.details.colonLeakCount),
      smokeMsg('E', result),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-131-release-tarball-smoke-explicit-home.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-131-release-tarball-smoke-explicit-home (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: integration-test-input (see #131)
// Regression test for #131: runNpm() must not fail when HOME points at an
// unwritable directory. The before() hook in release-tarball-smoke.install.test.cjs
// calls runNpm(['pack', ...]) and runNpm(['install', '-g', ...]) — if those inherit
// an unwritable HOME from the environment (common in constrained Docker hosts),
// the entire hook fails and all 6 subtests are cancelled.
//
// Fix: runNpm() must inject an explicit HOME, npm_config_cache, and
// npm_config_userconfig that point into a temp directory it owns, so that npm
// never reads from or writes to the caller's HOME.
//
// Test 3 (added in the second fix pass) verifies that isolatedNpmEnv() — the
// companion export that lets runSmoke() apply the same isolation — also redirects
// HOME away from the caller's HOME. Without this, subtests A-F of
// release-tarball-smoke.install.test.cjs still fail because runSmoke() calls
// spawnSync('npm', ...) internally and was not covered by the runNpm() fix.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The helpers under test.
const { isolatedNpmEnv, cleanup } = require('./helpers.cjs');

// Resolve a filesystem path to its canonical (symlink-free) form even if the
// leaf does not exist yet (e.g. ~/.npm before npm has written its cache).
// Walks up to the nearest existing ancestor, resolves that, then re-appends
// the trailing segments. This handles macOS /var → /private/var symlinks for
// paths created under os.tmpdir() where the leaf directory may not exist yet.
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    // Leaf does not exist — resolve the nearest existing ancestor then
    // reconstruct the original suffix so the result is still canonical.
    const segments = [];
    let cur = p;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached filesystem root — return original path unchanged.
        return p;
      }
      segments.unshift(path.basename(cur));
      cur = parent;
      try {
        return path.join(fs.realpathSync(cur), ...segments);
      } catch (__) {
        // Keep walking up.
      }
    }
  }
}

describe('bug-131: runNpm isolates HOME from the caller environment', () => {
  // ── Test 1 — runNpm works with an unwritable HOME ────────────────────────
  // Spawn a child Node process that sets HOME to a chmod-0500 directory, then
  // invokes runNpm(['--version']). Without the fix, npm tries to read/write
  // HOME/.npmrc and HOME/.npm, fails with EACCES, and runNpm throws.
  // With the fix, runNpm injects its own isolated HOME and npm succeeds.
  test('runNpm succeeds even when process HOME is unwritable', () => {
    // Create an unwritable dir to serve as a poisoned HOME.
    const poisonedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug131-poison-'));
    try {
      fs.chmodSync(poisonedHome, 0o500); // r-x only — not writable

      // We exercise the real runNpm() path by running a tiny inline Node script
      // that requires helpers.cjs and calls runNpm(['--version']) with HOME set
      // to the unwritable dir. The script exits 0 on success, non-zero on throw.
      const script = `
        process.env.HOME = ${JSON.stringify(poisonedHome)};
        process.env.USERPROFILE = ${JSON.stringify(poisonedHome)};
        const { runNpm } = require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});
        try {
          const out = runNpm(['--version']);
          if (!out || out.trim() === '') process.exit(2); // vacuous success guard
          process.stdout.write(out);
          process.exit(0);
        } catch (e) {
          process.stderr.write(e.message + '\\n');
          process.exit(1);
        }
      `;

      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      try {
        stdout = execFileSync(process.execPath, ['-e', script], {
          encoding: 'utf-8',
          timeout: 30_000,
        });
      } catch (err) {
        stdout = err.stdout || '';
        stderr = err.stderr || '';
        exitCode = err.status ?? 1;
      }

      assert.equal(
        exitCode,
        0,
        `runNpm should succeed with an unwritable HOME but exited ${exitCode}. stderr: ${stderr}`,
      );
      // npm --version returns something like "10.x.y"
      assert.match(
        stdout.trim(),
        /^\d+\.\d+/,
        `expected semver output from npm --version, got: ${stdout}`,
      );
    } finally {
      // Restore write permission before cleanup so the directory can be deleted.
      try { fs.chmodSync(poisonedHome, 0o700); } catch (_) { /* best-effort */ }
      cleanup(poisonedHome);
    }
  });

  // ── Test 2 — runNpm does not leak a caller-supplied HOME into npm ────────
  // Even if the caller exports HOME=/some/real/path, the injected HOME must be
  // a different (temp) path so npm writes never touch the caller's $HOME.
  test('runNpm injects a HOME distinct from process.env.HOME', () => {
    // Capture what HOME runNpm actually passes to npm by asking npm to print
    // the value it sees for the $HOME env var. We do this via `npm config get
    // cache` which reveals the cache path — if it's under process.env.HOME,
    // the fix is absent; if it's under a tmp dir, the fix is present.

    const script = `
      const { runNpm } = require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});
      try {
        // npm config get cache prints the effective cache directory.
        const out = runNpm(['config', 'get', 'cache']);
        process.stdout.write(out.trim());
        process.exit(0);
      } catch (e) {
        process.stderr.write(e.message + '\\n');
        process.exit(1);
      }
    `;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      exitCode = err.status ?? 1;
    }

    assert.equal(
      exitCode,
      0,
      `runNpm config get cache failed with exit ${exitCode}. stderr: ${stderr}`,
    );

    const effectiveCacheDir = stdout.trim();

    // The effective npm cache must NOT be inside the calling process's HOME.
    // If it is, the fix was not applied and the Docker regression can still occur.
    const callerHome = os.homedir();
    assert.ok(
      !effectiveCacheDir.startsWith(callerHome),
      `npm cache dir ${effectiveCacheDir} is still under caller HOME ${callerHome} — fix not applied`,
    );

    // It must be somewhere under the system tmp dir, confirming isolation.
    // Use safeRealpath on both sides so that macOS /var→/private/var symlinks
    // do not cause a false mismatch when os.tmpdir() and the resolved cache
    // path differ only in symlink expansion. The cache sub-directory (.npm) may
    // not exist yet; safeRealpath walks up to the nearest existing ancestor.
    const sysTmp = safeRealpath(os.tmpdir());
    const realCacheDir = safeRealpath(effectiveCacheDir);
    assert.ok(
      realCacheDir.startsWith(sysTmp),
      `npm cache dir ${realCacheDir} should be under tmpdir ${sysTmp}`,
    );
  });

  // ── Test 3 — isolatedNpmEnv() redirects HOME away from the caller's HOME ──
  // runSmoke() calls spawnSync('npm', ...) with npmEnv from isolatedNpmEnv().
  // If isolatedNpmEnv() didn't redirect HOME, subtests A-F would still fail on
  // Docker hosts with an unwritable HOME (the original bug #131 root cause,
  // manifesting via the sibling runSmoke() path). (#131)
  test('isolatedNpmEnv() HOME is distinct from the caller HOME and lives under tmpdir', () => {
    const env = isolatedNpmEnv();

    // Must expose a HOME key.
    assert.ok(
      typeof env.HOME === 'string' && env.HOME.length > 0,
      'isolatedNpmEnv() must set HOME',
    );

    // Must not be the caller's HOME.
    const callerHome = os.homedir();
    assert.notEqual(
      env.HOME,
      callerHome,
      `isolatedNpmEnv() HOME must differ from caller HOME ${callerHome}`,
    );

    // Must live under the system tmpdir, confirming it is an isolated temp directory.
    // Use safeRealpath on both sides so that macOS /var→/private/var symlinks
    // do not cause a false mismatch.
    const sysTmp = safeRealpath(os.tmpdir());
    const realHome = safeRealpath(env.HOME);
    assert.ok(
      realHome.startsWith(sysTmp),
      `isolatedNpmEnv() HOME ${realHome} should be under tmpdir ${sysTmp}`,
    );

    // npm_config_cache and npm_config_userconfig must also be set and under the isolated HOME.
    assert.ok(
      typeof env.npm_config_cache === 'string' && env.npm_config_cache.startsWith(env.HOME),
      `npm_config_cache ${env.npm_config_cache} should be under isolated HOME ${env.HOME}`,
    );
    assert.ok(
      typeof env.npm_config_userconfig === 'string' && env.npm_config_userconfig.startsWith(env.HOME),
      `npm_config_userconfig ${env.npm_config_userconfig} should be under isolated HOME ${env.HOME}`,
    );
    assert.equal(
      env.npm_config_loglevel,
      'error',
      'isolatedNpmEnv() should suppress npm notice/warn chatter in test gates',
    );
    assert.equal(
      env.npm_config_update_notifier,
      'false',
      'isolatedNpmEnv() should disable npm update-notifier notices in test gates',
    );
    assert.equal(
      env.NO_UPDATE_NOTIFIER,
      '1',
      'isolatedNpmEnv() should disable npm update-notifier notices for npm versions that honor NO_UPDATE_NOTIFIER',
    );
  });

  // ── Test 4 — runNpm's 180000ms bound survives an explicit `timeout: undefined` ──
  // (#3148 wave 4) runNpm() used to spread `...defaults` (which carries
  // `timeout: 180000`) and then `...otherOptions` AFTER it, so a caller
  // passing an own `timeout: undefined` key (not an omission) silently won
  // the spread and erased the bound, leaving the underlying execFileSync call
  // unbounded. The fix destructures `timeout` off `options` with a default
  // and passes it explicitly after both spreads, so an own `undefined` key
  // resolves to the default instead of erasing it.
  //
  // Proof is behavioral, not textual: a fresh child process monkeypatches
  // `child_process.execFileSync` to capture the options object it actually
  // receives — before `helpers.cjs` is required in that child, so its
  // top-level `const { execFileSync } = require('child_process')` picks up
  // the patched function — then calls `runNpm(['--version'], { timeout:
  // undefined })` and reports back the captured `timeout` value. Reverting
  // the destructure-with-default fix (restoring the plain `{ ...defaults,
  // ...otherOptions, env: mergedEnv }` spread order) makes this test fail:
  // the captured `timeout` becomes `undefined` instead of `180000`.
  test('runNpm resolves an explicit `timeout: undefined` to the 180000ms bound, not unbounded', () => {
    const script = `
      const cp = require('node:child_process');
      const seen = [];
      cp.execFileSync = (cmd, args, options) => {
        seen.push(options);
        return '9.9.9';
      };
      const { runNpm } = require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});
      // An own \`timeout: undefined\` key — not an omitted key — is the exact
      // hazard: a caller-controlled property that must not erase the bound.
      runNpm(['--version'], { timeout: undefined });
      process.stdout.write(JSON.stringify({ timeout: seen[0] && seen[0].timeout }));
    `;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      exitCode = err.status ?? 1;
    }

    assert.equal(
      exitCode,
      0,
      `runNpm timeout-capture probe failed with exit ${exitCode}. stderr: ${stderr}`,
    );

    const captured = JSON.parse(stdout.trim());
    assert.equal(
      captured.timeout,
      180000,
      `runNpm must resolve an explicit timeout: undefined to the 180000ms bound; ` +
        `captured options.timeout was ${JSON.stringify(captured.timeout)} — an unset bound ` +
        `is not a bound (DEFECT.UNBOUNDED-SUBPROCESS)`,
    );
  });
});
  });
}
