/**
 * #2794 — the qwen reviewer leg was the last one still sending stderr to /dev/null.
 *
 * Every other lane captured stderr to a `.err` sidecar and appended it to the stub (#2494/#2605);
 * qwen wrote a bare "failed or returned empty output." with no diagnostic at all, so a missing
 * binary, an auth prompt and a rate-limit were indistinguishable from each other AND from a clean
 * empty review.
 *
 * Phase 5b (#2799) deleted the per-CLI bash this suite used to extract and run under a real bash.
 * The invariant is now structural rather than per-leg — the sidecar is written by the shared runner
 * for every lane — so these tests drive the runner directly. That also means the defect this issue
 * describes can no longer recur for ONE lane: there is no longer a per-lane place to get it wrong.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/repo';

function planFor(slug) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true);
  return r.plan;
}

function deps(spawnResult, files = {}, hasBinary = () => true) {
  return {
    files,
    spawn: () => spawnResult,
    httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
    hasBinary,
    configGet: () => undefined,
    homeDir: '/home/u',
    warn: () => {},
  };
}

describe('#2794 qwen reviewer stderr capture', () => {
  test('writes the review on success', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '## Qwen findings\nall good\n', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, false);
    assert.ok(d.files[p.reviewPath].includes('## Qwen findings'));
  });

  test('a failed lane surfaces its stderr in the review stub', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 1, stdout: '', stderr: 'auth required: run `qwen login`' });
    await runLane(p, d, { repoRoot: ROOT });
    assert.ok(d.files[p.reviewPath].includes('auth required'),
      'the diagnostic must reach the review, not just the sidecar');
    assert.equal(d.files[p.errPath], 'auth required: run `qwen login`');
  });

  test('a silently empty lane still produces a diagnosable stub', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, true);
    assert.ok(d.files[p.reviewPath].includes('failed or returned empty output'));
  });

  test('a missing qwen binary reports unavailable rather than an empty review', async () => {
    // Stronger than the original: the lane is now reported with a TYPED reason before it is ever
    // spawned, instead of producing a stub that looked the same as every other failure.
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '', stderr: '' }, {}, () => false);
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_binary');
    assert.equal(d.files[p.reviewPath], undefined, 'no review file for a lane that never ran');
  });

  test('the sidecar is structural — no lane can opt out of it', async () => {
    // The #2794 defect was one lane diverging from a convention every other lane followed. There is
    // no per-lane place to diverge any more; this asserts that directly.
    for (const lane of REVIEWER_LANES.filter((l) => l.transport === 'spawn')) {
      const p = planFor(lane.slug);
      assert.ok(p.errPath.endsWith('.err'), `${lane.slug} must declare a stderr sidecar`);
      assert.notEqual(p.errPath, '/dev/null');
    }
  });
});
