'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3795 — execute-plan's interrupted-agent detection must be REACHABLE.
//
// The init_agent_tracking step cleared `.planning/current-agent-id.txt`
// BEFORE the existence check that read it, so the interrupted-agent branch
// and the Task `resume` prompt it exists to offer could never execute: a
// kill -9 mid-executor left the file, and the very next run deleted it
// before looking. The read must precede the clear.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXECUTE_PLAN_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');

// execute-plan.md is shipped workflow text — the bytes ARE what the runtime
// loads; a structural scan over the step's own fenced block tests the
// deployed contract (same shape as tests/config-get-raw-guard.test.cjs).
function initAgentTrackingBlock() {
  const md = fs.readFileSync(EXECUTE_PLAN_MD, 'utf-8');
  const step = md.indexOf('<step name="init_agent_tracking">');
  assert.ok(step > 0, 'execute-plan.md must contain the init_agent_tracking step');
  const end = md.indexOf('</step>', step);
  assert.ok(end > step, 'init_agent_tracking step must close');
  return md.slice(step, end);
}

test('#3795: the interrupted-agent read must precede the stale-id clear', () => {
  const block = initAgentTrackingBlock();
  const readCheck = block.indexOf('[ -f .planning/current-agent-id.txt ]');
  const clear = block.indexOf('rm -f .planning/current-agent-id.txt');
  assert.ok(readCheck > 0, 'the step must probe for a surviving current-agent-id.txt');
  assert.ok(clear > 0, 'the step must clear the stale id for the fresh run');
  assert.ok(
    readCheck < clear,
    '#3795: the existence check must run BEFORE the rm — delete-first made the interrupted-agent branch and its Task resume prompt unreachable',
  );
  assert.ok(
    /INTERRUPTED_ID=\$\(/.test(block),
    'the surviving id must be captured while the file still exists',
  );
  assert.ok(
    /resume/.test(block),
    'the resume-or-fresh prompt the read enables must stay present',
  );
});
