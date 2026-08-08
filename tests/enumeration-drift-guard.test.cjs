'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Unit coverage for the phase-ENUMERATION drift guard
 * (scripts/lint-phase-enumeration-drift.cjs, epic #3180, issue #3185,
 * ADR-3180 Decision 1 row "Phase enumeration").
 *
 * Modelled on tests/phase-id-drift-guard.test.cjs: this guard was previously
 * exercised only via `lint:ci`, with no unit test of its own pure functions.
 * Behavioral throughout: assertions drive `findPhaseEnumerationDrift` /
 * `scanRepo` / `stripComments` directly — no `readFileSync().includes()` in
 * a test body.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  findPhaseEnumerationDrift,
  scanRepo,
  stripComments,
} = require(path.join(ROOT, 'scripts', 'lint-phase-enumeration-drift.cjs'));

describe('#3185 phase-enumeration drift scanner: findPhaseEnumerationDrift (pure)', () => {
  test('a clean line carrying neither detector shape is not flagged', () => {
    assert.deepEqual(
      findPhaseEnumerationDrift("const { value: dirs } = listMilestonePhaseDirs(phasesDir, { cwd });", 'src/fake.cts'),
      [],
    );
  });

  test('an injected fs.readdirSync(phasesDir, ...) line IS flagged', () => {
    const v = findPhaseEnumerationDrift(
      "const names = fs.readdirSync(phasesDir, { withFileTypes: true });",
      'src/fake.cts',
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('an injected /^999(?:\\.|$)/ sentinel literal IS flagged', () => {
    const v = findPhaseEnumerationDrift(
      "const isBacklog = /^999(?:\\.|$)/.test(dirName);",
      'src/fake.cts',
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('a COMMENT containing either shape is NOT flagged', () => {
    const readdirInComment = findPhaseEnumerationDrift(
      "// legacy code used to do fs.readdirSync(phasesDir, { withFileTypes: true })",
      'src/fake.cts',
    );
    assert.deepEqual(readdirInComment, []);

    const sentinelInComment = findPhaseEnumerationDrift(
      "// the old regex was /^999(?:\\.|$)/ before the single owner existed",
      'src/fake.cts',
    );
    assert.deepEqual(sentinelInComment, []);

    const blockCommentContinuation = findPhaseEnumerationDrift(
      " * mirrors fs.readdirSync(phasesDir, { withFileTypes: true }) from before",
      'src/fake.cts',
    );
    assert.deepEqual(blockCommentContinuation, []);
  });

  test('an unrelated numeric such as const n = total + 1999 is NOT flagged', () => {
    assert.deepEqual(
      findPhaseEnumerationDrift('const n = total + 1999;', 'src/fake.cts'),
      [],
    );
  });
});

describe('#3185 phase-enumeration drift scanner: stripComments (pure)', () => {
  test('a whole-line // comment strips to empty', () => {
    assert.equal(stripComments('// just a comment'), '');
  });

  test('a JSDoc continuation line strips to empty', () => {
    assert.equal(stripComments(' * some doc text'), '');
  });

  test('a trailing // comment after code strips only the comment portion', () => {
    assert.equal(stripComments('const x = 1; // trailing note'), 'const x = 1; ');
  });

  test('a line with no comment is returned unchanged', () => {
    const line = 'const dirs = listMilestonePhaseDirs(phasesDir, { cwd });';
    assert.equal(stripComments(line), line);
  });
});

describe('#3185 phase-enumeration drift scanner: the live repo is clean', () => {
  test('scanRepo(repoRoot) returns zero unsanctioned re-derivations', () => {
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'unsanctioned phase-enumeration re-derivation(s) — route through listMilestonePhaseDirs / isSentinelPhaseId:\n' +
        violations.map((d) => `  ${d.file}:${d.line} ${d.found}`).join('\n'),
    );
  });
});
