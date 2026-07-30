// allow-test-rule: structural-implementation-guard (#2772)
'use strict';

// Regression guard for #2772: four self-contained text inconsistencies in the
// discuss-phase surface, each a literal-instruction hazard. The shipped markdown IS
// the runtime contract, so structural inspection is the correct guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('auto.md does not read the dead MAX_PASSES / max_discuss_passes config (#2772.1)', () => {
  const src = read('gsd-core/workflows/discuss-phase/modes/auto.md');
  assert.ok(/single pass/i.test(src), 'auto.md must still mandate the single-pass rule');
  assert.ok(!/MAX_PASSES=/.test(src), 'auto.md must not read MAX_PASSES (dead config — single-pass rule governs) (#2772)');
  assert.ok(!/max_discuss_passes/.test(src), 'auto.md must not reference max_discuss_passes (contradicts the single-pass rule) (#2772)');
});

test('gate-prompts context-handling matches the actual check_existing options (#2772.2)', () => {
  const src = read('gsd-core/references/gate-prompts.md');
  const ctx = src.slice(src.indexOf('## Pattern: context-handling'), src.indexOf('## Pattern: gray-area-option'));
  assert.ok(/Update it \| View it \| Skip/.test(ctx), 'context-handling options must be "Update it | View it | Skip" (the actual check_existing flow) (#2772)');
  assert.ok(!/Overwrite \| Append \| Cancel/.test(ctx), 'context-handling must NOT document the obsolete "Overwrite | Append | Cancel" (#2772)');
});

test('gate-prompts gray-area-option does not mandate "Let Claude decide" (#2772.2)', () => {
  const src = read('gsd-core/references/gate-prompts.md');
  const gray = src.slice(src.indexOf('## Pattern: gray-area-option'));
  assert.ok(!/Always include "Let Claude decide"/i.test(gray), 'gray-area-option must NOT mandate "Let Claude decide" — it contradicts discuss-phase.md:353 ("Do NOT include a skip or you decide option") (#2772)');
});

test('discuss-phase auto_advance fallback ends the workflow, not routes back to confirm_creation (#2772.3)', () => {
  const src = read('gsd-core/workflows/discuss-phase.md');
  const step = src.slice(src.indexOf('<step name="auto_advance">'), src.indexOf('</step>', src.indexOf('<step name="auto_advance">')));
  assert.ok(!/route to `confirm_creation`/.test(step), 'auto_advance fallback must not route back to confirm_creation (it already ran earlier in the step order — circular) (#2772)');
  assert.ok(/end here|workflow is complete/i.test(step), 'auto_advance fallback must explicitly END the workflow (positive anchor — a re-phrased regression should not slip past) (#2772)');
});

test('discuss-phase-assumptions auto_advance fallback also ends the workflow (sibling of #2772.3)', () => {
  const src = read('gsd-core/workflows/discuss-phase-assumptions.md');
  const step = src.slice(src.indexOf('<step name="auto_advance">'), src.indexOf('</step>', src.indexOf('<step name="auto_advance">')));
  assert.ok(!/Route to confirm_creation step/.test(step), 'assumptions auto_advance fallback must not route back to confirm_creation (same circularity as the parent) (#2772)');
  assert.ok(/end here|workflow is complete/i.test(step), 'assumptions auto_advance fallback must explicitly END the workflow (#2772)');
});

test('discuss-phase-assumptions answer_validation matches the parent canonical content (#2772.4)', () => {
  const parent = read('gsd-core/workflows/discuss-phase.md');
  const assumptions = read('gsd-core/workflows/discuss-phase-assumptions.md');
  // The parent's canonical answer_validation includes the "Other" empty-text branch.
  const parentBlock = parent.slice(parent.indexOf('<answer_validation>'), parent.indexOf('</answer_validation>') + '</answer_validation>'.length);
  const assumptionsBlock = assumptions.slice(assumptions.indexOf('<answer_validation>'), assumptions.indexOf('</answer_validation>') + '</answer_validation>'.length);
  assert.ok(/"Other" with empty text/.test(assumptionsBlock), 'assumptions answer_validation must include the "Other" empty-text branch (was drifted) (#2772)');
  // The two blocks must now agree on the empty-response handling.
  assert.strictEqual(assumptionsBlock, parentBlock, 'discuss-phase-assumptions answer_validation must match the parent canonical block exactly (single source of truth) (#2772)');
});
