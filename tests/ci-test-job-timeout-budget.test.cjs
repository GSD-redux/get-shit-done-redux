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
const { COVERED } = require('../scripts/mutation-matrix.cjs');

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
    // #4070: the `run 30677442953 — 7m12s` figure this entry carried before
    // was stale — it predated the aux-suite growth this entry now tracks, and
    // being stale meant this gate never caught the drift it exists to catch.
    // Real measured cost from issue #4070's cited evidence (independently
    // re-verified against the workflow's current step order): shard 1/3 hit
    // 13m48s on run 33278340189 (successful) and was CANCELLED at ~14m51s (99%
    // of the 15-minute cap) on run 33285384930. 14 minutes is the honest
    // figure — rounded up from the higher, cancelled-run observation, since a
    // cancelled run's own timestamp is still real elapsed time even though the
    // job never finished.
    // #4070's method applied again: the 14-minute figure went stale after
    // #4207's run-tests temp-root regression suite landed — its rows spawn
    // real runner instances on the windows scoped lane (each booting the full
    // build), and windows shards 1-2 were CANCELLED at 99% of the 21-minute
    // cap on three consecutive runs (33722188315 and two reruns; ubuntu and
    // macos lanes green throughout, other PRs' windows lanes green — the
    // long pole is this lane's windows matrix alone). A cancelled run's own
    // timestamp is still real elapsed time: >=21 minutes, so 21 is the
    // honest floor and the budget moves 21 -> 32 (1.5x headroom).
    measuredMinutes: 21,
    // Sharded three ways as of #2952, so this is ONE shard's cost, not the
    // whole unit suite. Shard 1 is the long pole because the unsharded aux
    // suites (integration/security/install/slow) ride on it — #4070 fixed the
    // LPT unit-test packer to reserve shard 1's aux-suite cost
    // (RUN_TESTS_SHARD_RESERVE, see .github/workflows/test.yml and
    // tests/ci-full-lane-sharding.test.cjs) so shard 1 gets a smaller
    // unit-test share than shards 2/3. Before sharding the same lane cost
    // 15m20s and blew a 15-minute cap (#2952).
    //
    // This one `timeout-minutes` also covers the `scope: windows` matrix
    // entries — GitHub applies a single job-level budget across every matrix
    // combination, not one per entry. That lane is now sharded three ways too
    // (#3057), but no post-sharding per-shard measurement exists yet: its only
    // recorded cost is the PRE-sharding whole-suite run that hit 15m05s and was
    // CANCELLED on PR #3094. Each of its three shards should now cost roughly a
    // third of that (~5m), comfortably under what this entry requires — so no
    // separate LANE_COSTS entry is added on a number that has not actually
    // been measured. Replace this estimate with a real measured shard cost
    // once one exists, the same discipline every other entry here follows.
    evidence: 'run 33278340189 — 13m48s completed; run 33285384930 — CANCELLED at ~14m51s (#4070)',
  },
  {
    job: 'test-full',
    measuredMinutes: 27,
    // Lane moved from windows-22 to windows-latest/24 and is now sharded three
    // ways. Worst observed shard is `full test (windows-latest, 24, shard
    // 3/3)`: 26m18s on run 32614439702 (shard 2/3 23m36s, shard 1/3 19m22s),
    // and 23m17s for shard 2/3 on run 32603886007. The previous 18m59s /
    // windows-22 figure recorded here predated this cost and is stale — the
    // lane is measurably slower now, not merely relabeled.
    evidence: 'run 32614439702 — 26m18s, windows-latest/24 shard 3/3',
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
  {
    job: 'smoke',
    workflowFile: 'install-smoke.yml',
    measuredMinutes: 2,
    // Worst observed wall-clock across the two most recent PUSH-triggered
    // (full-matrix, macos-latest included) runs: 65s on macos-latest, run
    // 32260569855 (2026-08-19). A second push run (31240989202, 2026-08-08)
    // measured 43-56s across its three jobs, all under this figure. PR-context
    // runs are faster (~50-62s, ubuntu only, macOS full_only row skipped) and
    // are not the binding case. Rounded up to whole minutes per this file's
    // convention.
    evidence: 'run 32260569855 — 65s, macos-latest push (full matrix)',
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
  for (const lane of LANE_COSTS) {
    await t.test(`${lane.job} is budgeted above its measured cost`, () => {
      const workflowFile = lane.workflowFile || 'test.yml';
      const workflow = loadWorkflow(workflowFile);

      assert.ok(
        workflow.jobs && Object.prototype.hasOwnProperty.call(workflow.jobs, lane.job),
        `.github/workflows/${workflowFile} declares no job \`${lane.job}\`. If it was `
        + 'renamed or removed, update LANE_COSTS in this file to match — do not '
        + 'delete the entry to make this pass.',
      );

      const budget = workflow.jobs[lane.job]['timeout-minutes'];
      const required = requiredBudgetMinutes(lane.measuredMinutes);

      assert.equal(
        typeof budget, 'number',
        `.github/workflows/${workflowFile} jobs.${lane.job} must declare timeout-minutes`,
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

test('mutation.yml mutate job timeout budgets (#4036)', async (t) => {
  await t.test('mutate job timeout-minutes is matrix-driven, not a fixed literal', () => {
    const workflow = loadWorkflow('mutation.yml');
    assert.equal(
      workflow.jobs.mutate['timeout-minutes'],
      '${{ matrix.timeoutMinutes }}',
      'mutation.yml jobs.mutate.timeout-minutes must stay matrix-driven so each covered '
      + 'module can declare its own per-shard budget via scripts/mutation-matrix.cjs — a '
      + 'fixed literal here would either under-budget a slow module or over-budget every '
      + 'fast one.',
    );
  });

  await t.test('every covered module declares a sane per-shard timeout', () => {
    for (const [name, mod] of Object.entries(COVERED)) {
      const timeoutMinutes = mod.timeoutMinutes || 15;
      assert.ok(
        Number.isInteger(timeoutMinutes) && timeoutMinutes >= 15,
        `COVERED.${name}.timeoutMinutes resolves to ${timeoutMinutes}, but must be an `
        + 'integer >= 15 (the shared default) — a module\'s override must never budget '
        + 'BELOW the shared floor every other module gets for free.',
      );
    }
  });

  await t.test('frontmatter mutate shard is budgeted above its measured cost', () => {
    // Measured: CI run 33026833181 — 713s (11m53s) under the tap runner
    // (coverageAnalysis: 'perTest'). See scripts/mutation-matrix.cjs's own
    // comment on the `frontmatter` COVERED entry for the full citation.
    const measuredMinutes = 12; // 713s rounded up
    const declared = COVERED.frontmatter.timeoutMinutes || 15;
    const required = requiredBudgetMinutes(measuredMinutes);
    assert.ok(
      hasSufficientBudget(declared, measuredMinutes),
      `COVERED.frontmatter.timeoutMinutes is ${declared}, but the shard measured `
      + `${measuredMinutes}m (run 33026833181 — 713s) and needs at least ${required} — `
      + `${HEADROOM_FACTOR}x — so this module cannot quietly regress toward its cap.`,
    );
  });
});

test('near-cap check CI_JOB_TIMEOUT_MINUTES literals match each job\'s own timeout-minutes (#4036)', async (t) => {
  const staticLanes = [
    { workflowFile: 'test.yml', jobKey: 'test', envLiteral: '32' },
    { workflowFile: 'test.yml', jobKey: 'test-full', envLiteral: '45' },
    { workflowFile: 'install-smoke.yml', jobKey: 'smoke', envLiteral: '12' },
  ];

  for (const lane of staticLanes) {
    await t.test(`${lane.workflowFile} jobs.${lane.jobKey}: CI_JOB_TIMEOUT_MINUTES matches timeout-minutes`, () => {
      const workflow = loadWorkflow(lane.workflowFile);
      const declared = workflow.jobs[lane.jobKey]['timeout-minutes'];
      assert.equal(
        String(declared), lane.envLiteral,
        `.github/workflows/${lane.workflowFile} jobs.${lane.jobKey}.timeout-minutes is ${declared}, `
        + `but the near-cap check step's CI_JOB_TIMEOUT_MINUTES literal is hardcoded to '${lane.envLiteral}' `
        + '— these two must be updated together (GH Actions has no expression to read a sibling job-level '
        + 'key from within a step\'s env, so this parity test is the drift guard instead). Update BOTH the '
        + 'literal in this test AND the CI_JOB_TIMEOUT_MINUTES env value in the workflow step when the cap changes.',
      );
    });
  }

  await t.test('ci-timeout-report.cjs JOB_RULES prefixes still match each job\'s declared name: template', () => {
    const { JOB_RULES } = require('../scripts/ci-timeout-report.cjs');
    const testWorkflow = loadWorkflow('test.yml');

    const testRule = JOB_RULES.find((r) => r.workflowFile === 'test.yml' && r.jobKey === 'test');
    assert.ok(testWorkflow.jobs.test.name.startsWith('test ('),
      'test.yml jobs.test.name no longer starts with "test (" — update JOB_RULES in scripts/ci-timeout-report.cjs to match');
    assert.equal(testRule.test('test (ubuntu-latest, 24, shard 1/3)'), true);

    const testFullRule = JOB_RULES.find((r) => r.workflowFile === 'test.yml' && r.jobKey === 'test-full');
    assert.ok(testWorkflow.jobs['test-full'].name.startsWith('full test ('),
      'test.yml jobs.test-full.name no longer starts with "full test (" — update JOB_RULES to match');
    assert.equal(testFullRule.test('full test (windows-latest, 24, shard 1/3)'), true);

    const testInertRule = JOB_RULES.find((r) => r.workflowFile === 'test.yml' && r.jobKey === 'test-inert');
    assert.equal(testWorkflow.jobs['test-inert'].name, 'test (inert CI)',
      'test.yml jobs.test-inert.name changed — update JOB_RULES to match');
    assert.equal(testInertRule.test('test (inert CI)'), true);

    const coverageGateRule = JOB_RULES.find((r) => r.workflowFile === 'test.yml' && r.jobKey === 'coverage-gate');
    assert.equal(testWorkflow.jobs['coverage-gate'].name, 'Coverage gate (merged shards)',
      'test.yml jobs.coverage-gate.name changed — update JOB_RULES to match');
    assert.equal(coverageGateRule.test('Coverage gate (merged shards)'), true);
  });
});
