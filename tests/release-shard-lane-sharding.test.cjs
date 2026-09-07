'use strict';

/**
 * release.yml's rc and finalize jobs both shard the unit suite the same way
 * test.yml's `scope: full` lane does (#2952) — see #4335 (recurrence of
 * #2280/#2281): the unsharded `npm run test:coverage:unit` step outgrew even
 * a 30-minute job timeout as the suite grew (run 33988966357 — all tests
 * passed, 0 failures, cancelled ~80s into the post-test coverage merge).
 *
 * Sharding introduces the same two failure modes ci-full-lane-sharding.test.cjs
 * pins for test.yml, so both are pinned here too:
 *
 *  1. An incomplete shard set. If the matrix declares shards 1/3 and 2/3 but
 *     never 3/3, a third of the unit suite simply stops running and every
 *     check still passes.
 *
 *  2. A dropped coverage gate. A sharded run leaves each runner with a
 *     partial picture — shard 2 never executes shard 1's files, so those
 *     read 0%. The gate therefore cannot live on the shards; it moved to
 *     rc-coverage-gate/finalize-coverage-gate, which merge every shard's raw
 *     V8 dumps. If those jobs silently stopped being required, coverage
 *     enforcement would vanish without any red check.
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

/** Mirrors ci-full-lane-sharding.test.cjs's shard-spec grammar. */
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

const LANES = [
  { label: 'rc', testJob: 'rc-test', gateJob: 'rc-coverage-gate', finalJob: 'rc', artifactPrefix: 'coverage-tmp-rc-shard-' },
  { label: 'finalize', testJob: 'finalize-test', gateJob: 'finalize-coverage-gate', finalJob: 'finalize', artifactPrefix: 'coverage-tmp-finalize-shard-' },
];

test('release.yml rc/finalize unit-suite lanes are sharded and complete (#4335)', async (t) => {
  const workflow = loadWorkflow('release.yml');

  for (const lane of LANES) {
    await t.test(`${lane.label}: the *-test job's matrix declares a complete shard set`, () => {
      const job = workflow.jobs[lane.testJob];
      assert.ok(job, `release.yml declares no \`${lane.testJob}\` job`);
      const shards = (job.strategy && job.strategy.matrix && job.strategy.matrix.shard) || [];
      assert.ok(
        Array.isArray(shards) && shards.length > 1,
        `\`${lane.testJob}\` is not actually sharded (matrix.shard: ${JSON.stringify(shards)}) — `
        + 'that is the #4335/#2952 regression: the whole suite on one runner grows past its cap.',
      );
      assert.ok(
        isCompleteShardSet(shards),
        `\`${lane.testJob}\`'s declared shards ${JSON.stringify(shards)} are not a complete set. `
        + 'Every entry must share one denominator N and the numerators must be exactly 1..N — a '
        + 'missing numerator silently stops running that slice of the suite while every check stays green.',
      );
    });

    await t.test(`${lane.label}: each shard runs its own slice, not the whole suite`, () => {
      const job = workflow.jobs[lane.testJob];
      const unitStep = job.steps.find(
        (s) => typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw'),
      );
      assert.ok(unitStep, `no step in \`${lane.testJob}\` runs the raw unit coverage script`);
      assert.match(
        unitStep.run, /--shard \$\{\{ matrix\.shard \}\}/,
        `the unit step in \`${lane.testJob}\` does not pass matrix.shard through to run-tests.cjs, `
        + 'so every shard would run the ENTIRE suite — N times the cost, no speedup.',
      );
    });

    await t.test(`${lane.label}: each shard uploads a distinctly-named raw coverage artifact`, () => {
      const job = workflow.jobs[lane.testJob];
      const uploadStep = job.steps.find(
        (s) => String(s.uses || '').includes('upload-artifact'),
      );
      assert.ok(uploadStep, `no upload-artifact step in \`${lane.testJob}\``);
      assert.ok(
        String(uploadStep.with && uploadStep.with.name).startsWith(lane.artifactPrefix),
        `\`${lane.testJob}\`'s upload-artifact name does not start with '${lane.artifactPrefix}' `
        + `(was: ${JSON.stringify(uploadStep.with && uploadStep.with.name)})`,
      );
    });

    await t.test(`${lane.label}: a dedicated coverage-gate job exists and merges the shards`, () => {
      const gate = workflow.jobs[lane.gateJob];
      assert.ok(gate, `release.yml declares no \`${lane.gateJob}\` job`);
      assert.ok(
        (gate.needs || []).includes(lane.testJob),
        `\`${lane.gateJob}\` must depend on \`${lane.testJob}\` — it merges that job's shard artifacts`,
      );

      const merges = gate.steps.some(
        (s) => String(s.uses || '').includes('download-artifact')
          && s.with && s.with['merge-multiple'] === true
          && String(s.with.pattern || '').startsWith(lane.artifactPrefix),
      );
      assert.ok(
        merges,
        `\`${lane.gateJob}\` does not download the \`${lane.artifactPrefix}*\` shard artifacts with `
        + 'merge-multiple. Without every shard merged into one coverage/tmp, the gate scores a '
        + 'partial run: files no shard in hand executed read 0%.',
      );

      const reports = gate.steps.some(
        (s) => typeof s.run === 'string' && s.run.includes('test:coverage:report'),
      );
      assert.ok(
        reports,
        `\`${lane.gateJob}\` never runs the coverage report+gate script — the gsd-core/bin/lib `
        + 'coverage floor would be gone',
      );
    });

    await t.test(`${lane.label}: the final job depends on its coverage gate`, () => {
      const finalJob = workflow.jobs[lane.finalJob];
      assert.ok(finalJob, `release.yml declares no \`${lane.finalJob}\` job`);
      assert.ok(
        (finalJob.needs || []).includes(lane.gateJob),
        `\`${lane.finalJob}\` does not depend on \`${lane.gateJob}\` — a red/skipped coverage gate `
        + `could not block ${lane.label} from tagging/publishing`,
      );
    });
  }
});

test('release.yml shard-spec parsing is exact at its boundaries (#4335)', () => {
  assert.deepEqual(parseShardSpec('1/3'), { index: 1, total: 3 });
  assert.deepEqual(parseShardSpec('3/3'), { index: 3, total: 3 });
  assert.equal(parseShardSpec('0/3'), null);
  assert.equal(parseShardSpec('4/3'), null);
  assert.equal(parseShardSpec('a/3'), null);

  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/3']), true);
  assert.equal(isCompleteShardSet(['1/3', '2/3']), false, 'missing numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '2/3']), false, 'duplicate numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/4']), false, 'mixed denominator');
  assert.equal(isCompleteShardSet([]), false, 'empty set');
});
