'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const {
  parseSavedRuntimeEvidencePolicy,
} = require('../gsd-core/bin/lib/debug-session-policy.cjs');

const SAFE_LINE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;_=>-'.split('');
const safeLine = fc
  .array(fc.constantFrom(...SAFE_LINE_CHARS), { minLength: 0, maxLength: 80 })
  .map((chars) => chars.join(''));
const noteBlock = fc
  .array(safeLine, { minLength: 0, maxLength: 12 })
  .map((lines) => lines.map((line) => `note: ${line}`).join('\n'));

function validSession(policy, before = '', after = '') {
  return [
    before,
    '## Runtime Evidence',
    'schema_version: 1',
    `policy: ${policy}`,
    'state: not_used',
    after,
  ].join('\n');
}

describe('parseSavedRuntimeEvidencePolicy (#3128)', () => {
  test('fc: canonical policies survive ordinary user text, stray closers, and CRLF', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('adaptive', 'off'),
        noteBlock,
        noteBlock,
        (policy, before, after) => {
          const lf = validSession(policy, before, after);
          assert.equal(parseSavedRuntimeEvidencePolicy(lf), policy);
          assert.equal(parseSavedRuntimeEvidencePolicy(lf.replace(/\n/g, '\r\n')), policy);
        },
      ),
      { seed: 3128, numRuns: 300 },
    );
  });

  test('fc: comments, fences, duplicate sections, and invalid values never activate policy', () => {
    const invalidPolicy = fc
      .stringMatching(/^[a-z]{0,24}$/)
      .filter((value) => value !== 'adaptive' && value !== 'off');

    fc.assert(
      fc.property(
        fc.constantFrom('adaptive', 'off'),
        invalidPolicy,
        noteBlock,
        (policy, invalid, notes) => {
          const canonical = validSession(policy, notes);
          const commented = `<!--\n${canonical}\n-->`;
          const fenced = ['```yaml', canonical, '```'].join('\n');
          const duplicate = `${canonical}\n\n${validSession(policy)}`;
          const malformed = validSession(invalid, notes);

          assert.equal(parseSavedRuntimeEvidencePolicy(commented), null);
          assert.equal(parseSavedRuntimeEvidencePolicy(fenced), null);
          assert.equal(parseSavedRuntimeEvidencePolicy(duplicate), null);
          assert.equal(parseSavedRuntimeEvidencePolicy(malformed), null);
        },
      ),
      { seed: 3128, numRuns: 300 },
    );
  });

  test('nested or unclosed comments and NUL bytes fail closed', () => {
    const canonical = validSession('adaptive');
    assert.equal(parseSavedRuntimeEvidencePolicy(`<!-- ${canonical}`), null);
    assert.equal(parseSavedRuntimeEvidencePolicy(`<!-- outer <!-- nested -->\n${canonical}`), null);
    assert.equal(parseSavedRuntimeEvidencePolicy(`${canonical}\0`), null);
    assert.equal(parseSavedRuntimeEvidencePolicy(`<!-- hidden\0data -->\n${canonical}`), null);
  });
});
