'use strict';

/**
 * Integration tests for the `check predicate` subcommand wiring (#2008).
 *
 * These exercise the PRODUCTION stack: the real `buildPredicateDeps()` binding
 * (which wraps shell-command-projection.execTool → bounded `sh -c` spawnSync) and
 * the `parsePredicateFlags` arg parser. The pure evaluator logic is covered by
 * gate-predicate-evaluator.test.cjs; this file proves the wiring holds against
 * real subprocess exit codes and a real timeout kill.
 *
 * Commands run are instant (`true` / `false` / `exit 3`) or tightly bounded
 * (a 100ms timeout killing `sleep 1`), so there is no orphan/leak risk.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePredicate } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { buildPredicateDeps, parsePredicateFlags } = require('../gsd-core/bin/lib/check-command-router.cjs');

// ─── buildPredicateDeps: real subprocess exit mapping ─────────────────────────

describe('buildPredicateDeps — real bounded sh -c subprocess', () => {
  const deps = buildPredicateDeps();
  const cwd = process.cwd();

  test('`true` => exitCode 0, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'true', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test('`false` => exitCode 1, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'false', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
  });

  test('`exit 3` => exitCode 3', () => {
    const r = deps.runBoundedShell({ command: 'exit 3', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 3);
  });

  test('stderr is captured from the subprocess', () => {
    const r = deps.runBoundedShell({ command: 'echo oops >&2; exit 4', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr, /oops/);
  });

  test('timeout kills the subprocess (SIGTERM => timedOut:true)', () => {
    const r = deps.runBoundedShell({ command: 'sleep 1', cwd, timeoutMs: 100 });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGTERM');
  });
});

// ─── evaluatePredicate + production deps: end-to-end exit mapping ─────────────

describe('evaluatePredicate + production deps — command-exit-zero e2e', () => {
  const deps = buildPredicateDeps();
  const ctx = { cwd: process.cwd() };

  test('command `true` => block:false', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'true' }, ctx, deps);
    assert.equal(res.block, false);
  });

  test('command `false` => block:true', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'false' }, ctx, deps);
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
  });

  test('interpolation reaches the real shell ($PHASE_NUMBER via flag context)', () => {
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'test "${PHASE_NUMBER}" = "07" && true || false' },
      { cwd: process.cwd(), phaseNumber: '07' },
      deps,
    );
    assert.equal(res.block, false);
  });
});

// ─── parsePredicateFlags ───────────────────────────────────────────────────────

describe('parsePredicateFlags', () => {
  test('extracts --flag value pairs, skips positional + bare --flags', () => {
    const out = parsePredicateFlags(['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw']);
    assert.deepEqual(out, { predicate: '{"kind":"x"}', 'phase-number': '03' });
  });

  test('last write wins for repeated flags', () => {
    const out = parsePredicateFlags(['--phase-number', '01', '--phase-number', '02']);
    assert.equal(out['phase-number'], '02');
  });

  test('value that starts with -- is not consumed (treated as a flag)', () => {
    const out = parsePredicateFlags(['--predicate', '--phase-number']);
    assert.equal('predicate' in out, false);
  });

  test('empty args => empty map', () => {
    assert.deepEqual(parsePredicateFlags([]), {});
  });
});

// ─── #4130 follow-up: partitionPredicateArgs (flags + positionals, one parser) ─

/**
 * `partitionPredicateArgs` is the single pass behind `parsePredicateFlags`:
 * it returns BOTH the --flag value map AND the non-consumed positional tokens
 * under the exact same skip/consume/last-wins semantics. `check
 * decision-coverage-plan --context <path>` uses it so the flag and the
 * positional surface share one parser with `check predicate` — the two
 * parsers cannot diverge because there is only one.
 */
describe('partitionPredicateArgs (#4130 follow-up)', () => {
  const { partitionPredicateArgs } = require('../gsd-core/bin/lib/check-command-router.cjs');

  test('splits --flag value pairs from positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(
      ['check', 'decision-coverage-plan', '--context', '/tmp/CONTEXT.md', 'phases/01-init'],
    );
    assert.deepEqual(flags, { context: '/tmp/CONTEXT.md' });
    assert.deepEqual(positionals, ['check', 'decision-coverage-plan', 'phases/01-init']);
  });

  test('parsePredicateFlags is exactly the flags half (one source of truth)', () => {
    const vectors = [
      ['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw'],
      ['--phase-number', '01', '--phase-number', '02'],
      ['--predicate', '--phase-number'],
      [],
      ['--context'],
      ['a', '--context', 'b', '--context', 'c', 'd'],
    ];
    for (const v of vectors) {
      assert.deepEqual(partitionPredicateArgs(v).flags, parsePredicateFlags(v),
        `flags half must equal parsePredicateFlags for ${JSON.stringify(v)}`);
    }
  });

  test('value that starts with -- is not consumed: both stay flags, neither becomes positional', () => {
    const { flags, positionals } = partitionPredicateArgs(['--context', '--other']);
    assert.deepEqual(flags, {});
    assert.deepEqual(positionals, ['--context', '--other']);
  });

  test('last write wins; flag values never leak into positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(['p1', '--context', 'a', 'p2', '--context', 'b', 'p3']);
    assert.equal(flags.context, 'b');
    assert.deepEqual(positionals, ['p1', 'p2', 'p3']);
  });
});

// ─── #4354: --phase-dir confinement (the flag → ctx seam) ─────────────────────

/**
 * DEFECT (#4354): `cmdCheckPredicate` built `ctx.phaseDir` from `--phase-dir`
 * verbatim. `findPhaseArtifact` confines the artifact *suffix* under phaseDir
 * (`validatePath(artifactSuffix, phaseDir)`) but nothing confined phaseDir
 * itself, so a BLOCKING capability-declared gate could source a `block:false`
 * verdict from any directory on the machine — and the same unconfined value
 * interpolated into `${PHASE_DIR}` for the `command-exit-zero` kind.
 *
 * These drive the real CLI because the defect lived in the flag -> ctx seam,
 * not in the pure evaluator: only the CLI wrapper knows the project root to
 * confine against, and only it can map a rejection to the non-zero exit the
 * two-step gate contract routes per `onError`.
 */
describe('check predicate — --phase-dir project confinement (#4354)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

  const FRONTMATTER = '---\nstatus: complete\n---\n# Summary\n';

  const ARTIFACT_PREDICATE = JSON.stringify({
    kind: 'artifact-frontmatter-equals',
    artifact: 'SUMMARY.md',
    field: 'status',
    equals: 'complete',
  });
  // Passes iff ${PHASE_DIR} resolves to a directory holding the outside artifact.
  const COMMAND_PREDICATE = JSON.stringify({
    kind: 'command-exit-zero',
    command: 'test -f "${PHASE_DIR}/01-SUMMARY.md"',
  });

  /**
   * A project whose in-project phase dir AND an unrelated outside dir both hold
   * an artifact satisfying the predicate. Only the artifact's LOCATION differs
   * between the passing case and the must-not-pass cases.
   */
  function makeFixture(t) {
    const project = createTempDir('pred-4354-proj-');
    const outside = createTempDir('pred-4354-out-');
    t.after(() => { cleanup(project); cleanup(outside); });
    const inside = path.join(project, '.planning', 'phases', '01-demo');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, '01-SUMMARY.md'), FRONTMATTER, 'utf8');
    fs.writeFileSync(path.join(outside, '01-SUMMARY.md'), FRONTMATTER, 'utf8');
    return { project, outside, inside };
  }

  function runPredicate(fx, phaseDir, predicateJson) {
    return runGsdTools(
      ['check', 'predicate',
        '--predicate', predicateJson || ARTIFACT_PREDICATE,
        '--phase-dir', phaseDir,
        '--cwd', fx.project,
        '--raw'],
      fx.project,
    );
  }

  /** Non-zero exit is the fail-closed shape: a step-1 command failure, routed per onError. */
  function assertRejected(result, label) {
    assert.strictEqual(
      result.success, false,
      `${label}: an out-of-project --phase-dir must fail the check COMMAND, not return a verdict. stdout: ${result.output}`,
    );
    assert.match(result.error, /--phase-dir must resolve inside the project/,
      `${label}: the error must name the offending flag and the confinement rule`);
  }

  test('[negative] an unrelated outside directory cannot satisfy the gate', (t) => {
    const fx = makeFixture(t);
    assertRejected(runPredicate(fx, fx.outside), 'absolute outside dir');
  });

  test('[negative] a symlink inside the project resolving outside cannot satisfy the gate', (t) => {
    const fx = makeFixture(t);
    const link = path.join(fx.project, '.planning', 'phases', 'escape');
    try {
      fs.symlinkSync(fx.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (e && ['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw e;
    }
    assertRejected(runPredicate(fx, link), 'in-project symlink to outside');
  });

  test('[negative] ${PHASE_DIR} interpolation cannot reach outside the project', (t) => {
    const fx = makeFixture(t);
    assertRejected(runPredicate(fx, fx.outside, COMMAND_PREDICATE), 'command-exit-zero interpolation');
  });

  test('[happy] an in-project phase dir still resolves its artifact and passes', (t) => {
    const fx = makeFixture(t);
    const result = runPredicate(fx, fx.inside);
    assert.strictEqual(result.success, true, `in-project --phase-dir must still be accepted; stderr: ${result.error}`);
    const verdict = JSON.parse(result.output);
    assert.strictEqual(verdict.block, false);
    assert.strictEqual(verdict.details.match, true);
  });

  test('[happy] a project-relative in-project phase dir resolves against the project root', (t) => {
    const fx = makeFixture(t);
    const result = runPredicate(fx, path.join('.planning', 'phases', '01-demo'));
    assert.strictEqual(result.success, true, `relative --phase-dir must be accepted; stderr: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).block, false);
  });

  test('[happy] ${PHASE_DIR} interpolation still reaches an in-project phase dir', (t) => {
    const fx = makeFixture(t);
    const result = runPredicate(fx, fx.inside, COMMAND_PREDICATE);
    assert.strictEqual(result.success, true, `in-project command predicate must run; stderr: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).block, false);
  });

  test('[bva:empty] a blank --phase-dir stays the "no phase context" fallback, not an error', (t) => {
    const fx = makeFixture(t);
    // The evaluator treats a blank phaseDir as absent and falls back to the
    // project root; confinement must not turn that into a hard command failure.
    // The project root holds no SUMMARY.md, so the expected verdict is block:true.
    const result = runPredicate(fx, '');
    assert.strictEqual(result.success, true, `blank --phase-dir must not fail the command; stderr: ${result.error}`);
    const verdict = JSON.parse(result.output);
    assert.strictEqual(verdict.block, true);
    assert.strictEqual(verdict.details.artifactNotFound, true);
  });
});
