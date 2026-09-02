/**
 * Edge-probe reference core unit tests.
 *
 * Asserts the LOCKED export surface of the spec-completeness edge-probe against
 * the BUILT artifact (`gsd-core/bin/lib/edge-probe.cjs`), which
 * `npm run build:lib` (run by pretest) emits from `src/edge-probe.cts`.
 *
 * Post ADR-550 Decision 7: the generic resolution model lives in `probe-core`;
 * edge-probe is its first adapter (shapes/TAXONOMY/proposeEdges + the
 * `{explicit, backstop}` verification validators). The resolution model is the
 * status×verification re-cut: `status: resolved | dismissed | unresolved` ×
 * `verification: explicit | backstop`. `covered`/`backstop` are no longer status
 * values — `covered → {resolved, explicit}`, `backstop → {resolved, backstop}`.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'edge-probe.cjs');
const ep = require(BUILT_SCRIPT);

describe('edge-probe: classifyShape', () => {
  test('detects numeric-range from rounding/threshold cues', () => {
    assert.deepEqual(ep.classifyShape('Round a number to N decimal places').sort(),
      ['numeric-range']);
  });
  test('detects collection from interval/merge cues', () => {
    const shapes = ep.classifyShape('Merge a list of overlapping intervals');
    assert.ok(shapes.includes('collection'));
  });
  test('detects text from truncate/string cues', () => {
    const shapes = ep.classifyShape('Truncate a string to a maximum length');
    assert.ok(shapes.includes('text'));
  });
  test('returns [] when no cue matches', () => {
    assert.deepEqual(ep.classifyShape('Display the company logo'), []);
  });
});

describe('edge-probe: TAXONOMY + applicableCategories', () => {
  test('TAXONOMY has the 8 documented categories in order', () => {
    assert.deepEqual(ep.TAXONOMY.map((c) => c.id),
      ['boundary', 'adjacency', 'empty', 'encoding', 'ordering', 'precision', 'idempotency', 'concurrency']);
  });
  test('every category has name, shapes[], probe', () => {
    for (const c of ep.TAXONOMY) {
      assert.equal(typeof c.name, 'string');
      assert.ok(Array.isArray(c.shapes) && c.shapes.length >= 1);
      assert.equal(typeof c.probe, 'string');
    }
  });
  test('numeric-range raises boundary + precision only', () => {
    assert.deepEqual(ep.applicableCategories(['numeric-range']).sort(),
      ['boundary', 'precision']);
  });
  test('collection raises adjacency, empty, ordering', () => {
    assert.deepEqual(ep.applicableCategories(['collection']).sort(),
      ['adjacency', 'empty', 'ordering']);
  });
  test('text raises empty + encoding', () => {
    assert.deepEqual(ep.applicableCategories(['text']).sort(),
      ['empty', 'encoding']);
  });
  test('no shapes raises nothing', () => {
    assert.deepEqual(ep.applicableCategories([]), []);
  });
});

describe('edge-probe: proposeEdges', () => {
  test('rounding requirement proposes boundary + precision, all unresolved (verification null)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Round a number to N decimal places' });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
    for (const e of edges) {
      assert.equal(e.requirement_id, 'R1');
      assert.equal(e.status, 'unresolved');
      assert.equal(e.verification, null);
      assert.equal(e.resolution, null);
      assert.equal(e.reason, null);
      assert.equal(typeof e.probe, 'string');
    }
  });
  test('authored shapes override prose classification', () => {
    const edges = ep.proposeEdges({ id: 'R9', text: 'opaque label', shapes: ['collection'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['adjacency', 'empty', 'ordering']);
  });
});

describe('edge-probe: validateResolution', () => {
  test('rejects an unknown status', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'maybe' }),
      /invalid status/i);
  });
  test('rejects a former covered status (re-cut: covered is no longer a status)', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'covered', resolution: 'x' }),
      /invalid status/i);
  });
  test('rejects dismissed without a reason', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'dismissed', reason: '' }),
      /dismissed requires a reason/i);
  });
  test('accepts dismissed with a reason', () => {
    assert.equal(ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'dismissed', reason: 'bounded enum' }), true);
  });
  test('rejects resolved with a missing verification tier', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', resolution: 'AC' }),
      /verification/i);
  });
  test('rejects resolved with a verification tier outside {explicit, backstop}', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'judgment', resolution: 'AC' }),
      /invalid verification/i);
  });
});

describe('edge-probe: analyzeCoverage', () => {
  const reqs = [{ id: 'R1', text: 'Merge a list of overlapping intervals' }];
  test('with no resolutions, every applicable edge is unresolved (byVerification zeroed)', () => {
    const rep = ep.analyzeCoverage(reqs, []);
    assert.deepEqual(rep.coverage, { applicable: 3, resolved: 0, unresolved: 3, byVerification: { explicit: 0, backstop: 0 } });
  });
  test('merges a resolved/explicit resolution and counts it resolved', () => {
    const rep = ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#6: touching intervals merge' },
    ]);
    const adj = rep.items.find((i) => i.category === 'adjacency');
    assert.equal(adj.status, 'resolved');
    assert.equal(adj.verification, 'explicit');
    assert.equal(adj.resolution, 'AC#6: touching intervals merge');
    assert.equal(rep.coverage.resolved, 1);
    assert.equal(rep.coverage.unresolved, 2);
    assert.deepEqual(rep.coverage.byVerification, { explicit: 1, backstop: 0 });
  });
  test('throws if a resolution is invalid (dismissed w/o reason)', () => {
    assert.throws(() => ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'empty', status: 'dismissed' },
    ]), /dismissed requires a reason/i);
  });
});

describe('edge-probe: CLI (built artifact)', () => {
  test('reads a requirements file and prints a coverage report as JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-'));
    const reqPath = path.join(dir, 'requirements.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    const nodeResult = runNode([BUILT_SCRIPT, reqPath], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(nodeResult, `node ${BUILT_SCRIPT} ${reqPath}`);
    const rep = JSON.parse(nodeResult.stdout);
    assert.deepEqual(rep.coverage, { applicable: 2, resolved: 0, unresolved: 2, byVerification: { explicit: 0, backstop: 0 } });
  });
  test('with no args exits with status 2 (assert on exit code, not stderr prose)', () => {
    const result = runNode([BUILT_SCRIPT], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(result.exitCode, 2);
  });
});

describe('edge-probe: CLI JSON.parse error handling (RR-10)', () => {
  test('invalid requirements JSON exits with status 2 (handled error, not uncaught throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const badJson = path.join(dir, 'bad-req.json');
    fs.writeFileSync(badJson, 'not valid json {{{');
    try {
      const r = runNode([BUILT_SCRIPT, badJson], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('invalid resolutions JSON exits with status 2 (handled error, not uncaught throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const goodReq = path.join(dir, 'req.json');
    const badRes = path.join(dir, 'bad-res.json');
    fs.writeFileSync(goodReq, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    fs.writeFileSync(badRes, 'not valid json {{{');
    try {
      const r = runNode([BUILT_SCRIPT, goodReq, badRes], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('valid requirements file exits 0 and stdout is parseable JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const reqPath = path.join(dir, 'req.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    try {
      const r = runNode([BUILT_SCRIPT, reqPath], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 0);
      const rep = JSON.parse(r.stdout);
      assert.deepEqual(rep.coverage, { applicable: 2, resolved: 0, unresolved: 2, byVerification: { explicit: 0, backstop: 0 } });
    } finally {
      cleanup(dir);
    }
  });
});

describe('edge-probe: proposeEdges — empty-shapes override (RR-06)', () => {
  test('shapes: [] returns zero edges (explicit empty-shapes override)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'merge intervals', shapes: [] });
    assert.deepEqual(edges, []);
  });
  test('absent shapes key classifies from prose (no override)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'merge intervals' });
    assert.ok(edges.length > 0, 'should classify collection edges from prose');
  });
  test('shapes: [collection] overrides prose and proposes collection categories', () => {
    const edges = ep.proposeEdges({ id: 'R9', text: 'opaque text with no cues', shapes: ['collection'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['adjacency', 'empty', 'ordering']);
  });
});

describe('edge-probe: proposeEdges — unclassified candidate for prose-zero-cue (#1110)', () => {
  // A requirement with non-empty prose that matches NO shape cue must not be silently
  // dropped (zero edges, no signal). It now surfaces ONE soft "unclassified — review
  // manually" candidate instead. The explicit `shapes: []` opt-out stays silent.
  test('prose with no shape cue surfaces a single unclassified candidate', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Display the company logo' });
    assert.equal(edges.length, 1, 'prose-zero-cue must surface exactly one unclassified candidate');
    assert.deepEqual(edges[0], {
      requirement_id: 'R1',
      category: 'unclassified',
      status: 'unresolved',
      verification: null,
      resolution: null,
      reason: null,
      probe: 'unclassified — review manually',
    });
  });

  test('UNCLASSIFIED_CATEGORY is a valid item category but NOT a taxonomy category', () => {
    assert.equal(ep.UNCLASSIFIED_CATEGORY, 'unclassified');
    assert.ok(ep.EDGE_VALIDATORS.categories.includes('unclassified'), 'analyzeCoverage must accept the unclassified item category');
    assert.ok(!ep.TAXONOMY.some((c) => c.id === 'unclassified'), 'unclassified must NOT pollute the closed 8-category taxonomy');
  });

  test('explicit shapes: [] stays silent (deliberate opt-out — NOT unclassified)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Display the company logo', shapes: [] });
    assert.deepEqual(edges, []);
  });

  test('prose that DOES classify proposes real edges, never an unclassified candidate', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Round a number to N decimal places' });
    assert.ok(edges.length > 0);
    assert.ok(!edges.some((e) => e.category === 'unclassified'), 'a classifiable requirement must not emit unclassified');
  });

  test('analyzeCoverage surfaces the unclassified candidate as unresolved (no throw)', () => {
    const report = ep.analyzeCoverage([{ id: 'R1', text: 'Display the company logo' }]);
    assert.equal(report.coverage.applicable, 1);
    assert.equal(report.coverage.unresolved, 1);
    assert.equal(report.items[0].category, 'unclassified');
  });

  test('an unclassified candidate can be dismissed with a reason (edge-probe parity)', () => {
    const report = ep.analyzeCoverage(
      [{ id: 'R1', text: 'Display the company logo' }],
      [{ requirement_id: 'R1', category: 'unclassified', status: 'dismissed', reason: 'genuinely edge-free — static asset' }],
    );
    assert.equal(report.items[0].status, 'dismissed');
  });
});

describe('edge-probe: proposeEdges — invalid authored shapes fail closed (re-review #3 High)', () => {
  // A non-empty but INVALID shapes array must NOT silently suppress every probe.
  // shapes:['numeric'] (typo for the locked 'numeric-range') previously passed
  // Array.isArray, matched no category, and returned applicable:0 — failing OPEN.
  test('rejects an unknown shape value (typo for a locked shape)', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: ['numeric'] }),
      /invalid shape/i,
    );
  });
  test('rejects a mixed array where one entry is invalid', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: ['numeric-range', 'bogus'] }),
      /invalid shape/i,
    );
  });
  test('rejects a non-string shape entry', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: [42] }),
      /invalid shape/i,
    );
  });
  test('analyzeCoverage propagates the invalid-shape throw', () => {
    assert.throws(
      () => ep.analyzeCoverage([{ id: 'R1', text: 'Round a number', shapes: ['numeric'] }]),
      /invalid shape/i,
    );
  });
  test('CLI exits 2 (handled) on an invalid authored shape, not an uncaught trace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-shape-'));
    const reqPath = path.join(dir, 'req.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number', shapes: ['numeric'] }]));
    try {
      const r = runNode([BUILT_SCRIPT, reqPath], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('a valid locked shape still proposes its categories (no false rejection)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'opaque', shapes: ['numeric-range'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
  });
  test('shapes: [] remains a valid zero-edge override (RR-06 intact)', () => {
    assert.deepEqual(ep.proposeEdges({ id: 'R1', text: 'merge intervals', shapes: [] }), []);
  });
});

describe('edge-probe: input validation & orphan-resolution rejection (adversarial review)', () => {
  // HIGH: a resolution whose (requirement_id, category) matches no proposed edge — a typo'd
  // category or a non-applicable one — was silently DROPPED, so an author who typos `precison`
  // sees the precision edge as still-unresolved with no error (a confirmed money-rounding exploit).
  test('rejects an orphan resolution (typo category — no matching proposed edge)', () => {
    assert.throws(
      () => ep.analyzeCoverage(
        [{ id: 'R1', text: 'Round a number to N decimal places' }],
        [{ requirement_id: 'R1', category: 'precison', status: 'resolved', verification: 'explicit', resolution: 'AC: precision handled' }],
      ),
      /unknown resolution|no matching proposed edge/i,
    );
  });
  test('rejects a resolution for a valid-but-non-applicable category', () => {
    // 'encoding' is a real taxonomy id but applies to text, not the numeric-range requirement.
    assert.throws(
      () => ep.analyzeCoverage(
        [{ id: 'R1', text: 'Round a number to N decimal places' }],
        [{ requirement_id: 'R1', category: 'encoding', status: 'resolved', verification: 'explicit', resolution: 'AC' }],
      ),
      /unknown resolution|no matching proposed edge/i,
    );
  });
  test('a matching resolution still resolves (no false orphan rejection)', () => {
    const rep = ep.analyzeCoverage(
      [{ id: 'R1', text: 'Round a number to N decimal places' }],
      [{ requirement_id: 'R1', category: 'precision', status: 'resolved', verification: 'explicit', resolution: 'AC: precision tested' }],
    );
    assert.equal(rep.coverage.resolved, 1);
  });
  test('rejects requirements that is not an array', () => {
    assert.throws(() => ep.analyzeCoverage('nope'), /requirements must be an array/i);
  });
  test('rejects a duplicate requirement id', () => {
    assert.throws(
      () => ep.analyzeCoverage([{ id: 'R1', text: 'a' }, { id: 'R1', text: 'b' }]),
      /duplicate requirement/i,
    );
  });
  test('rejects a truthy non-array shapes (string instead of array)', () => {
    // A bare string `shapes: "numeric-range"` previously fell through to prose classification,
    // silently ignoring the authored override instead of honoring or rejecting it.
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'x', shapes: 'numeric-range' }),
      /shapes must be an array/i,
    );
  });
  test('rejects a missing requirement id', () => {
    assert.throws(() => ep.proposeEdges({ text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects an empty requirement id', () => {
    assert.throws(() => ep.proposeEdges({ id: '   ', text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects a non-string requirement text', () => {
    assert.throws(() => ep.proposeEdges({ id: 'R1', text: 42 }), /text must be a string/i);
  });
  test('rejects a missing requirement text when no shapes override (M2 fail-open)', () => {
    // Without text or an authored shape, prose classification yields zero shapes → zero edges →
    // the requirement is silently DROPPED from coverage with no signal — the exact fail-open this
    // feature exists to eliminate. The edge adapter's `text` is required, so reject it.
    assert.throws(
      () => ep.proposeEdges({ id: 'R1' }),
      /text must be a non-empty string when no shapes override/i,
    );
    assert.throws(
      () => ep.analyzeCoverage([{ id: 'R1' }]),
      /text must be a non-empty string when no shapes override/i,
    );
  });
  test('rejects an empty/whitespace requirement text when no shapes override (M2)', () => {
    assert.throws(() => ep.proposeEdges({ id: 'R1', text: '' }), /text must be a non-empty string when no shapes override/i);
    assert.throws(() => ep.proposeEdges({ id: 'R1', text: '   ' }), /text must be a non-empty string when no shapes override/i);
  });
  test('allows missing/empty text WHEN an explicit shapes override is provided (M2 legitimate path)', () => {
    // An authored `shapes` array (including `[]` for "no applicable categories") opts out of prose
    // classification, so `text` is not required — this must remain valid.
    assert.deepEqual(ep.proposeEdges({ id: 'R1', shapes: [] }), []);
    const edges = ep.proposeEdges({ id: 'R1', shapes: ['numeric-range'] });
    assert.ok(edges.length > 0, 'an explicit shape override must still propose edges without text');
  });
});

describe('edge-probe: validateResolution — explicit-needs-resolution (RR-07, re-cut)', () => {
  test('rejects resolved/explicit with empty resolution string', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'explicit', resolution: '' }),
      /explicit requires a resolution/i,
    );
  });
  test('rejects resolved/explicit with whitespace-only resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'explicit', resolution: '   ' }),
      /explicit requires a resolution/i,
    );
  });
  test('rejects resolved/explicit with missing resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'explicit' }),
      /explicit requires a resolution/i,
    );
  });
  test('accepts resolved/explicit with a non-empty resolution', () => {
    assert.equal(
      ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'explicit', resolution: 'AC#3: boundary tested in suite' }),
      true,
    );
  });
});

describe('edge-probe: validateResolution — backstop-needs-resolution (RR-07 follow-up, re-cut)', () => {
  test('rejects resolved/backstop with empty resolution string', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'backstop', resolution: '' }),
      /backstop requires a resolution/i,
    );
  });
  test('rejects resolved/backstop with whitespace-only resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'backstop', resolution: '   ' }),
      /backstop requires a resolution/i,
    );
  });
  test('rejects resolved/backstop with missing resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'backstop' }),
      /backstop requires a resolution/i,
    );
  });
  test('accepts resolved/backstop with a non-empty resolution note', () => {
    assert.equal(
      ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'backstop', resolution: 'held-out: covered by integration fuzz suite' }),
      true,
    );
  });
});

describe('edge-probe: analyzeCoverage — duplicate rejection (RR-09)', () => {
  const reqs = [{ id: 'R1', text: 'Merge a list of overlapping intervals' }];
  test('rejects duplicate (requirement_id, category) resolution', () => {
    assert.throws(
      () => ep.analyzeCoverage(reqs, [
        { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#1' },
        { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#2' },
      ]),
      /duplicate resolution/i,
    );
  });
  test('distinct pairs still analyze without throwing', () => {
    // mirrors fixture 06-resolved-mixed
    assert.doesNotThrow(() => ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#6: touching intervals merge' },
      { requirement_id: 'R1', category: 'ordering', status: 'dismissed', resolution: null, reason: 'output is canonically sorted; no tie possible' },
    ]));
  });
});

describe('edge-probe: text_en language-aware classification (#3717)', () => {
  // The prose the #2773 stopgap test file already uses as its canonical Portuguese/English
  // pair, kept identical here so the two test files agree on the same fixture (no drift).
  const pt = 'O sistema mescla intervalos sobrepostos em uma lista ordenada';
  const en = 'The system merges overlapping intervals in a sorted list';

  test('proposeEdges: text_en absent falls back to text (back-compat)', () => {
    const withoutTextEn = ep.proposeEdges({ id: 'R1', text: 'Round a number to N decimal places' });
    assert.deepEqual(withoutTextEn.map((e) => e.category).sort(), ['boundary', 'precision']);
  });

  test('proposeEdges: text_en present is used for classification instead of text', () => {
    // text alone (non-English) classifies to zero shapes -> the unclassified sentinel.
    const nonEnglishOnly = ep.proposeEdges({ id: 'R1', text: pt });
    assert.deepEqual(nonEnglishOnly.map((e) => e.category), ['unclassified']);

    // text_en present -> classification runs against the English translation.
    const withTextEn = ep.proposeEdges({ id: 'R1', text: pt, text_en: en });
    assert.deepEqual(withTextEn.map((e) => e.category).sort(), ['adjacency', 'empty', 'ordering']);
  });

  test('#3717: a non-English requirement with text_en classifies identically to its English equivalent', () => {
    const englishOnly = ep.proposeEdges({ id: 'R1', text: en });
    const nonEnglishWithTranslation = ep.proposeEdges({ id: 'R1', text: pt, text_en: en });
    assert.deepEqual(
      nonEnglishWithTranslation.map((e) => e.category).sort(),
      englishOnly.map((e) => e.category).sort(),
      'a translated non-English requirement must raise the same categories as the English original',
    );
  });

  test('validateRequirement: text_en: null is treated as absent (no throw)', () => {
    assert.doesNotThrow(() => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: null }));
  });

  test('proposeEdges: text_en: null falls back to text', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Round a number to N decimal places', text_en: null });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
  });

  test('validateRequirement: rejects empty-string text_en (?? does not catch \'\')', () => {
    // Nullish coalescing only falls back on null/undefined — an empty string would
    // otherwise win `text_en ?? text` and silently classify against '', degrading to
    // zero shapes with no signal (the exact fail-open #1110/#2773 exist to eliminate).
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: '' }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('validateRequirement: rejects whitespace-only text_en', () => {
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: '   ' }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('validateRequirement: rejects non-string text_en (number/array/object)', () => {
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: 42 }),
      /text_en must be a non-empty string when present/i,
    );
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: ['x'] }),
      /text_en must be a non-empty string when present/i,
    );
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'Round a number', text_en: {} }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('proposeEdges: authored shapes override still wins when text_en is also present', () => {
    const edges = ep.proposeEdges({ id: 'R9', text: pt, text_en: en, shapes: ['numeric-range'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
  });

  test('validateRequirement: rejects empty text_en even when shapes override makes it unused', () => {
    // Validation is unconditional — it does not skip the text_en check just because the
    // classify branch would never run. Bad data fails closed regardless of whether it
    // happens to be dead for this particular call.
    assert.throws(
      () => ep.validateRequirement({ id: 'R1', text: 'x', text_en: '', shapes: ['collection'] }),
      /text_en must be a non-empty string when present/i,
    );
  });
});

describe('edge-probe: SHAPE_CUES/VALID_SHAPES/Shape vocabulary stay single-sourced (DEFECT.GENERATIVE-FIX)', () => {
  // RULESET.GENERATIVE-FIX (CONTEXT.md): parallel implementations diverge silently when no
  // parity test enforces equality at the test layer. VALID_SHAPES is derived from
  // Object.keys(SHAPE_CUES) in source, but that construction alone is not a regression
  // guard — this test fails if a future edit ever hardcodes one of them independently or
  // adds/removes a shape from only one side.
  const LOCKED_SHAPES = ['numeric-range', 'collection', 'text', 'stateful', 'io'];

  test('SHAPE_CUES keys match the locked 5-shape vocabulary exactly', () => {
    assert.deepEqual(Object.keys(ep.SHAPE_CUES).sort(), [...LOCKED_SHAPES].sort());
  });

  test('VALID_SHAPES matches SHAPE_CUES keys exactly (single source of truth)', () => {
    assert.deepEqual([...ep.VALID_SHAPES].sort(), Object.keys(ep.SHAPE_CUES).sort());
  });

  test('VALID_SHAPES matches the locked 5-shape vocabulary exactly', () => {
    assert.deepEqual([...ep.VALID_SHAPES].sort(), [...LOCKED_SHAPES].sort());
  });
});

describe('edge-probe: golden fixtures', () => {
  const root = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe-fixtures');
  const fixtures = fs.readdirSync(root).filter((d) =>
    fs.statSync(path.join(root, d)).isDirectory());
  assert.ok(fixtures.length >= 6, 'expected at least 6 fixtures');
  for (const name of fixtures) {
    test(`fixture ${name} matches its golden coverage`, () => {
      const dir = path.join(root, name);
      const reqs = JSON.parse(fs.readFileSync(path.join(dir, 'requirements.json'), 'utf8'));
      const resPath = path.join(dir, 'resolutions.json');
      const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, 'utf8')) : [];
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected-coverage.json'), 'utf8'));
      assert.deepEqual(ep.analyzeCoverage(reqs, res), expected);
    });
  }
});
