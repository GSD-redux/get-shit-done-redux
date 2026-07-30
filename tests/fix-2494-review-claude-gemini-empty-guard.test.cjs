/**
 * #2494 — a failed reviewer lane must be diagnosable, never a silent drop.
 *
 * Before the fix, gemini and claude sent stderr to `/dev/null` and wrote nothing on failure. A
 * failed lane — CLI missing, unauthenticated, rate-limited, crashed, any exit that writes no
 * stdout — left a zero-byte file that `write_reviews` rendered as "a reviewer that ran cleanly with
 * nothing to report", silently dropping a lane from the cross-AI consensus while `present_results`
 * reported success.
 *
 * The invariant is unchanged; what moved is where it lives. This suite used to extract the two
 * shell blocks verbatim from `review.md` and run them under a real bash against a failing stub.
 * Phase 5b (#2799) deleted those blocks, so the tests now drive the real runner with stubbed
 * dependencies — the same behavioural altitude (a lane is actually run and its artifacts
 * inspected), against the surface that ships today. Nothing here reads source text any more, so
 * the source-text exemption this file used to carry is gone.
 *
 * The guarantee also got STRONGER in one way worth locking: the policy is uniform across every
 * lane now rather than fixed per-leg, so these assertions run over the whole spawn roster instead
 * of the two legs the issue named.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/repo';

/** Lanes whose empty-output policy is the shared stub (antigravity owns its own diagnostics). */
const STUB_LANES = REVIEWER_LANES.filter(
  (l) => l.transport === 'spawn' && l.emptyOutput === 'stub-with-stderr',
);

function planFor(slug) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true, `${slug} failed to resolve`);
  return r.plan;
}

function deps(spawnResult, files = {}) {
  return {
    files,
    // `kimi-code` declares a `command-capability` probe, so the runner spawns `--help` BEFORE the
    // review. Answer that separately or the probe fails and the lane never reaches the invocation
    // this test is about.
    spawn: (binary, argv) =>
      argv && argv.length === 1 && argv[0] === '--help'
        ? { status: 0, stdout: '--output-format', stderr: '' }
        : spawnResult,
    httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
    hasBinary: () => true,
    configGet: () => undefined,
    homeDir: '/home/u',
    warn: () => {},
  };
}

describe('#2494 — a failed lane writes a diagnosable stub, not a zero-byte file', () => {
  for (const lane of STUB_LANES) {
    test(`${lane.slug}: a lane that exits non-zero with no stdout is stubbed`, async () => {
      const p = planFor(lane.slug);
      const d = deps({ status: 127, stdout: '', stderr: 'command not found' });
      const r = await runLane(p, d, { repoRoot: ROOT });

      assert.equal(r.stubbed, true, 'a failed lane must be reported as stubbed');
      const review = d.files[p.reviewPath];
      assert.ok(review !== undefined, 'a review file must exist after a failed lane');
      assert.notStrictEqual(review.trim(), '', 'the review file must not be empty');
      assert.ok(
        review.includes('failed or returned empty output'),
        'the stub must be distinguishable from a real review',
      );
    });

    test(`${lane.slug}: stderr is captured to a .err sidecar, never discarded`, async () => {
      // The sidecar is the difference between "this lane failed" and "this lane failed BECAUSE…".
      // Without it every failure mode looks identical to every other.
      const p = planFor(lane.slug);
      const d = deps({ status: 1, stdout: '', stderr: 'HTTP 429 rate limited' });
      await runLane(p, d, { repoRoot: ROOT });

      assert.equal(d.files[p.errPath], 'HTTP 429 rate limited', 'stderr must reach the sidecar');
      assert.ok(
        d.files[p.reviewPath].includes('HTTP 429 rate limited'),
        'and must be surfaced in the stub, where a reader will actually see it',
      );
      assert.ok(p.reviewPath.endsWith('.md'), 'review output path unchanged');
    });
  }

  test('a successful review passes through untouched', async () => {
    const p = planFor('gemini');
    const d = deps({ status: 0, stdout: 'Looks good.\n', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });

    assert.equal(r.stubbed, false);
    assert.ok(d.files[p.reviewPath].includes('Looks good.'));
    assert.ok(
      !d.files[p.reviewPath].includes('failed or returned empty output'),
      'a real review must never carry the failure header',
    );
  });

  test('no lane sends stderr to /dev/null — the sidecar is unconditional', async () => {
    // The original defect in one line, asserted over the whole roster rather than the two legs the
    // issue named: the policy is uniform now, and a future lane must not be able to opt out.
    for (const lane of STUB_LANES) {
      const p = planFor(lane.slug);
      const d = deps({ status: 0, stdout: 'ok', stderr: 'a warning' });
      await runLane(p, d, { repoRoot: ROOT });
      assert.equal(d.files[p.errPath], 'a warning', `${lane.slug} discarded stderr`);
    }
  });
});
