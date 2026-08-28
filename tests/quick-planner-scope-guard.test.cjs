'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3786 — the /gsd-quick planner constraints must carry a mutable-scope
// AUTHORITY rule.
//
// A minimized planner probe committed HISTORICAL scope as authorized edit /
// verification scope in 2 of 3 trials: for a merge-conflict task whose fresh
// merge had not run, one trial provisionally authorized 65 cached PR-diff
// paths, another broadened verification to the whole PR integration surface.
// Adding one explicit requirement — authorized scope comes only from the
// fresh merge index — reduced failures to 0 of 3. The rule lives in the
// shipped planner prompt (quick.md's <constraints> block), so a structural
// guard over that text pins it.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const QUICK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

// quick.md is shipped workflow text — the bytes ARE what the runtime loads,
// so a structural scan over it tests the deployed contract (same shape as
// tests/config-get-raw-guard.test.cjs; no allow-test-rule marker needed for
// .md reads).
function plannerConstraints() {
  const md = fs.readFileSync(QUICK_MD, 'utf-8');
  // quick.md carries TWO <constraints> blocks (planner at ~315, executor at
  // ~479). Anchor to the PLANNER's: the last block opening before its
  // subagent_type declaration — step reordering can never silently redirect
  // the guard to another agent's block.
  const plannerDispatch = md.indexOf('subagent_type="gsd-planner"');
  assert.ok(plannerDispatch > 0, 'quick.md must dispatch the gsd-planner agent');
  const start = md.lastIndexOf('<constraints>', plannerDispatch);
  const end = md.indexOf('</constraints>', start);
  assert.ok(start > 0 && end > start, 'quick.md must contain the planner <constraints> block');
  return md.slice(start, end);
}

test('#3786: the quick planner constraints carry a mutable-scope authority rule', () => {
  const constraints = plannerConstraints();
  assert.ok(
    /live observation/i.test(constraints) && /conditional/i.test(constraints),
    '#3786: scope derived from mutable external state must be live-observed or kept conditional',
  );
  assert.ok(
    /may guide investigation only/i.test(constraints),
    '#3786: historical STATE.md/recovery/cached-diff paths must be labeled investigation-only, never edit/verification authority',
  );
  assert.ok(
    constraints.includes('git diff --name-only --diff-filter=U'),
    '#3786: the conflict-resolution case must name the fresh-merge-index command the probe validated',
  );
});
