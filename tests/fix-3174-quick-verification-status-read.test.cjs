// allow-test-rule: source-text-is-the-product see #3174
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';

/**
 * quick verification-status read contract (#3174)
 *
 * quick's verification step used to read the verifier's result with a raw
 * `grep "^status:" F | cut -d: -f2 | tr -d ' '` and route it through arms
 * passed / human_needed / gaps_found only. That read failed two ways,
 * both measured against the old pipeline.
 *
 * Matched NO arm: a missing report; most off-schema values; a `status:` line
 * in BOTH the frontmatter and the prose (two lines); and — on a CRLF
 * checkout — a perfectly valid `passed`, which arrives as `passed\r`.
 *
 * Matched the SUCCESS arm when it should not have: a stale report still
 * reading `passed` (staleness was never evaluated); a report whose only
 * `status:` line sits in its prose; and an off-schema value carrying a colon
 * (`passed:bogus`), which `cut -d: -f2` splits at that colon, leaving the
 * pipeline to yield `passed` once `tr -d ' '` strips the leading space.
 *
 * The unanchored match is the DEFECT.FRONTMATTER-SCALAR-BROAD-GREP class the
 * code side already fixed by name.
 *
 * These tests pin the five properties that keep the replacement honest.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_VERIFICATION = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'quick', 'steps', 'quick-verification.md',
);
// The canonical launcher preamble. scripts/sync-runtime-launcher.cjs rewrites
// every workflow's bootstrap from this file, so THIS is the authority — not
// whichever sibling step file happens to carry a copy today.
const LAUNCHER_SNIPPET = path.join(
  __dirname, '..', 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh',
);

const SHIM_ANCHOR = '_GSD_SHIM_NAME="gsd-tools.cjs"';

describe('quick verification status read (#3174)', () => {
  test('status is read through the canonical query, not a raw frontmatter grep', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const queryIdx = content.indexOf('gsd_run query verification.status "${QUICK_DIR}"');

    assert.ok(queryIdx !== -1, 'quick-verification.md must read status via the verification.status query');
    assert.ok(
      !content.includes('grep "^status:"'),
      'the raw frontmatter-scalar grep must not return — it matches body lines too (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP)',
    );
  });

  test('the query call is preceded by the runtime shim bootstrap in this step file', () => {
    // Step files are read and executed as their own units, so quick.md's
    // bootstrap does not reach here. Without this the call resolves to
    // nothing, 2>/dev/null swallows it, and the default arm is taken forever.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const shimIdx = content.indexOf(SHIM_ANCHOR);
    const queryIdx = content.indexOf('gsd_run query verification.status');

    assert.ok(shimIdx !== -1, 'the step file must carry its own runtime shim bootstrap');
    assert.ok(queryIdx > shimIdx, 'the shim bootstrap must precede the gsd_run call');
  });

  test('the shim bootstrap is the canonical launcher preamble, not a fork of it', () => {
    // Anchored on _runtime-launcher.snippet.sh rather than on a sibling step
    // file: sync-runtime-launcher.cjs regenerates every workflow from the
    // snippet, so a synchronized launcher update keeps this green (correct),
    // and a sibling that legitimately stops calling gsd_run cannot fail us.
    const lineWithShim = (file) => fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .find((line) => line.startsWith(SHIM_ANCHOR));

    const mine = lineWithShim(QUICK_VERIFICATION);
    const canonical = lineWithShim(LAUNCHER_SNIPPET);

    assert.ok(canonical, '_runtime-launcher.snippet.sh must carry the canonical preamble');
    assert.equal(mine, canonical, 'the bootstrap must match the canonical launcher snippet verbatim');
  });

  test('status extraction does not depend on jq', () => {
    // #2589: a `| jq -r '.field'` pipe yields an empty variable with no
    // diagnostic wherever jq is absent (the Windows/Git-Bash default), which
    // would route a passing verification into the recovery arm.
    //
    // Scoped to the executable fence on purpose: the surrounding prose cites
    // the jq form in order to explain why it is not used, and an assertion
    // over the whole file would fire on its own rationale.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const fences = content.match(/```bash\r?\n[\s\S]*?```/g) || [];
    const statusFence = fences.find((f) => f.includes('gsd_run query verification.status'));

    assert.ok(statusFence, 'the status read must live in a bash fence');
    assert.ok(
      statusFence.includes('--pick status'),
      'the bare status must be picked by the query itself',
    );
    assert.ok(!/\|\s*jq\b/.test(statusFence), 'the status-read fence must not pipe through jq');
  });

  test('the routing table carries a terminal arm for missing / unknown / stale', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const gapsIdx = content.indexOf('| `gaps_found` |');
    const fallbackIdx = content.indexOf('| anything else');

    assert.ok(gapsIdx !== -1, 'the three verifier-status arms must remain');
    assert.ok(fallbackIdx > gapsIdx, 'a terminal arm must follow the verifier-status arms');

    const fallbackRow = content.slice(fallbackIdx, content.indexOf('\n', fallbackIdx));
    for (const sentinel of ['missing', 'unknown', 'stale']) {
      assert.ok(
        fallbackRow.includes(sentinel),
        `the terminal arm must name the ${sentinel} sentinel the query can return`,
      );
    }
    assert.ok(
      fallbackRow.includes('VERIFICATION_STATUS'),
      'the terminal arm must set the display string consumed by the quick index row and banner',
    );
  });
});
