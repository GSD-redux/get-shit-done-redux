'use strict';

/**
 * #4020 — the runner's run-scoped temp root.
 *
 * Fixture trees leak under os.tmpdir() on the success path; on a tmpfs /tmp a full
 * `npm test` exhausts the filesystem and the failure surfaces as misleading EDQUOT
 * (-122) copyfile errors in whichever suite runs next. The fix bounds the run: a
 * dedicated `gsd-test-run-*` root repointed via TMPDIR (so every child's
 * mkdtempSync(os.tmpdir()) lands inside it), a sweep between chunks that spares the
 * two reserved sandboxes, a leak-count fail-fast, and removal on exit.
 *
 * Unit rows exercise the runner's exported helpers in-process (the harness
 * convention); the spawn row drives the real CLI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

describe('#4020 — run-tests temp root', () => {
  // setupRunTempRoot mutates the PROCESS env (TMPDIR/TEMP/TMP), so these rows
  // drive it in an isolated child — an in-process call would poison every other
  // subtest's os.tmpdir() resolution (observed: ENOENT cascades in the bench).
  const setupProbe = `
    const runner = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'run-tests.cjs'))});
    const root = runner.setupRunTempRoot();
    console.log(JSON.stringify({
      root,
      base: require('path').basename(root),
      parent: require('path').dirname(root),
      TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    }));
  `;

  test('setupRunTempRoot creates a dedicated run temp root and repoints the env', (t) => {
    const outer = createTempDir('gsd-4020-outer-');
    t.after(() => cleanup(outer));

    const r = runNode(['-e', setupProbe], {
      timeoutMs: 30_000,
      env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
    });
    assert.equal(r.exitCode, 0, `probe failed: ${r.stderr.slice(-300)}`);
    const out = JSON.parse(r.stdout.trim().split(/\n/).pop());
    assert.ok(out.base.startsWith('gsd-test-run-'),
      'the root is a gsd-test-run-* directory, so a sweep is scoped to it');
    assert.equal(out.parent, outer,
      'the root lives INSIDE the operator-provided TMPDIR, preserving the workaround');
    assert.equal(out.TMPDIR, out.root, 'TMPDIR is repointed so children allocate inside the root');
    assert.equal(out.TEMP, out.root, 'TEMP repointed (Windows children read TEMP, not TMPDIR)');
    assert.equal(out.TMP, out.root, 'TMP repointed (Windows fallback)');
    cleanup(out.root);
  });

  test('setupRunTempRoot is idempotent for nested run-tests spawns', (t) => {
    // Mirrors the GSD_HOME sandbox contract: a nested run-tests spawn (the harness
    // regression test) inherits the root via env and must REUSE it, never mkdtemp a
    // fresh root per invocation.
    const probe = setupProbe.replace('const root = runner.setupRunTempRoot();',
      'const first = runner.setupRunTempRoot(); const root = runner.setupRunTempRoot(); console.error(JSON.stringify({ reuse: root === first }));');
    const outer = createTempDir('gsd-4020-idem-');
    t.after(() => cleanup(outer));

    const r = runNode(['-e', probe], {
      timeoutMs: 30_000,
      env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
    });
    assert.equal(r.exitCode, 0, `probe failed: ${r.stderr.slice(-300)}`);
    assert.ok(JSON.parse(r.stderr.trim().split('\n').pop()).reuse === true,
      'a second invocation with the root active reuses it');
  });

  test('sweepRunTempRoot removes leaked fixtures and spares the reserved sandboxes', (t) => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.sweepRunTempRoot, 'function',
      'the runner must export sweepRunTempRoot for in-process verification');
    const root = createTempDir('gsd-test-run-sweep-');
    t.after(() => cleanup(root));
    for (const name of ['gsd-2930-overlay-a', 'gsd-slurm-b', 'spec-section-c', 'unprefixed-d']) {
      fs.mkdirSync(path.join(root, name));
    }
    fs.mkdirSync(path.join(root, 'gsd-test-home-keep'));
    fs.writeFileSync(path.join(root, 'gsd-run-tests-events-keep'), '');

    const removed = runner.sweepRunTempRoot(root);
    assert.equal(removed, 4, 'exactly the four leaked fixture entries are removed');
    for (const name of ['gsd-2930-overlay-a', 'gsd-slurm-b', 'spec-section-c', 'unprefixed-d']) {
      assert.ok(!fs.existsSync(path.join(root, name)), `${name} removed`);
    }
    assert.ok(fs.existsSync(path.join(root, 'gsd-test-home-keep')),
      'the GSD_HOME sandbox survives the sweep (nested-spawn reuse contract)');
    assert.ok(fs.existsSync(path.join(root, 'gsd-run-tests-events-keep')),
      'the events dir survives the sweep (timeout diagnostics)');

    // #4020 CI fix: ancestors of the runner's own selected files must survive —
    // the harness stages synthetic test files under the temp root and later
    // chunks still need them (tests/run-tests-harness.test.cjs #3597).
    for (const name of ['gsd-leak-x', 'gsd-leak-y']) fs.mkdirSync(path.join(root, name));
    const protectedSwept = runner.sweepRunTempRoot(root, new Set([path.join(root, 'gsd-leak-x')]));
    assert.equal(protectedSwept, 1, 'only the unprotected entry is removed');
    assert.ok(fs.existsSync(path.join(root, 'gsd-leak-x')), 'the protected entry survives');
    assert.ok(!fs.existsSync(path.join(root, 'gsd-leak-y')), 'the unprotected entry is removed');
  });

  test('the leak guard fails fast naming the leaked roots', (t) => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.assertTempRootBounded, 'function',
      'the runner must export assertTempRootBounded for in-process verification');
    const root = createTempDir('gsd-test-run-guard-');
    t.after(() => cleanup(root));
    // Boundary: at the limit it passes (limit-1 and limit), at limit+1 it throws.
    for (let i = 0; i < 3; i++) fs.mkdirSync(path.join(root, `gsd-leak-${i}`));

    assert.doesNotThrow(() => runner.assertTempRootBounded(root, 3), 'residue at the limit passes');
    assert.throws(
      () => runner.assertTempRootBounded(root, 2),
      (err) => /temp root leak/i.test(err.message) && err.message.includes('gsd-leak-0'),
      'one over the limit throws a message naming the leaked roots (not EDQUOT)');
  });

  test('the runner removes its temp root on exit', (t) => {
    const sandbox = createTempDir('gsd-4020-spawn-');
    t.after(() => cleanup(sandbox));
    // A single trivial real test file so the runner has work to do and exits 0.
    const target = path.join(__dirname, 'helpers-4020-probe.test.cjs');
    fs.writeFileSync(target, "require('node:test').test('noop #4020', () => {});\n");
    // A single file in the repo tree, not a temp dir — cleanup() refuses
    // out-of-temp-root paths by design, so unlink it directly.
    t.after(() => fs.unlinkSync(target));

    const r = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: 120_000, env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox } },
    );
    assert.equal(r.exitCode, 0, `runner should pass: ${r.stderr.slice(-400)}`);
    const m = /tmp-root=(\S+)/.exec(r.stderr);
    assert.ok(m, 'runner stderr must announce its temp root');
    assert.ok(m[1].startsWith(sandbox), 'the announced root lives inside the sandboxed TMPDIR');
    assert.ok(!fs.existsSync(m[1]), 'the temp root is removed after the run');
  });

  test('a nested runner reuses an inherited root and never removes it', (t) => {
    // #4020 review: the harness regression test spawns run-tests INSIDE a live
    // run — the nested process must reuse the outer root and leave it standing
    // on ITS exit, or the outer suite mass-ENOENTs every later fixture.
    const inherited = createTempDir('gsd-test-run-inherited');
    t.after(() => cleanup(inherited));
    const target = path.join(__dirname, 'helpers-4020-probe.test.cjs');
    fs.writeFileSync(target, "require('node:test').test('noop #4020 nested', () => {});\n");
    // A single file in the repo tree, not a temp dir — cleanup() refuses
    // out-of-temp-root paths by design, so unlink it directly.
    t.after(() => fs.unlinkSync(target));

    const r = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: 120_000, env: { ...process.env, TMPDIR: inherited, TEMP: inherited, TMP: inherited } },
    );
    assert.equal(r.exitCode, 0, `nested runner should pass: ${r.stderr.slice(-400)}`);
    const m = /tmp-root=(\S+)/.exec(r.stderr);
    assert.ok(m, 'nested runner announces its root');
    assert.equal(m[1], inherited, 'the nested runner REUSES the inherited root');
    // The sweep may legitimately clean the root's CONTENTS between chunks; the
    // property under test is that the nested runner never rmSyncs the root ITSELF.
    assert.ok(fs.existsSync(inherited), 'the inherited root survives the nested runner\'s exit');
    // OWNER-ONLY SWEEP: the nested runner runs while the OUTER chunk's sibling
    // test files may be live — it must not sweep THEIR fixtures out from under
    // them (macOS CI: template.test.cjs lost its plan file to exactly that).
    const sibling = path.join(inherited, 'gsd-sibling-live-fixture');
    fs.mkdirSync(sibling);
    const r2 = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: 120_000, env: { ...process.env, TMPDIR: inherited, TEMP: inherited, TMP: inherited } },
    );
    assert.equal(r2.exitCode, 0, `second nested runner should pass: ${r2.stderr.slice(-300)}`);
    assert.ok(fs.existsSync(sibling),
      'a nested runner never sweeps the shared root — sibling fixtures survive');
  });

  describe('#4220 — computeSweepProtectSet ancestor-walk termination', () => {
    // The original inline block stopped the ancestor walk on
    // `cur !== runTempRoot && cur.length > 1`, a POSIX-only sentinel:
    // path.posix.dirname('/') === '/' (length 1) correctly stops, but
    // path.win32.dirname('C:\\') === 'C:\\' (length 3) never satisfies a
    // length check — dirname returns the SAME string forever, so the loop
    // never terminates on Windows whenever a selected file lives outside
    // runTempRoot (the common case: most selected test files are in the repo
    // checkout, not the temp root). This bounds every assertion below with a
    // hard iteration cap so a genuinely-hanging implementation fails FAST in
    // this test run rather than wedging the suite.
    const HARD_ITERATION_CAP = 10_000;

    // A dirnameImpl wrapper that throws once it has been called more times
    // than a real ancestor walk could ever need, turning an infinite loop
    // into a fast, loud test failure instead of a hang.
    function boundedDirname(realDirnameImpl) {
      let calls = 0;
      return (p) => {
        calls++;
        if (calls > HARD_ITERATION_CAP) {
          throw new Error(
            `computeSweepProtectSet: dirname called >${HARD_ITERATION_CAP} times — ` +
            `the ancestor walk did not terminate (regression of #4220)`,
          );
        }
        return realDirnameImpl(p);
      };
    }

    test('terminates and protects ancestors on win32 paths outside runTempRoot', () => {
      const runner = require('../scripts/run-tests.cjs');
      assert.equal(typeof runner.computeSweepProtectSet, 'function',
        'the runner must export computeSweepProtectSet for in-process verification');
      const win32 = require('node:path').win32;
      // A file living entirely outside runTempRoot (the common case — most
      // selected test files are in the repo checkout), walked with the
      // Windows dirname implementation whose drive-root is NOT length 1.
      const selected = ['C:\\repo\\tests\\a\\b.test.cjs'];
      const runTempRoot = 'C:\\Users\\ci\\AppData\\Local\\Temp\\gsd-test-run-xyz';

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(win32.dirname),
      );

      assert.ok(protectSet.has('C:\\repo\\tests\\a\\b.test.cjs'), 'the file itself is protected');
      assert.ok(protectSet.has('C:\\repo\\tests\\a'), 'immediate parent is protected');
      assert.ok(protectSet.has('C:\\repo\\tests'), 'grandparent is protected');
      assert.ok(protectSet.has('C:\\repo'), 'walk reaches up to the drive-relative root');
      // The walk must have stopped — it must NOT contain the drive root
      // itself looping forever, and the protect set must be finite/small.
      assert.ok(protectSet.size < 20, 'the walk terminates with a small, bounded protect set');
    });

    test('terminates and protects ancestors on win32 paths INSIDE runTempRoot (exact-file case)', () => {
      const runner = require('../scripts/run-tests.cjs');
      const win32 = require('node:path').win32;
      const runTempRoot = 'C:\\Users\\ci\\AppData\\Local\\Temp\\gsd-test-run-xyz';
      const selected = [`${runTempRoot}\\fixture\\nested\\c.test.cjs`];

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(win32.dirname),
      );

      assert.ok(protectSet.has(selected[0]), 'the file itself is protected');
      assert.ok(protectSet.has(`${runTempRoot}\\fixture\\nested`), 'immediate parent is protected');
      assert.ok(protectSet.has(`${runTempRoot}\\fixture`), 'grandparent is protected');
      assert.ok(!protectSet.has(win32.dirname(runTempRoot)),
        'the walk stops at runTempRoot and never protects its parent');
    });

    test('terminates and protects ancestors on posix paths (parity with win32)', () => {
      const runner = require('../scripts/run-tests.cjs');
      const posix = require('node:path').posix;
      const selected = ['/repo/tests/a/b.test.cjs'];
      const runTempRoot = '/synthetic-root/gsd-test-run-xyz';

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(posix.dirname),
      );

      assert.ok(protectSet.has('/repo/tests/a/b.test.cjs'), 'the file itself is protected');
      assert.ok(protectSet.has('/repo/tests/a'), 'immediate parent is protected');
      assert.ok(protectSet.has('/repo/tests'), 'grandparent is protected');
      assert.ok(protectSet.has('/repo'), 'walk reaches up toward the root');
      assert.ok(!protectSet.has('/'),
        'the walk stops before adding the filesystem root itself, mirroring win32 behavior');
    });

    test('exact-file case on posix: selected file lies directly under runTempRoot', () => {
      const runner = require('../scripts/run-tests.cjs');
      const posix = require('node:path').posix;
      const runTempRoot = '/synthetic-root/gsd-test-run-xyz';
      const selected = [runTempRoot];

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(posix.dirname),
      );
      assert.ok(protectSet.has(runTempRoot), 'the exact-file case protects runTempRoot itself');
    });

    test('defaults dirnameImpl to the real platform path.dirname when not injected', () => {
      const runner = require('../scripts/run-tests.cjs');
      const path = require('node:path');
      const os = require('node:os');
      const runTempRoot = path.join(os.tmpdir(), 'gsd-test-run-default');
      const selected = [path.join(runTempRoot, 'fixture', 'd.test.cjs')];

      const protectSet = runner.computeSweepProtectSet(selected, runTempRoot);
      assert.ok(protectSet.has(selected[0]), 'default dirnameImpl still protects the selected file');
      assert.ok(protectSet.has(path.join(runTempRoot, 'fixture')), 'default dirnameImpl walks ancestors');
    });
  });
});
