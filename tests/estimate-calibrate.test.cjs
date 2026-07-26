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

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const est = require('../gsd-core/bin/lib/phase-estimation.cjs');

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
