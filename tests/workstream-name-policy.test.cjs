const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkstreamNameInput,
  validateActiveWorkstreamName,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  toWorkstreamSlug,
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

  // #3883 regression: the slug consolidation (01cc283da) routed
  // toWorkstreamSlug through generateSlugInternal's hard-coded 60-char cap,
  // which this site never had. Two distinct >60-char names collapsed onto
  // the identical slug, so `workstream create` on the second name silently
  // wrote into (or reported already_exists for) the first name's directory.
  test('toWorkstreamSlug does not truncate — distinct long names stay distinct', () => {
    const nameA = `${'a'.repeat(60)}alpha`;
    const nameB = `${'a'.repeat(60)}beta`;
    const slugA = toWorkstreamSlug(nameA);
    const slugB = toWorkstreamSlug(nameB);
    assert.notEqual(slugA, slugB, 'distinct >60-char workstream names must not collide on slug');
    assert.equal(slugA, `${'a'.repeat(60)}alpha`);
    assert.equal(slugB, `${'a'.repeat(60)}beta`);
  });
});
