const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { TEST_GATE_REASON, classifyTestGateResult } = require('../scripts/gsd-test-gate-reasons.cjs');

describe('test failure reason classification', () => {
  test('classifies pass on exitCode 0', () => {
    const out = classifyTestGateResult({ exitCode: 0, output: 'all good' });
    assert.deepStrictEqual(out, { ok: true, reason: TEST_GATE_REASON.PASS });
  });

  test('classifies infrastructure failure via exitCode 2', () => {
    const out = classifyTestGateResult({ exitCode: 2, output: 'ERROR: infrastructure failure' });
    assert.deepStrictEqual(out, { ok: false, reason: TEST_GATE_REASON.INFRA_FAILURE });
  });

  test('classifies infrastructure failure via known worktree construct signature', () => {
    const out = classifyTestGateResult({
      exitCode: 1,
      output: 'worktree.Construct: worktree construction failed at merge',
    });
    assert.deepStrictEqual(out, { ok: false, reason: TEST_GATE_REASON.INFRA_FAILURE });
  });

  test('classifies test failure via FAIL markers', () => {
    const out = classifyTestGateResult({
      exitCode: 1,
      output: 'linux      FAIL  11274/11277 tests (3 failures)',
    });
    assert.deepStrictEqual(out, { ok: false, reason: TEST_GATE_REASON.TEST_FAILURE });
  });

  test('classifies unknown failure when non-zero without known signatures', () => {
    const out = classifyTestGateResult({ exitCode: 1, output: 'nonzero but unknown format' });
    assert.deepStrictEqual(out, { ok: false, reason: TEST_GATE_REASON.UNKNOWN_FAILURE });
  });
});
