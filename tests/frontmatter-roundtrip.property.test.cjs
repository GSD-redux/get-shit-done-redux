'use strict';

/**
 * ADR-3473 §8.1's mandated gate (#3881, phase test-matrix §E): "a property-based
 * `fast-check` round-trip test is the gate."
 *
 * E1: parse(serialize(x)) === parse(serialize(parse(serialize(x)))) — idempotence after
 *     one round-trip cycle, the invariant #3349 violated (a value that changed shape on
 *     a SECOND write, even though the first write looked fine).
 * E2: the #3257 full-line-comment channel survives a parse -> reconstruct -> re-parse ->
 *     reconstruct cycle intact and in place.
 *
 * `serialize` = reconstructFrontmatter (object -> YAML body text, no `---` delimiters).
 * `parse` = extractFrontmatter (delimited document text -> object), applied to the body
 * wrapped back in `---` fences the way every real caller round-trips it.
 *
 * fast-check v4 in this repo: no `fc.stringOf`; arbitraries live at module scope (never
 * built inside a `describe` body) — see tests/frontmatter.property.test.cjs for the
 * established pattern this file follows.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { extractFrontmatter, reconstructFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

// ─── Arbitraries — realistic key/value shapes, not free-form noise ────────────────────

// A real top-level frontmatter key: lower-kebab/snake identifiers as seen across the
// corpus (phase, key-decisions, tech-stack, human_verification, ...).
const realisticKey = fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/);

// A plain scalar value shaped like real frontmatter content: printable, no raw control
// chars, no YAML-significant leading/trailing whitespace of its own (reconstructFrontmatter
// is exercised elsewhere, in tests/frontmatter.property.test.cjs, for the quoting/escaping
// contract itself — this file is about ROUND-TRIP IDENTITY, so values are drawn from the
// well-formed subset rather than re-testing escaping).
const realisticScalar = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._/:-]{0,60}$/);

// A short list of realistic scalars, the shape `tags:`/`requires:`/`key-decisions:` use.
const realisticList = fc.array(realisticScalar, { minLength: 0, maxLength: 5 });

// One frontmatter object: a flat dictionary whose values are either a scalar or a list of
// scalars — the two value shapes reconstructFrontmatter's top-level branch documents.
const frontmatterObject = fc.dictionary(
  realisticKey,
  fc.oneof(realisticScalar, realisticList),
  { minKeys: 1, maxKeys: 8 },
);

/** serialize -> wrap in fences -> parse, the shape every real caller round-trips through. */
function roundTripParse(obj) {
  const body = reconstructFrontmatter(obj);
  return extractFrontmatter(`---\n${body}\n---\n`);
}

describe('frontmatter round-trip idempotence — ADR-3473 §8.1 mandated gate (#3881, §E1)', () => {
  test('property: parse(serialize(x)) is a fixed point of one more round-trip cycle', () => {
    fc.assert(
      fc.property(frontmatterObject, (x) => {
        const once = roundTripParse(x);
        const twice = roundTripParse(once);
        assert.deepEqual(
          twice,
          once,
          `round-trip is not idempotent for ${JSON.stringify(x)}: once=${JSON.stringify(once)} twice=${JSON.stringify(twice)}`,
        );
      }),
    );
  });

  test('property: a single round-trip preserves every key and its scalar/list shape', () => {
    fc.assert(
      fc.property(frontmatterObject, (x) => {
        const once = roundTripParse(x);
        for (const [key, value] of Object.entries(x)) {
          assert.ok(key in once, `key ${key} lost on round-trip`);
          if (Array.isArray(value)) {
            assert.ok(Array.isArray(once[key]), `key ${key} lost its list shape on round-trip`);
          } else {
            assert.equal(typeof once[key], 'string', `key ${key} lost its scalar shape on round-trip`);
          }
        }
      }),
    );
  });

  test('sensor: the idempotence check is not vacuous — a mutated second pass is caught', () => {
    // Prove the deepEqual comparison above can actually fail: fabricate a "second pass"
    // that differs from the first and confirm the property-style check rejects it.
    const once = roundTripParse({ phase: 'p1', tags: ['a', 'b'] });
    const mutatedTwice = { ...once, phase: `${once.phase}__MUTATED__` };
    assert.notDeepEqual(mutatedTwice, once, 'sensor failed: a mutated second pass must not equal the first');
  });
});

describe('frontmatter round-trip preserves the #3257 comment channel (#3881, §E2)', () => {
  // A column-0 `# text` comment line, restricted to characters that cannot themselves be
  // mistaken for the next key line by extractCommentChannel's own matcher.
  const commentText = fc.stringMatching(/^# [A-Za-z0-9 .,'-]{1,40}$/);

  test('property: a leading comment above a generated key survives a full round-trip cycle', () => {
    fc.assert(
      fc.property(realisticKey, realisticScalar, commentText, (key, value, comment) => {
        const doc = `---\n${comment}\n${key}: ${JSON.stringify(value)}\n---\n`;
        const extracted = extractFrontmatter(doc);
        assert.equal(extracted[key], value, 'sanity: the key itself must parse before testing comment survival');

        const reconstructed = reconstructFrontmatter(extracted);
        assert.ok(
          reconstructed.includes(comment),
          `comment lost on first round-trip: ${JSON.stringify(reconstructed)}`,
        );

        // Full cycle: re-parse the reconstructed doc and reconstruct again — the comment
        // must still be attached to the same key, not merely present anywhere.
        const reExtracted = extractFrontmatter(`---\n${reconstructed}\n---\n`);
        const reReconstructed = reconstructFrontmatter(reExtracted);
        assert.ok(
          reReconstructed.includes(comment),
          `comment lost on second round-trip cycle: ${JSON.stringify(reReconstructed)}`,
        );
        // The comment must still immediately precede its key (attached, not orphaned).
        const idx = reReconstructed.indexOf(comment);
        const keyIdx = reReconstructed.indexOf(`${key}:`);
        assert.ok(keyIdx > idx, `comment did not stay attached ahead of its key: ${JSON.stringify(reReconstructed)}`);
      }),
    );
  });

  test('property: a trailing comment after the last key survives a full round-trip cycle', () => {
    fc.assert(
      fc.property(realisticKey, realisticScalar, commentText, (key, value, comment) => {
        const doc = `---\n${key}: ${JSON.stringify(value)}\n${comment}\n---\n`;
        const extracted = extractFrontmatter(doc);
        const reconstructed = reconstructFrontmatter(extracted);
        assert.ok(reconstructed.includes(comment), `trailing comment lost: ${JSON.stringify(reconstructed)}`);

        const reExtracted = extractFrontmatter(`---\n${reconstructed}\n---\n`);
        const reReconstructed = reconstructFrontmatter(reExtracted);
        assert.ok(
          reReconstructed.includes(comment),
          `trailing comment lost on second cycle: ${JSON.stringify(reReconstructed)}`,
        );
      }),
    );
  });

  test('sensor: comment-channel preservation is not vacuous — a document with no comment carries none forward', () => {
    const doc = '---\nkey: value\n---\n';
    const extracted = extractFrontmatter(doc);
    const reconstructed = reconstructFrontmatter(extracted);
    assert.ok(!reconstructed.includes('#'), `expected no comment to appear from nowhere: ${JSON.stringify(reconstructed)}`);
  });
});
