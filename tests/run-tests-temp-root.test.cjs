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
 *
 * #4220 extends this file to the protect-set walk that feeds the sweep; the
 * rows drive it with an injected path module because the defect is unreachable
 * from POSIX-only assertions. See collectSweepProtectPaths for the why.
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

    const r = runNode(['-e', setupProbe], { timeoutMs: 30_000, env: { ...process.env, TMPDIR: outer } });
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

    const r = runNode(['-e', probe], { timeoutMs: 30_000, env: { ...process.env, TMPDIR: outer } });
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

  // #4220 — the ancestor walk that feeds sweepRunTempRoot's protect set.
  // collectSweepProtectPaths's JSDoc carries the account of the defect; what
  // matters here is that these rows inject the path module, because a
  // pure-POSIX assertion cannot observe the class at all.
  //
  // BOUNDED BY CONSTRUCTION: the injected dirname throws once its call budget
  // is spent, so a regression fails this test loudly instead of re-hanging CI
  // the way the bug hangs the runner.
  const budgetedPath = (impl, budget) => {
    const state = { calls: 0 };
    return {
      state,
      pathMod: {
        dirname(p) {
          if (++state.calls > budget) {
            throw new Error(`ancestor walk exceeded ${budget} dirname() calls — it does not terminate`);
          }
          return impl.dirname(p);
        },
      },
    };
  };

  test('the sweep protect walk terminates at a win32 drive root', () => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.collectSweepProtectPaths, 'function',
      'the runner must export collectSweepProtectPaths for in-process verification');

    // The shape that hung CI: a selected file on C:\ while the run temp root is
    // on a DIFFERENT branch of the tree, so the walk can never meet it and must
    // stop at the drive root on its own.
    const root = 'C:\\Users\\runner\\AppData\\Local\\Temp\\gsd-test-run-abc123';
    const selected = ['C:\\a\\gsd-core\\tests\\run-tests-temp-root.test.cjs'];
    const { state, pathMod } = budgetedPath(path.win32, 64);

    let protectSet;
    assert.doesNotThrow(
      () => { protectSet = runner.collectSweepProtectPaths(selected, root, pathMod); },
      'the walk terminates at the win32 drive root instead of spinning on it');
    assert.ok(state.calls <= 8,
      `the walk visits one ancestor per level (observed ${state.calls} dirname calls)`);
    // #4207 semantics preserved: every ancestor between the file and the drive
    // root is protected, and the drive root itself is not (it is never a direct
    // child of the run root, so protecting it would be meaningless).
    assert.ok(protectSet.has('C:\\a\\gsd-core\\tests\\run-tests-temp-root.test.cjs'), 'the file itself is protected');
    assert.ok(protectSet.has('C:\\a\\gsd-core\\tests'), 'its parent directory is protected');
    assert.ok(protectSet.has('C:\\a'), 'the topmost non-root ancestor is protected');
    assert.ok(!protectSet.has('C:\\'), 'the drive root itself is not added');
  });

  test('the sweep protect walk terminates at a UNC and a long-path win32 root', () => {
    // Adversarial review (#4220): rows using only `C:\\` pin the ONE sentinel
    // that shipped, not the class. A "Windows-aware" length check
    // (`cur.length > 3`) or a drive-letter regex (`/^[A-Za-z]:\\$/`) both pass
    // those rows and both still spin here — a UNC share root and a `\\\\?\\`
    // long-path root are neither short nor drive-letter-shaped. Only a dirname
    // FIXED POINT terminates on all four.
    const runner = require('../scripts/run-tests.cjs');
    const root = 'C:\\Temp\\gsd-test-run-abc';
    const selected = [
      '\\\\srv\\share\\gsd-core\\tests\\a.test.cjs',
      '\\\\?\\C:\\a\\gsd-core\\tests\\a.test.cjs',
    ];
    const { state, pathMod } = budgetedPath(path.win32, 64);

    let protectSet;
    assert.doesNotThrow(
      () => { protectSet = runner.collectSweepProtectPaths(selected, root, pathMod); },
      'the walk terminates at a UNC share root and at a long-path root');
    assert.ok(state.calls <= 16, `bounded ancestor walk (observed ${state.calls} dirname calls)`);
    // The fixed points themselves — path.win32.dirname returns these unchanged —
    // must not be protected, exactly as the drive root is not.
    assert.ok(protectSet.has('\\\\srv\\share\\gsd-core'), 'the topmost non-root UNC ancestor is protected');
    assert.ok(!protectSet.has('\\\\srv\\share\\'), 'the UNC share root itself is not added');
    assert.ok(protectSet.has('\\\\?\\C:\\a'), 'the topmost non-root long-path ancestor is protected');
    assert.ok(!protectSet.has('\\\\?\\C:\\'), 'the long-path root itself is not added');
  });

  test('the sweep protect walk terminates at a posix filesystem root', () => {
    const runner = require('../scripts/run-tests.cjs');
    const root = '/tmp/gsd-test-run-abc123';
    const selected = ['/home/runner/gsd-core/tests/run-tests-temp-root.test.cjs'];
    const { state, pathMod } = budgetedPath(path.posix, 64);

    let protectSet;
    assert.doesNotThrow(
      () => { protectSet = runner.collectSweepProtectPaths(selected, root, pathMod); },
      'the walk terminates at the posix filesystem root');
    assert.ok(state.calls <= 8, `bounded ancestor walk (observed ${state.calls} dirname calls)`);
    assert.ok(protectSet.has('/home/runner/gsd-core/tests'), 'the parent directory is protected');
    assert.ok(!protectSet.has('/'), 'the filesystem root itself is not added');
  });

  test('the sweep protect walk protects ancestors inside the run temp root', () => {
    // #4020's actual purpose, asserted under BOTH path flavours: a harness
    // stages synthetic test files under the run root, and the walk must protect
    // the directory chain up to (but not including) the root so the
    // between-chunk sweep leaves them standing for later chunks.
    const runner = require('../scripts/run-tests.cjs');

    for (const [label, impl, root, file, ancestor] of [
      ['win32', path.win32, 'C:\\Temp\\gsd-test-run-abc', 'C:\\Temp\\gsd-test-run-abc\\staged\\a.test.cjs', 'C:\\Temp\\gsd-test-run-abc\\staged'],
      ['posix', path.posix, '/tmp/gsd-test-run-abc', '/tmp/gsd-test-run-abc/staged/a.test.cjs', '/tmp/gsd-test-run-abc/staged'],
    ]) {
      const { pathMod } = budgetedPath(impl, 64);
      const protectSet = runner.collectSweepProtectPaths([file], root, pathMod);
      assert.ok(protectSet.has(file), `${label}: the staged file is protected`);
      assert.ok(protectSet.has(ancestor),
        `${label}: the staged file's directory — a DIRECT child of the run root, i.e. exactly what sweepRunTempRoot tests — is protected`);
      assert.ok(!protectSet.has(root), `${label}: the run root itself is not in the protect set`);
    }
  });

  test('the sweep protect walk keeps the exact-file case', () => {
    // A selected path that IS the run root: the loop body never runs, and the
    // `if (cur === runTempRoot)` branch below it is what puts the entry in the
    // set. #4207 shipped that branch unreachable on Windows (the loop above it
    // never exited); assert it under win32 so it stays reachable.
    const runner = require('../scripts/run-tests.cjs');
    const root = 'C:\\Temp\\gsd-test-run-abc';
    const { state, pathMod } = budgetedPath(path.win32, 64);
    const protectSet = runner.collectSweepProtectPaths([root], root, pathMod);
    assert.deepEqual([...protectSet], [root],
      'the exact-file case adds the path itself and nothing else');
    assert.equal(state.calls, 0, 'no ancestor walk is needed when the file IS the root');
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
});
