/**
 * Closed-loop convergence for phase-effort estimation.
 *
 * Epic #1952. Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Estimation is a feedback control loop: the correction derived from past
 * phases feeds back into the next estimate. Two real defects shipped past a
 * green suite of ~26,800 step-wise tests during this epic, because BOTH are
 * properties of the loop over time rather than of any single call:
 *
 *   1. Calibration applied twice (#2631 review). The planner emitted an
 *      already-calibrated figure and `estimate-check` re-applied the factor, so
 *      the effective correction was factor². Every unit test still passed —
 *      each function was individually correct; the COMPOSITION was not.
 *
 *   2. Non-convergence (#2632). Calibration measured actual/calibrated instead
 *      of actual/raw, so once the correction worked the observed ratio
 *      approached 1, dragging the median back down. Simulated over 10 phases
 *      the factor oscillated and settled near 1.41 instead of 2.0. Every
 *      boundary fixture, property test and round-trip still passed.
 *
 * Neither is visible to a test that asserts "given X, return Y". Both are
 * visible here, because this drives the REAL verbs through many iterations and
 * asserts on the TRAJECTORY of the user-visible number.
 *
 * The rule this encodes (CONTEXT.md RULESET.TESTS.feedback-loop-convergence):
 * when a feature's output feeds back into its own input, a step-wise test is
 * not sufficient evidence of correctness. Simulate the loop and assert it
 * converges, stays bounded, and lands on the truth.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const RAW_PROJECTION = 50000;   // what the planner would say with no history
const TRUE_COST = 100000;       // reality: consistently 2x the raw projection
const TRUE_RATIO = TRUE_COST / RAW_PROJECTION;

/** Drive one full plan→execute→calibrate cycle and return what the user sees. */
function runPhase(tmpDir, phaseIndex) {
  const factorRaw = runGsdTools('query estimate-calibration --pick factor --raw', tmpDir).output;
  const factor = Number(String(factorRaw).trim()) || 1;

  // The planner emits tokens = raw x factor, and records the raw projection.
  const emitted = Math.max(1, Math.round(RAW_PROJECTION * factor));

  const dir = path.join(tmpDir, '.planning', 'phases', `${String(phaseIndex).padStart(2, '0')}-p`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01-PLAN.md'),
    `---\nphase: p\nestimate:\n  tokens: ${emitted}\n  raw_tokens: ${RAW_PROJECTION}\n`
    + `  tasks: 3\n  confidence: low\nmust_haves:\n---\nx\n`);
  fs.writeFileSync(path.join(dir, '01-SUMMARY.md'),
    `---\nphase: p\nactuals:\n  tokens: ${TRUE_COST}\n  tasks: 3\n  commits: 5\n---\nx\n`);

  runGsdTools('query estimate-calibrate', tmpDir);

  // What the checker actually compares against the budget for this plan.
  const check = JSON.parse(
    runGsdTools(`query estimate-check --tokens ${emitted} --calibrated`, tmpDir).output,
  );
  return { factor, emitted, userSees: check.calibrated_tokens };
}

describe('estimation feedback loop', () => {
  test('converges on the true cost and stays there', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const history = [];
    for (let i = 1; i <= 8; i += 1) history.push(runPhase(tmpDir, i));

    // Early phases have no history, so no correction is applied yet.
    assert.equal(history[0].factor, 1, 'phase 1 has no history');
    assert.equal(history[0].emitted, RAW_PROJECTION);

    // Once enough samples exist the correction must reach the TRUE ratio…
    const settled = history.slice(4);
    for (const step of settled) {
      assert.ok(Math.abs(step.factor - TRUE_RATIO) < 1e-9,
        `factor drifted to ${step.factor}; expected ${TRUE_RATIO}. `
        + 'A factor that wanders means calibration is measuring against its own output.');
      assert.equal(step.emitted, TRUE_COST,
        `emitted estimate ${step.emitted} should equal the true cost ${TRUE_COST}`);
    }

    // …and the number the USER is shown must equal the emitted estimate.
    // If anything re-applies the factor downstream this reads 2x and fails.
    for (const step of settled) {
      assert.equal(step.userSees, step.emitted,
        `the checker compared ${step.userSees} against the budget but the plan says ${step.emitted} — `
        + 'a downstream surface is applying the correction a second time (factor²).');
    }
  });

  test('stays bounded under a wildly inconsistent history', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Alternating 10x over and 10x under: the clamp must hold and the loop
    // must not run away in either direction.
    const costs = [500000, 5000, 500000, 5000, 500000, 5000];
    costs.forEach((cost, i) => {
      const dir = path.join(tmpDir, '.planning', 'phases', `${String(i + 1).padStart(2, '0')}-p`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'),
        `---\nphase: p\nestimate:\n  tokens: 50000\n  raw_tokens: 50000\n  tasks: 3\n  confidence: low\nmust_haves:\n---\nx\n`);
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'),
        `---\nphase: p\nactuals:\n  tokens: ${cost}\n  tasks: 3\n  commits: 5\n---\nx\n`);
    });

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.ok(out.factor >= 0.5 && out.factor <= 3.0,
      `factor ${out.factor} escaped the clamp under an adversarial history`);

    const check = JSON.parse(runGsdTools('query estimate-check --tokens 50000', tmpDir).output);
    assert.ok(check.calibrated_tokens >= 25000 && check.calibrated_tokens <= 150000,
      `a corrected estimate of ${check.calibrated_tokens} is outside the clamp's reachable range`);
  });

  test('an all-accurate history leaves estimates unchanged (fixed point)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // A project whose estimates are already right must not be "corrected".
    for (let i = 1; i <= 5; i += 1) {
      const dir = path.join(tmpDir, '.planning', 'phases', `${String(i).padStart(2, '0')}-p`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'),
        `---\nphase: p\nestimate:\n  tokens: 60000\n  raw_tokens: 60000\n  tasks: 3\n  confidence: low\nmust_haves:\n---\nx\n`);
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'),
        `---\nphase: p\nactuals:\n  tokens: 60000\n  tasks: 3\n  commits: 5\n---\nx\n`);
    }

    const out = JSON.parse(runGsdTools('query estimate-calibrate', tmpDir).output);
    assert.equal(out.factor, 1, 'an accurate project must be a fixed point — no correction applied');

    const check = JSON.parse(runGsdTools('query estimate-check --tokens 60000', tmpDir).output);
    assert.equal(check.calibrated_tokens, 60000, 'an accurate estimate must pass through unchanged');
  });
});
