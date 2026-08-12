'use strict';

/**
 * #2138 — track_shipping ship-note must be pushed onto the PR branch.
 *
 * ship.md's track_shipping step committed the STATE ship-note (Phase N shipped —
 * PR #N) AFTER create_pr and never pushed it. The commit stayed local-only, so
 * when the GitHub PR merged (especially fast/auto-merge) the ship-note was not in
 * the source branch and never reached the default branch — STATE's ship-status
 * was silently lost.
 *
 * The fix pushes the ship-note commit onto the PR branch with a `[ci skip]`
 * trailer (honored by GitHub) so it lands on merge without triggering a redundant
 * pipeline. This test is a source-text regression guard: ship.md IS the product
 * the runtime loads, so asserting its track_shipping step pushes (with [ci skip])
 * guards the deployed contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');

function extractStep(name) {
  const content = fs.readFileSync(SHIP_MD, 'utf8');
  const open = `<step name="${name}">`;
  const start = content.indexOf(open);
  assert.notEqual(start, -1, `ship.md must contain a ${name} step`);
  const end = content.indexOf('</step>', start);
  assert.notEqual(end, -1, `${name} step must close`);
  return content.slice(start, end);
}

describe('#2138 ship.md track_shipping pushes the ship-note onto the PR branch', () => {
  const step = extractStep('track_shipping');

  test('track_shipping pushes the committed ship-note (not local-only)', () => {
    // The bug was that the ship-note commit was never pushed. The fix adds a
    // `git push origin ${CURRENT_BRANCH}` inside track_shipping.
    assert.ok(
      /git push origin \$\{CURRENT_BRANCH\}/.test(step),
      'track_shipping must push the ship-note commit onto the PR branch so it survives merge (#2138)',
    );
  });

  test('the ship-note commit carries a [ci skip] trailer to avoid a redundant pipeline', () => {
    // GitHub honors `[ci skip]` / `[skip ci]`; the trailer suppresses the second
    // pipeline the post-create_pr push would otherwise trigger.
    assert.ok(
      /\[ci skip\]|\[skip ci\]/.test(step),
      'track_shipping ship-note commit must include a [ci skip] trailer',
    );
  });

  test('the ship-note step handles wedged PRs caused by skip-token or required status checks', () => {
    assert.ok(
      /mergeStateStatus|BLOCKED|trigger CI/.test(step),
      'track_shipping must include self-healing or check handling for wedged PRs (#2783)',
    );
  });

  test('the ship-note commit still records the phase + PR number in STATE', () => {
    assert.ok(
      /ship phase \$\{PHASE_NUMBER\}.*PR #\$\{PR_NUMBER\}/.test(step),
      'track_shipping must still commit the phase + PR-number ship-note into STATE',
    );
  });
});
