const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkstreamNameInput,
  validateActiveWorkstreamName,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
} = require('../gsd-core/bin/lib/workstream-name-policy.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

describe('workstream-name-policy', () => {
  test('normalizeWorkstreamNameInput trims and nulls empty input', () => {
    assert.equal(normalizeWorkstreamNameInput('  alpha  '), 'alpha');
    assert.equal(normalizeWorkstreamNameInput('   '), null);
    assert.equal(normalizeWorkstreamNameInput(null), null);
  });

  test('validateActiveWorkstreamName returns structured validation', () => {
    assert.deepEqual(
      validateActiveWorkstreamName('alpha_1'),
      { ok: true, reason: null, value: 'alpha_1' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('alpha beta'),
      { ok: false, reason: 'invalid', value: 'alpha beta' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('../alpha'),
      { ok: false, reason: 'invalid', value: '../alpha' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('  '),
      { ok: false, reason: 'empty', value: null }
    );
  });

  test('assertValidActiveWorkstreamName returns normalized value and throws canonical error', () => {
    assert.equal(assertValidActiveWorkstreamName('  alpha  '), 'alpha');
    assert.throws(
      () => assertValidActiveWorkstreamName('alpha/beta'),
      new RegExp(escapeRegex(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE))
    );
  });

  test('isValidActiveWorkstreamName accepts canonical and rejects invalid names', () => {
    assert.equal(isValidActiveWorkstreamName('alpha-1'), true);
    assert.equal(isValidActiveWorkstreamName('ws..traversal'), false);
    assert.equal(isValidActiveWorkstreamName('alpha beta'), false);
  });
});
