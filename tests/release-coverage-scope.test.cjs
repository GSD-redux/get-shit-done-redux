// allow-test-rule: source-text-is-the-product
// .github/workflows/release.yml is the deployed CI contract; asserting
// the release-gate test command is only expressible against the workflow text.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

describe('release-coverage-scope', () => {
  // #4335: rc/finalize used to run one unsharded `npm run test:coverage:unit`
  // line each. Both now shard the unit suite (raw coverage only, one line per
  // *-test job) and gate on a separate merged-coverage job (one report line
  // per *-coverage-gate job) — see rc-test/finalize-test and
  // rc-coverage-gate/finalize-coverage-gate. This asserts the new surface is
  // still unit-scoped end to end: the unsharded single-shot invocation is
  // gone for good (not silently reintroduced), the raw/report scripts appear
  // exactly once per job pair, and no bare full-suite line ever appears.
  test('release.yml uses the sharded unit-coverage scripts (not the unsharded or full suite) in both rc and finalize gates', () => {
    // Normalize an optional leading `run: ` so a single-line `run: npm run
    // …` step (the style rc-coverage-gate/finalize-coverage-gate use) counts
    // the same as a bare command line inside a multi-line `run: |` block
    // (the style the raw-coverage and legacy unit steps use).
    const lines = fs.readFileSync(RELEASE_WORKFLOW, 'utf8').split(/\r?\n/)
      .map(l => l.trim().replace(/^run:\s*/, ''));
    const bareCount = lines.filter(l => l === 'npm run test:coverage').length;
    const unshardedUnitCount = lines.filter(l => l === 'npm run test:coverage:unit').length;
    const rawShardedCount = lines.filter(l => l === 'npm run test:coverage:unit:raw -- --shard ${{ matrix.shard }}').length;
    const reportCount = lines.filter(l => l === 'npm run test:coverage:report').length;

    assert.strictEqual(bareCount, 0,
      `release.yml still has ${bareCount} bare 'npm run test:coverage' line(s); expected 0`);
    assert.strictEqual(unshardedUnitCount, 0,
      `release.yml has ${unshardedUnitCount} unsharded 'npm run test:coverage:unit' line(s); ` +
      'expected 0 — the #4335 fix sharded rc/finalize onto test:coverage:unit:raw + test:coverage:report');
    assert.strictEqual(rawShardedCount, 2,
      `release.yml has ${rawShardedCount} sharded raw-coverage line(s) (one expected in each of ` +
      `rc-test and finalize-test); expected 2`);
    assert.strictEqual(reportCount, 2,
      `release.yml has ${reportCount} 'npm run test:coverage:report' line(s) (one expected in each ` +
      'of rc-coverage-gate and finalize-coverage-gate); expected 2');
  });
});
