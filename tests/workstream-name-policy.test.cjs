const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkstreamNameInput,
  validateActiveWorkstreamName,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
  toWorkstreamSlug,
} = require('../gsd-core/bin/lib/workstream-name-policy.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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
      new RegExp(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  test('isValidActiveWorkstreamName accepts canonical and rejects invalid names', () => {
    assert.equal(isValidActiveWorkstreamName('alpha-1'), true);
    assert.equal(isValidActiveWorkstreamName('ws..traversal'), false);
    assert.equal(isValidActiveWorkstreamName('alpha beta'), false);
  });
});

// ─── toWorkstreamSlug guard survives slug consolidation (#2848) ──────────────

/**
 * `toWorkstreamSlug` was deliberately excluded from the slug consolidation: its
 * character class is an admissibility check on a name that becomes a directory
 * under .planning/workstreams/, and its caller already refuses a degenerate
 * result loudly. That pairing is what keeps a nameless workstream directory
 * from being created, so both halves are pinned here — a later consolidation
 * that folds this into the canonical generator breaks this test rather than
 * silently removing the check.
 */
describe('toWorkstreamSlug guard (post slug-consolidation)', () => {
  test('returns an empty slug for names it cannot render, rather than guessing', () => {
    for (const name of ['ελληνικά', '中文', 'расчёт', '!!!', '   ']) {
      assert.equal(toWorkstreamSlug(name), '', `unexpected slug for ${JSON.stringify(name)}`);
    }
  });

  test('still renders an ordinary name', () => {
    // Negative control: without this the assertions above would pass on a
    // function that returns '' for everything.
    assert.equal(toWorkstreamSlug('Payments API v2'), 'payments-api-v2');
  });

  test('`workstream create` refuses the empty slug instead of creating a nameless directory', () => {
    const tmp = createTempProject();
    try {
      const res = runGsdTools(['workstream', 'create', 'ελληνικά'], tmp);
      assert.equal(res.success, false, `workstream create accepted an unrenderable name: ${res.output}`);
      assert.match(String(res.error), /at least one alphanumeric character/);
    } finally {
      cleanup(tmp);
    }
  });
});
