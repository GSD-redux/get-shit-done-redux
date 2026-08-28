'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3797 — gsd-roadmapper must follow ONE contract: write-first.
//
// The agent's role blurb, output format, and completion checklist described
// an approve-first flow ("Return structured draft for user approval",
// "Awaiting / Approve roadmap", "Files written (after approval)") while its
// execution flow said "Write Files Immediately ... Write files first, then
// return" with reactive-only revision. The approval gate belongs to the
// ORCHESTRATOR (new-project.md reads the written ROADMAP.md, presents it,
// and gates on approval/auto-mode itself — a subagent cannot host the user
// loop). The agent's write-first execution flow is the intentional contract
// (explicit durability rationale; the #2255 write-guard arming in the same
// Step 7); the approve-first text is a leftover and must not return.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROADMAPPER = path.join(__dirname, '..', 'agents', 'gsd-roadmapper.md');

// agents/*.md is shipped agent text — the bytes ARE what the runtime loads;
// a structural scan over it tests the deployed contract.
test('#3797: the roadmapper follows one write-first contract (approval is the orchestrator\'s)', () => {
  const md = fs.readFileSync(ROADMAPPER, 'utf-8');
  assert.ok(
    !/for user approval/i.test(md),
    '#3797: the agent cannot host a user approval loop — approve-first phrasing must not return',
  );
  assert.ok(
    !/Awaiting \/ Approve/.test(md),
    '#3797: the Awaiting/Approve output footer is the old contract; revision is the orchestrator\'s gate plus Step 9 re-runs',
  );
  assert.ok(
    /^## Step 7: Write Files Immediately$/m.test(md),
    'the write-first execution flow (durability rationale) is the intended contract and must stay',
  );
  assert.ok(
    !/\(after approval\)/.test(md),
    '#3797: the checklist must not claim files are written after an approval the agent never hosts',
  );
  assert.ok(
    /^## Step 9: Handle Revision/.test(md),
    'reactive revision (Step 9) stays — it is the revision path under the write-first contract too',
  );
});
