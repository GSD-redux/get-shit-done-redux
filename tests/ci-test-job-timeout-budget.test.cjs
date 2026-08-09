'use strict';

/**
 * CI job timeout budgets — .github/workflows/test.yml (#2952).
 *
 * A GitHub Actions job that exceeds its `timeout-minutes` is reported
 * `cancelled`, not `failed`. That conclusion propagates into `Required tests`
 * and reddens the branch, while reading like someone hit the cancel button —
 * which is what makes this failure mode expensive to diagnose and worth a gate.
 *
 * It has now happened three times in this repo: #1051 and #1212 on the Windows
 * full-test lane, and #2952 on the unsharded `test` lane, whose
 * `ubuntu-latest / 24` entry is the only `scope: full` matrix entry — it runs
 * the whole unit suite under c8 coverage, then the scripts/ coverage floor,
 * integration, security, install and slow, serially on one runner. Every one of
 * those was the same root cause: a budget sized to what the lane cost that
 * week, with no headroom for the suite to grow into.
 *
 * So the rule enforced here is not a fixed number per lane — it is a HEADROOM
 * FACTOR over each lane's measured cost. A lane may be slow; what it may not be
 * is budgeted to finish with seconds to spare.
 *
 * This is a budget assertion, not a duration assertion. No unit test can prove
 * a lane still FITS its budget — only a real CI run measures that. What this
 * file guarantees is that a budget cannot be quietly lowered back beneath what
 * its lane is already known to need.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

/**
 * Multiplier applied to a lane's measured cost to get its required budget.
 * 1.5x is enough slack for ordinary suite growth across a release cycle without
 * letting a genuinely runaway lane hide behind a large number.
 */
const HEADROOM_FACTOR = 1.5;

/**
 * Measured wall-clock cost per lane, in whole minutes rounded UP, each from a
 * named run. Raise an entry only alongside a fresh measurement — never to make
 * a red gate green. Raising a measurement raises the required budget with it,
 * which is the point: a lane that got slower must be re-budgeted, not excused.
 */
const LANE_COSTS = [
  {
    job: 'test',
    measuredMinutes: 8,
    // Sharded three ways as of #2952, so this is ONE shard's cost, not the
    // whole unit suite. Run 30677442953: shard 1/3 7m12s, 2/3 4m32s, 3/3 3m59s.
    // Shard 1 is the long pole because the unsharded aux suites ride on it.
    // Before sharding the same lane cost 15m20s and blew a 15-minute cap.
    //
    // This one `timeout-minutes` also covers the `scope: windows` matrix
    // entries — GitHub applies a single job-level budget across every matrix
    // combination, not one per entry. That lane is now sharded three ways too
    // (#3057), but no post-sharding per-shard measurement exists yet: its only
    // recorded cost is the PRE-sharding whole-suite run that hit 15m05s and was
    // CANCELLED on PR #3094. Each of its three shards should now cost roughly a
    // third of that (~5m), which is already comfortably under the 8m/12m this
    // entry requires — so no separate LANE_COSTS entry is added on a number
    // that has not actually been measured. Replace this estimate with a real
    // measured shard cost once one exists, the same discipline every other
    // entry here follows.
    evidence: 'run 30677442953 — 7m12s slowest shard',
  },
  {
    job: 'test-full',
    measuredMinutes: 19,
    // Worst observed shard is `full test (windows-latest, 22, shard 3/3)`:
    // 18m59s on 05b170e44 and 18m14s on 81eeb8a53. The Windows shards are slow
    // for platform reasons, not extra work.
    evidence: 'run 30650559192 — 18m59s, windows-22 shard 3/3',
  },
  {
    job: 'coverage-gate',
    measuredMinutes: 2,
    // Downloads three shards' raw V8 dumps, renders one merged report and runs
    // both thresholds. Run 30677442953: 1m20s end to end, most of it npm ci.
    evidence: 'run 30677442953 — 1m20s',
  },
  {
    job: 'test-inert',
    measuredMinutes: 2,
    // Runs only the targeted-test step when no product code changed; observed
    // around a minute. Listed so its budget cannot be dropped to nothing.
    evidence: 'targeted-only lane, ~1m observed',
  },
];

function requiredBudgetMinutes(measuredMinutes, headroomFactor = HEADROOM_FACTOR) {
  return Math.ceil(measuredMinutes * headroomFactor);
}

function hasSufficientBudget(budgetMinutes, measuredMinutes, headroomFactor = HEADROOM_FACTOR) {
  return Number.isInteger(budgetMinutes)
    && budgetMinutes >= requiredBudgetMinutes(measuredMinutes, headroomFactor);
}

test('CI job timeout budgets carry headroom over measured cost (#2952)', async (t) => {
  const workflow = loadWorkflow('test.yml');

  for (const lane of LANE_COSTS) {
    await t.test(`${lane.job} is budgeted above its measured cost`, () => {
      assert.ok(
        workflow.jobs && Object.prototype.hasOwnProperty.call(workflow.jobs, lane.job),
        `.github/workflows/test.yml declares no job \`${lane.job}\`. If it was `
        + 'renamed or removed, update LANE_COSTS in this file to match — do not '
        + 'delete the entry to make this pass.',
      );

      const budget = workflow.jobs[lane.job]['timeout-minutes'];
      const required = requiredBudgetMinutes(lane.measuredMinutes);

      assert.equal(
        typeof budget, 'number',
        `.github/workflows/test.yml jobs.${lane.job} must declare timeout-minutes`,
      );
      assert.ok(
        hasSufficientBudget(budget, lane.measuredMinutes),
        `jobs.${lane.job}.timeout-minutes is ${budget}, but the lane measured `
        + `${lane.measuredMinutes}m (${lane.evidence}) and needs at least `
        + `${required} — ${HEADROOM_FACTOR}x — so suite growth does not breach `
        + 'the cap. A job that exceeds timeout-minutes is reported `cancelled` '
        + 'and reddens `Required tests`.',
      );
    });
  }

  // Boundary coverage on the predicate that decides every lane above:
  // required-1 must be rejected, required and required+1 accepted.
  await t.test('budget sufficiency is exact at the boundary', () => {
    for (const lane of LANE_COSTS) {
      const required = requiredBudgetMinutes(lane.measuredMinutes);

      assert.equal(hasSufficientBudget(required - 1, lane.measuredMinutes), false,
        `${lane.job}: a budget one minute under the requirement must be rejected`);
      assert.equal(hasSufficientBudget(required, lane.measuredMinutes), true,
        `${lane.job}: a budget exactly at the requirement must be accepted`);
      assert.equal(hasSufficientBudget(required + 1, lane.measuredMinutes), true,
        `${lane.job}: a budget over the requirement must be accepted`);
    }
  });

  await t.test('a non-integer budget is not a sufficient budget', () => {
    // `timeout-minutes: 24.5` is not something GitHub accepts; treating it as
    // sufficient would let a malformed workflow through this gate.
    assert.equal(hasSufficientBudget(24.5, 16), false);
    assert.equal(hasSufficientBudget(Number.NaN, 16), false);
    assert.equal(hasSufficientBudget(undefined, 16), false);
  });

  await t.test('requiredBudgetMinutes rounds up rather than truncating', () => {
    // 15 * 1.5 = 22.5 — truncation would hand back 22 and under-budget the lane.
    assert.equal(requiredBudgetMinutes(15, 1.5), 23);
    assert.equal(requiredBudgetMinutes(16, 1.5), 24);
    assert.equal(requiredBudgetMinutes(19, 1.5), 29);
    assert.equal(requiredBudgetMinutes(10, 1.5), 15);
  });
});
