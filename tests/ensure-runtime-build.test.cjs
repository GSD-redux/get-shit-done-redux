'use strict';

/**
 * Tests for gsd-core/bin/ensure-runtime-build.cjs — the self-healing runtime
 * build that compiles the gitignored ./lib/*.cjs artifacts on demand when the
 * CLI is run from a channel (Claude Code plugin marketplace) that never ran
 * `npm run build:lib`. See #2002.
 *
 * The unit tests inject `spawn` so no real tsc runs; the final integration test
 * drives the REAL module against a real (tiny) tsc build in a temp package to
 * prove the end-to-end heal. IO failures are injected by monkeypatching the fs
 * method (root-independent, OS-independent), never via chmod.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  ensureRuntimeBuild,
  resolveTscScript,
  isBuilt,
  RuntimeBuildError,
  SENTINEL,
} = require('../gsd-core/bin/ensure-runtime-build.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
// 180000: a build — this driver invokes ensureRuntimeBuild against a REAL
// tsc compile (not a query), at the tsc-compile end of the
// 120000-180000 build-class norm.
const BUILD_TIMEOUT_MS = 180000;

/** Fresh isolated package dir (auto-cleaned) with a libDir and optional tsconfig. */
function makeEnv(t, { withTsconfig = true, prebuilt = false } = {}) {
  const dir = createTempDir('gsd-erb-');
  t.after(() => cleanup(dir));
  const libDir = path.join(dir, 'gsd-core', 'bin', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  if (withTsconfig) fs.writeFileSync(path.join(dir, 'tsconfig.build.json'), '{}');
  if (prebuilt) fs.writeFileSync(path.join(libDir, SENTINEL), '// built\n');
  return { dir, packageRoot: dir, libDir };
}

/** A spawn stub that "builds" by writing the sentinel, then reports success. */
function buildingSpawn(libDir, calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    fs.writeFileSync(path.join(libDir, SENTINEL), '// built by stub\n');
    return { status: 0, stdout: '', stderr: '' };
  };
}

const silent = () => {};

test('fast path: already-built lib is a no-op, never spawns tsc', (t) => {
  const { libDir, packageRoot } = makeEnv(t, { prebuilt: true });
  const calls = [];
  const res = ensureRuntimeBuild({
    libDir,
    packageRoot,
    spawn: (...a) => { calls.push(a); return { status: 0 }; },
    log: silent,
  });
  assert.deepEqual(res, { built: true, healed: false });
  assert.equal(calls.length, 0, 'must not spawn when already built');
});

test('heal path: missing lib is compiled once with the correct tsc invocation', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  const calls = [];
  const res = ensureRuntimeBuild({
    libDir,
    packageRoot,
    tscScript: '/fake/typescript/bin/tsc',
    spawn: buildingSpawn(libDir, calls),
    log: silent,
  });
  assert.equal(res.built, true);
  assert.equal(res.healed, true);
  assert.equal(calls.length, 1, 'compiles exactly once');
  const { cmd, args, options } = calls[0];
  assert.equal(cmd, process.execPath, 'runs `node <tsc>` (portable, no shell/.cmd)');
  assert.deepEqual(args, [
    '/fake/typescript/bin/tsc',
    '-p',
    path.join(packageRoot, 'tsconfig.build.json'),
  ]);
  assert.equal(options.cwd, packageRoot);
  assert.ok(isBuilt(libDir), 'sentinel exists after heal');
});

test('missing tsconfig.build.json throws an actionable RuntimeBuildError', (t) => {
  const { libDir, packageRoot } = makeEnv(t, { withTsconfig: false });
  assert.throws(
    () => ensureRuntimeBuild({ libDir, packageRoot, tscScript: '/fake/tsc', log: silent }),
    (err) => {
      assert.ok(err instanceof RuntimeBuildError);
      assert.match(err.message, /tsconfig\.build\.json not found/);
      assert.match(err.message, /npm run build:lib/);
      return true;
    },
  );
});

test('absent TypeScript throws with install guidance and does not spawn', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  const calls = [];
  assert.throws(
    () => ensureRuntimeBuild({
      libDir,
      packageRoot,
      tscScript: null, // TypeScript not resolvable
      spawn: (...a) => { calls.push(a); return { status: 0 }; },
      log: silent,
    }),
    (err) => {
      assert.ok(err instanceof RuntimeBuildError);
      assert.match(err.message, /TypeScript is unavailable/);
      assert.match(err.message, /npm install && npm run build:lib/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'never spawns when tsc is absent');
});

test('non-zero tsc exit surfaces the exit code and captured output', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  assert.throws(
    () => ensureRuntimeBuild({
      libDir,
      packageRoot,
      tscScript: '/fake/tsc',
      spawn: () => ({ status: 2, stdout: '', stderr: 'src/x.cts(1,1): error TS1005' }),
      log: silent,
    }),
    (err) => {
      assert.ok(err instanceof RuntimeBuildError);
      assert.match(err.message, /tsc exit 2/);
      assert.match(err.message, /error TS1005/);
      return true;
    },
  );
});

test('tsc reports success but sentinel is still missing → throws', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  assert.throws(
    () => ensureRuntimeBuild({
      libDir,
      packageRoot,
      tscScript: '/fake/tsc',
      spawn: () => ({ status: 0 }), // "succeeds" but writes nothing
      log: silent,
    }),
    (err) => {
      assert.ok(err instanceof RuntimeBuildError);
      assert.match(err.message, /still missing/);
      return true;
    },
  );
});

test('the build lock releases after a successful heal', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  ensureRuntimeBuild({
    libDir,
    packageRoot,
    tscScript: '/fake/tsc',
    spawn: buildingSpawn(libDir, []),
    log: silent,
  });
  assert.ok(!fs.existsSync(path.join(libDir, '.build.lock')), 'lock removed in finally');
});

test('lock contention: waits for a peer build instead of racing tsc', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  fs.mkdirSync(path.join(libDir, '.build.lock')); // a peer "holds" the lock
  const calls = [];
  const res = ensureRuntimeBuild({
    libDir,
    packageRoot,
    tscScript: '/fake/tsc',
    spawn: (...a) => { calls.push(a); return { status: 0 }; },
    log: silent,
    pollMs: 1,
    waitTimeoutMs: 1000,
    // Peer finishes the build between polls.
    onPoll: () => fs.writeFileSync(path.join(libDir, SENTINEL), '// peer built\n'),
  });
  assert.equal(res.healed, true);
  assert.equal(res.waited, true);
  assert.equal(calls.length, 0, 'never launches a competing tsc');
});

test('lock takeover: a crashed peer (stale lock) is taken over and the build runs', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  const lockDir = path.join(libDir, '.build.lock');
  fs.mkdirSync(lockDir);
  const calls = [];
  const res = ensureRuntimeBuild({
    libDir,
    packageRoot,
    tscScript: '/fake/tsc',
    spawn: buildingSpawn(libDir, calls),
    log: silent,
    pollMs: 1,
    waitTimeoutMs: 0, // give up waiting immediately
    // Peer vanished without finishing — free the stale lock so we can take over.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- simulating a peer releasing its lock, not temp-dir teardown
    onPoll: () => fs.rmSync(lockDir, { recursive: true, force: true }),
  });
  assert.equal(res.healed, true);
  assert.equal(calls.length, 1, 'takes over and builds once');
});

test('lock never frees before timeout → throws a lock-held RuntimeBuildError', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  fs.mkdirSync(path.join(libDir, '.build.lock')); // stuck peer, never released
  assert.throws(
    () => ensureRuntimeBuild({
      libDir,
      packageRoot,
      tscScript: '/fake/tsc',
      spawn: buildingSpawn(libDir, []),
      log: silent,
      pollMs: 1,
      waitTimeoutMs: 0,
    }),
    (err) => {
      assert.ok(err instanceof RuntimeBuildError);
      assert.match(err.message, /did not complete within 0ms/);
      return true;
    },
  );
});

test('IO fault on lock acquisition propagates (injected via fs monkeypatch, not chmod)', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  const lockDir = path.join(libDir, '.build.lock');
  const orig = fs.mkdirSync;
  fs.mkdirSync = (target, opts) => {
    if (target === lockDir) {
      const e = new Error('injected EPERM');
      e.code = 'EPERM';
      throw e;
    }
    return orig(target, opts);
  };
  try {
    assert.throws(
      () => ensureRuntimeBuild({
        libDir,
        packageRoot,
        tscScript: '/fake/tsc',
        spawn: buildingSpawn(libDir, []),
        log: silent,
      }),
      (err) => {
        // Non-EEXIST lock errors must NOT be swallowed as "peer holds lock".
        assert.equal(err.code, 'EPERM');
        return true;
      },
    );
  } finally {
    fs.mkdirSync = orig;
  }
});

test('heal clears a stale tsc incremental cache before compiling (forces full emit)', (t) => {
  const { libDir, packageRoot } = makeEnv(t);
  const buildInfo = path.join(packageRoot, 'tsconfig.build.tsbuildinfo');
  fs.writeFileSync(buildInfo, '{"stale":true}'); // leftover from a partial build
  ensureRuntimeBuild({
    libDir,
    packageRoot,
    tscScript: '/fake/tsc',
    spawn: buildingSpawn(libDir, []),
    log: silent,
  });
  assert.ok(!fs.existsSync(buildInfo), 'stale .tsbuildinfo removed so tsc re-emits');
});

test('resolveTscScript finds the real TypeScript under the repo root', () => {
  const tsc = resolveTscScript(REPO_ROOT);
  assert.ok(tsc && tsc.includes('typescript'), 'resolves the installed typescript/bin/tsc');
  assert.ok(fs.existsSync(tsc), 'resolved tsc script exists on disk');
});

test('integration: real tsc heals a missing lib end-to-end (subprocess)', (t) => {
  // Build a tiny package that mirrors the real layout: a src/*.cts that tsc
  // compiles to gsd-core/bin/lib/cli-exit.cjs. Then invoke the REAL module from
  // a subprocess with lib absent and assert it self-heals and the require works.
  const dir = createTempDir('gsd-erb-int-');
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        rootDir: 'src',
        outDir: 'gsd-core/bin/lib',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'ES2022',
        noEmitOnError: true,
      },
      include: ['src/**/*.cts'],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'cli-exit.cts'),
    'export const runMain = (): string => "ok";\n',
  );

  // Resolve the REAL tsc and pass it explicitly, rather than symlinking
  // node_modules into the temp package — directory-symlink creation is a
  // privileged operation on Windows and would fail on CI runners. resolveTscScript
  // itself is covered by its own unit test; here we just need a real tsc to run.
  const realTsc = resolveTscScript(REPO_ROOT);
  assert.ok(realTsc, 'real typescript resolvable for the integration build');
  const driver = path.join(dir, 'driver.cjs');
  fs.writeFileSync(
    driver,
    `const { ensureRuntimeBuild } = require(${JSON.stringify(
      path.join(REPO_ROOT, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'),
    )});\n` +
      `const libDir = ${JSON.stringify(path.join(dir, 'gsd-core', 'bin', 'lib'))};\n` +
      `const packageRoot = ${JSON.stringify(dir)};\n` +
      `const tscScript = ${JSON.stringify(realTsc)};\n` +
      'const r = ensureRuntimeBuild({ libDir, packageRoot, tscScript, log: () => {} });\n' +
      'const { runMain } = require(require("path").join(libDir, "cli-exit.cjs"));\n' +
      'process.stdout.write(JSON.stringify({ healed: r.healed, run: runMain() }));\n',
  );

  assert.ok(!isBuilt(path.join(dir, 'gsd-core', 'bin', 'lib')), 'lib starts empty');
  const driverResult = runNode([driver], { cwd: dir, timeoutMs: BUILD_TIMEOUT_MS });
  throwIfFailed(driverResult, `node ${driver}`);
  const parsed = JSON.parse(driverResult.stdout);
  assert.equal(parsed.healed, true, 'self-healed the missing build');
  assert.equal(parsed.run, 'ok', 'the freshly-compiled cli-exit.cjs loads and runs');
});
