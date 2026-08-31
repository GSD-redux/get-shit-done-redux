'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3807 — advance-plan must refuse a Current Position section carrying
// more than one `Phase:` entry instead of silently advancing the first.
//
// The #2956 fix scoped the milestone-conflict Phase read to the Current
// Position section, but advancePlanCore's plan fields still came from
// document-wide first-match stateExtractField — so a wave-log style section
// (one Phase: entry per completed wave, all under Current Position) had its
// FIRST entry's plan counter silently advanced — in the reporter's incident,
// a hard-gated final plan 7→8 of 8 — with advanced:true and
// milestone_conflict:null, no error, no ambiguity signal.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const TWO_ENTRY_BODY = [
  '## Current Position',
  '',
  'Phase: 03.1 of 8 (some-phase)',
  'Plan: 7 of 8 in current phase',
  'Status: In progress',
  'Last activity: 2026-08-24 — working',
  '',
  'Phase: 04 of 15 (other-phase)',
  'Plan: 7 of 15 in current phase',
  'Status: Phase complete',
  'Last activity: 2026-08-24 — wave 4 done',
  '',
].join('\n');

function writeState(tmpDir, positionBody) {
  const content = [
    '---',
    'gsd_state_version: 1.0',
    'current_phase: 03',
    'status: executing',
    'progress:',
    '  total_phases: 2',
    '---',
    '',
    positionBody,
  ].join('\n');
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
}

function runAdvance(cwd) {
  return runGsdTools(['state', 'advance-plan'], cwd);
}

describe('#3807: advance-plan refuses an ambiguous multi-entry Current Position', () => {
  test('#3807: two Phase: entries under Current Position → ambiguous error, no mutation', (t) => {
    const tmpDir = createTempProject('gsd-3807-amb-');
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, TWO_ENTRY_BODY);
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');

    const r = runAdvance(tmpDir);
    // The CLI reports an error payload (exit success shape is the command's
    // own convention for parse errors — assert on the payload, not the code).
    const out = JSON.parse(r.output);
    assert.ok(
      out.error && out.reason === 'ambiguous_position_phase' && /more than one Phase/i.test(String(out.error)),
      `#3807: the error must name the multi-Phase condition with the typed reason; got ${r.output}`,
    );
    assert.ok(
      Array.isArray(out.phase_candidates) && out.phase_candidates.length === 2,
      `#3807: both Phase: candidates must be named; got ${JSON.stringify(out.phase_candidates)}`,
    );
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    assert.equal(after, before, '#3807: refusing must leave STATE.md byte-identical');
    assert.ok(!/Plan: 8 of 8/.test(after), 'the first entry\'s plan counter must NOT advance');
  });

  test('#3807 control: a single-entry section advances exactly as before', (t) => {
    const tmpDir = createTempProject('gsd-3807-ctl-');
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, [
      '## Current Position',
      '',
      'Phase: 03 of 8 (some-phase)',
      'Plan: 3 of 8 in current phase',
      'Status: In progress',
      'Last activity: 2026-08-24 — working',
      '',
    ].join('\n'));

    const r = runAdvance(tmpDir);
    const out = JSON.parse(r.output);
    assert.equal(out.advanced, true, `single-entry advance still works; got ${r.output}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    assert.match(after, /Plan: 4 of 8/, 'the plan counter advanced');
  });
});
