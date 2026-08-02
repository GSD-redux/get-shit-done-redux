'use strict';

/**
 * Property-based tests for src/workflow-fragments.cts (compiled to
 * gsd-core/bin/lib/workflow-fragments.cjs) — issue #2930 (epic #1671
 * Phase 3). Covers 50-test-matrix.md rows 30-31.
 *
 * Document-shaped generators (CONTRIBUTING.md "Fixture provenance #2371",
 * mirroring tests/context-predicates.property.test.cjs): these generators
 * build arbitrary markdown documents out of prose lines, fenced blocks
 * (whose contents — including marker LOOKALIKES — are always literal), and
 * well-formed `gsd:section` marker pairs. They are NOT seeded from this
 * module's own `composeWorkflow`/`renderFragments` — document shape (which
 * lines exist, in what order, wrapped in what fences) is generated
 * independently; only the STRIPPED-EXPECTATION bookkeeping (which line
 * indexes are real top-level marker lines) is computed alongside, from the
 * same generation step, never by round-tripping through the code under
 * test.
 *
 * Deterministic per CONTRIBUTING.md: seed and numRuns are pinned by
 * tests/helpers/fast-check-setup.cjs (seed 42, numRuns 200).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { parseWorkflowSections, composeWorkflow, WHEN_VOCABULARY } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

// Derived from the module's own frozen WHEN_VOCABULARY (DEFECT.GENERATIVE-FIX,
// chore/2930 review): a hardcoded copy here would silently desync from the
// production vocabulary the moment either side is edited without the other.
const WHEN_VALUES = [...WHEN_VOCABULARY];

// ─── Document-shaped generators ────────────────────────────────────────────

// Plain-text charset that can never accidentally spell an HTML comment
// delimiter or a fence delimiter — keeps every "decoy" line unambiguous.
const proseTextArb = fc.stringMatching(/^[A-Za-z0-9 .,'":;()]{0,40}$/);

const idArb = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
const whenArb = fc.constantFrom(...WHEN_VALUES);

// A prose line that LOOKS marker-adjacent but is never a real marker: a
// heading, a blockquote, a table row, a mid-line backticked mention (extra
// prose before/after disqualifies it structurally), or a one-line
// `gsd:loop-host` comment (a different marker family entirely).
const proseLineArb = fc.oneof(
  proseTextArb,
  proseTextArb.map((t) => `# ${t}`),
  proseTextArb.map((t) => `> ${t}`),
  proseTextArb.map((t) => `| ${t} | cell |`),
  idArb.map((id) => `See \`<!-- gsd:section id="${id}" when="always" -->\` for syntax.`),
  fc.constant('<!-- gsd:loop-host foo -->'),
);

const fenceTickArb = fc.constantFrom('```', '~~~', '````');

// A fenced block: opener, 0-4 inner lines (prose OR a marker-lookalike full
// line), matching closer using the SAME tick string — everything inside is
// LITERAL regardless of shape (rows 5-8 of 50-test-matrix.md).
function fenceBlockArb() {
  return fc
    .tuple(
      fenceTickArb,
      fc.array(
        fc.oneof(
          proseLineArb,
          idArb.map((id) => `<!-- gsd:section id="${id}" when="always" -->`),
          fc.constant('<!-- /gsd:section -->'),
        ),
        { minLength: 0, maxLength: 4 },
      ),
    )
    .map(([tick, inner]) => [tick, ...inner, tick]);
}

// A well-formed marker's interior: 0-3 items, each either a prose line or a
// nested fenced block (which may itself contain marker lookalikes).
function markerBodyArb() {
  return fc
    .array(fc.oneof({ arbitrary: proseLineArb, weight: 3 }, { arbitrary: fenceBlockArb(), weight: 1 }), {
      minLength: 0,
      maxLength: 3,
    })
    .map((items) => items.flat());
}

// A top-level document block: a single prose line, a whole fenced block, or
// a well-formed gsd:section marker pair (id assigned by the assembler for
// document-wide uniqueness — see documentArb).
const blockArb = fc.oneof(
  { arbitrary: proseLineArb.map((line) => ({ kind: 'prose', lines: [line] })), weight: 3 },
  { arbitrary: fenceBlockArb().map((lines) => ({ kind: 'prose', lines })), weight: 2 },
  { arbitrary: fc.tuple(whenArb, markerBodyArb()).map(([when, body]) => ({ kind: 'marker', when, body })), weight: 2 },
);

const eolArb = fc.constantFrom('\n', '\r\n');

/**
 * A whole document assembled from an arbitrary sequence of blocks. Returns
 * `{source, expectedStripped}`: `source` is the generated document text;
 * `expectedStripped` is `source` with exactly the REAL top-level marker
 * lines removed (computed from the same generation step, independent of
 * the code under test).
 */
function documentArb() {
  return fc
    .tuple(fc.array(blockArb, { minLength: 0, maxLength: 8 }), eolArb, fc.boolean())
    .map(([blocks, eol, trailingEol]) => {
      const allLines = [];
      const markerLineIndexes = new Set();
      let counter = 0;
      for (const block of blocks) {
        if (block.kind === 'prose') {
          allLines.push(...block.lines);
          continue;
        }
        const id = `sec${counter}`;
        counter += 1;
        markerLineIndexes.add(allLines.length);
        allLines.push(`<!-- gsd:section id="${id}" when="${block.when}" -->`);
        allLines.push(...block.body);
        markerLineIndexes.add(allLines.length);
        allLines.push('<!-- /gsd:section -->');
      }
      // Per-line records, each carrying ITS OWN terminator -- mirrors how
      // workflow-fragments.cts's own line splitter models termination, so
      // "expected" is computed by the same "remove this line INCLUDING its
      // terminator" rule the partition invariant defines. A naive
      // `filter().join(eol)` is WRONG here: `.join()` inserts a separator
      // only BETWEEN surviving elements, so it silently drops a survivor's
      // real trailing terminator whenever the (now-removed) line that used
      // to follow it supplied that separator — caught live by this
      // generator against a real marker-wrapped empty fence, where the
      // section's last body line sits immediately before the close marker.
      const records = allLines.map((text, idx) => ({
        text,
        eol: idx === allLines.length - 1 ? (trailingEol ? eol : '') : eol,
      }));
      const source = records.map((r) => r.text + r.eol).join('');
      const expectedStripped = records
        .filter((_, idx) => !markerLineIndexes.has(idx))
        .map((r) => r.text + r.eol)
        .join('');
      return { source, expectedStripped };
    });
}

// ─── Row 30: parse/render round trip ───────────────────────────────────────

describe('property: parse/render round trip', () => {
  test('parseRenderRoundTripProperty', () => {
    fc.assert(
      fc.property(documentArb(), ({ source, expectedStripped }) => {
        const rendered = composeWorkflow(source);
        assert.equal(rendered, expectedStripped);
      }),
    );
  });

  test('parseRenderRoundTripProperty: no markers means exact identity', () => {
    fc.assert(
      fc.property(fc.array(proseLineArb, { minLength: 0, maxLength: 10 }), eolArb, (lines, eol) => {
        const source = lines.join(eol);
        assert.equal(composeWorkflow(source), source);
      }),
    );
  });
});

// ─── Row 31: idempotency ────────────────────────────────────────────────────

describe('property: parse is idempotent over render', () => {
  test('parseIsIdempotentOverRender', () => {
    fc.assert(
      fc.property(documentArb(), ({ source }) => {
        const rendered = composeWorkflow(source);

        // Composing an already-composed (marker-free) document is a no-op.
        assert.equal(composeWorkflow(rendered), rendered);

        // Re-parsing the rendered output yields a fixed shape: zero
        // sections for an empty document, otherwise exactly ONE implicit
        // gap fragment whose body is the whole (now marker-free) document —
        // no marker survives composition to be re-recognized.
        const sectionsAfter = parseWorkflowSections(rendered);
        if (rendered === '') {
          assert.deepEqual(sectionsAfter, []);
        } else {
          assert.equal(sectionsAfter.length, 1);
          assert.equal(sectionsAfter[0].explicit, false);
          assert.equal(sectionsAfter[0].body, rendered);
        }
      }),
    );
  });
});
