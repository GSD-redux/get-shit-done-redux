/**
 * Phase estimation — schema, smart-zone threshold policy, and calibration.
 *
 * Epic #1952 Phase 1 (#2630). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * The two invariants worth stating up front, because most of these tests exist
 * to defend them:
 *
 *   1. Confidence is DERIVED from calibration sample count, never self-rated.
 *      This project measured self-rated confidence and found it weak
 *      (gsd-core/references/honest-verifier.md:25-29). A future edit that adds
 *      a "how sure are you?" input should fail here.
 *   2. The budget comparison is strictly greater-than, so an estimate landing
 *      exactly on the budget is NOT a violation. Boundary fixtures at
 *      limit-1 / limit / limit+1 per RULESET.TESTS.boundary-coverage.fixtures.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const est = require('../gsd-core/bin/lib/phase-estimation.cjs');

// ─── deriveConfidence — exogenous, sample-count driven ──────────────────────

describe('deriveConfidence', () => {
  // Boundary fixtures at both thresholds: limit-1 / limit / limit+1.
  test('routes on sample count at the med threshold (2/3/4)', () => {
    assert.equal(est.deriveConfidence(2), 'low');
    assert.equal(est.deriveConfidence(3), 'med');
    assert.equal(est.deriveConfidence(4), 'med');
  });

  test('routes on sample count at the high threshold (5/6/7)', () => {
    assert.equal(est.deriveConfidence(5), 'med');
    assert.equal(est.deriveConfidence(6), 'high');
    assert.equal(est.deriveConfidence(7), 'high');
  });

  test('zero history is low confidence', () => {
    assert.equal(est.deriveConfidence(0), 'low');
  });

  test('unusable counts degrade to low rather than throwing', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity, null, undefined, '6', {}, []]) {
      assert.equal(est.deriveConfidence(bad), 'low', `${String(bad)} must degrade to low`);
    }
  });

  test('only ever returns a declared confidence value', () => {
    // f(n) === f(n) would hold for ANY deterministic function, including one
    // that always returned 'high'. Constrain the codomain instead.
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), (n) => {
      assert.ok(
        est.CONFIDENCE_VALUES.includes(est.deriveConfidence(n)),
        `deriveConfidence(${n}) returned a value outside CONFIDENCE_VALUES`,
      );
    }), { numRuns: 100, seed: 19520, verbose: true });
    // ...and that every declared value is actually reachable, so the enum and
    // the thresholds cannot drift apart.
    assert.deepEqual(
      [...new Set([0, 3, 6].map((n) => est.deriveConfidence(n)))].sort(),
      [...est.CONFIDENCE_VALUES].sort(),
    );
  });

  test('is monotonic — more history never lowers confidence', () => {
    const rank = { low: 0, med: 1, high: 2 };
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 200 }),
      fc.integer({ min: 0, max: 200 }),
      (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        assert.ok(
          rank[est.deriveConfidence(lo)] <= rank[est.deriveConfidence(hi)],
          `confidence dropped going from ${lo} to ${hi} samples`,
        );
      },
    ), { numRuns: 200, seed: 19521, verbose: true });
  });
});

// ─── classifyAgainstBudget — the smart-zone threshold ───────────────────────

describe('classifyAgainstBudget', () => {
  const BUDGET = 100000;

  test('boundary: limit-1 is under, limit is under, limit+1 is over', () => {
    assert.equal(est.classifyAgainstBudget(BUDGET - 1, BUDGET).overBudget, false, 'budget-1 must be under');
    assert.equal(est.classifyAgainstBudget(BUDGET, BUDGET).overBudget, false, 'exactly at budget must NOT be a violation');
    assert.equal(est.classifyAgainstBudget(BUDGET + 1, BUDGET).overBudget, true, 'budget+1 must be over');
  });

  test('under budget carries no recommendation', () => {
    const r = est.classifyAgainstBudget(50000, BUDGET);
    assert.equal(r.recommendation, null);
    assert.equal(r.budgetValid, true);
    assert.ok(Math.abs(r.ratio - 0.5) < 1e-9);
  });

  test('over budget recommends a slice count derived from the ratio', () => {
    const r = est.classifyAgainstBudget(250000, BUDGET);
    assert.equal(r.overBudget, true);
    assert.ok(Math.abs(r.ratio - 2.5) < 1e-9);
    assert.ok(typeof r.recommendation === 'string' && r.recommendation.length > 0);
    // ceil(2.5) === 3 slices.
    assert.match(r.recommendation, /\b3\b/);
  });

  test('an unusable budget never fabricates a violation', () => {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, '100000', {}]) {
      const r = est.classifyAgainstBudget(999999999, bad);
      assert.equal(r.overBudget, false, `budget ${String(bad)} must not report a violation`);
      assert.equal(r.budgetValid, false, `budget ${String(bad)} must report itself invalid`);
      assert.equal(r.recommendation, null);
    }
  });

  test('an unusable estimate reports no violation but keeps a valid budget flagged valid', () => {
    const r = est.classifyAgainstBudget(NaN, BUDGET);
    assert.equal(r.overBudget, false);
    assert.equal(r.budgetValid, true, 'the budget was fine; the estimate was not');
  });

  test('property: overBudget is exactly estimate > budget', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1000000 }),
      fc.integer({ min: 1, max: 1000000 }),
      (estimate, budget) => {
        assert.equal(est.classifyAgainstBudget(estimate, budget).overBudget, estimate > budget);
      },
    ), { numRuns: 300, seed: 19522, verbose: true });
  });
});

// ─── computeCalibration — median, clamped, sample-gated ─────────────────────

const sample = (estimateTokens, actualTokens) => ({ estimateTokens, actualTokens });

describe('computeCalibration', () => {
  test('boundary: no correction below the minimum sample count (2/3)', () => {
    const two = [sample(100, 200), sample(100, 200)];
    const r2 = est.computeCalibration(two);
    assert.equal(r2.applied, false, '2 samples must not apply a correction');
    assert.equal(r2.factor, 1, 'unapplied factor must be exactly 1');
    assert.equal(r2.sampleCount, 2);

    const three = [sample(100, 200), sample(100, 200), sample(100, 200)];
    const r3 = est.computeCalibration(three);
    assert.equal(r3.applied, true, '3 samples must apply a correction');
    assert.equal(r3.factor, 2, 'median of [2,2,2] is 2');
  });

  test('a consistently-underestimated project gets a larger future estimate (AC4)', () => {
    // Every phase cost roughly twice its estimate.
    const history = [sample(50000, 98000), sample(60000, 121000), sample(40000, 82000)];
    const r = est.computeCalibration(history);

    assert.equal(r.applied, true);
    assert.ok(r.factor > 1, `expected an upward correction, got ${r.factor}`);

    const raw = 60000;
    const corrected = est.applyCalibration(raw, r.factor);
    assert.ok(corrected > raw, `calibrated estimate ${corrected} must exceed the raw ${raw}`);
  });

  test('a consistently-overestimated project gets a smaller future estimate', () => {
    const history = [sample(100000, 60000), sample(80000, 48000), sample(90000, 54000)];
    const r = est.computeCalibration(history);

    assert.equal(r.applied, true);
    assert.ok(r.factor < 1, `expected a downward correction, got ${r.factor}`);
    assert.ok(est.applyCalibration(50000, r.factor) < 50000);
  });

  test('median averages the two middle ratios on an even-length history', () => {
    // Every explicit-value case elsewhere uses 3 samples (odd), so the
    // even-length averaging branch had no fixed-value assertion.
    const history = [sample(100, 100), sample(100, 120), sample(100, 140), sample(100, 160)];
    const r = est.computeCalibration(history);
    assert.equal(r.sampleCount, 4);
    // ratios [1.0, 1.2, 1.4, 1.6] -> median = (1.2 + 1.4) / 2 = 1.3
    assert.ok(Math.abs(r.factor - 1.3) < 1e-9, `expected ~1.3, got ${r.factor}`);
  });

  test('median resists a single pathological outlier', () => {
    // Two honest 1.0 phases plus one aborted run that burned 50x.
    const history = [sample(100, 100), sample(100, 100), sample(100, 5000)];
    const r = est.computeCalibration(history);
    assert.equal(r.factor, 1, 'median must ignore the outlier a mean would chase');
  });

  test('factor is clamped at both bounds and reports the clamp', () => {
    const huge = [sample(100, 100000), sample(100, 100000), sample(100, 100000)];
    const rHigh = est.computeCalibration(huge);
    assert.equal(rHigh.factor, est.CALIBRATION_FACTOR_MAX);
    assert.equal(rHigh.clamped, true);

    const tiny = [sample(100000, 100), sample(100000, 100), sample(100000, 100)];
    const rLow = est.computeCalibration(tiny);
    assert.equal(rLow.factor, est.CALIBRATION_FACTOR_MIN);
    assert.equal(rLow.clamped, true);

    const inRange = [sample(100, 150), sample(100, 150), sample(100, 150)];
    assert.equal(est.computeCalibration(inRange).clamped, false);
  });

  test('drops unusable samples instead of coercing them', () => {
    const mixed = [
      sample(100, 200),
      sample(0, 200),          // zero estimate would divide to Infinity
      sample(100, 0),
      sample(-100, 200),
      sample(100, NaN),
      sample(100, 200),
      null,
      'nope',
      { estimateTokens: '100', actualTokens: '200' },
      sample(100, 200),
    ];
    const r = est.computeCalibration(mixed);
    assert.equal(r.sampleCount, 3, 'only the three well-formed samples count');
    assert.equal(r.applied, true);
    assert.equal(r.factor, 2);
  });

  test('non-array input degrades to an empty history', () => {
    for (const bad of [null, undefined, 'samples', 42, {}]) {
      const r = est.computeCalibration(bad);
      assert.equal(r.sampleCount, 0);
      assert.equal(r.applied, false);
      assert.equal(r.factor, 1);
      assert.equal(r.confidence, 'low');
    }
  });

  test('confidence always agrees with deriveConfidence on the usable count', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 })), { maxLength: 12 }),
      (pairs) => {
        const samples = pairs.map(([e, a]) => sample(e, a));
        const r = est.computeCalibration(samples);
        assert.equal(r.sampleCount, samples.length);
        assert.equal(r.confidence, est.deriveConfidence(samples.length));
      },
    ), { numRuns: 200, seed: 19523, verbose: true });
  });

  test('property: factor always lands inside the clamp', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 })), { minLength: 3, maxLength: 20 }),
      (pairs) => {
        const r = est.computeCalibration(pairs.map(([e, a]) => sample(e, a)));
        assert.ok(r.factor >= est.CALIBRATION_FACTOR_MIN, `factor ${r.factor} below clamp`);
        assert.ok(r.factor <= est.CALIBRATION_FACTOR_MAX, `factor ${r.factor} above clamp`);
      },
    ), { numRuns: 300, seed: 19524, verbose: true });
  });
});

describe('applyCalibration', () => {
  test('never returns a zero-token estimate', () => {
    assert.equal(est.applyCalibration(1, 0.5), 1);
    assert.ok(est.applyCalibration(2, est.CALIBRATION_FACTOR_MIN) >= 1);
  });

  test('an unusable factor leaves the estimate intact', () => {
    assert.equal(est.applyCalibration(1234, NaN), 1234);
    assert.equal(est.applyCalibration(1234, null), 1234);
    assert.equal(est.applyCalibration(1234, 0), 1234);
  });

  test('an unusable raw estimate yields 0', () => {
    assert.equal(est.applyCalibration(0, 2), 0);
    assert.equal(est.applyCalibration(NaN, 2), 0);
  });
});

// ─── schema parse/render ───────────────────────────────────────────────────

describe('parseEstimate', () => {
  test('accepts a whole frontmatter object or the estimate mapping itself', () => {
    const expected = { tokens: 60000, tasks: 5, confidence: 'med' };
    assert.deepEqual(est.parseEstimate({ estimate: expected }), expected);
    assert.deepEqual(est.parseEstimate(expected), expected);
  });

  test('rejects an incomplete block rather than defaulting a missing field', () => {
    assert.equal(est.parseEstimate({ tokens: 100, tasks: 2 }), null, 'missing confidence');
    assert.equal(est.parseEstimate({ tokens: 100, confidence: 'low' }), null, 'missing tasks');
    assert.equal(est.parseEstimate({ tasks: 2, confidence: 'low' }), null, 'missing tokens');
  });

  test('rejects hostile and malformed values', () => {
    const bad = [
      null, undefined, 'estimate', 42, [],
      { tokens: 0, tasks: 1, confidence: 'low' },
      { tokens: -5, tasks: 1, confidence: 'low' },
      { tokens: 1.5, tasks: 1, confidence: 'low' },
      { tokens: NaN, tasks: 1, confidence: 'low' },
      { tokens: Infinity, tasks: 1, confidence: 'low' },
      { tokens: Number.MAX_SAFE_INTEGER + 2, tasks: 1, confidence: 'low' },
      { tokens: '60000', tasks: 1, confidence: 'low' },
      { tokens: 100, tasks: 0, confidence: 'low' },
      { tokens: 100, tasks: 1, confidence: 'certain' },
      { tokens: 100, tasks: 1, confidence: '' },
      { tokens: 100, tasks: 1, confidence: 1 },
      { estimate: null },
      { estimate: [] },
    ];
    for (const value of bad) {
      assert.equal(est.parseEstimate(value), null, `must reject ${JSON.stringify(value) ?? String(value)}`);
    }
  });
});

describe('parseActuals', () => {
  test('accepts zero commits but not zero tokens or tasks', () => {
    assert.deepEqual(
      est.parseActuals({ actuals: { tokens: 74000, tasks: 5, commits: 0 } }),
      { tokens: 74000, tasks: 5, commits: 0 },
    );
    assert.equal(est.parseActuals({ tokens: 0, tasks: 5, commits: 1 }), null);
    assert.equal(est.parseActuals({ tokens: 100, tasks: 0, commits: 1 }), null);
  });

  test('rejects negative or malformed commits', () => {
    assert.equal(est.parseActuals({ tokens: 100, tasks: 1, commits: -1 }), null);
    assert.equal(est.parseActuals({ tokens: 100, tasks: 1, commits: 1.5 }), null);
    assert.equal(est.parseActuals({ tokens: 100, tasks: 1, commits: '3' }), null);
    assert.equal(est.parseActuals({ tokens: 100, tasks: 1 }), null);
  });
});

describe('estimate/actuals schema disjointness', () => {
  // estimateBlockOf/actualsBlockOf fall back to treating the whole record as
  // the block when the wrapper key is absent. That is only safe while the two
  // schemas require disjoint fields. Pin it: if either schema ever gains the
  // other's disambiguator, this fails loudly instead of silently cross-parsing.
  test('an actuals block never parses as an estimate, and vice versa', () => {
    const actualsBlock = { tokens: 74000, tasks: 5, commits: 7 };
    const estimateBlock = { tokens: 60000, tasks: 5, confidence: 'med' };

    assert.equal(est.parseEstimate(actualsBlock), null, 'actuals must not parse as an estimate');
    assert.equal(est.parseActuals(estimateBlock), null, 'an estimate must not parse as actuals');
  });
});

describe('estimate/actuals round-trip', () => {
  test('property: parseEstimate(renderEstimate(e)) === e', () => {
    fc.assert(fc.property(
      fc.record({
        tokens: fc.integer({ min: 1, max: 5000000 }),
        tasks: fc.integer({ min: 1, max: 200 }),
        confidence: fc.constantFrom('low', 'med', 'high'),
      }),
      (estimate) => {
        const rendered = est.renderEstimate(estimate);
        // Render emits YAML; parse the scalar lines back into an object the
        // parser accepts, proving the rendered text carries every field.
        const parsedBack = {};
        for (const line of rendered.split('\n').slice(1)) {
          const m = /^ {2}(\w+): (.+)$/.exec(line);
          assert.ok(m, `unparseable rendered line: ${line}`);
          parsedBack[m[1]] = m[1] === 'confidence' ? m[2] : Number(m[2]);
        }
        // fast-check's fc.record yields a null-prototype object; deepEqual
        // compares prototypes, so rebuild a plain object to compare values.
        assert.deepEqual(est.parseEstimate(parsedBack), {
          tokens: estimate.tokens, tasks: estimate.tasks, confidence: estimate.confidence,
        });
      },
    ), { numRuns: 300, seed: 19525, verbose: true });
  });

  test('property: parseActuals(renderActuals(a)) === a', () => {
    fc.assert(fc.property(
      fc.record({
        tokens: fc.integer({ min: 1, max: 5000000 }),
        tasks: fc.integer({ min: 1, max: 200 }),
        commits: fc.integer({ min: 0, max: 500 }),
      }),
      (actuals) => {
        const rendered = est.renderActuals(actuals);
        const parsedBack = {};
        for (const line of rendered.split('\n').slice(1)) {
          const m = /^ {2}(\w+): (.+)$/.exec(line);
          assert.ok(m, `unparseable rendered line: ${line}`);
          parsedBack[m[1]] = Number(m[2]);
        }
        // Same null-prototype caveat as the estimate round-trip above.
        assert.deepEqual(est.parseActuals(parsedBack), {
          tokens: actuals.tokens, tasks: actuals.tasks, commits: actuals.commits,
        });
      },
    ), { numRuns: 300, seed: 19526, verbose: true });
  });
});

// ─── calibration document — a disk trust boundary ──────────────────────────

describe('parseCalibrationDocument', () => {
  test('reads a well-formed document', () => {
    const raw = est.renderCalibrationDocument([sample(100, 200), sample(300, 400)]);
    assert.deepEqual(est.parseCalibrationDocument(raw), [sample(100, 200), sample(300, 400)]);
  });

  test('round-trips through render', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 })), { maxLength: 15 }),
      (pairs) => {
        const samples = pairs.map(([e, a]) => sample(e, a));
        assert.deepEqual(est.parseCalibrationDocument(est.renderCalibrationDocument(samples)), samples);
      },
    ), { numRuns: 200, seed: 19527, verbose: true });
  });

  test('refuses an unrecognized schema_version outright', () => {
    const future = JSON.stringify({ schema_version: 99, samples: [sample(100, 200)] });
    assert.deepEqual(est.parseCalibrationDocument(future), [],
      'a future schema may redefine the ratio — best-effort reading it would corrupt every later estimate');

    const missing = JSON.stringify({ samples: [sample(100, 200)] });
    assert.deepEqual(est.parseCalibrationDocument(missing), []);
  });

  test('degrades to empty on malformed and hostile input', () => {
    const bad = [
      '', '   ', 'not json', '{', '[]', 'null', '"string"', '42',
      JSON.stringify({ schema_version: 1 }),
      JSON.stringify({ schema_version: 1, samples: 'nope' }),
      JSON.stringify({ schema_version: 1, samples: {} }),
      JSON.stringify({ schema_version: '1', samples: [] }),
      null, undefined, 42, {},
    ];
    for (const value of bad) {
      assert.deepEqual(est.parseCalibrationDocument(value), [],
        `must degrade to [] for ${String(value).slice(0, 40)}`);
    }
  });

  test('drops individually malformed samples but keeps the good ones', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      samples: [
        sample(100, 200),
        { estimateTokens: 0, actualTokens: 5 },
        { estimateTokens: 'x', actualTokens: 5 },
        null,
        [1, 2],
        sample(300, 400),
      ],
    });
    assert.deepEqual(est.parseCalibrationDocument(raw), [sample(100, 200), sample(300, 400)]);
  });

  test('a prototype-pollution payload cannot reach Object.prototype', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      samples: [{ estimateTokens: 100, actualTokens: 200, __proto__: { polluted: true } }],
    });
    const parsed = est.parseCalibrationDocument(raw);
    assert.equal(parsed.length, 1);
    assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
    assert.deepEqual(parsed[0], sample(100, 200), 'only the two known fields are carried forward');
  });
});

// ─── measureTokens — one scale for estimate and actual ─────────────────────

describe('measureTokens', () => {
  test('is the same scale prompt-budget uses', () => {
    const { estimateTokens } = require('../gsd-core/bin/lib/prompt-budget.cjs');
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
      assert.equal(est.measureTokens(s), estimateTokens(s),
        'estimate and actuals must share one estimator or the ratio is meaningless');
    }), { numRuns: 200, seed: 19528, verbose: true });
  });

  test('empty and nullish inputs measure zero', () => {
    assert.equal(est.measureTokens(''), 0);
    assert.equal(est.measureTokens(null), 0);
    assert.equal(est.measureTokens(undefined), 0);
  });
});

// ─── config key: workflow.smart_zone_tokens ────────────────────────────────

describe('workflow.smart_zone_tokens config key', () => {
  test('defaults to 100000 with no config file written', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const r = runGsdTools('query config-get workflow.smart_zone_tokens --raw', tmpDir);
    assert.ok(r.success, `config-get should resolve the schema default: ${r.error}`);
    assert.equal(String(r.output).trim(), '100000');
  });

  test('config-set persists an override', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set workflow.smart_zone_tokens 60000', tmpDir);
    assert.ok(set.success, `config-set should accept the key: ${set.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.workflow?.smart_zone_tokens, 60000, 'value must be persisted under workflow.');

    const get = runGsdTools('query config-get workflow.smart_zone_tokens --raw', tmpDir);
    assert.equal(String(get.output).trim(), '60000');
  });

  test('rejects non-positive-integer values', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    for (const bad of ['0', '-1', '1.5', 'abc', 'Infinity', '']) {
      const r = runGsdTools(`config-set workflow.smart_zone_tokens ${bad === '' ? '""' : bad}`, tmpDir);
      assert.ok(!r.success, `config-set must reject ${JSON.stringify(bad)}`);
    }
  });
});

// ─── CLI verbs ─────────────────────────────────────────────────────────────

describe('query estimate-check', () => {
  test('reports under-budget against the configured budget', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const r = runGsdTools('query estimate-check --tokens 50000', tmpDir);
    assert.ok(r.success, `estimate-check should succeed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.equal(out.over_budget, false);
    assert.equal(out.budget, 100000);
  });

  test('reports over-budget with a recommendation and honors a configured budget', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools('config-set workflow.smart_zone_tokens 40000', tmpDir);
    const r = runGsdTools('query estimate-check --tokens 90000', tmpDir);
    assert.ok(r.success, `estimate-check should succeed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.equal(out.budget, 40000);
    assert.equal(out.over_budget, true);
    assert.ok(typeof out.recommendation === 'string' && out.recommendation.length > 0);
  });

  test('boundary: exactly at the configured budget is not over', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools('config-set workflow.smart_zone_tokens 40000', tmpDir);
    const at = JSON.parse(runGsdTools('query estimate-check --tokens 40000', tmpDir).output);
    assert.equal(at.over_budget, false);

    const over = JSON.parse(runGsdTools('query estimate-check --tokens 40001', tmpDir).output);
    assert.equal(over.over_budget, true);
  });

  test('rejects a missing, empty, or malformed --tokens value', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    for (const args of [
      'query estimate-check',
      'query estimate-check --tokens',
      'query estimate-check --tokens ""',
      'query estimate-check --tokens abc',
      'query estimate-check --tokens -5',
      'query estimate-check --tokens 0',
    ]) {
      const r = runGsdTools(args, tmpDir);
      assert.ok(!r.success, `must reject: ${args}`);
      assert.ok(!/\bat Object\.|\bat Module\./.test(String(r.error ?? '')), 'no stack trace in failure output');
    }
  });

  test('does not shell-interpolate a hostile --tokens value', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const marker = path.join(tmpDir, 'pwned.txt');
    const r = runGsdTools(`query estimate-check --tokens "1; touch ${marker}"`, tmpDir);
    assert.ok(!r.success, 'a command-substitution payload must be rejected as a bad number');
    assert.equal(fs.existsSync(marker), false, 'no shell interpolation of attacker-controlled values');
  });
});

describe('query estimate-calibration', () => {
  test('reports an inert calibration with no history', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const r = runGsdTools('query estimate-calibration', tmpDir);
    assert.ok(r.success, `estimate-calibration should succeed with no history: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.equal(out.applied, false);
    assert.equal(out.factor, 1);
    assert.equal(out.sample_count, 0);
    assert.equal(out.confidence, 'low');
  });

  test('applies a correction once enough history exists', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'estimation-calibration.json'),
      est.renderCalibrationDocument([sample(100, 200), sample(100, 200), sample(100, 200)]),
    );

    const out = JSON.parse(runGsdTools('query estimate-calibration', tmpDir).output);
    assert.equal(out.applied, true);
    assert.equal(out.factor, 2);
    assert.equal(out.sample_count, 3);
    assert.equal(out.confidence, 'med');
  });

  test('degrades to inert on a corrupt calibration file rather than failing planning', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    fs.writeFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), '{ not json');

    const r = runGsdTools('query estimate-calibration', tmpDir);
    assert.ok(r.success, 'a corrupt calibration file must not fail the command');
    const out = JSON.parse(r.output);
    assert.equal(out.applied, false);
    assert.equal(out.factor, 1);
  });

  test('survives an unreadable calibration file', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const target = path.join(tmpDir, '.planning', 'estimation-calibration.json');
    fs.writeFileSync(target, est.renderCalibrationDocument([sample(100, 200)]));

    // Drives the REAL readCalibrationSamples — an earlier version of this test
    // re-implemented the try/catch inline and would have kept passing if the
    // production guard were deleted.
    const cli = require('../gsd-core/bin/lib/estimate-cli.cjs');

    // Deterministic IO fault injection: monkeypatch the fs method and restore in
    // finally. Never chmod 0o000 — root bypasses mode bits, so the test would
    // silently pass with zero coverage in root Docker/CI.
    const originalReadFileSync = fs.readFileSync;
    let sawInjectedRead = false;
    fs.readFileSync = function patched(p, ...rest) {
      if (String(p).endsWith('estimation-calibration.json')) {
        sawInjectedRead = true;
        throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      }
      return originalReadFileSync.call(this, p, ...rest);
    };
    let samples;
    try {
      samples = cli.readCalibrationSamples(tmpDir);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(sawInjectedRead, true, 'the injected fault must actually have fired');
    assert.deepEqual(samples, [], 'an unreadable file degrades to no history');

    // And the degraded history must still yield an inert calibration.
    const calibration = est.computeCalibration(samples);
    assert.equal(calibration.applied, false);
    assert.equal(calibration.factor, 1);
  });
});

// ─── double-calibration guard (#2631) ──────────────────────────────────────

describe('estimate-check --calibrated', () => {
  // A plan's recorded `estimate.tokens` already has the factor applied at
  // emission time (ADR-2629 Decision 1). Without --calibrated, estimate-check
  // applies it a SECOND time and compares factor^2 against the budget. With the
  // [0.5, 3.0] clamp that ranges from 4x under to 9x over — and it is invisible
  // until a project reaches 3 samples, because below that factor === 1 and
  // 1^2 === 1. These tests pin both modes at a factor where they diverge.
  const withHistory = (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'estimation-calibration.json'),
      est.renderCalibrationDocument([sample(100, 200), sample(100, 200), sample(100, 200)]),
    );
    return tmpDir;
  };

  test('without the flag, a raw projection IS corrected', (t) => {
    const tmpDir = withHistory(t);
    const out = JSON.parse(runGsdTools('query estimate-check --tokens 50000', tmpDir).output);
    assert.equal(out.calibration_factor, 2, 'fixture must produce factor 2');
    assert.equal(out.calibrated_tokens, 100000, 'a raw projection must be multiplied by the factor');
    assert.equal(out.pre_calibrated, false);
  });

  test('with the flag, an already-calibrated figure is NOT corrected again', (t) => {
    const tmpDir = withHistory(t);
    const out = JSON.parse(runGsdTools('query estimate-check --tokens 50000 --calibrated', tmpDir).output);
    assert.equal(out.calibration_factor, 2, 'the factor is still reported');
    assert.equal(out.calibrated_tokens, 50000,
      'a pre-calibrated figure must pass through untouched — re-applying squares the correction');
    assert.equal(out.pre_calibrated, true);
  });

  test('the two modes diverge by exactly the factor', (t) => {
    const tmpDir = withHistory(t);
    const raw = JSON.parse(runGsdTools('query estimate-check --tokens 40000', tmpDir).output);
    const pre = JSON.parse(runGsdTools('query estimate-check --tokens 40000 --calibrated', tmpDir).output);
    assert.equal(raw.calibrated_tokens, pre.calibrated_tokens * raw.calibration_factor);
  });

  test('the flag changes the over-budget verdict at the boundary', (t) => {
    const tmpDir = withHistory(t);
    runGsdTools('config-set workflow.smart_zone_tokens 60000', tmpDir);
    // 50000 raw -> 100000 calibrated -> over 60000. Same value pre-calibrated -> under.
    const raw = JSON.parse(runGsdTools('query estimate-check --tokens 50000', tmpDir).output);
    const pre = JSON.parse(runGsdTools('query estimate-check --tokens 50000 --calibrated', tmpDir).output);
    assert.equal(raw.over_budget, true, 'double-applied correction reports a false over-budget');
    assert.equal(pre.over_budget, false, 'the honest figure is under budget');
  });
});
