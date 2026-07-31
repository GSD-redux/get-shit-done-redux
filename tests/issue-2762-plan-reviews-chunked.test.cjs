// allow-test-rule: structural-implementation-guard (#2762)
'use strict';

// Regression guard for #2762: /gsd-plan-phase --reviews was a silent no-op in chunked
// mode. Two defects in plan-phase.md §8.5:
//   A. §8.5.1 outline resume-check greps for a marker the agent only RETURNED (never
//      wrote to the file) → outline always re-ran/overwrote (broke crash-resume).
//   B. §8.5.2 per-plan resume-check skipped any plan with frontmatter, with no
//      --reviews exception → --reviews skipped 100% of plans (contradicted §6's
//      "go straight to replanning" contract).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const read = () => fs.readFileSync(MD, 'utf8');

test('§8.5.1 outline agent writes the resume marker into the file (#2762 defect A)', () => {
  const src = read();
  // The outline prompt must instruct writing ## OUTLINE COMPLETE into PLAN-OUTLINE.md
  // (the §8.5.1 resume-check greps for it in the file).
  const outlineSection = src.slice(src.indexOf('### 8.5.1'), src.indexOf('### 8.5.2'));
  assert.ok(
    /outline|PLAN-OUTLINE/i.test(outlineSection) && /End the file.*## OUTLINE COMPLETE|write.*## OUTLINE COMPLETE.*file/i.test(outlineSection.replace(/\s+/g, ' ')),
    'the outline agent prompt must instruct writing ## OUTLINE COMPLETE into the file (the resume-check greps the file for it) (#2762)'
  );
});

test('§8.5.2 per-plan resume-check does NOT skip under --reviews (#2762 defect B)', () => {
  const src = read();
  const perPlanSection = src.slice(src.indexOf('### 8.5.2'));
  // The resume-check bash must gate the skip on --reviews being ABSENT.
  const bashMatch = perPlanSection.match(/PLAN_FILE=[\s\S]*?fi\s*\n/);
  assert.ok(bashMatch, '§8.5.2 must contain the per-plan resume-check bash block');
  const bash = bashMatch[0];
  assert.ok(
    /--reviews/.test(bash),
    'the per-plan resume-check must reference --reviews so it does NOT skip when replanning with review feedback (#2762)'
  );
  // The skip must be conditional on --reviews being ABSENT (e.g. ARGUMENTS != *"--reviews"*).
  assert.ok(
    /!=\s*\*"--reviews"\*|!~.*--reviews|--reviews.*absent|not.*--reviews/i.test(bash),
    'the resume-check skip must be gated on --reviews being ABSENT (so --reviews overwrites/replans) (#2762)'
  );
});

test('§8.5.2 crash-resume (non-reviews) still skips written plans (#2762 negative space)', () => {
  const src = read();
  const perPlanSection = src.slice(src.indexOf('### 8.5.2'));
  const bashMatch = perPlanSection.match(/PLAN_FILE=[\s\S]*?fi\s*\n/);
  const bash = bashMatch ? bashMatch[0] : '';
  assert.ok(
    /head -1.*grep.*\^---|frontmatter/i.test(bash + perPlanSection.slice(0, 400)),
    'crash-resume (non-reviews) must still skip plans with valid frontmatter (resume safety preserved) (#2762)'
  );
});
