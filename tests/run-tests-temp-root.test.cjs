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
  test('setupRunTempRoot creates a dedicated run temp root and repoints the env', (t) => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.setupRunTempRoot, 'function',
      'the runner must export setupRunTempRoot for in-process verification');
    const outer = createTempDir('gsd-4020-outer-');
    t.after(() => cleanup(outer));

    const prev = { ...process.env };
    t.after(() => { process.env = prev; });
    process.env.TMPDIR = outer;
    delete process.env.TEMP;
    delete process.env.TMP;

    const root = runner.setupRunTempRoot();
    t.after(() => cleanup(root));
    assert.ok(path.basename(root).startsWith('gsd-test-run-'),
      'the root is a gsd-test-run-* directory, so a sweep is scoped to it');
    assert.ok(path.dirname(root).startsWith(outer),
      'the root lives INSIDE the operator-provided TMPDIR, preserving the workaround');
    assert.equal(process.env.TMPDIR, root, 'TMPDIR is repointed so children allocate inside the root');
    assert.equal(process.env.TEMP, root, 'TEMP repointed (Windows children read TEMP, not TMPDIR)');
    assert.equal(process.env.TMP, root, 'TMP repointed (Windows fallback)');
  });

  test('setupRunTempRoot is idempotent for nested run-tests spawns', (t) => {
    // Mirrors the GSD_HOME sandbox contract: a nested run-tests spawn (the harness
    // regression test) inherits the root via env and must REUSE it, never mkdtemp a
    // fresh root per invocation.
    const runner = require('../scripts/run-tests.cjs');
    const outer = createTempDir('gsd-4020-idem-');
    t.after(() => cleanup(outer));
    const prev = { ...process.env };
    t.after(() => { process.env = prev; });
    process.env.TMPDIR = outer;

    const first = runner.setupRunTempRoot();
    t.after(() => cleanup(first));
    const second = runner.setupRunTempRoot();
    assert.equal(second, first, 'a second invocation with the root active reuses it');
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
    t.after(() => cleanup(target));

    const r = runNode(
      [RUNNER, target],
      { timeoutMs: 120_000, env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox } },
    );
    assert.equal(r.exitCode, 0, `runner should pass: ${r.stderr.slice(-400)}`);
    const m = /tmp-root=(\S+)/.exec(r.stderr);
    assert.ok(m, 'runner stderr must announce its temp root');
    assert.ok(m[1].startsWith(sandbox), 'the announced root lives inside the sandboxed TMPDIR');
    assert.ok(!fs.existsSync(m[1]), 'the temp root is removed after the run');
  });
});
