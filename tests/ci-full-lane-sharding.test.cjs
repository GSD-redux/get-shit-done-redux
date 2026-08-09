'use strict';

/**
 * The full test lane and the scoped Windows lane are both sharded, and the
 * coverage gate that sharding displaced is still wired in —
 * .github/workflows/test.yml (#2952, #3057).
 *
 * The `scope: full` lane was the only unsharded lane in this file. It ran the
 * entire unit suite under c8 on a single runner, grew past a 15-minute cap, and
 * reddened `next` (#2952). Raising the cap treated the symptom; sharding is the
 * shape fix, and it is the same answer #1212 reached for the Windows lane at
 * the time.
 *
 * The `scope: windows` lane then hit the identical cliff itself: it reached
 * exactly 15m05s and was CANCELLED on PR #3094, four shas in a row. Per #869's
 * stated durable follow-up, it is now sharded three ways too (#3057), leaving
 * `scope: targeted` as the only lane in this job with no shard.
 *
 * Sharding introduces two failure modes that stay GREEN while being wrong, so
 * both are pinned here:
 *
 *  1. An incomplete shard set. If the matrix declares shards 1/3 and 2/3 but
 *     never 3/3, a third of the unit suite simply stops running and every check
 *     still passes. The partition MATH is already covered — completeness,
 *     disjointness, balance and determinism are asserted against selectShard in
 *     run-tests-harness.test.cjs (#1212), including a fast-check property. What
 *     is NOT covered there, and is asserted here, is that the WORKFLOW asks for
 *     a complete set: same denominator everywhere, numerators exactly 1..N.
 *
 *  2. A dropped coverage gate. A sharded run leaves each runner with a partial
 *     picture — shard 2 never executes shard 1's files, so those read 0%. The
 *     ≥70% gate therefore cannot live on the shards; it moved to `coverage-gate`,
 *     which merges every shard's raw V8 dumps. If that job silently stopped
 *     being required, coverage enforcement would vanish without any red check.
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
 * Parse an `i/n` shard spec into { index, total }, or null if malformed.
 * Mirrors the grammar scripts/run-tests.cjs accepts for --shard.
 */
function parseShardSpec(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec));
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || index < 1 || index > total) return null;
  return { index, total };
}

/** True iff `specs` is exactly one complete shard set: same N, numerators 1..N. */
function isCompleteShardSet(specs) {
  if (specs.length === 0) return false;
  const parsed = specs.map(parseShardSpec);
  if (parsed.some((p) => p === null)) return false;
  const total = parsed[0].total;
  if (parsed.some((p) => p.total !== total)) return false;
  if (parsed.length !== total) return false;
  const seen = new Set(parsed.map((p) => p.index));
  return seen.size === total && [...seen].every((i) => i >= 1 && i <= total);
}

test('the full test lane is sharded and complete (#2952)', async (t) => {
  const workflow = loadWorkflow('test.yml');
  const include = workflow.jobs.test.strategy.matrix.include;
  const fullLanes = include.filter((e) => e.scope === 'full');
  const windowsLanes = include.filter((e) => e.scope === 'windows');
  // The only lane in this job with no shard is `scope: targeted` — the fast,
  // single-runner default lane. Both `full` and `windows` are sharded.
  const shardedScopes = { full: fullLanes, windows: windowsLanes };

  for (const [scope, lanes] of Object.entries(shardedScopes)) {
    await t.test(`the \`scope: ${scope}\` lane is actually sharded, not a single runner`, () => {
      assert.ok(lanes.length > 0, `expected at least one \`scope: ${scope}\` matrix entry`);
      assert.ok(
        lanes.length > 1,
        `the \`scope: ${scope}\` lane is back to a single unsharded entry. That is `
        + 'the #2952/#3057 regression: the whole suite on one runner grows past '
        + 'its cap and reddens `next`.',
      );
      for (const lane of lanes) {
        assert.ok(
          lane.shard !== undefined,
          `a \`scope: ${scope}\` matrix entry declares no shard: ${JSON.stringify(lane)}`,
        );
      }
    });

    await t.test(`the \`scope: ${scope}\` lane's declared shards form one complete set`, () => {
      const specs = lanes.map((e) => e.shard);
      assert.ok(
        isCompleteShardSet(specs),
        `the \`scope: ${scope}\` lane's shards ${JSON.stringify(specs)} are not a `
        + 'complete set. Every entry must share one denominator N and the '
        + 'numerators must be exactly 1..N — a missing numerator silently stops '
        + 'running that slice of the suite while every check stays green.',
      );
    });
  }

  await t.test('no other lane is sharded', () => {
    for (const lane of include.filter((e) => e.scope !== 'full' && e.scope !== 'windows')) {
      assert.equal(
        lane.shard, undefined,
        `lane ${JSON.stringify(lane)} declares a shard but is neither \`scope: full\` `
        + 'nor `scope: windows` — the targeted lane runs a selected file list, not '
        + 'a partition.',
      );
    }
  });

  await t.test('the scoped Windows shards are passed through to run-tests.cjs', () => {
    const scopedStep = workflow.jobs.test.steps.find(
      (s) => s.name === 'Run scoped tests',
    );
    assert.ok(scopedStep, 'no "Run scoped tests" step in the test job');
    assert.match(
      scopedStep.run, /matrix\.shard/,
      'the "Run scoped tests" step does not reference matrix.shard, so the '
      + 'windows lane\'s three shards would each run the entire selected file '
      + 'list — N times the cost, no speedup.',
    );
  });

  await t.test('each shard runs its own slice, not the whole suite', () => {
    const unitStep = workflow.jobs.test.steps.find(
      (s) => typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw'),
    );
    assert.ok(unitStep, 'no step in the test job runs the raw unit coverage script');
    assert.match(
      unitStep.run, /--shard \$\{\{ matrix\.shard \}\}/,
      'the unit step does not pass matrix.shard through to run-tests.cjs, so '
      + 'every shard would run the ENTIRE suite — N times the cost, no speedup.',
    );
  });

  await t.test('the aux suites are pinned to one shard that actually exists', () => {
    // Pinning to a LIVE shard is the whole assertion. A pin to a shard the
    // matrix no longer declares — say the count moves to 4 and these `if:`
    // conditions keep naming 1/3 — means the aux suites stop running entirely
    // while every check stays green. Checking only that some shard literal is
    // present would not catch that, so the literal is resolved against the
    // shards the matrix actually declares.
    const declared = fullLanes.map((e) => String(e.shard));
    const auxScripts = ['test:integration', 'test:security', 'test:install', 'test:slow'];
    const pins = new Set();

    for (const script of auxScripts) {
      const step = workflow.jobs.test.steps.find(
        (s) => typeof s.run === 'string' && s.run.includes(script),
      );
      assert.ok(step, `no step runs \`npm run ${script}\``);

      const pin = /matrix\.shard == '([^']+)'/.exec(String(step.if));
      assert.ok(
        pin,
        `the \`${script}\` step is not pinned to a single shard; it would run `
        + 'once per shard and multiply its cost for no extra signal.',
      );
      assert.ok(
        declared.includes(pin[1]),
        `the \`${script}\` step is pinned to shard '${pin[1]}', which the matrix `
        + `does not declare (${JSON.stringify(declared)}). That condition can `
        + 'never be true, so this suite would silently never run.',
      );
      pins.add(pin[1]);
    }

    assert.equal(
      pins.size, 1,
      `the aux suites are split across shards ${JSON.stringify([...pins])}; they `
      + 'are meant to run together on exactly one.',
    );
  });
});

test('the merged coverage gate survives sharding (#2952)', async (t) => {
  const workflow = loadWorkflow('test.yml');

  await t.test('a dedicated coverage-gate job exists and consumes the shards', () => {
    const gate = workflow.jobs['coverage-gate'];
    assert.ok(gate, '.github/workflows/test.yml declares no `coverage-gate` job');
    assert.ok(
      (gate.needs || []).includes('test'),
      'coverage-gate must depend on `test` — it merges that job\'s shard artifacts',
    );

    const merges = gate.steps.some(
      (s) => String(s.uses || '').includes('download-artifact')
        && s.with && s.with['merge-multiple'] === true,
    );
    assert.ok(
      merges,
      'coverage-gate does not download the shard artifacts with merge-multiple. '
      + 'Without every shard merged into one coverage/tmp, the gate scores a '
      + 'partial run: files no shard in hand executed read 0%.',
    );
  });

  await t.test('both coverage thresholds are still enforced', () => {
    const runs = workflow.jobs['coverage-gate'].steps
      .map((s) => s.run).filter((r) => typeof r === 'string').join('\n');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );

    assert.match(
      runs, /test:coverage:report/,
      'coverage-gate never runs the coverage report+gate script — the >=70% '
      + 'lines / >=60% branches gate on gsd-core/bin/lib would be gone',
    );
    assert.match(
      runs, /test:coverage:scripts-floor/,
      'coverage-gate never enforces the >=55% scripts/ floor',
    );

    // The workflow calls npm scripts precisely so the thresholds are defined
    // once. If a future edit inlines c8 into the YAML, the two surfaces can
    // drift silently — the gate would still be green while measuring something
    // other than what package.json says.
    assert.match(
      pkg.scripts['test:coverage:report'], /check-coverage-gate\.cjs/,
      'test:coverage:report no longer runs check-coverage-gate.cjs',
    );
    assert.match(
      pkg.scripts['test:coverage:scripts-floor'], /--lines 55/,
      'test:coverage:scripts-floor no longer enforces 55%',
    );
    assert.match(
      pkg.scripts['test:coverage:unit:raw'], /--suite unit/,
      'test:coverage:unit:raw no longer runs the unit suite',
    );
    assert.doesNotMatch(
      pkg.scripts['test:coverage:unit:raw'], /--shard/,
      'the shard must come from the workflow matrix, not be baked into the script',
    );
  });

  await t.test('required-tests fails when the coverage gate fails', () => {
    const required = workflow.jobs['required-tests'];
    assert.ok(
      (required.needs || []).includes('coverage-gate'),
      'required-tests does not depend on coverage-gate, so a red gate could not '
      + 'block a merge',
    );

    const summarize = required.steps[0];
    assert.ok(
      'COVERAGE_GATE_RESULT' in (summarize.env || {}),
      'required-tests does not read needs.coverage-gate.result',
    );
    assert.match(
      summarize.run, /coverage-gate did not pass/,
      'required-tests never fails on a red coverage-gate — depending on a job '
      + 'without checking its result makes the dependency decorative',
    );
  });

  await t.test('a skipped coverage gate is not treated as a failure', () => {
    // coverage-gate is conditioned on product_changed, exactly like the test
    // lane. A docs-only PR skips both; treating `skipped` as red would block
    // every one of them.
    assert.match(
      workflow.jobs['required-tests'].steps[0].run,
      /COVERAGE_GATE_RESULT" != "skipped"/,
      'required-tests treats a skipped coverage-gate as a failure',
    );
  });
});

test('shard-spec parsing is exact at its boundaries (#2952)', () => {
  assert.deepEqual(parseShardSpec('1/3'), { index: 1, total: 3 });
  assert.deepEqual(parseShardSpec('3/3'), { index: 3, total: 3 });
  assert.deepEqual(parseShardSpec('1/1'), { index: 1, total: 1 });

  // index 0 is below the range, index total+1 above it.
  assert.equal(parseShardSpec('0/3'), null);
  assert.equal(parseShardSpec('4/3'), null);
  assert.equal(parseShardSpec('1/0'), null);

  assert.equal(parseShardSpec('1'), null);
  assert.equal(parseShardSpec('a/3'), null);
  assert.equal(parseShardSpec(''), null);
  assert.equal(parseShardSpec(undefined), null);

  // A complete set, and the three ways one stops being complete.
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/3']), true);
  assert.equal(isCompleteShardSet(['1/3', '2/3']), false, 'missing numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '2/3']), false, 'duplicate numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/4']), false, 'mixed denominator');
  assert.equal(isCompleteShardSet([]), false, 'empty set');
});
