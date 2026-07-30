'use strict';

/**
 * Property-based tests for conventional-title.cjs
 *
 * Module: scripts/release-notes/conventional-title.cjs
 * Exported: evaluatePrTitle({ title }), classifyBucket(title)
 *
 * Properties tested:
 *   (a) round-trip: any `type(#n): summary` (type ∈ [a-z]+, n a positive
 *       integer, non-empty summary) is accepted by the gate. This is the
 *       generative complement to the hand-picked cases in
 *       conventional-title.test.cjs — the convention CONTRIBUTING.md asks
 *       contributors to follow must never be rejected.
 *   (b) total function: evaluatePrTitle never throws on any string input.
 *   (c) classifyBucket never throws and always returns one of the 3 buckets.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  evaluatePrTitle,
  classifyBucket,
} = require('../scripts/release-notes/conventional-title.cjs');

describe('evaluatePrTitle — properties', () => {
  test('(a) any well-formed `type(#n): summary` is accepted', () => {
    fc.assert(
      fc.property(
        // type: a lowercase ascii word, e.g. fix / feat / enhance / chore
        fc.stringMatching(/^[a-z]+$/).filter((s) => s.length > 0),
        // n: a positive issue number
        fc.integer({ min: 1, max: 1_000_000 }),
        // summary: non-empty, and not all-whitespace (the title is trimmed,
        // but the body after the colon is irrelevant to validity anyway)
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        (type, n, summary) => {
          const title = `${type}(#${n}): ${summary}`;
          assert.deepEqual(evaluatePrTitle({ title }), { valid: true, reason: 'valid' });
        }
      )
    );
  });

  test('(b) never throws on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const r = evaluatePrTitle({ title });
        assert.equal(typeof r.valid, 'boolean');
        assert.equal(typeof r.reason, 'string');
      })
    );
  });

  test('(b) never throws when called with no argument or a non-string title', () => {
    fc.assert(
      fc.property(fc.anything(), (title) => {
        // evaluatePrTitle coerces title via String(...) — any payload is safe.
        const r = evaluatePrTitle({ title });
        assert.equal(typeof r.valid, 'boolean');
      })
    );
    assert.equal(evaluatePrTitle().valid, false);
  });
});

describe('classifyBucket — properties', () => {
  test('(c) always returns one of the three buckets and never throws', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const bucket = classifyBucket(title);
        assert.ok(['Feature', 'Fix', 'Enhancement', 'Internal'].includes(bucket));
      })
    );
  });
});
