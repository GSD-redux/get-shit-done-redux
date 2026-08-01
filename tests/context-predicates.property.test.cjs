'use strict';

/**
 * Property-based tests for src/context-predicates.cts (compiled to
 * gsd-core/bin/lib/context-predicates.cjs).
 *
 * Document-shaped generators (CONTRIBUTING.md "Fixture provenance #2371"):
 * these generators build arbitrary markdown documents out of prose lines,
 * fences of varying tick-length, list items with varying markers, and
 * predicate-shaped / predicate-lookalike lines — they are NOT seeded from
 * this module's own writer/serializer. Seeding a property generator from the
 * code under test's own render function make the document shape a constant
 * and the property unable to fail; see 50-test-matrix.md Step 1.
 *
 * Deterministic per CONTRIBUTING.md: seed and numRuns are pinned by
 * tests/helpers/fast-check-setup.cjs (seed 42, numRuns 200); failures print
 * replay data via fast-check's own counterexample + seed reporting.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { parsePredicates, selectPredicates, buildIndex } = require('../gsd-core/bin/lib/context-predicates.cjs');

// ─── Document-shaped generators ────────────────────────────────────────────

// A predicate-shaped line: `CLASS.subkey=value` in one of the recognized
// declaration forms. `asDeclared` controls whether the caller wants this
// specific fixture to be a genuinely-recognized declaration (bare or `- `
// list item — the two forms even today's implementation accepts) so property
// H1/H4 can reason about "predicates the parser actually extracts" without
// depending on the A4-A7 defects under test elsewhere.
const idClassArb = fc.stringMatching(/^[A-Z][A-Z0-9_-]{0,8}$/);
const idSubkeyArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const valueArb = fc.stringMatching(/^[A-Za-z0-9 _.-]{1,20}$/);

const declaredPredicateLineArb = fc
  .tuple(idClassArb, fc.option(idSubkeyArb, { nil: undefined }), valueArb, fc.boolean())
  .map(([klass, subkey, value, asListItem]) => {
    const id = subkey ? `${klass}.${subkey}` : klass;
    const inner = `\`${id}=${value}\``;
    return { text: asListItem ? `- ${inner}` : inner, id, klass, value };
  });

// A prose line that is NOT a predicate declaration: plain text, a heading, a
// blockquote line, a table row, or an inline mid-prose backtick reference.
const proseLineArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9 .,'"()-]{0,40}$/),
  idClassArb.map((k) => `# ${k} heading`),
  idClassArb.map((k) => `> quoting ${k}`),
  idClassArb.map((k) => `| cell | \`${k}.x=y\` |`),
  declaredPredicateLineArb.map((p) => `see ${p.text.replace(/^- /, '')} for details`),
);

const fenceTickArb = fc.constantFrom('```', '~~~', '````');

// A whole document assembled from a mix of prose lines and declared
// predicate lines, optionally wrapping a contiguous run in a fence.
function documentArb() {
  return fc
    .array(fc.oneof({ arbitrary: declaredPredicateLineArb, weight: 2 }, { arbitrary: proseLineArb, weight: 3 }), {
      minLength: 0,
      maxLength: 12,
    })
    .map((items) => items);
}

// ─── H1: index preserves every parsed predicate ────────────────────────────

describe('property: parse <-> index contract', () => {
  test('indexPreservesEveryParsedPredicate', () => {
    fc.assert(
      fc.property(documentArb(), (items) => {
        const md = items.map((it) => (typeof it === 'string' ? it : it.text)).join('\n');
        const parsed = parsePredicates(md);
        const index = buildIndex(parsed.predicates);

        assert.equal(index.count, parsed.predicates.length);

        const parsedIds = parsed.predicates.map((p) => p.id).sort();
        const indexIds = index.predicates.map((p) => p.id).sort();
        assert.deepEqual(indexIds, parsedIds, 'buildIndex must invent or lose no predicate id');

        for (const p of parsed.predicates) {
          const inIndex = index.predicates.find((ip) => ip.id === p.id && ip.value === p.value);
          assert.ok(inIndex, `predicate ${p.id}=${p.value} from the parse must appear in the index`);
        }
      }),
    );
  });

  // ─── H2: buildIndex is deterministic and order-independent ────────────────

  test('indexSerializationIsOrderIndependentAndDeterministic', () => {
    fc.assert(
      fc.property(
        fc.array(declaredPredicateLineArb, { minLength: 0, maxLength: 10 }),
        (decls) => {
          // Dedupe by id so this property is not entangled with duplicate
          // semantics (covered separately by the E-row unit tests) — the
          // property under test here is pure ordering independence.
          const seen = new Set();
          const uniqueDecls = decls.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));

          const forwardMd = uniqueDecls.map((d) => d.text).join('\n');
          const reverseMd = uniqueDecls
            .slice()
            .reverse()
            .map((d) => d.text)
            .join('\n');

          const forwardIndex = buildIndex(parsePredicates(forwardMd).predicates);
          const reverseIndex = buildIndex(parsePredicates(reverseMd).predicates);

          assert.deepEqual(forwardIndex, reverseIndex, 'index must not depend on source declaration order');

          // Determinism: building twice from the same parsed predicates must
          // produce byte-identical JSON serialization.
          const parsed = parsePredicates(forwardMd);
          const a = JSON.stringify(buildIndex(parsed.predicates));
          const b = JSON.stringify(buildIndex(parsed.predicates));
          assert.equal(a, b);
        },
      ),
    );
  });

  // ─── H3: fencing a region never increases the predicate count ─────────────

  test('fencingRegionNeverIncreasesPredicateCount', () => {
    fc.assert(
      fc.property(
        fc.array(declaredPredicateLineArb, { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 5 }),
        fenceTickArb,
        (decls, wrapAt, fence) => {
          const lines = decls.map((d) => d.text);
          const before = parsePredicates(lines.join('\n')).predicates.length;

          const cut = Math.min(wrapAt, lines.length);
          const fenced = [...lines.slice(0, cut), fence, ...lines.slice(cut), fence].join('\n');
          const after = parsePredicates(fenced).predicates.length;

          assert.ok(after <= before, `fencing must never increase the parsed count (before=${before}, after=${after})`);
        },
      ),
    );
  });
});

// ─── H5: comment/fence mutual precedence (DEFECT.CONTEXT-PREDICATES-COMMENT-
// FENCE-BLIND, #2928 review) — a predicate genuinely OUTSIDE a wrapper
// (comment or fence) is always parsed live, and a predicate genuinely INSIDE
// it is never parsed live, even when the wrapper's own content contains
// tokens that LOOK LIKE the OTHER construct (fence delimiters inside a
// comment, or comment tokens inside a fence — the two directions the
// interleaved single-pass in `computeSkippedLineFlags` must both get right).
// Document-shaped generator: wraps a marked "inside" predicate between an
// open/close pair of ONE kind, salted with lookalike noise from the OTHER
// kind, with unrelated real predicates before/after the wrapper. ──────────

// Noise lines that look like the OTHER construct's tokens, keyed by which
// kind is being used as the OUTER wrapper for a given run.
const FENCE_NOISE_LINES = ['<!-- not a real comment, just fence content', 'text mentioning --> mid-line', '<!-- nested-looking'];
const COMMENT_NOISE_LINES = ['```', '~~~', '``` info string'];

const wrapperKindArb = fc.constantFrom('fence', 'comment');

describe('property: comment/fence mutual precedence', () => {
  test('predicateOutsideWrapperIsAlwaysLiveAndInsideIsNeverLive', () => {
    fc.assert(
      fc.property(
        wrapperKindArb,
        fc.array(fc.constantFrom(0, 1, 2), { minLength: 0, maxLength: 3 }),
        fc.array(fc.constantFrom(0, 1, 2), { minLength: 0, maxLength: 3 }),
        (wrapperKind, beforeNoiseIdx, afterNoiseIdx) => {
          const noisePool = wrapperKind === 'fence' ? FENCE_NOISE_LINES : COMMENT_NOISE_LINES;
          const open = wrapperKind === 'fence' ? '```' : '<!-- wrapper open';
          const close = wrapperKind === 'fence' ? '```' : '-->';

          const lines = [
            '`OUTSIDE_BEFORE=1`',
            open,
            ...beforeNoiseIdx.map((i) => noisePool[i]),
            '`INSIDE_MARKER=2`',
            ...afterNoiseIdx.map((i) => noisePool[i]),
            close,
            '`OUTSIDE_AFTER=3`',
          ];

          const md = lines.join('\n');
          const r = parsePredicates(md);
          const ids = new Set(r.predicates.map((p) => p.id));

          assert.ok(ids.has('OUTSIDE_BEFORE'), `OUTSIDE_BEFORE must always be live (wrapper=${wrapperKind})`);
          assert.ok(ids.has('OUTSIDE_AFTER'), `OUTSIDE_AFTER must always be live (wrapper=${wrapperKind})`);
          assert.ok(
            !ids.has('INSIDE_MARKER'),
            `INSIDE_MARKER must never be live inside a real ${wrapperKind}, even with ${
              wrapperKind === 'fence' ? 'comment' : 'fence'
            }-lookalike noise around it`,
          );
        },
      ),
    );
  });
});

describe('property: selectPredicates subset invariant', () => {
  test('selectorReturnsOnlyMatchingSubset', () => {
    fc.assert(
      fc.property(fc.array(declaredPredicateLineArb, { minLength: 0, maxLength: 10 }), idClassArb, (decls, klass) => {
        const md = decls.map((d) => d.text).join('\n');
        const all = parsePredicates(md).predicates;
        const selected = selectPredicates(all, { klass });

        for (const p of selected) {
          assert.ok(
            all.includes(p),
            'every selected predicate must be a reference from the original array (subset, not a copy with invented members)',
          );
          assert.equal(p.klass, klass, `selectPredicates({klass}) must only return predicates whose klass === ${klass}`);
        }
      }),
    );
  });
});
