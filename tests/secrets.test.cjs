'use strict';

/**
 * Dedicated coverage for src/secrets.cts (compiled to gsd-core/bin/lib/secrets.cjs).
 * Closes #3322 (H8 of epic #3053): the module previously had one incidental masking
 * assertion (landed via #2299) exercising only the >8-char branch; the s.length < 8
 * reveal boundary was uncovered. See .gsd/phase/test-3322-secrets-reveal-boundary-coverage/
 * for the design rationale and full test matrix.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { maskSecret, isSecretKey, maskIfSecret } = require('../gsd-core/bin/lib/secrets.cjs');

describe('maskSecret — unset triad', () => {
  test('maskSecretReturnsUnsetForNull', () => {
    assert.equal(maskSecret(null), '(unset)');
  });

  test('maskSecretReturnsUnsetForUndefined', () => {
    assert.equal(maskSecret(undefined), '(unset)');
  });

  test('maskSecretReturnsUnsetForEmptyString', () => {
    assert.equal(maskSecret(''), '(unset)');
  });
});

describe('maskSecret — 8-char reveal boundary', () => {
  test('maskSecretFullyMasksBelowEightChars', () => {
    // length 7 (limit-1): fully masked, nothing revealed
    assert.equal(maskSecret('abcdefg'), '****');
  });

  test('maskSecretRevealsLastFourAtEightChars', () => {
    // length 8 (limit): threshold itself falls into the reveal branch
    assert.equal(maskSecret('abcdefgh'), '****efgh');
  });

  test('maskSecretRevealsLastFourAboveEightChars', () => {
    // length 9 (limit+1)
    assert.equal(maskSecret('abcdefghi'), '****fghi');
  });
});

describe('maskSecret — falsy-but-valid values are not treated as unset', () => {
  test('maskSecretDoesNotTreatZeroAsUnset', () => {
    assert.equal(maskSecret(0), '****');
  });

  test('maskSecretDoesNotTreatFalseAsUnset', () => {
    assert.equal(maskSecret(false), '****');
  });

  test('maskSecretMasksBooleanTrue', () => {
    assert.equal(maskSecret(true), '****');
  });
});

describe('maskSecret — non-string scalar coercion and negative space', () => {
  test('maskSecretRevealsLastFourForNumericAtEightDigits', () => {
    assert.equal(maskSecret(12345678), '****5678');
  });

  test('maskSecretMasksLiteralNullString', () => {
    // The string "null" (4 chars) must be masked like any other short secret,
    // not mistaken for the actual `null` unset sentinel.
    assert.equal(maskSecret('null'), '****');
  });
});

describe('isSecretKey — membership', () => {
  test('isSecretKeyMatchesConfiguredKeys', () => {
    assert.equal(isSecretKey('brave_search'), true);
    assert.equal(isSecretKey('firecrawl'), true);
    assert.equal(isSecretKey('exa_search'), true);
  });

  test('isSecretKeyRejectsUnknownKey', () => {
    assert.equal(isSecretKey('not_a_secret'), false);
  });

  test('isSecretKeyRejectsPrefixSuffixMatch', () => {
    // Exact Set membership, not substring/prefix/suffix matching.
    assert.equal(isSecretKey('brave_search_extra'), false);
    assert.equal(isSecretKey('my_firecrawl'), false);
  });
});

describe('maskIfSecret — wiring', () => {
  test('maskIfSecretMasksWhenKeyIsSecret', () => {
    assert.equal(maskIfSecret('firecrawl', 'abcdefgh'), '****efgh');
  });

  test('maskIfSecretPassesThroughNonSecretString', () => {
    assert.equal(maskIfSecret('not_a_secret', 'abcdefgh'), 'abcdefgh');
  });

  test('maskIfSecretPassesThroughNonSecretNonString', () => {
    // Passthrough must preserve type — not coerce to string.
    assert.equal(maskIfSecret('not_a_secret', 42), 42);
  });
});
