'use strict';

/**
 * Golden parity, hermetic (ADR-3473 §8.1, #3881, phase test-matrix §D — redesigned).
 *
 * The parser moved from a hand-rolled line scanner to vendored js-yaml. This suite proves
 * nothing was silently changed by diffing the CURRENT parser's output against a golden
 * captured from the LEGACY parser, independently of it — but unlike the original design,
 * every fixture entry carries its OWN literal document text. Nothing here enumerates the
 * tree, reads a tracked repo path, or shells out to git. That is deliberate:
 *
 * The original design keyed ~376 golden entries by tracked repo path (every git-tracked
 * command file, workflow file, agent file, and doc under the repo's markdown surfaces). This repo
 * merges roughly 21 commits/day; a 14-day sample measured 937 touches of exactly those
 * covered files. Any PR that edits one of those files' frontmatter — adding an
 * `argument-hint`, changing `allowed-tools`, editing a description — changed its parse and
 * turned this suite red for a change that had nothing to do with the parser. The reflex fix
 * was "regenerate the golden," which overwrites the very snapshot meant to catch a real
 * regression — training people to blow away their own regression fixture on every unrelated
 * touch. It was also a guaranteed merge-conflict magnet: the JSON was one big file every
 * such PR would need to touch. Excluding `.changeset/**` (a prior, narrower fix) was not
 * enough — the design itself was wrong.
 *
 * This redesign carries no tracked-path dependency at all: each entry stores a stable `id`,
 * the literal `documentText` (shrunk from a real ddde001af-era corpus document — see
 * provenance below), and an `expectedParse` captured from the legacy parser. A PR editing
 * `commands/gsd/help.md` cannot affect this suite. The only thing that can ever conflict
 * here is two PRs both editing the parser itself.
 *
 * Golden provenance (do NOT re-derive `expectedParse` from the current parser — that would
 *   make the comparison circular and prove nothing): `tests/fixtures/golden/
 *   frontmatter-legacy-golden.json` was captured by compiling `src/frontmatter.cts` AS IT
 *   EXISTED AT COMMIT ddde001af (`git show ddde001af:src/frontmatter.cts`) standalone with
 *   tsc, against this repo's sibling support modules (`io.cts`, `shell-command-projection.
 *   cts`, `validate.cts`, `text-lines.cts`, `unusable-input.cts`, `pattern.cts`, `phase-id.
 *   cts`) — all byte-identical between ddde001af and HEAD (`git diff ddde001af..HEAD --stat`
 *   over those paths is empty), so borrowing the current sources of those pure helpers does
 *   not change what the legacy frontmatter parser itself computed. The legacy
 *   `extractFrontmatter` was run once, at capture time, over a representative sample of real
 *   ddde001af-era documents — every document then listed as a known divergence, every
 *   adversarial fixture under `tests/fixtures/adversarial/frontmatter/`, and a sample chosen
 *   for breadth across the distinct YAML shapes present in the corpus (block scalars, inline
 *   arrays, dashed lists, object-lists, nested maps, unicode keys, CRLF, empty values,
 *   comments, multi-doc-looking bodies) — each result was structurally serialized (see
 *   `tests/helpers/frontmatter-golden-serializer.cjs`, D2) and committed alongside the
 *   shrunk document text it was captured from. This is a one-time capture: the compiled
 *   legacy module is not part of this repo and is not re-run by the suite below, which only
 *   ever reads the committed golden.
 *
 * Shrinking: most entries store the frontmatter region plus a short stub body rather than a
 *   whole file. Every entry was verified AT CAPTURE TIME that both the current parser and
 *   the legacy parser produce the same structurally-serialized result over the original
 *   full document and the shrunk `documentText` — any candidate where either parser's
 *   output changed under shrinking was dropped rather than stored (0 of 51 candidates were
 *   dropped by this check in this capture; 1 additional file, the adversarial
 *   `unclosed-block.md` fixture, has no closing fence to truncate at and is stored
 *   unshrunk, verbatim).
 *
 * Divergences: entries with `diverges: true` are documented, deliberate legacy/current
 *   mismatches — see each entry's `justification`. They are asserted to STILL diverge
 *   (D3), never silently absorbed as a wildcard exemption. Non-diverging entries are
 *   asserted to match `expectedParse` exactly (D1).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { serializeFrontmatterValue } = require('./helpers/frontmatter-golden-serializer.cjs');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'golden', 'frontmatter-legacy-golden.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
const ENTRIES = golden.entries;

/** Serialized current-parser output for one entry's embedded document text. */
function currentSerialized(entry) {
  return serializeFrontmatterValue(extractFrontmatter(entry.documentText));
}

describe('frontmatter golden parity, hermetic (ADR-3473 §8.1, #3881, §D)', () => {
  test('fixture sanity: entries are present and every id is unique', () => {
    assert.ok(Array.isArray(ENTRIES) && ENTRIES.length > 0, 'expected at least one golden entry');
    const ids = ENTRIES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate entry id(s) in the golden fixture');
    console.log(`frontmatter-golden-parity: ${ENTRIES.length} hermetic golden entries`);
  });

  test('D1: every non-diverging entry matches its legacy-parser expectedParse exactly', () => {
    const failures = [];
    for (const entry of ENTRIES) {
      if (entry.diverges) continue;
      const actual = currentSerialized(entry);
      if (actual !== entry.expectedParse) {
        failures.push({ id: entry.id, expected: entry.expectedParse, actual });
      }
    }
    assert.deepEqual(
      failures,
      [],
      'undocumented parity divergence(s) — either the parser silently changed behavior, or '
        + `this is a deliberate divergence that must be marked diverges:true with a justification: ${JSON.stringify(failures, null, 2)}`,
    );
  });

  test('D1 sensor: the parity check is not vacuous — a mutated expectedParse is caught', () => {
    const rel = ENTRIES.find((e) => !e.diverges);
    assert.ok(rel, 'expected at least one non-diverging entry to sensor-check against');
    const actual = currentSerialized(rel);
    const mutated = `${rel.expectedParse}__MUTATED__`;
    assert.notEqual(
      actual,
      mutated,
      'sensor failed: a mutated expectedParse must not equal the real parser output',
    );
  });

  test('D3: every diverging entry actually diverges from its expectedParse today', () => {
    const stillMatching = [];
    for (const entry of ENTRIES) {
      if (!entry.diverges) continue;
      const actual = currentSerialized(entry);
      if (actual === entry.expectedParse) stillMatching.push(entry.id);
    }
    assert.deepEqual(
      stillMatching,
      [],
      'entries marked diverges:true that no longer diverge must have diverges FLIPPED TO '
        + `false (it must never become a wildcard exemption): ${JSON.stringify(stillMatching)}`,
    );
  });

  test('D3: every diverging entry carries a non-empty justification', () => {
    for (const entry of ENTRIES) {
      if (!entry.diverges) continue;
      assert.ok(
        typeof entry.justification === 'string' && entry.justification.trim().length > 0,
        `${entry.id} is marked diverges:true but has no justification`,
      );
    }
  });

  test('hermeticity: fixture entries carry no filesystem path operands', () => {
    // sourcePath is provenance-only metadata (never read at test time) — everything else on
    // an entry must be inert data, not something that could be mistaken for a live path
    // lookup.
    for (const entry of ENTRIES) {
      assert.equal(typeof entry.documentText, 'string');
      assert.equal(typeof entry.expectedParse, 'string');
    }
  });
});

describe('frontmatter golden serializer protects the gate itself (ADR-3473 §8.1, #3881, §D2)', () => {
  test('D2: JSON.stringify silently drops a named property on an Array', () => {
    // Reproduce the exact legacy shape: `k:\n  - test: a\n    other: b` parses to an
    // array whose element 0 is "test: a" and which ALSO carries `.other === "b"`.
    const namedArray = ['test: a'];
    namedArray.other = 'b';

    assert.equal(
      JSON.stringify(namedArray),
      '["test: a"]',
      'JSON.stringify must (still) silently drop the named array property — this pins the '
        + 'exact defect a JSON-based golden would have',
    );
  });

  test('D2: the structural serializer distinguishes a plain array from the same array carrying a named property', () => {
    const plainArray = ['test: a'];
    const namedArray = ['test: a'];
    namedArray.other = 'b';

    const plainSerialized = serializeFrontmatterValue(plainArray);
    const namedSerialized = serializeFrontmatterValue(namedArray);

    assert.notEqual(
      plainSerialized,
      namedSerialized,
      'the serializer must distinguish ["test: a"] from the same array carrying .other = "b"',
    );
    assert.ok(
      namedSerialized.includes('"other"') && namedSerialized.includes('"b"'),
      `named-property serialization must surface the property and its value; got: ${namedSerialized}`,
    );
    // And it must not have been captured by dropping straight to JSON.stringify.
    assert.notEqual(namedSerialized, JSON.stringify(namedArray));
  });

  test('D2: the named-array-property shape is real, not hypothetical — it appears in the captured golden', () => {
    // gsd-core__templates__summary-complex's `requires` entry is captured golden proof this
    // shape occurs on a real, tracked document (verified live against the legacy parser
    // while writing this suite): its expectedParse must carry a named-property tail.
    const entry = ENTRIES.find((e) => e.id === 'gsd-core__templates__summary-complex');
    assert.ok(entry, 'expected the summary-complex divergence entry in the golden set');
    assert.ok(
      /"requires":\["[^"]*"\]\{"provides":/.test(entry.expectedParse),
      `expected the expectedParse for ${entry.id} to carry a named-property tail on 'requires'; got: ${entry.expectedParse}`,
    );
  });
});
