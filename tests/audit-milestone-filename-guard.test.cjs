'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3796 — the audit-milestone report writer and its readers must agree on
// the report's filename.
//
// The single writer line created `.planning/v{version}-v{version}-MILESTONE
// -AUDIT.md` (a doubled version segment) while every downstream reference —
// the step's own heading, the Report pointers, the `cat`, and the completion
// checklist — reads `v{version}-MILESTONE-AUDIT.md`. The report landed at a
// path no reader ever looked at.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUDIT_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'audit-milestone.md');

// audit-milestone.md is shipped workflow text — the bytes ARE what the
// runtime loads; a structural scan over it tests the deployed contract.
test('#3796: the audit report writer and readers agree on the single-version filename', () => {
  const md = fs.readFileSync(AUDIT_MD, 'utf-8');
  assert.ok(
    !md.includes('v{version}-v{version}'),
    '#3796: no doubled version segment may appear anywhere in the workflow',
  );
  const writer = /^Create `\.planning\/v\{version\}-MILESTONE-AUDIT\.md` with:$/m;
  assert.ok(
    writer.test(md),
    '#3796: the writer line must create exactly .planning/v{version}-MILESTONE-AUDIT.md',
  );
  const readers = md.match(/v\{version\}-MILESTONE-AUDIT\.md/g) || [];
  assert.ok(
    readers.length >= 5,
    `the single-version readers (heading, Report pointers, cat, checklist) must remain; found ${readers.length}`,
  );
});
