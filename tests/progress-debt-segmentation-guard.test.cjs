'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3782 — progress.md step 1.6 must SEGMENT verification debt by the
// `archived_milestone` stamp instead of reading the cross-population
// `summary.total_items`.
//
// `query audit-uat` milestone-filters the ACTIVE tree but deliberately adds
// ARCHIVED trees unfiltered (each result stamped `archived_milestone`), while
// `summary.total_items` spans both populations. Reading that summary as
// current-milestone debt made every /gsd-progress run present six shipped
// milestones' worth of still-open items as CURRENT debt (49 reported vs 13
// real). The fix counts non-archived results only and gives archived debt its
// own labeled line — segmented, never hidden (an item archived still-open is
// still open; the reporter's archived set included an unrun security
// boundary test).
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROGRESS_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md');

// allow-test-rule: source-text-is-the-product (#3782)
// progress.md is shipped workflow text — the bytes ARE what the runtime
// loads, so a structural scan over it tests the deployed contract (same
// shape as tests/config-get-raw-guard.test.cjs).
function step16() {
  const md = fs.readFileSync(PROGRESS_MD, 'utf-8');
  const start = md.indexOf('**Step 1.6: Cross-phase health check**');
  assert.ok(start > 0, 'progress.md must contain Step 1.6');
  const end = md.indexOf('**Step 1.7:', start);
  assert.ok(end > start, 'progress.md must contain Step 1.7 after 1.6');
  return md.slice(start, end);
}

test('#3782: step 1.6 counts current-milestone debt from non-archived results only', () => {
  const step = step16();
  assert.ok(
    /select\(has\("archived_milestone"\)\s*\|\s*not\)/.test(step),
    '#3782: the debt count must select results WITHOUT the archived_milestone stamp',
  );
  assert.ok(
    !/Track:\s*`outstanding_debt`\s*—\s*`summary\.total_items`/.test(step),
    '#3782: outstanding_debt must not read the cross-population summary.total_items',
  );
  assert.ok(
    !/which respects milestone boundaries/.test(step),
    '#3782: the false whole-query milestone-boundaries claim must be corrected (only the active tree is filtered)',
  );
});

test('#3782: archived debt stays visible with its own labeled line', () => {
  const step = step16();
  assert.ok(
    /archived_debt/.test(step),
    '#3782: archived debt must be tracked as its own value',
  );
  assert.ok(
    /\|\s*Archived milestones\s*\|/.test(step) || /archived verification debt/i.test(step),
    '#3782: the warning section must render archived debt as its own labeled line — segmented, not hidden',
  );
});
