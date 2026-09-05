// docs-guard-exempt: docPath is a .planning/estimation-calibration.json tmp fixture; the docs/adr and docs/reference citations are comment-only.
/**
 * estimate-calibrate — build the calibration document from completed phases.
 *
 * Epic #1952 Phase 3 (#2632). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * This is the verb that makes AC4 real. Phase 1 shipped the calibration MATH;
 * Phase 2 made the planner emit an estimate. Neither closes the loop, because
 * nothing pairs a plan's `estimate` with its summary's `actuals` and writes the
 * result. Leaving that to agent prose would make "estimates improve over time"
 * unverifiable — so the pairing and the write are deterministic here, and
 * extract-learnings just invokes them.
 *
 * The headline test is `a consistently-underestimated project produces an
 * upward correction`: that is epic acceptance criterion AC4 stated as an
 * executable claim.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools, captureFdSync } = require('./helpers.cjs');
const est = require('../gsd-core/bin/lib/phase-estimation.cjs');
const estimateCli = require('../gsd-core/bin/lib/estimate-cli.cjs');
// io.cjs owns error()/ERROR_REASON/JSON-error-mode — driven directly here so
// H1 below can assert a typed `reason`, mirroring tests/config-get-default.test.cjs's
// established in-process CLI-error-path pattern.
const io = require('../gsd-core/bin/lib/io.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');

/** Write a phase dir containing a PLAN with an estimate and a SUMMARY with actuals. */
function writePhase(tmpDir, phaseDir, { estTokens, actTokens, tasks = 3, commits = 4 }) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  if (estTokens !== null) {
    fs.writeFileSync(path.join(dir, '01-PLAN.md'), [
      '---',
      'phase: ' + phaseDir,
      'plan: 01',
      'estimate:',
      `  tokens: ${estTokens}`,
      `  tasks: ${tasks}`,
      '  confidence: low',
      'must_haves:',
      '  truths: []',
      '---',
      '<objective>x</objective>',
      '',
    ].join('\n'));
  }
  if (actTokens !== null) {
    fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), [
      '---',
      'phase: ' + phaseDir,
      'plan: 01',
      'actuals:',
      `  tokens: ${actTokens}`,
      `  tasks: ${tasks}`,
      `  commits: ${commits}`,
      '---',
      '## What shipped',
      '',
    ].join('\n'));
  }
  return dir;
}

describe('estimate-calibrate', () => {
  test('AC4: a consistently-underestimated project produces an upward correction', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Three phases that each cost ~2x their estimate.
    writePhase(tmpDir, '01-alpha', { estTokens: 50000, actTokens: 98000 });
    writePhase(tmpDir, '02-beta', { estTokens: 60000, actTokens: 121000 });
    writePhase(tmpDir, '03-gamma', { estTokens: 40000, actTokens: 82000 });

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, `estimate-calibrate should succeed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.equal(out.sample_count, 3, 'all three phases pair up');
    assert.equal(out.applied, true);
    assert.ok(out.factor > 1, `expected an upward correction, got ${out.factor}`);

    // The document must be persisted where estimate-calibration reads it.
    const docPath = path.join(tmpDir, '.planning', 'estimation-calibration.json');
    assert.ok(fs.existsSync(docPath), 'calibration document must be written');
    assert.deepEqual(
      est.parseCalibrationDocument(fs.readFileSync(docPath, 'utf8')).length, 3,
      'persisted document must carry all three samples',
    );

    // And the read verb must now agree — this is the loop actually closing.
    const readBack = JSON.parse(runGsdTools('query estimate-calibration', tmpDir).output);
    assert.equal(readBack.factor, out.factor, 'estimate-calibration must see what estimate-calibrate wrote');
    assert.equal(readBack.applied, true);

    // A subsequent estimate is therefore larger than the raw projection.
    const check = JSON.parse(runGsdTools('query estimate-check --tokens 50000', tmpDir).output);
    assert.ok(check.calibrated_tokens > 50000,
      `a later estimate must be corrected upward, got ${check.calibrated_tokens}`);
  });

  test('a consistently-overestimated project produces a downward correction', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writePhase(tmpDir, '01-a', { estTokens: 100000, actTokens: 60000 });
    writePhase(tmpDir, '02-b', { estTokens: 80000, actTokens: 48000 });
    writePhase(tmpDir, '03-c', { estTokens: 90000, actTokens: 54000 });

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.ok(out.factor < 1, `expected a downward correction, got ${out.factor}`);
  });

  test('boundary: inert below the minimum sample count, applied at it', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    writePhase(tmpDir, '01-a', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '02-b', { estTokens: 100, actTokens: 200 });
    let out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 2);
    assert.equal(out.applied, false, '2 samples must not apply a correction');
    assert.equal(out.factor, 1);

    writePhase(tmpDir, '03-c', { estTokens: 100, actTokens: 200 });
    out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 3);
    assert.equal(out.applied, true, '3 samples must apply');
    assert.equal(out.factor, 2);
  });

  test('phases missing either side are skipped, not guessed', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    writePhase(tmpDir, '01-paired', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '02-plan-only', { estTokens: 100, actTokens: null });
    writePhase(tmpDir, '03-summary-only', { estTokens: null, actTokens: 200 });

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 1, 'only the fully-paired phase counts');
  });

  test('a phase whose PLAN has no estimate block contributes nothing', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const dir = path.join(tmpDir, '.planning', 'phases', '01-noest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-PLAN.md'), '---\nphase: 01-noest\nplan: 01\n---\nbody\n');
    fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), '---\nphase: 01-noest\nactuals:\n  tokens: 5\n  tasks: 1\n  commits: 1\n---\nx\n');

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 0);
    assert.equal(out.applied, false);
  });

  test('no phases at all is a clean no-op, not an error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, 'must not fail on an empty project');
    const out = JSON.parse(r.output);
    assert.equal(out.sample_count, 0);
    assert.equal(out.factor, 1);
  });

  test('re-running is idempotent — it rebuilds, never appends duplicates', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writePhase(tmpDir, '01-a', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '02-b', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '03-c', { estTokens: 100, actTokens: 200 });

    const first = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    const second = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.deepEqual(second, first, 'a second run must produce an identical result');

    const doc = est.parseCalibrationDocument(
      fs.readFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), 'utf8'),
    );
    assert.equal(doc.length, 3, 'samples must not accumulate across runs');
  });

  test('a corrupt pre-existing document is replaced, not merged', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), '{ not json');
    writePhase(tmpDir, '01-a', { estTokens: 100, actTokens: 200 });

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, 'a corrupt prior document must not fail the rebuild');
    const doc = est.parseCalibrationDocument(
      fs.readFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), 'utf8'),
    );
    assert.equal(doc.length, 1);
  });

  test('the written document round-trips through the parser', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writePhase(tmpDir, '01-a', { estTokens: 12345, actTokens: 23456 });

    runGsdTools('query estimate-calibrate', tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), 'utf8');
    const parsed = est.parseCalibrationDocument(raw);
    assert.deepEqual(parsed, [{ estimateTokens: 12345, actualTokens: 23456 }]);
    assert.equal(JSON.parse(raw).schema_version, est.CALIBRATION_SCHEMA_VERSION,
      'must stamp the current schema version so a future reader can refuse it');
  });
});

// ─── convergence guard (#2632) ─────────────────────────────────────────────

describe('calibration converges instead of oscillating', () => {
  // The loop must measure actual/RAW, not actual/calibrated. Measuring against
  // the already-corrected figure is self-defeating: once the correction works
  // the observed ratio approaches 1, dragging the median back toward 1, which
  // un-corrects the next estimate. This test pins convergence over enough
  // phases for that oscillation to show up — it fails at ~1.41 if the basis
  // regresses to the calibrated value.
  const RAW = 50000;
  const TRUE_COST = 100000;   // the planner is consistently 2x low

  const simulate = (useRawBasis) => {
    const samples = [];
    for (let phase = 0; phase < 10; phase += 1) {
      const cal = est.computeCalibration(samples);
      const emitted = est.applyCalibration(RAW, cal.factor);
      const estimate = { tokens: emitted, rawTokens: RAW, tasks: 3, confidence: cal.confidence };
      samples.push({
        estimateTokens: useRawBasis ? est.calibrationBasis(estimate) : estimate.tokens,
        actualTokens: TRUE_COST,
      });
    }
    return est.computeCalibration(samples).factor;
  };

  test('measuring against the raw projection converges on the true ratio', () => {
    assert.ok(Math.abs(simulate(true) - 2) < 1e-9,
      `expected convergence on 2.0, got ${simulate(true)}`);
  });

  test('measuring against the calibrated figure does NOT converge', () => {
    // Negative proof that the basis choice is load-bearing, not incidental.
    assert.ok(simulate(false) < 1.9,
      'if this passes at ~2.0 the two bases are equivalent and this guard is vacuous');
  });

  test('calibrationBasis prefers raw_tokens and falls back for older plans', () => {
    assert.equal(est.calibrationBasis({ tokens: 100000, rawTokens: 50000, tasks: 3, confidence: 'med' }), 50000);
    assert.equal(est.calibrationBasis({ tokens: 60000, tasks: 3, confidence: 'low' }), 60000,
      'a pre-#2632 plan with no raw_tokens must still contribute a sample');
  });

  test('estimate-calibrate uses raw_tokens from the plan when present', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // tokens=100000 (calibrated) but raw_tokens=50000; actual=100000.
    // Ratio must be 100000/50000 = 2, NOT 100000/100000 = 1.
    for (const phase of ['01-a', '02-b', '03-c']) {
      const dir = path.join(tmpDir, '.planning', 'phases', phase);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'),
        `---\nphase: ${phase}\nestimate:\n  tokens: 100000\n  raw_tokens: 50000\n  tasks: 3\n  confidence: med\nmust_haves:\n---\nx\n`);
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'),
        `---\nphase: ${phase}\nactuals:\n  tokens: 100000\n  tasks: 3\n  commits: 5\n---\nx\n`);
    }

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 3);
    assert.equal(out.factor, 2,
      'ratio must be actual/raw (2.0), not actual/calibrated (1.0)');
  });
});

// ─── multi-plan pairing (#2632 review BLOCKER) ─────────────────────────────

describe('multi-plan phases pair per plan, not per phase', () => {
  // A phase routinely holds several plans (`<NN>-<PP>-PLAN.md`, one per plan —
  // docs/reference/planning-artifacts.md). An earlier implementation took the
  // first PLAN carrying an estimate and the first SUMMARY carrying actuals
  // INDEPENDENTLY, which cross-paired one plan's projection with another plan's
  // cost and discarded every later plan. The whole suite passed because its
  // helper only ever wrote `01-PLAN.md`.

  /** Write one plan/summary pair inside a phase, using the real `<NN>-<PP>` naming. */
  const writePlan = (tmpDir, phase, pp, { estTokens, actTokens }) => {
    const dir = path.join(tmpDir, '.planning', 'phases', phase);
    fs.mkdirSync(dir, { recursive: true });
    const nn = phase.slice(0, 2);
    if (estTokens !== null) {
      fs.writeFileSync(path.join(dir, `${nn}-${pp}-PLAN.md`),
        `---\nphase: ${phase}\nplan: ${pp}\nestimate:\n  tokens: ${estTokens}\n`
        + `  raw_tokens: ${estTokens}\n  tasks: 3\n  confidence: low\nmust_haves:\n---\nx\n`);
    } else {
      fs.writeFileSync(path.join(dir, `${nn}-${pp}-PLAN.md`), `---\nphase: ${phase}\nplan: ${pp}\n---\nx\n`);
    }
    fs.writeFileSync(path.join(dir, `${nn}-${pp}-SUMMARY.md`),
      `---\nphase: ${phase}\nplan: ${pp}\nactuals:\n  tokens: ${actTokens}\n  tasks: 3\n  commits: 4\n---\nx\n`);
  };

  test('never cross-pairs one plan\'s estimate with another plan\'s actuals', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Plan 01 has NO estimate but cheap actuals; plan 02 has both (true 2.5x).
    writePlan(tmpDir, '04-multi', '01', { estTokens: null, actTokens: 30000 });
    writePlan(tmpDir, '04-multi', '02', { estTokens: 80000, actTokens: 200000 });

    runGsdTools('query estimate-calibrate', tmpDir);
    const doc = est.parseCalibrationDocument(
      fs.readFileSync(path.join(tmpDir, '.planning', 'estimation-calibration.json'), 'utf8'),
    );

    assert.deepEqual(doc, [{ estimateTokens: 80000, actualTokens: 200000 }],
      'plan 02\'s estimate must pair with plan 02\'s actuals — cross-pairing fabricates a sample '
      + 'and throws away the real signal');
  });

  test('counts every correctly-paired plan in a multi-plan phase', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Three plans in ONE phase, each cleanly 2x.
    writePlan(tmpDir, '05-wave', '01', { estTokens: 40000, actTokens: 80000 });
    writePlan(tmpDir, '05-wave', '02', { estTokens: 50000, actTokens: 100000 });
    writePlan(tmpDir, '05-wave', '03', { estTokens: 60000, actTokens: 120000 });

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 3, 'all three plans must contribute — not just the first');
    assert.equal(out.factor, 2);
    assert.equal(out.applied, true, 'three samples in one phase must reach the minimum');
  });

  test('a plan with no matching summary contributes nothing', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const dir = path.join(tmpDir, '.planning', 'phases', '06-partial');
    fs.mkdirSync(dir, { recursive: true });
    // 06-01 pairs; 06-02 is a plan with no summary (mid-execution).
    fs.writeFileSync(path.join(dir, '06-01-PLAN.md'),
      '---\nphase: 06-partial\nestimate:\n  tokens: 100\n  raw_tokens: 100\n  tasks: 1\n  confidence: low\nmust_haves:\n---\nx\n');
    fs.writeFileSync(path.join(dir, '06-01-SUMMARY.md'),
      '---\nphase: 06-partial\nactuals:\n  tokens: 200\n  tasks: 1\n  commits: 1\n---\nx\n');
    fs.writeFileSync(path.join(dir, '06-02-PLAN.md'),
      '---\nphase: 06-partial\nestimate:\n  tokens: 999999\n  raw_tokens: 999999\n  tasks: 1\n  confidence: low\nmust_haves:\n---\nx\n');

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 1, 'an in-flight plan must not contribute a half-sample');
  });

  test('samples accumulate across BOTH plans and phases', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    writePlan(tmpDir, '01-a', '01', { estTokens: 100, actTokens: 200 });
    writePlan(tmpDir, '01-a', '02', { estTokens: 100, actTokens: 200 });
    writePlan(tmpDir, '02-b', '01', { estTokens: 100, actTokens: 200 });

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.sample_count, 3, 'two plans in phase 1 plus one in phase 2');
    assert.equal(out.applied, true);
  });
});

// ─── sentinel phases must not skew calibration (#3882, ADR-3473 §8.2) ──────
//
// collectCalibrationSamples enumerates .planning/phases with a raw readdirSync
// and treats every directory as a completed phase — it never routes through
// the phase-directory owner and never applies isSentinelPhaseId, so a sentinel
// directory (milestone 0 or 999 — SENTINEL_RANGES in src/phase-id.cts) whose
// PLAN/SUMMARY pair carries an estimate/actuals block contributes a phantom
// calibration sample.
//
// Governing constraint (.gsd/phase/feat-3882-enumerations/50-test-matrix.md
// row A1): computeCalibration is MEDIAN-based, so a single outlier sample does
// not move a 3-sample factor at all — asserting "the factor is unchanged" against
// exactly one sentinel would pass on the broken code for the wrong reason. The
// real, measured damage is the MIN_CALIBRATION_SAMPLES threshold crossing
// (applied flips false -> true, confidence low -> med on phantom evidence) and,
// once two sentinels are present, actual factor corruption. Every assertion
// below compares the WHOLE computed CalibrationResult object between a
// sentinel-free project and its sentinel-injected twin, reached the same way
// production reaches it (collectCalibrationSamples -> computeCalibration, the
// exact pair cmdEstimateCalibrate calls).
describe('sentinel phases must not skew calibration (#3882)', () => {
  // Two genuine phases with DIFFERING ratios (1x and 2x), so A3 can pin each
  // one's own unchanged value rather than two indistinguishable duplicates.
  const REAL_PHASES = [
    ['01-alpha', 1000, 1000],
    ['02-beta', 2000, 4000],
  ];
  // A deliberately extreme, fabricated ratio (50x) — the shape of what a
  // sentinel's PLAN/SUMMARY pair would carry.
  const SENTINEL_SAMPLE = { estTokens: 1000, actTokens: 50000 };

  function buildRealOnlyProject() {
    const tmpDir = createTempProject();
    for (const [dir, estTokens, actTokens] of REAL_PHASES) {
      writePhase(tmpDir, dir, { estTokens, actTokens });
    }
    return tmpDir;
  }

  /** Reached the way production reaches it — see cmdEstimateCalibrate above. */
  function calibrationResultFor(tmpDir) {
    return est.computeCalibration(estimateCli.collectCalibrationSamples(tmpDir));
  }

  test('A1a: sentinelPhaseDoesNotActivateCalibration', (t) => {
    const realOnly = buildRealOnlyProject();
    t.after(() => cleanup(realOnly));
    const withSentinel = buildRealOnlyProject();
    t.after(() => cleanup(withSentinel));
    // milestone 999 — reserved icebox sentinel range (SENTINEL_RANGES).
    writePhase(withSentinel, '999-icebox', SENTINEL_SAMPLE);

    const realOnlyResult = calibrationResultFor(realOnly);
    const withSentinelResult = calibrationResultFor(withSentinel);

    assert.deepEqual(
      withSentinelResult, realOnlyResult,
      'a single sentinel phase must not change the computed calibration at all — '
      + `real-only=${JSON.stringify(realOnlyResult)} with-sentinel=${JSON.stringify(withSentinelResult)}`,
    );
  });

  test('A1b: sentinelPhasesDoNotCorruptTheFactor', (t) => {
    const realOnly = buildRealOnlyProject();
    t.after(() => cleanup(realOnly));
    const withTwoSentinels = buildRealOnlyProject();
    t.after(() => cleanup(withTwoSentinels));
    // milestone 999 and milestone 0 — both reserved sentinel ranges.
    writePhase(withTwoSentinels, '999-icebox', SENTINEL_SAMPLE);
    writePhase(withTwoSentinels, '0-backlog', SENTINEL_SAMPLE);

    const realOnlyResult = calibrationResultFor(realOnly);
    const withSentinelsResult = calibrationResultFor(withTwoSentinels);

    assert.deepEqual(
      withSentinelsResult, realOnlyResult,
      'sentinel phases must not corrupt the calibration factor — '
      + `real-only=${JSON.stringify(realOnlyResult)} with-sentinels=${JSON.stringify(withSentinelsResult)}`,
    );
  });

  test('A2: sentinelPhaseContributesNoCalibrationSample', (t) => {
    const withTwoSentinels = buildRealOnlyProject();
    t.after(() => cleanup(withTwoSentinels));
    writePhase(withTwoSentinels, '999-icebox', SENTINEL_SAMPLE);
    writePhase(withTwoSentinels, '0-backlog', SENTINEL_SAMPLE);

    const samples = estimateCli.collectCalibrationSamples(withTwoSentinels);
    const sentinelHits = samples.filter(
      (s) => s.estimateTokens === SENTINEL_SAMPLE.estTokens && s.actualTokens === SENTINEL_SAMPLE.actTokens,
    );
    assert.equal(
      sentinelHits.length, 0,
      `the sentinel phases' sample must be absent from the returned list; got ${JSON.stringify(samples)}`,
    );
  });

  test('A3: realPhasesStillContribute', (t) => {
    const withTwoSentinels = buildRealOnlyProject();
    t.after(() => cleanup(withTwoSentinels));
    writePhase(withTwoSentinels, '999-icebox', SENTINEL_SAMPLE);
    writePhase(withTwoSentinels, '0-backlog', SENTINEL_SAMPLE);

    const samples = estimateCli.collectCalibrationSamples(withTwoSentinels);
    const realSamples = samples.filter(
      (s) => !(s.estimateTokens === SENTINEL_SAMPLE.estTokens && s.actualTokens === SENTINEL_SAMPLE.actTokens),
    );
    assert.deepEqual(
      realSamples.sort((a, b) => a.estimateTokens - b.estimateTokens),
      [
        { estimateTokens: 1000, actualTokens: 1000 },
        { estimateTokens: 2000, actualTokens: 4000 },
      ],
      'the two genuine phases must still contribute their own, unchanged samples',
    );
  });

  // A1a-A3 above only assert against the `collectCalibrationSamples` helper's
  // return value. Per ADR-3180 Decision 4(b) / epic #3473 B7, a behavioral
  // identity test must assert at the CONSUMER's output — the real `query
  // estimate-calibrate` CLI JSON and the persisted calibration document it
  // writes, not the internal sample array. #3372 named this exact surface
  // (`src/estimate-cli.cts`) as one of four candidate sentinel-enumeration
  // gaps; #3882 confirmed and fixed it. This closes the CLI-level gap.
  test('CLI (#3372, #3882): query estimate-calibrate excludes sentinel phase directories from the emitted sample_count and the persisted document', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    writePhase(tmpDir, '01-alpha', { estTokens: 1000, actTokens: 1000 });
    writePhase(tmpDir, '02-beta', { estTokens: 2000, actTokens: 4000 });
    // milestone 999 — reserved icebox sentinel range (SENTINEL_RANGES).
    writePhase(tmpDir, '999-icebox', { estTokens: 1000, actTokens: 50000 });

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, `estimate-calibrate should succeed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.equal(
      out.sample_count, 2,
      `the sentinel phase directory must not be counted in the CLI's emitted sample_count; got ${JSON.stringify(out)}`,
    );

    const docPath = path.join(tmpDir, '.planning', 'estimation-calibration.json');
    const persisted = est.parseCalibrationDocument(fs.readFileSync(docPath, 'utf8'));
    assert.equal(
      persisted.length, 2,
      `the persisted calibration document must not carry the sentinel phase's sample; got ${JSON.stringify(persisted)}`,
    );
  });
});

// ─── PhasesUnreadableError / estimate_phases_unreadable (#3882, ADR-3473 §8.5,
// review finding #2) ─────────────────────────────────────────────────────
//
// `collectCalibrationSamples` now routes through `listMilestonePhaseDirs`
// (the #3882 fix above), which means an unreadable phases directory is no
// longer output-identical to a genuinely empty one — it surfaces as
// `scope: SCOPE.UNREADABLE`. `cmdEstimateCalibrate` converts that into a
// refusal (`PhasesUnreadableError`, `process.exit(1)`,
// `ERROR_REASON.ESTIMATE_PHASES_UNREADABLE`) instead of silently persisting
// a phantom empty calibration document — a real behavior change (previously
// silent-empty), disclosed and tested here rather than left as an
// undocumented side effect of the routing fix.
//
// H1 drives the real `cmdEstimateCalibrate` IN-PROCESS: `runGsdTools` spawns
// a real subprocess, and neither `fs.readdirSync` monkeypatching nor
// `process.exit` interception crosses that process boundary. The pattern
// below is the two established repo idioms composed, not invented: the
// process.exit-interception + `--json-errors`-mode capture from
// tests/config-get-default.test.cjs, and the `fs.readdirSync` method
// monkeypatch (never chmod, which root/CI bypasses — CLAUDE.md's
// cross-platform IO-failure-injection rule) already used in
// tests/phase-locator.test.cjs for `listAllPhaseDirs`'s own unreadable case.
describe('unreadable phases directory refuses calibration (#3882, ADR-3473 §8.5)', () => {
  /** Runs cmdEstimateCalibrate in-process, catching the ExitError error()
   * throws (ADR-3889 — error() no longer calls process.exit() directly) with
   * stderr(fd 2) captured. */
  function runCalibrateExpectError(tmpDir) {
    io.setJsonErrorMode(true);
    let exitCode;
    let stderr;
    try {
      stderr = captureFdSync(2, () => {
        try {
          estimateCli.cmdEstimateCalibrate(tmpDir, [], false);
          assert.fail('expected cmdEstimateCalibrate to throw ExitError');
        } catch (e) {
          if (!(e instanceof ExitError)) throw e;
          exitCode = e.code;
        }
      });
    } finally {
      io.setJsonErrorMode(false);
    }
    const lines = stderr.split('\n').filter(Boolean);
    const lastError = () => {
      try { return JSON.parse(lines[lines.length - 1]); } catch { return {}; }
    };
    assert.ok(exitCode !== 0 && exitCode !== undefined, 'expected a non-zero exit code');
    assert.equal(lines.length, 1, 'error() must emit exactly one stderr line');
    return { status: exitCode, ...lastError() };
  }

  test('H1: unreadable phases directory exits non-zero with estimate_phases_unreadable', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (...args) => {
      if (args[0] === phasesDir) {
        const err = new Error('EACCES: permission denied, scandir');
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.apply(fs, args);
    };
    let result;
    try {
      result = runCalibrateExpectError(tmpDir);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(result.status, 1);
    assert.equal(result.reason, io.ERROR_REASON.ESTIMATE_PHASES_UNREADABLE);
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'estimation-calibration.json')),
      'refusing the rebuild must not persist a phantom empty calibration document',
    );
  });

  test('H2: a genuinely-empty phases directory still succeeds with empty calibration (boundary the H1 guard must not cross)', (t) => {
    // Real CLI as a subprocess (runGsdTools) — this is the boundary case:
    // .planning/phases/ EXISTS and is READABLE, but has zero entries. Must
    // succeed, not be caught by the unreadable-directory refusal above.
    // Overlaps the pre-existing "no phases at all is a clean no-op" test
    // above; kept as its own named row because it pins THIS boundary
    // specifically (see 50-test-matrix.md row H2), not incidentally.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, `a readable, genuinely-empty phases dir must succeed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.equal(out.sample_count, 0);
    assert.equal(out.applied, false);
  });

  test('H3: a normal project with real phases is unaffected by the unreadable-dir guard', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writePhase(tmpDir, '01-a', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '02-b', { estTokens: 100, actTokens: 200 });
    writePhase(tmpDir, '03-c', { estTokens: 100, actTokens: 200 });

    const r = runGsdTools('query estimate-calibrate', tmpDir);
    assert.ok(r.success, `a normal readable project must not be affected by the guard: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.equal(out.sample_count, 3);
    assert.equal(out.applied, true);
  });
});
