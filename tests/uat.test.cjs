/**
 * GSD Tools Tests - UAT Audit
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const {
  buildCheckpoint,
  CHECKPOINT_FRAMES,
  CHECKPOINT_LANGUAGE_ALIASES,
  resolveCheckpointFrame,
  parseDeferredItems,
  parseUatItemsWithStats,
} = require('../gsd-core/bin/lib/uat.cjs');

describe('audit-uat command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty results when no UAT files exist', () => {
    // Create a phase directory with no UAT files
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '.gitkeep'), '');

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('detects UAT with pending items', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Login Form
expected: Form displays with email and password fields
result: pass

### 2. Submit Button
expected: Submitting shows loading state
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].phase, '01');
    assert.strictEqual(output.results[0].items[0].result, 'pending');
    assert.strictEqual(output.results[0].items[0].category, 'pending');
    assert.strictEqual(output.results[0].items[0].name, 'Submit Button');
  });

  // Regression: #2273 — bracketed result values [pending], [blocked], [skipped]
  test('detects UAT items with bracketed result values (#2273)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
      '---',
      'status: testing',
      'phase: 01-foundation',
      'started: 2025-01-01T00:00:00Z',
      'updated: 2025-01-01T00:00:00Z',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Login Form',
      'expected: Form displays correctly',
      'result: [pending]',
      '',
      '### 2. Submit Button',
      'expected: Shows loading state',
      'result: [blocked]',
      'blocked_by: #123',
      '',
      '### 3. Error Message',
      'expected: Shows validation error',
      'result: [skipped]',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 3, 'all 3 bracketed items should be detected');
    assert.strictEqual(output.results[0].items[0].result, 'pending', '[pending] should parse as pending');
    assert.strictEqual(output.results[0].items[1].result, 'blocked', '[blocked] should parse as blocked');
    assert.strictEqual(output.results[0].items[2].result, 'skipped', '[skipped] should parse as skipped');
  });

  test('detects UAT with blocked items and categorizes blocked_by', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. API Health Check
expected: Returns 200 OK
result: blocked
blocked_by: server
reason: Server not running locally
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, 'blocked');
    assert.strictEqual(output.results[0].items[0].category, 'server_blocked');
    assert.strictEqual(output.results[0].items[0].blocked_by, 'server');
  });

  test('detects false completion (complete status with pending items)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), `---
status: complete
phase: 03-ui
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Dashboard Layout
expected: Cards render in grid
result: pass

### 2. Mobile Responsive
expected: Grid collapses to single column on mobile
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].status, 'complete');
    assert.strictEqual(output.results[0].items[0].result, 'pending');
  });

  test('extracts human_needed items from VERIFICATION files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), `---
status: human_needed
phase: 04-auth
---

## Automated Checks

All passed.

## Human Verification

1. Test SSO login with Google account
2. Test password reset flow end-to-end
3. Verify MFA enrollment on new device
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 3);
    assert.strictEqual(output.results[0].type, 'verification');
    assert.strictEqual(output.results[0].status, 'human_needed');
    assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    assert.strictEqual(output.results[0].items[0].name, 'Test SSO login with Google account');
  });

  test('scans and aggregates across multiple phases', () => {
    // Phase 1 with pending
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-UAT.md'), `---
status: partial
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Test A
expected: Works
result: pending
`);

    // Phase 2 with blocked
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Test B
expected: Responds
result: blocked
blocked_by: server

### 2. Test C
expected: Returns data
result: skipped
reason: device not available
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_files, 2);
    assert.strictEqual(output.summary.total_items, 3);
    assert.strictEqual(output.summary.by_phase['01'], 1);
    assert.strictEqual(output.summary.by_phase['02'], 2);
  });

  test('milestone scoping filters phases to current milestone', () => {
    // Create a ROADMAP.md that only references Phase 2
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), `# Roadmap

### Phase 2: API Layer
**Goal:** Build API
`);

    // Phase 1 (not in current milestone) with pending
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-UAT.md'), `---
status: partial
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Old Test
expected: Old behavior
result: pending
`);

    // Phase 2 (in current milestone) with pending
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. New Test
expected: New behavior
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Only Phase 2 should be included (Phase 1 not in ROADMAP)
    assert.strictEqual(output.summary.total_files, 1);
    assert.strictEqual(output.results[0].phase, '02');
  });

  test('summary by_category counts are correct', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-billing');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '05-UAT.md'), `---
status: partial
phase: 05-billing
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Payment Form
expected: Stripe elements load
result: pending

### 2. Webhook Handler
expected: Processes payment events
result: blocked
blocked_by: third-party Stripe

### 3. Invoice PDF
expected: Generates downloadable PDF
result: skipped
reason: needs release build

### 4. Refund Flow
expected: Processes refund
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 4);
    assert.strictEqual(output.summary.by_category.pending, 2);
    assert.strictEqual(output.summary.by_category.third_party, 1);
    assert.strictEqual(output.summary.by_category.build_needed, 1);
  });

  test('ignores VERIFICATION files without human_needed or gaps_found status', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), `---
status: passed
phase: 01-foundation
---

## Results

All checks passed.
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  // Regression: #2383 — human_needed items with result: PASS are still reported
  test('ignores human_verification items with result PASS (regression #2383)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '31-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    // This file has status: human_needed in frontmatter but all individual items
    // have result: "PASS" — they should not be reported as outstanding
    fs.writeFileSync(path.join(phaseDir, '31-VERIFICATION.md'), [
      '---',
      'status: human_needed',
      'phase: 31-auth',
      'gaps_remaining: []',
      '---',
      '',
      '## Human Verification',
      '',
      '| # | Item | Result | Evidence |',
      '|---|------|--------|----------|',
      '| 1 | Test SSO login with Google | PASS | Verified 2025-01-15 |',
      '| 2 | Test password reset flow | PASS | Verified 2025-01-15 |',
      '| 3 | Verify MFA enrollment | PASS | Verified 2025-01-15 |',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0,
      `Expected 0 outstanding items but got ${output.summary.total_items} — resolved PASS items should not be counted`);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('ignores human_needed VERIFICATION file when file-level status is passed (regression #2383)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '31-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    // When the frontmatter status is "passed", skip entirely regardless of section content
    fs.writeFileSync(path.join(phaseDir, '31-VERIFICATION.md'), [
      '---',
      'status: passed',
      'phase: 31-auth',
      'gaps_remaining: []',
      '---',
      '',
      '## Human Verification',
      '',
      '1. Test SSO login with Google account',
      '2. Test password reset flow end-to-end',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0,
      `status: passed file should produce 0 outstanding items, got ${output.summary.total_items}`);
    assert.strictEqual(output.summary.total_files, 0);
  });

  // #3511: a cross-phase, stray, or ad-hoc UAT/VERIFICATION file sitting in
  // this phase's directory must not surface under this phase's audit-uat
  // entry; this phase's own UAT/VERIFICATION artifacts must keep reporting
  // exactly as before (non-stray case unchanged).
  test('#3511: cross-phase stray UAT/VERIFICATION files in the same dir do not surface; own artifacts still do', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-foo');
    fs.mkdirSync(phaseDir, { recursive: true });

    // This phase's own UAT — must still report its pending item.
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Own Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));
    // This phase's own VERIFICATION — must still report its human-needed item.
    fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), [
      '---', 'status: human_needed', 'phase: 03-foo', '---', '',
      '## Human Verification', '',
      '1. Own human check',
    ].join('\n'));

    // Cross-phase strays sitting in the SAME directory — token "04", not "03".
    fs.writeFileSync(path.join(phaseDir, '04-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Stray Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
      '---', 'status: human_needed', 'phase: 04-bar', '---', '',
      '## Human Verification', '',
      '1. Stray human check',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.summary.total_files, 2,
      `only this phase's own 2 files must be scanned; got: ${JSON.stringify(output.results.map(r => r.file))}`);
    assert.strictEqual(output.summary.total_items, 2,
      `1 own UAT item + 1 own VERIFICATION item, strays excluded; got: ${output.summary.total_items}`);
    assert.strictEqual(output.summary.by_phase['03'], 2, 'own phase must be credited both items');
    assert.ok(!('04' in output.summary.by_phase), 'the cross-phase stray must not appear in by_phase at all');
    assert.ok(!result.output.includes('04-UAT.md'), 'stray UAT filename must never surface in the output');
    assert.ok(!result.output.includes('04-VERIFICATION.md'), 'stray VERIFICATION filename must never surface in the output');
    assert.ok(output.results.some(r => r.file === '03-UAT.md' && r.items.some(i => i.name === 'Own Test')));
    assert.ok(output.results.some(r => r.file === '03-VERIFICATION.md' && r.items.some(i => i.name === 'Own human check')));
  });

  // #3511 follow-up: over-exclusion check on the #2528 digit-leading-slug
  // family. "05-80-20-cleanup" tokenizes to "05-80-20" (mis-absorbed past
  // the digit run scaffold actually writes into), so a literal token compare
  // excluded the phase's own report — audit-uat reported total_files: 0.
  test('#3511 follow-up: own UAT file still surfaces from the digit-leading-slug dir "05-80-20-cleanup" (over-exclusion check)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-80-20-cleanup');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '05-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Own Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.summary.total_files, 1,
      `own UAT file in a digit-leading-slug dir must still surface; got: ${JSON.stringify(output)}`);
    assert.strictEqual(output.summary.by_phase['05'], 1);
  });

  // Regression: #2286 — parseUatItems never scanned a `## Gaps` section, so a
  // *-UAT.md file recording its only outstanding findings there returned
  // total_items: 0 (false-clean). Boundary: 0 / 1 / 2+ unresolved entries.
  describe('Gaps section scanning (#2286)', () => {
    test('a Gaps-only UAT file with 0 unresolved entries (all resolved) yields no items', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Widget renders with data"',
        '  status: resolved',
        '  reason: "Fixed in follow-up commit"',
        '',
        '- truth: "SC2: Second finding also fixed"',
        '  status: resolved',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 0,
        'resolved Gaps entries must not be counted as outstanding items');
      assert.strictEqual(output.summary.total_files, 0);
    });

    test('a Gaps-only UAT file with exactly 1 unresolved entry and zero ### N. test blocks yields 1 item', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Widget renders with data"',
        '  status: open',
        '  reason: "Missing data binding"',
        '  severity: major',
        '  test: 2',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1, 'total_items must be > 0, not the false-clean 0');
      assert.strictEqual(output.results[0].type, 'uat');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Widget renders with data');
      assert.strictEqual(output.results[0].items[0].result, 'open');
      assert.strictEqual(output.results[0].items[0].reason, 'Missing data binding');
      assert.strictEqual(output.results[0].items[0].test, 2);
    });

    test('a Gaps section with 2+ unresolved entries surfaces all of them and skips the resolved one', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-api');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '02-UAT.md'), [
        '---',
        'status: partial',
        'phase: 02-api',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: First outstanding gap"',
        '  status: failed',
        '  reason: "Endpoint returns 500"',
        '',
        '- truth: "SC2: Second outstanding gap"',
        '  status: open',
        '',
        '- truth: "SC3: Already fixed gap"',
        '  status: resolved',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'exactly the 2 unresolved gaps should be counted, resolved gap excluded');
      const names = output.results[0].items.map((item) => item.name).sort();
      assert.deepStrictEqual(names, ['SC1: First outstanding gap', 'SC2: Second outstanding gap']);
    });

    // Regression: #2286 review HIGH finding — a naive whole-string `key:`
    // scan over a Gaps entry's flattened text matches the FIRST `key:`-shaped
    // substring anywhere, including one embedded inside an EARLIER field's
    // own quoted free-text value. A `truth`/`reason` value that itself
    // contains the literal text "status: resolved" (or "reason:"/"test:")
    // must never hijack the real, later `status:`/`reason:`/`test:` field —
    // the fix parses each field anchored to the START of its own line.
    test('a truth value containing the literal substring "status: resolved" does not suppress the real open status', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "The status: resolved workflow should trigger a banner"',
        '  status: failed',
        '  reason: "Contains a reason: field embedded phrase, and test: 9 too"',
        '  test: 3',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'the genuinely open gap must be surfaced, not dropped because its truth text contains "status: resolved"');
      const item = output.results[0].items[0];
      assert.strictEqual(item.name, 'The status: resolved workflow should trigger a banner');
      assert.strictEqual(item.result, 'failed', 'the REAL status: field must win, not the embedded phrase inside truth');
      assert.strictEqual(item.reason, 'Contains a reason: field embedded phrase, and test: 9 too',
        'the reason value is taken verbatim, including its own embedded colon-bearing phrases');
      assert.strictEqual(item.test, 3, 'the REAL test: field (3) must win, not the "test: 9" phrase embedded in reason');
    });

    // Regression: #2286 review LOW finding — a nested `artifacts:` sub-list
    // (per templates/UAT.md's `## Gaps` schema) must be folded into its
    // parent entry, not mis-split into spurious standalone items.
    test('a Gaps entry with a nested artifacts sub-list parses as exactly one item', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Some behavior"',
        '  status: failed',
        '  reason: "reason text"',
        '  severity: major',
        '  test: 1',
        '  root_cause: ""',
        '  artifacts:',
        '    - src/foo.ts',
        '    - src/bar.ts',
        '  missing: []',
        '  debug_session: ""',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'the nested artifacts sub-list items must not spawn spurious extra Gaps items');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Some behavior');
      assert.strictEqual(output.results[0].items[0].category, 'unknown',
        'a Gaps item with no dedicated category mapping falls back to unknown');
    });

    // Regression: #2286 review item 5 (fail-safe direction) — #2286 is a
    // false-NEGATIVE bug, so a Gaps entry with no parseable `status:` field
    // is surfaced (as result: 'unknown') rather than silently dropped.
    test('a Gaps entry with no status field is surfaced as an unknown-status item (fail-safe)', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '- truth: "SC1: Missing status field entirely"',
        '  reason: "why it is open"',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'a garbled/missing status must SURFACE the entry, not silently drop it');
      assert.strictEqual(output.results[0].items[0].result, 'unknown');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Missing status field entirely');
    });

    test('an empty Gaps section (heading present, no bullets) yields 0 items without throwing', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 0);
      assert.strictEqual(output.summary.total_files, 0);
    });
  });

  // Regression: #2286 — parseVerificationItems never read the frontmatter's
  // structured `human_verification:` YAML array, and never recognized the
  // `### N. <label>` + bold-paragraph body shape shipped by
  // templates/verification-report.md. Boundary: array length 0 / 1 / 2+.
  describe('human_verification frontmatter array + heading shape (#2286)', () => {
    test('an empty human_verification array (length 0) falls back to the body scan', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification: []',
        '---',
        '',
        '## Human Verification',
        '',
        '1. Test SSO login with Google account',
        '2. Test password reset flow end-to-end',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'an empty structured array must fall back to the existing body scan, not report 0');
      assert.strictEqual(output.results[0].items[0].name, 'Test SSO login with Google account');
    });

    test('a populated human_verification array of length 1 is sourced from frontmatter as primary', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - test: "Confirm the widget renders correctly"',
        '---',
        '',
        '## Human Verification',
        '',
        'None — see frontmatter human_verification array.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'total_items must reflect the frontmatter array, not the unstructured body prose');
      // #2286 review LOW finding: extractFrontmatter's generic array-item
      // parser has no notion of nested key/value objects — a `- test: "..."`
      // entry is ALWAYS flattened to the raw post-"- " text, verbatim (only
      // its own wrapping quote is stripped, and only at the string's outer
      // edges). normalizeHumanVerificationEntry deliberately does NOT strip
      // a leading "key:"-shaped prefix (see its doc comment) because doing
      // so is indistinguishable from truncating a legitimate plain string
      // that starts with a word and a colon — so this documented, slightly
      // ugly artifact is the CORRECT (non-data-lossy) output for this shape.
      assert.strictEqual(output.results[0].items[0].name, 'test: "Confirm the widget renders correctly');
      assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    });

    // Regression: #2286 review LOW finding — a plain-string human_verification
    // entry that itself starts with "Word: " must be preserved verbatim, not
    // truncated by a (removed) leading-key-prefix strip.
    test('a plain-string human_verification entry beginning with "Word: " is preserved verbatim', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - "Confirm: the button responds"',
        '---',
        '',
        '## Human Verification',
        '',
        'None.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1);
      assert.strictEqual(output.results[0].items[0].name, 'Confirm: the button responds',
        'a plain string beginning with a word and a colon must not be truncated');
    });

    test('a populated human_verification array of length 2+ takes priority over a differently-shaped body', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - "Confirm SSO login works end to end"',
        '  - "Confirm MFA enrollment banner appears"',
        '---',
        '',
        '## Human Verification',
        '',
        '1. A body-scan item that must NOT be double-counted',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'the structured array is the PRIMARY source and must not union with the body scan');
      const names = output.results[0].items.map((item) => item.name).sort();
      assert.deepStrictEqual(names, ['Confirm MFA enrollment banner appears', 'Confirm SSO login works end to end']);
    });

    test('recognizes the ### N. <label> + bold-paragraph Human Verification body shape', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-widgets');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '05-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 05-widgets',
        '---',
        '',
        '## Human Verification Required',
        '',
        '### 1. Widget render check',
        '**Test:** Confirm the widget appears as expected on the dashboard.',
        '**Expected:** Widget renders with live data within 2 seconds.',
        '**Why human:** Visual rendering cannot be verified by static analysis.',
        '',
        '### 2. Notification banner check',
        '**Test:** Trigger a new notification and confirm the banner appears.',
        '**Expected:** Banner appears within 1 second and auto-dismisses after 5 seconds.',
        '**Why human:** Timing-based UI behavior requires visual confirmation.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'the ### N. + bold-paragraph shape must be recognized instead of returning 0 items');
      assert.strictEqual(output.results[0].items[0].test, 1);
      assert.strictEqual(output.results[0].items[0].name, 'Widget render check');
      assert.strictEqual(output.results[0].items[1].test, 2);
      assert.strictEqual(output.results[0].items[1].name, 'Notification banner check');
      assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    });
  });
});

describe('uat render-checkpoint', () => {
  let tmpDir;
  let uatPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    uatPath = path.join(phaseDir, '01-UAT.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('buildCheckpoint: unset/unrecognized language falls back to English default (#2402)', () => {
    const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
    const defaultOutput = buildCheckpoint(currentTest);
    const explicitEnglish = buildCheckpoint(currentTest, 'English');
    const unrecognized = buildCheckpoint(currentTest, 'Klingon');

    assert.strictEqual(defaultOutput, explicitEnglish, 'unset language should equal the English frame');
    assert.strictEqual(defaultOutput, unrecognized, 'unrecognized language should fall back to the English frame');
    assert.ok(defaultOutput.includes('CHECKPOINT: Verification Required'));
  });

  test('buildCheckpoint: recognized language swaps only the two frame strings (#2402)', () => {
    const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
    const english = buildCheckpoint(currentTest);
    const japanese = buildCheckpoint(currentTest, 'Japanese');

    assert.ok(japanese.includes('チェックポイント'));
    assert.ok(japanese.includes('`pass`'));
    // Structural lines (heading marker, separator, Test N heading, expected content) are untouched.
    assert.ok(japanese.includes('### チェックポイント: 検証が必要です'));
    assert.ok(japanese.includes('---'));
    assert.ok(japanese.includes('**Test 1: Sample**'));
    assert.ok(japanese.includes('Something happens.'));
    assert.ok(!/[╔╗╚╝║]/.test(japanese), 'the box border must be gone (#3028)');
    assert.notStrictEqual(japanese, english);
  });

  test('resolveCheckpointFrame: every extended-pack alias resolves its localized frame', () => {
    // Exercise canonical names, ISO codes, endonyms, and transliterations so a
    // typo or duplicate alias cannot silently route a supported language back
    // to the English fallback.
    const cases = [
      {
        aliases: ['Dutch', 'nl', 'nederlands', 'flemish', 'vlaams'],
        frame: {
          banner: 'CONTROLEPUNT: Verificatie vereist',
          instruction: 'Typ `pass` of beschrijf wat er mis is.',
        },
      },
      {
        aliases: ['Polish', 'pl', 'polski'],
        frame: {
          banner: 'PUNKT KONTROLNY: Wymagana weryfikacja',
          instruction: 'Wpisz `pass` lub opisz, co jest nie tak.',
        },
      },
      {
        aliases: ['Russian', 'ru', 'ru-ru', 'русский'],
        frame: {
          banner: 'КОНТРОЛЬНАЯ ТОЧКА: требуется проверка',
          instruction: 'Введите `pass` или опишите, что не так.',
        },
      },
      {
        aliases: ['Ukrainian', 'uk', 'ua', 'українська'],
        frame: {
          banner: 'КОНТРОЛЬНА ТОЧКА: потрібна перевірка',
          instruction: 'Введіть `pass` або опишіть, що не так.',
        },
      },
      {
        aliases: ['Turkish', 'tr', 'türkçe', 'turkce'],
        frame: {
          banner: 'KONTROL NOKTASI: Doğrulama gerekli',
          instruction: '`pass` yazın veya sorunu açıklayın.',
        },
      },
      {
        aliases: ['Hindi', 'hi', 'हिन्दी', 'हिंदी'],
        frame: {
          banner: 'चेकपॉइंट: सत्यापन आवश्यक',
          instruction: '`pass` लिखें या बताएं कि क्या गलत है।',
        },
      },
      {
        aliases: ['Arabic', 'ar', 'العربية'],
        frame: {
          banner: 'نقطة تحقق: المراجعة مطلوبة',
          instruction: 'اكتب `pass` أو صف المشكلة.',
          direction: 'rtl',
        },
      },
      {
        aliases: ['Vietnamese', 'vi', 'tiếng việt', 'tieng viet'],
        frame: {
          banner: 'ĐIỂM KIỂM TRA: Cần xác minh',
          instruction: 'Nhập `pass` hoặc mô tả vấn đề.',
        },
      },
      {
        aliases: ['Indonesian', 'id', 'bahasa indonesia'],
        frame: {
          banner: 'TITIK PEMERIKSAAN: Verifikasi diperlukan',
          instruction: 'Ketik `pass` atau jelaskan apa yang salah.',
        },
      },
    ];
    for (const { aliases, frame } of cases) {
      for (const alias of aliases) {
        assert.deepStrictEqual(
          resolveCheckpointFrame(alias),
          frame,
          `${alias} resolved to the wrong checkpoint frame`,
        );
      }
    }
  });

  test('checkpoint frame and alias catalogs remain structurally complete', () => {
    const english = CHECKPOINT_FRAMES.english;
    assert.ok(english, 'English fallback frame must exist');

    for (const [language, frame] of Object.entries(CHECKPOINT_FRAMES)) {
      const expectedKeys = frame.direction
        ? ['banner', 'direction', 'instruction']
        : ['banner', 'instruction'];
      assert.deepStrictEqual(
        Object.keys(frame).sort(),
        expectedKeys,
        `${language} has an unexpected checkpoint-frame shape`,
      );
      assert.ok(frame.banner.trim(), `${language} banner must be non-empty`);
      assert.ok(frame.instruction.trim(), `${language} instruction must be non-empty`);
      if (frame.direction !== undefined) {
        assert.strictEqual(frame.direction, 'rtl', `${language} has an unsupported direction`);
      }
      assert.strictEqual(
        CHECKPOINT_LANGUAGE_ALIASES[language],
        language,
        `${language} must self-alias to its canonical frame`,
      );
      if (language !== 'english') {
        assert.notDeepStrictEqual(frame, english, `${language} must not duplicate the English frame`);
      }
    }

    for (const [alias, language] of Object.entries(CHECKPOINT_LANGUAGE_ALIASES)) {
      const frame = CHECKPOINT_FRAMES[language];
      assert.ok(frame, `${alias} targets missing checkpoint frame ${language}`);
      assert.strictEqual(
        resolveCheckpointFrame(alias),
        frame,
        `${alias} must resolve to its declared checkpoint frame`,
      );
      if (language !== 'english') {
        assert.notDeepStrictEqual(
          frame,
          english,
          `${alias} must not resolve to the English fallback`,
        );
      }
    }
  });

  // Two alias keys that differ only by case or Unicode normalization form are
  // distinct object keys — every assertion above still passes. But resolution
  // lowercases and NFC-normalizes before the lookup, so the two collapse to one
  // lookup key at runtime and whichever was written first becomes unreachable:
  // the losing language silently renders the English fallback.
  //
  // Both defects survive compilation and both are observable on the catalog
  // itself, precisely because the keys stay distinct. The remaining case — two
  // byte-identical keys, where the object genuinely no longer records what was
  // written — is rejected by tsc as TS1117 before this suite can run, since the
  // tests execute against `gsd-core/bin/lib/uat.cjs` built from this source.
  test('checkpoint alias catalog declares no colliding or unreachable alias keys', () => {
    const declared = Object.keys(CHECKPOINT_LANGUAGE_ALIASES);

    const seen = new Set();
    const collisions = declared.filter(
      (alias) => seen.size === seen.add(alias.normalize('NFC').toLowerCase()).size,
    );
    assert.deepStrictEqual(
      collisions,
      [],
      `alias key(s) collapse onto an earlier alias once normalized for lookup, so one language silently loses its alias: ${collisions.join(', ')}`,
    );

    // An alias not already in lookup form is the mirror defect: it collides with
    // nothing, and resolveCheckpointFrame() — which normalizes its argument
    // before indexing — can never produce it, so the entry is simply dead.
    const unreachable = declared.filter(
      (alias) => alias !== alias.normalize('NFC').toLowerCase(),
    );
    assert.deepStrictEqual(
      unreachable,
      [],
      `alias key(s) are not in NFC-lowercase lookup form and can never resolve: ${unreachable.join(', ')}`,
    );
  });

  test('resolveCheckpointFrame: canonically equivalent aliases resolve after NFC normalization', () => {
    assert.deepStrictEqual(
      resolveCheckpointFrame('türkçe'.normalize('NFD')),
      resolveCheckpointFrame('türkçe'),
    );
    assert.deepStrictEqual(
      resolveCheckpointFrame('tiếng việt'.normalize('NFD')),
      resolveCheckpointFrame('tiếng việt'),
    );
  });

  // Regression: #3028 — the checkpoint renderer no longer draws a 64-column
  // double-line box (checkpointBoxLine/displayWidth/isWideCodePoint/
  // ZERO_WIDTH_MARK_RE/CHECKPOINT_BOX_WIDTH were removed from src/uat.cts).
  // These cases now pin the heading form (`### {banner}`) directly instead of
  // a padded box interior; the localized-language coverage that used to prove
  // display-width-correct padding now proves the banner text is emitted
  // intact, unpadded, and box-free.
  describe('checkpoint banner renders as a heading, not a box (#2402, #2530, #3028)', () => {
    test('exact rendered banner heading for Japanese/Chinese/Korean (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const japanese = buildCheckpoint(currentTest, 'Japanese');
      const chinese = buildCheckpoint(currentTest, 'Chinese');
      const korean = buildCheckpoint(currentTest, 'Korean');

      assert.strictEqual(japanese.split('\n')[0], '### チェックポイント: 検証が必要です');
      assert.strictEqual(chinese.split('\n')[0], '### 检查点：需要验证');
      assert.strictEqual(korean.split('\n')[0], '### 체크포인트: 검증 필요');

      for (const output of [japanese, chinese, korean]) {
        assert.ok(!/[╔╗╚╝║]/.test(output), 'the box border must be gone (#3028)');
      }
    });

    test('exact rendered Hindi banner heading ignores combining-mark cell width (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const hindi = buildCheckpoint(currentTest, 'Hindi');
      assert.strictEqual(hindi.split('\n')[0], '### चेकपॉइंट: सत्यापन आवश्यक');
      assert.ok(!/[╔╗╚╝║]/.test(hindi), 'the box border must be gone (#3028)');
    });

    test('exact rendered Arabic frame is isolated inside the LTR checkpoint layout', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const arabic = buildCheckpoint(currentTest, 'Arabic');
      // The one behavior the box removal must not disturb: the RTL banner and
      // instruction text stay wrapped in directional isolates.
      assert.strictEqual(
        arabic.split('\n')[0],
        `### ⁧نقطة تحقق: المراجعة مطلوبة⁩`,
      );
      assert.ok(arabic.includes('⁧اكتب `pass` أو صف المشكلة.⁩'));
      assert.ok(!/[╔╗╚╝║]/.test(arabic), 'the box border must be gone (#3028)');
    });

    test('emits an over-long banner intact (no box to overflow)', (t) => {
      // Previously a banner exceeding the 64-column inner width produced a
      // ragged, unpadded border. Now there is no border to overflow — the
      // full heading text is emitted intact regardless of length. None of the
      // shipped frames are long enough to exercise this, so a synthetic frame
      // is registered on the exported (mutable) lookup tables for the
      // duration of the test.
      const longBanner = `${'X'.repeat(80)}: Verification required well beyond the old 64-column box width`;
      const frameKey = '__test_overlong_frame__3028__';
      const aliasKey = '__test_overlong_alias__3028__';
      CHECKPOINT_FRAMES[frameKey] = {
        banner: longBanner,
        instruction: 'Type `pass` or describe what\'s wrong.',
      };
      CHECKPOINT_LANGUAGE_ALIASES[aliasKey] = frameKey;
      t.after(() => {
        delete CHECKPOINT_FRAMES[frameKey];
        delete CHECKPOINT_LANGUAGE_ALIASES[aliasKey];
      });
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const output = buildCheckpoint(currentTest, aliasKey);
      assert.strictEqual(output.split('\n')[0], `### ${longBanner}`,
        'an over-long banner must be emitted in full, not truncated or wrapped');
      assert.ok(!/[╔╗╚╝║]/.test(output), 'no box characters should appear regardless of banner length');
    });
  });

  test('renders the current checkpoint as raw output', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('**Test 2: Submit form validation**'));
    assert.ok(result.output.includes('Empty submit keeps controls visible.'));
    // The instruction line renders as a bold line preceded by a `---` thematic
    // break, not inside a box border (#3028).
    assert.ok(result.output.includes("---\n\n**Type `pass` or describe what's wrong.**"));
  });

  test('strips protocol leak lines from current test copy', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 6
name: Locale copy
expected: |
  English strings render correctly.
  user to=all:final code 彩票平台招商 pass
  Chinese strings render correctly.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(!result.output.includes('user to=all:final code'));
    assert.ok(!result.output.includes('彩票平台'));
    assert.ok(result.output.includes('English strings render correctly.'));
    assert.ok(result.output.includes('Chinese strings render correctly.'));
  });

  test('does not truncate expected text containing the letter Z', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 3
name: Timezone display
expected: |
  Timezone abbreviation shows CET.
  Zero-offset zones display correctly.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('Timezone abbreviation shows CET.'),
      'Expected text before Z-containing word should be present');
    assert.ok(result.output.includes('Zero-offset zones display correctly.'),
      'Expected text starting with Z should not be truncated by \\Z regex bug');
  });

  test('parses expected block when it is the last field in the section', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 4
name: Final field test
expected: |
  This block has no trailing YAML key.
  It ends at the section boundary.
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('This block has no trailing YAML key.'));
    assert.ok(result.output.includes('It ends at the section boundary.'));
  });

  test('resumes paused Current Test placeholder from first pending test (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      'started: 2026-06-15T00:00:00Z',
      'updated: 2026-06-15T00:00:00Z',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 2 items outstanding]',
      '',
      '## Tests',
      '',
      '### 1. First test',
      'expected: something observable',
      'result: pass',
      '',
      '### 2. Second test',
      'expected: another observable thing',
      'result: [pending]',
      '',
      '## Summary',
      '',
      'total: 2',
      'passed: 1',
      'issues: 0',
      'pending: 1',
      'skipped: 0',
      'blocked: 0',
      '',
      '## Gaps',
      '',
      '[none yet]',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.test_number, 2);
    assert.strictEqual(output.test_name, 'Second test');
    assert.strictEqual(output.file_path, '.planning/phases/01-test-phase/01-UAT.md');
  });

  test('raw checkpoint mode accepts paused Current Test placeholder (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 1 item outstanding]',
      '',
      '## Tests',
      '',
      '### 1. First pending test',
      'expected: raw mode checkpoint is available',
      'result: [pending]',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.length > 0, 'raw mode must emit a checkpoint');
  });

  test('non-structured Current Test with no pending tests reports actionable resume error (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 0 items outstanding]',
      '',
      '## Tests',
      '',
      '### 1. Already handled test',
      'expected: completed behavior',
      'result: pass',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, false, 'Should fail when a paused placeholder has no pending test to resume');
    assert.ok(result.error.includes('no pending UAT test remains'));
    assert.ok(!result.error.includes('Current Test section is malformed'));
  });

  test('fails when testing is already complete', () => {
    fs.writeFileSync(uatPath, `---
status: complete
phase: 01-test-phase
---

## Current Test

[testing complete]
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, false, 'Should fail when no current test exists');
    assert.ok(result.error.includes('already complete'));
  });

  // #2402: response_language must reach the checkpoint frame itself — verify-work.md
  // requires the model to reprint the checkpoint byte-for-byte, so translation can't
  // happen after the fact. The renderer has to already emit localized frame strings.
  test('localizes the checkpoint frame when response_language is configured (#2402)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ response_language: 'Spanish' })
    );
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    // Frame strings must be localized, not English.
    assert.ok(!result.output.includes('CHECKPOINT: Verification Required'),
      'banner should be localized, not the English default');
    assert.ok(!result.output.includes("Type `pass` or describe what's wrong."),
      'instruction line should be localized, not the English default');
    assert.ok(result.output.includes('Verificación requerida'), 'banner should be in Spanish');
    assert.ok(result.output.includes('Escribe `pass`'), 'instruction line should be in Spanish');

    // Structure/IDs stay untranslated: the heading marker, the `---` separator,
    // the Test N: name line, and the expected content are preserved verbatim.
    assert.ok(result.output.includes('### PUNTO DE CONTROL: Verificación requerida'));
    assert.ok(result.output.includes('---'));
    assert.ok(result.output.includes('**Test 2: Submit form validation**'));
    assert.ok(result.output.includes('Empty submit keeps controls visible.'));
    assert.ok(result.output.includes('Validation error copy is shown.'));
    assert.ok(!/[╔╗╚╝║]/.test(result.output), 'the box border must be gone (#3028)');
  });

  // Regression guard for the "unset ⇒ byte-identical English" acceptance criterion.
  test('renders byte-identical English checkpoint when response_language is unset (#2402)', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    const expected = [
      '### CHECKPOINT: Verification Required',
      '',
      '**Test 2: Submit form validation**',
      '',
      'Empty submit keeps controls visible.\nValidation error copy is shown.',
      '',
      '---',
      '',
      '**Type `pass` or describe what\'s wrong.**',
    ].join('\n');

    assert.strictEqual(result.output, expected);
  });
});

// ─── cmdAuditUat behavioral coverage (#2287 deferred-items.md) ─────────────

describe('#2287 cmdAuditUat: deferred-items.md awareness', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no deferred-items.md present (0 entries) → no results, no false positive', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '.gitkeep'), '');

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('deferred-items.md with only a resolved entry (0 unresolved) → no result surfaced', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Already handled unrelated lint warning.',
      '  status: resolved',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, [],
      'a fully-resolved deferred-items.md must not surface any result');
    assert.strictEqual(output.summary.total_items, 0);
  });

  test('deferred-items.md with 1 unresolved entry → surfaced in structured JSON output', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Found an unrelated pre-existing test failure in `some-other-module` while working on',
      '  this phase\'s task. Out of scope for this task — logged here per SCOPE BOUNDARY.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.summary.total_files, 1);
    assert.strictEqual(output.summary.by_category.deferred, 1);
    assert.strictEqual(output.summary.by_phase['01'], 1);

    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(deferredResult, 'a deferred-typed result must be present');
    assert.strictEqual(deferredResult.phase, '01');
    assert.strictEqual(deferredResult.file, 'deferred-items.md');
    assert.strictEqual(
      deferredResult.file_path,
      '.planning/phases/01-foundation/deferred-items.md',
    );
    assert.strictEqual(deferredResult.items.length, 1);
    assert.match(deferredResult.items[0].name, /unrelated pre-existing test failure/);
    assert.strictEqual(deferredResult.items[0].result, 'unresolved');
    assert.strictEqual(deferredResult.items[0].category, 'deferred');
  });

  test('deferred-items.md with 2+ entries (mixed resolved/unresolved) → only unresolved surfaced', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- First unrelated finding, still open.',
      '- Second unrelated finding, also still open.',
      '- Third finding, already fixed separately.',
      '  status: resolved',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(deferredResult);
    assert.strictEqual(deferredResult.items.length, 2,
      'exactly the 2 unresolved entries must surface; the resolved 3rd must not');
    const names = deferredResult.items.map(i => i.name);
    assert.ok(names.some(n => n.includes('First unrelated finding')));
    assert.ok(names.some(n => n.includes('Second unrelated finding')));
    assert.ok(!names.some(n => n.includes('Third finding')));
  });

  test('deferred entries surface across multiple phase directories', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });

    fs.writeFileSync(path.join(phase1, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Phase 1 unrelated finding.',
    ].join('\n'));
    fs.writeFileSync(path.join(phase2, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Phase 2 unrelated finding.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const deferredResults = output.results.filter(r => r.type === 'deferred');
    assert.strictEqual(deferredResults.length, 2);
    assert.strictEqual(output.summary.total_items, 2);
    assert.strictEqual(output.summary.by_phase['01'], 1);
    assert.strictEqual(output.summary.by_phase['02'], 1);
  });

  test('an entry with a garbled/missing status fails safe and is surfaced (not silently dropped)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- An entry with no status field at all.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1,
      'missing status must SURFACE the entry, not silently drop it');
  });

  test('existing UAT/VERIFICATION scanning is unchanged when a deferred-items.md is also present', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
      '---',
      'status: testing',
      'phase: 01-foundation',
      'started: 2025-01-01T00:00:00Z',
      'updated: 2025-01-01T00:00:00Z',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Login Form',
      'expected: Form displays with email and password fields',
      'result: pending',
    ].join('\n'));

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- An unrelated out-of-scope finding.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.results.length, 2, 'both the UAT file and deferred-items.md must surface as separate results');
    const uatResult = output.results.find(r => r.type === 'uat');
    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(uatResult, 'existing uat-type result must still be present');
    assert.strictEqual(uatResult.items.length, 1);
    assert.strictEqual(uatResult.items[0].result, 'pending');
    assert.ok(deferredResult, 'new deferred-type result must be present');
    assert.strictEqual(deferredResult.items.length, 1);
  });
});

// ─── forensic_audit workflow-prose source-contract guard (#2287) ──────────

// #2994 fragmentization moved the --forensic-gated forensic_audit step out of
// progress.md into gsd-core/workflows/progress/steps/forensic-audit.md behind
// a section marker. Read that step file directly — it is the sole remaining
// source of the forensic_audit step body these guards assert on.
const PROGRESS_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress', 'steps', 'forensic-audit.md');

describe('#2287 progress.md forensic_audit: deferred-items.md contract', () => {
  const content = fs.readFileSync(PROGRESS_MD, 'utf-8');
  const stepStart = content.indexOf('<step name="forensic_audit">');
  const stepEnd = content.indexOf('</step>', stepStart);
  const section = stepStart !== -1 && stepEnd !== -1 ? content.slice(stepStart, stepEnd) : '';

  test('forensic_audit step exists', () => {
    assert.notEqual(stepStart, -1, 'progress.md (or its extracted progress/steps/forensic-audit.md) must contain the forensic_audit step');
  });

  test('forensic_audit now runs 7 checks (was 6) and globs deferred-items.md', () => {
    assert.ok(/running 7 deep checks/i.test(section),
      'forensic_audit must advertise 7 deep checks (was 6) now that deferred-items.md is read');
    assert.ok(/\.planning\/phases\/\*\/deferred-items\.md/.test(section),
      'forensic_audit must glob .planning/phases/*/deferred-items.md');
  });

  test('the new check reports unresolved deferred items with the same ✓/⚠ semantics as the other checks', () => {
    assert.ok(/check\s*7/i.test(section),
      'a 7th check must be present');
    assert.ok(/unresolved deferred items/i.test(section),
      'the check must be framed around unresolved deferred items');
    assert.ok(/✓[^\n]*no unresolved deferred items/i.test(section),
      'the check must emit a ✓ pass line when no unresolved deferred items exist');
    assert.ok(/⚠[^\n]*unresolved deferred items found/i.test(section),
      'the check must emit a ⚠ warning line when unresolved deferred items exist');
  });

  test('an entry is resolved only via an explicit status: resolved field (fail-safe otherwise)', () => {
    assert.ok(/status:\s*resolved/i.test(section),
      'the resolved/unresolved parsing rule must be documented in the step prose');
  });

  test('the verdict summary now gates on 7 checks (was 6)', () => {
    assert.ok(/after all 7 checks/i.test(section),
      'the verdict section must say "after all 7 checks"');
    assert.ok(/if all 7 checks passed/i.test(section),
      'the verdict section must say "if all 7 checks passed"');
    assert.ok(!/after all 6 checks/i.test(section) && !/if all 6 checks passed/i.test(section),
      'stale "6 checks" phrasing must not remain in the step');
  });
});

// ─── parseDeferredItems property test (#2287) ──────────────────────────────

describe('#2287 parseDeferredItems: property (status: resolved fail-safe)', () => {
  // Single-line entry text: no newlines (would break bullet-entry splitting),
  // non-empty after trim, and never itself SHAPED like a `status:` field line
  // (that would be indistinguishable from a real field regardless of intent).
  const plainText = fc.string({ minLength: 1, maxLength: 40 })
    .map((s) => s.replace(/[\r\n]/g, ' ').trim())
    .filter((s) => s.length > 0 && !/^status:/i.test(s));

  // Decoy: entry text that CONTAINS a `status: resolved`-shaped substring
  // mid-line (not at line start) — must never be misread as a resolved
  // marker, since extractGapEntryFields only recognises a field anchored to
  // the START of its own trimmed line (see parseDeferredItems' doc comment).
  const decoyText = plainText.map((s) => `${s} status: resolved trailing note`);

  const textArb = fc.oneof(plainText, decoyText);
  const entryArb = fc.record({ text: textArb, resolved: fc.boolean() });

  test('property: an entry is surfaced iff it is NOT marked status: resolved; surfaced count == non-resolved count', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 20 }),
        (rawEntries) => {
          // Index-prefix for uniqueness so surfaced items can be mapped back
          // to their source entry unambiguously even with colliding random text.
          const entries = rawEntries.map((e, i) => ({ text: `E${i}_${e.text}`, resolved: e.resolved }));

          const lines = ['## Deferred Items', ''];
          for (const e of entries) {
            lines.push(`- ${e.text}`);
            if (e.resolved) lines.push('  status: resolved');
          }
          const content = lines.join('\n');

          const items = parseDeferredItems(content);
          const surfacedNames = new Set(items.map((it) => it.name));

          const expectedUnresolved = entries.filter((e) => !e.resolved);
          const expectedResolved = entries.filter((e) => e.resolved);

          // Total surfaced count equals the count of non-resolved entries.
          assert.strictEqual(items.length, expectedUnresolved.length);

          // Every non-resolved entry IS surfaced (including status:-shaped
          // decoy substrings embedded mid-line — those must not flip the
          // outcome).
          for (const e of expectedUnresolved) {
            assert.ok(surfacedNames.has(e.text), `expected unresolved entry to surface: ${e.text}`);
          }

          // No status:-resolved entry is EVER surfaced.
          for (const e of expectedResolved) {
            assert.ok(!surfacedNames.has(e.text), `status: resolved entry must never surface: ${e.text}`);
          }

          // Every returned item carries the fixed deferred category/result shape.
          for (const item of items) {
            assert.strictEqual(item.result, 'unresolved');
            assert.strictEqual(item.category, 'deferred');
          }
        }
      )
    );
  });
});

// ─── #2766: archived phase dirs, and GFM-table-shaped deferred/gaps ────────

const UAT_ONE_PENDING = [
  '---',
  'status: partial',
  'phase: 01-foundation',
  '---',
  '',
  '## Current Test',
  '',
  '[awaiting human testing]',
  '',
  '## Tests',
  '',
  '### 1. A scenario nobody ever ran',
  'expected: something observable happens',
  'result: [pending]',
  '',
  '## Summary',
  '',
  'total: 1',
  'pending: 1',
  '',
  '## Gaps',
  '',
].join('\n');

/** Write a UAT file whose `## Gaps` section holds `gapsBody`. */
function uatWithGaps(gapsBody) {
  return [
    '---',
    'status: complete',
    'phase: 50-gaps',
    '---',
    '',
    '## Current Test',
    '',
    '[testing complete]',
    '',
    '## Tests',
    '',
    '### 1. A passing scenario',
    'expected: this one is fine',
    'result: pass',
    '',
    '## Summary',
    '',
    'total: 1',
    'passed: 1',
    '',
    '## Gaps',
    '',
    gapsBody,
    '',
  ].join('\n');
}

// ─── Bug 1: archived phase dirs ───────────────────────────────────────────────

describe('#2766 cmdAuditUat: archived phase directories', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phases ONLY in the archive → items surfaced, not a hard error', () => {
    const archiveDir = path.join(
      tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '01-UAT.md'), UAT_ONE_PENDING);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results.length, 1);
    assert.strictEqual(output.results[0].phase, '01');
    assert.strictEqual(output.results[0].archived_milestone, 'v1.0');
    assert.match(output.results[0].file_path, /milestones\/v1\.0-phases\//);
  });

  test('active and archived trees are both scanned', () => {
    const activeDir = path.join(tmpDir, '.planning', 'phases', '40-current');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '40-UAT.md'), UAT_ONE_PENDING);

    const archiveDir = path.join(
      tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '01-UAT.md'), UAT_ONE_PENDING);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const byPhase = new Map(output.results.map(r => [r.phase, r]));
    assert.ok(byPhase.has('01'), `archived phase missing: ${JSON.stringify([...byPhase.keys()])}`);
    assert.ok(byPhase.has('40'), `active phase missing: ${JSON.stringify([...byPhase.keys()])}`);
    assert.strictEqual(byPhase.get('01').archived_milestone, 'v1.0');
    assert.strictEqual(byPhase.get('40').archived_milestone, undefined);
  });

  test('multiple archived milestones are all scanned', () => {
    for (const [version, phase] of [['v1.0', '01-foundation'], ['v2.0', '07-later']]) {
      const dir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phase);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${phase.slice(0, 2)}-UAT.md`), UAT_ONE_PENDING);
    }

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 2);
    assert.deepStrictEqual(
      output.results.map(r => r.archived_milestone).sort(),
      ['v1.0', 'v2.0'],
    );
  });

  test('an empty active phases dir still succeeds with no items (pre-existing behavior)', () => {
    // createTempProject() ships an empty `.planning/phases/`, so this is the
    // shape the existing uat.test.cjs "no UAT files" case covers — the archive
    // change must not turn it into an error.
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
  });

  test('no phases dir AND no archive still errors — no false all-clear', (t) => {
    // A bare temp dir with a .planning/ that has NO phases subdir and no
    // milestones archive — built from createTempDir rather than by deleting
    // createTempProject's phases dir, so nothing is torn down mid-test.
    const bare = createTempDir();
    t.after(() => cleanup(bare));

    fs.mkdirSync(path.join(bare, '.planning'), { recursive: true });

    const result = runGsdTools('audit-uat --raw', bare);
    assert.strictEqual(result.success, false, 'expected a failure when no phases exist at all');
  });
});

// ─── Bug 2: table-shaped deferred-items.md ────────────────────────────────────

describe('#2766 parseDeferredItems: GFM table shape', () => {
  const names = (md) => parseDeferredItems(md).map(i => i.name);

  test('header + delimiter → header dropped, data rows surfaced', () => {
    assert.deepStrictEqual(
      names([
        '## Discovered during 01-03',
        '',
        '| Test | Failing seeds |',
        '|------|---------------|',
        '| test_a | 0, 1 |',
        '| test_b | 424242 |',
      ].join('\n')),
      ['test_a — 0, 1', 'test_b — 424242'],
    );
  });

  test('later columns are preserved, not truncated to the first cell', () => {
    const [name] = names('| T | seeds |\n|---|---|\n| test_a | 0, 1, 424242 |');
    assert.match(name, /0, 1, 424242/);
  });

  test('headerless table → every row surfaced', () => {
    assert.deepStrictEqual(
      names('| test_a | 0 |\n| test_b | 1 |'),
      ['test_a — 0', 'test_b — 1'],
    );
  });

  test('row marked resolved/done/pass is suppressed', () => {
    assert.deepStrictEqual(
      names([
        '| Test | Seeds | Status |',
        '|---|---|---|',
        '| test_open | 0 | open |',
        '| test_fixed | 1 | resolved |',
        '| test_done | 2 | DONE |',
      ].join('\n')),
      ['test_open — 0 — open'],
    );
  });

  test('two prose-separated tables → each drops its own header', () => {
    assert.deepStrictEqual(
      names([
        '| T1 | x |', '|---|---|', '| one | 1 |',
        '',
        'some prose in between',
        '',
        '| T2 | y |', '|---|---|', '| two | 2 |',
      ].join('\n')),
      ['one — 1', 'two — 2'],
    );
  });

  test('bullets and a table in one file → union, no double-counting', () => {
    const got = names([
      '## Deferred Items',
      '',
      '- a bullet-shaped deferred entry',
      '',
      '| Test | Seeds |',
      '|---|---|',
      '| test_a | 0 |',
    ].join('\n'));
    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.ok(got.some(n => n.includes('bullet-shaped')));
    assert.ok(got.some(n => n.startsWith('test_a')));
  });

  test('bullet-only file unchanged (no regression on #2287)', () => {
    assert.deepStrictEqual(
      names('## Deferred Items\n\n- entry one\n- entry two\n'),
      ['entry one', 'entry two'],
    );
  });

  test('explicit status: resolved bullet still suppressed (no regression on #2287)', () => {
    const got = names(
      '## Deferred Items\n\n- truth: "closed thing"\n  status: resolved\n- truth: "open thing"\n',
    );
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /open thing/);
  });

  test('no table and no bullets → zero items, no throw', () => {
    assert.deepStrictEqual(names('# Notes\n\njust prose, nothing actionable.\n'), []);
  });
});

// ─── #3457: heading-delimited deferred entries ────────────────────────────────

describe('#3457 parseDeferredItems: heading-delimited entries', () => {
  const items = (md) => parseDeferredItems(md);
  const names = (md) => items(md).map(i => i.name);

  test('issue minimal repro: heading + sibling field bullets = ONE item', () => {
    const got = items([
      '# Deferred Items',
      '',
      '## Deferred Items',
      '',
      '### Widget layout suite — 3 failing assertions',
      '',
      '- **What:** three assertions fail on widget alignment.',
      '- **Cause:** a pre-existing uncommitted edit in the working tree.',
      '- **Scope:** out of this plan\'s scope.',
      '- **Disposition:** NOT fixed here; left for a follow-up plan.',
    ].join('\n'));

    assert.strictEqual(got.length, 1, JSON.stringify(got.map(i => i.name)));
    assert.match(got[0].name, /Widget layout suite — 3 failing assertions/);
    assert.match(got[0].name, /three assertions fail/);
    assert.strictEqual(got[0].result, 'unresolved');
    assert.strictEqual(got[0].category, 'deferred');
  });

  test('flat shape: `#` title + `##` entries — title is not an item', () => {
    const got = names([
      '# Deferred Items',
      '',
      '## DEF-01 renderer fix',
      '',
      '- **What:** a.',
      '',
      '## DEF-02 seed drift',
      '',
      '- **What:** b.',
    ].join('\n'));

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^DEF-01 renderer fix/);
    assert.match(got[1], /^DEF-02 seed drift/);
  });

  test('container shape: `##` group label + `###` entries — group is not an item, entries not collapsed', () => {
    // The shape both shallow-boundary rules get wrong: "count all headings"
    // counts the group; "shallowest level" collapses both entries into one.
    const got = names([
      '# Deferred Items',
      '',
      '## Plan 28-02 provenance',
      '',
      '### Entry A — flaky seed',
      '',
      '- **What:** a.',
      '',
      '### Entry B — slow build',
      '',
      '- **What:** b.',
    ].join('\n'));

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^Entry A — flaky seed/);
    assert.match(got[1], /^Entry B — slow build/);
    // A following entry's heading must not be swallowed into the previous
    // entry's name (the pre-fix bullet-split folded it in).
    assert.ok(!got[0].includes('Entry B'), got[0]);
  });

  test('mixed shape: loose preamble bullets before a later heading group stay one-per-bullet', () => {
    const got = names([
      '# Deferred Items',
      '',
      '- loose preamble item one',
      '- loose preamble item two',
      '',
      '## Group under here',
      '',
      '### Entry C',
      '- **What:** c.',
    ].join('\n'));

    assert.deepStrictEqual(
      got.map(n => n.replace(/\s+- \*\*What:\*\*.*$/, '')),
      ['loose preamble item one', 'loose preamble item two', 'Entry C'],
      JSON.stringify(got),
    );
  });

  test('mixed depths: childless `##` entry alongside a `##` group with `###` children — all counted', () => {
    // The case "deepest heading level present" rules miss: the childless ##
    // is shallower than the deepest level in the file but is still an entry.
    const got = names([
      '# Deferred Items',
      '',
      '## Group with children',
      '',
      '### Entry A',
      '- **What:** a.',
      '',
      '### Entry B',
      '- **What:** b.',
      '',
      '## Standalone entry',
      '',
      '- **What:** standalone.',
    ].join('\n'));

    assert.strictEqual(got.length, 3, JSON.stringify(got));
    assert.ok(got.some(n => /^Standalone entry/.test(n)), JSON.stringify(got));
  });

  test('no headings at all → one-bullet-per-item, unchanged names (no regression)', () => {
    assert.deepStrictEqual(
      names('## Deferred Items\n\n- entry one\n- entry two\n'),
      ['entry one', 'entry two'],
    );
  });

  test('bolded `- **Status:** resolved` under a leaf heading resolves the entry', () => {
    const got = names([
      '## Deferred Items',
      '',
      '### Item resolved inline',
      '',
      '- **What:** x.',
      '- **Status:** resolved',
    ].join('\n'));

    assert.deepStrictEqual(got, [], JSON.stringify(got));
  });

  test('bolded `- **Status:** resolved` with no headings: resolves itself, never surfaces as its own item', () => {
    // The issue's negative control: previously count = 2 with a literal
    // `**Status:** resolved` pseudo-entry; must match the bare form's count = 1.
    const got = names('## Deferred Items\n\n- **What:** one deferred item.\n- **Status:** resolved\n');

    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /\*\*What:\*\* one deferred item\./);
    assert.ok(!got.some(n => /Status/.test(n)), JSON.stringify(got));
  });

  test('bare `status: resolved` controls keep working (no regression on #2287)', () => {
    // Headless continuation form.
    assert.strictEqual(names('## Deferred Items\n\n- a\n  status: resolved\n- b\n').length, 1);
    // Bare status as a sibling bullet under a leaf heading.
    assert.strictEqual(names([
      '## Deferred Items',
      '',
      '### Item resolved bare',
      '',
      '- **What:** x.',
      '  status: resolved',
    ].join('\n')).length, 0);
  });

  test('leaf heading over a table-only body → table rows only, no double-count', () => {
    // parseDeferredTableItems owns the rows; the heading must not add an item.
    const got = names([
      '## Discovered during 01-03',
      '',
      '| Test | Failing seeds |',
      '|------|---------------|',
      '| test_a | 0, 1 |',
    ].join('\n'));

    assert.deepStrictEqual(got, ['test_a — 0, 1'], JSON.stringify(got));
  });

  test('prose-only or bare headings contribute no items', () => {
    // "Prose is not an item" is this parser's pre-existing contract (#2766
    // `# Notes` case) — heading mode must not start counting prose sections.
    assert.deepStrictEqual(names('## Deferred Items\n\n### Musings\n\njust prose here.\n'), []);
    assert.deepStrictEqual(names('## Deferred Items\n\n### A bare heading with no body\n'), []);
  });

  test('CRLF files: heading entries still split and resolve', () => {
    const got = names('## Deferred Items\r\n\r\n### Entry\r\n\r\n- **What:** x.\r\n- **Status:** resolved\r\n');

    assert.deepStrictEqual(got, [], JSON.stringify(got));
  });

  test('mid-line `status: resolved` decoy under a heading must not resolve the entry', () => {
    // The #2287 decoy invariant, ported to the heading shape: a status-shaped
    // phrase inside entry prose is never a field.
    const got = items([
      '## Deferred Items',
      '',
      '### Entry with decoy prose',
      '',
      '- note: saw a status: resolved message in the log',
    ].join('\n'));

    assert.strictEqual(got.length, 1, JSON.stringify(got.map(i => i.name)));
    assert.strictEqual(got[0].result, 'unresolved');
  });
});

// ─── Bug 3: table-shaped ## Gaps section ──────────────────────────────────────

describe('#2766 parseGapsItems: GFM table shape', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Run audit-uat over a phase whose UAT file has `gapsBody` as its Gaps section. */
  function gapsItems(gapsBody) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '50-gaps');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '50-UAT.md'), uatWithGaps(gapsBody));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const uat = output.results.find(r => r.type === 'uat');
    return uat ? uat.items : [];
  }

  test('header-mapped table → truth/status/reason/test extracted', () => {
    const items = gapsItems([
      '| Truth | Status | Reason | Test |',
      '|-------|--------|--------|------|',
      '| Login should redirect | failed | User reported a 500 | 1 |',
    ].join('\n'));

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].name, 'Login should redirect');
    assert.strictEqual(items[0].result, 'failed');
    assert.strictEqual(items[0].reason, 'User reported a 500');
    assert.strictEqual(items[0].test, 1);
  });

  test('status: resolved row suppressed, open row kept', () => {
    const items = gapsItems([
      '| Truth | Status |',
      '|-------|--------|',
      '| closed thing | resolved |',
      '| open thing | failed |',
    ].join('\n'));

    assert.strictEqual(items.length, 1, JSON.stringify(items.map(i => i.name)));
    assert.strictEqual(items[0].name, 'open thing');
  });

  test('no status column → surfaced as unknown, not dropped', () => {
    const items = gapsItems('| Truth | Note |\n|---|---|\n| something is off | see logs |');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].result, 'unknown');
    assert.strictEqual(items[0].name, 'something is off');
  });

  test('unrecognizable header → joined cells + unknown status', () => {
    const items = gapsItems('| Alpha | Beta |\n|---|---|\n| xxx | yyy |');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].result, 'unknown');
    assert.match(items[0].name, /xxx/);
    assert.match(items[0].name, /yyy/);
  });

  test('headerless table → explicit resolved cell still suppressed', () => {
    const items = gapsItems('| open thing | failed |\n| closed thing | resolved |');

    assert.strictEqual(items.length, 1, JSON.stringify(items.map(i => i.name)));
    assert.match(items[0].name, /open thing/);
  });

  test('bullets and a table in one Gaps section → union, no double-counting', () => {
    const items = gapsItems([
      '- truth: "a bullet gap"',
      '  status: failed',
      '',
      '| Truth | Status |',
      '|---|---|',
      '| a table gap | failed |',
    ].join('\n'));

    assert.strictEqual(items.length, 2, JSON.stringify(items.map(i => i.name)));
    assert.ok(items.some(i => i.name === 'a bullet gap'));
    assert.ok(items.some(i => i.name === 'a table gap'));
  });

  test('bullet-only Gaps unchanged (no regression on #2286)', () => {
    const items = gapsItems('- truth: "only a bullet"\n  status: failed\n  reason: "because"\n');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].name, 'only a bullet');
    assert.strictEqual(items[0].reason, 'because');
  });
});

describe("#3707: audit-uat must not silently drop outstanding UAT rows", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Shared harness: write one UAT file into a phase directory using the same
  // naming convention (`.planning/phases/01-foundation/01-UAT.md`) the
  // existing `audit-uat command` tests above use. Phase dirs are
  // milestone-window filtered from ROADMAP.md, so an unlisted/invented phase
  // name risks being excluded for an unrelated reason — reusing the
  // established name avoids that entirely.
  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const ISSUE_ROW = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Login Form
expected: Form displays with email and password fields
result: issue
reported: "Button color is wrong"
severity: major
`;

  const BLOCK_SCALAR_ROW = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Wrapped Expected
expected: |
  Line one of the expected behavior.
  Line two of the expected behavior.
result: pending
`;

  const WRAPPED_INLINE_ROW = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Wrapped Inline
expected: Some behavior that wraps onto
  a second indented line
result: blocked
blocked_by: physical-device
`;

  // Post-FIX-1 both block-scalar and wrapped-inline `expected:` rows PARSE
  // (defect 2 is fixed), so a fixture built from them would go green via
  // FIX 1 alone and never exercise FIX 4 (#3707 review note). This fixture
  // instead carries rows with NO `result:` line at all — genuinely
  // unparseable as test rows under every fix — so the file still parses to
  // ZERO items and FIX 4's parse_gap path is the thing actually exercised.
  const ALL_UNPARSEABLE_ROWS = `---
status: partial
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Still Being Written
expected: Something should happen
notes: result not yet recorded

### 2. Also Still Being Written
expected: Another thing should happen
notes: result not yet recorded
`;

  // Control for FIX 4: a zero-item file whose frontmatter status IS the
  // terminal `complete` must stay omitted — this is the case defect 3's old
  // `items.length > 0` guard was legitimately protecting.
  const ALL_UNPARSEABLE_ROWS_COMPLETE = `---
status: complete
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Still Being Written
expected: Something should happen
notes: result not yet recorded
`;

  const UNRECOGNISED_RESULT_ROW = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Odd Result
expected: Something happens
result: wibble
`;

  const PASS_AND_PENDING_ROWS = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Passing Test
expected: Works fine
result: pass

### 2. Pending Test
expected: Still pending
result: pending
`;

  const ALL_PASS_ROWS = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Passing Test
expected: Works fine
result: pass

### 2. Also Passing
expected: Also works fine
result: pass
`;

  const CLASSIC_PENDING_ROW = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Classic Row
expected: Displays correctly
result: pending
`;

  // Defect 1: parseUatItems's result filter is a DROP-list
  // (`pending|skipped|blocked`) that never recognises the template-sanctioned
  // `result: issue` token, so a genuinely outstanding issue row is matched by
  // the regex and then thrown away by the filter. Pre-fix: total_items is 0.
  test("a template-sanctioned `result: issue` row is surfaced", () => {
    writeUat(ISSUE_ROW);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, "issue");
  });

  // Defect 1 (categorization half): categorizeItem has no branch for
  // `result === 'issue'` and falls through to the catch-all 'unknown'.
  // Pre-fix: this never even runs the assertion path because the row above
  // is dropped before categorizeItem sees it — so this too is red pre-fix.
  test("an issue row categorizes as issue, not unknown", () => {
    writeUat(ISSUE_ROW);
    const output = runAudit();
    assert.strictEqual(output.results[0].items[0].category, "issue");
  });

  // Defect 2: the `testPattern` regex requires `expected:` and `result:` to
  // be ADJACENT single lines (`expected:\s*([^\n]+)\nresult:\s*...`), so a
  // `expected: |` block-scalar row — whose continuation lines sit BETWEEN
  // `expected:` and `result:` — never matches the pattern at all. Pre-fix:
  // total_items is 0, the row is invisible with no trace.
  test("a block-scalar `expected: |` row is surfaced", () => {
    writeUat(BLOCK_SCALAR_ROW);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
  });

  // Defect 2 again, inline-wrap variant: an `expected:` value that wraps onto
  // a second indented line also breaks the adjacency the regex requires.
  // Pre-fix: total_items is 0.
  test("a wrapped inline `expected:` row is surfaced", () => {
    writeUat(WRAPPED_INLINE_ROW);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
  });

  // Same defect 2 fixture — pins that once surfaced, the row's own
  // `blocked_by` field (which the regex's failure to match currently
  // discards entirely) is preserved. Pre-fix: there is no item to read
  // `blocked_by` off of.
  test("a wrapped row keeps its blocked_by", () => {
    writeUat(WRAPPED_INLINE_ROW);
    const output = runAudit();
    assert.strictEqual(output.results[0].items[0].blocked_by, "physical-device");
  });

  // Same defect 2 fixture — pins categorizeItem's existing
  // `/device|physical/i` mapping on `blocked_by` still applies once the row
  // is actually surfaced. Pre-fix: there is no item to categorize.
  test("a wrapped blocked row categorizes by its blocked_by", () => {
    writeUat(WRAPPED_INLINE_ROW);
    const output = runAudit();
    assert.strictEqual(output.results[0].items[0].category, "device_needed");
  });

  // Defect 3: cmdAuditUat only pushes a file's result entry when
  // `items.length > 0`. A file whose every row happens to be unparseable
  // (both defect-2 shapes above) parses to zero items and the WHOLE FILE
  // vanishes from the audit — taking its phase and frontmatter `status:`
  // with it. Pre-fix: `by_phase` has no '01' key and `results` is empty.
  test("a file whose rows are all unparseable still reports its phase", () => {
    writeUat(ALL_UNPARSEABLE_ROWS);
    const output = runAudit();
    assert.ok(
      Object.prototype.hasOwnProperty.call(output.summary.by_phase, "01"),
      `expected phase '01' in by_phase, got ${JSON.stringify(output.summary.by_phase)}`,
    );
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry for 01-UAT.md, got ${JSON.stringify(output.results)}`);
  });

  // Defect 3, frontmatter half: the same vanished-file entry would have
  // carried the file's own `status: partial` frontmatter. Pre-fix: there is
  // no entry to read `status` off of.
  test("that entry carries the frontmatter status", () => {
    writeUat(ALL_UNPARSEABLE_ROWS);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry for 01-UAT.md, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.status, "partial");
    assert.strictEqual(entry.parse_gap, true);
  });

  // Control for FIX 4: a zero-item file whose status IS the terminal
  // `complete` stays omitted entirely — parse_gap must not fire for a
  // legitimately-finished file.
  // Round-3 review MAJOR 2: the original fixture wrote `02-UAT.md` into phase
  // dir `01-foundation`. Under #3511 phase scoping, `selectPhaseUatFiles`
  // filters files against the phase dir's OWN token ("01"), so a `02-UAT.md`
  // living in `01-foundation` is never even opened — `entry` was `undefined`
  // for a reason unrelated to the terminal-status guard this test claims to
  // exercise, i.e. vacuously green regardless of whether that guard exists.
  // Using the default (matching) `01-foundation` / `01-UAT.md` pairing makes
  // the file actually reachable, so the assertion is load-bearing on the
  // guard at src/uat.cts (the `status !== 'complete'` check alongside
  // `headingsSeen`), not on phase-scope filtering.
  test("a zero-item file with a complete status is still omitted", () => {
    writeUat(ALL_UNPARSEABLE_ROWS_COMPLETE);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry for 01-UAT.md, got ${JSON.stringify(entry)}`);
  });

  // Defect 1, design-decision case: the fix inverts the DROP-list filter to a
  // PASS set, so an unrecognised token like `result: wibble` — neither a
  // known passing nor a known non-passing token — is surfaced rather than
  // silently dropped. Pre-fix: total_items is 0.
  test("an unrecognised result token is surfaced rather than dropped", () => {
    writeUat(UNRECOGNISED_RESULT_ROW);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
  });

  // CONTROL: `result: pass` must never be surfaced, today or after the fix.
  // This constrains the defect-1 fix — inverting the filter to a PASS set
  // must not swing so far that passing rows become "outstanding".
  test("`result: pass` rows are never surfaced", () => {
    writeUat(PASS_AND_PENDING_ROWS);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, "pending");
  });

  // CONTROL: a file where every row passes must contribute zero items (and
  // therefore, pre-fix, is exactly the case defect 3's `items.length > 0`
  // guard is legitimately protecting — a fully-passing file SHOULD vanish).
  // Strengthened (regression review): the weak `total_items === 0` form
  // stayed green even while a bogus `parse_gap` entry was being emitted for
  // this exact fixture, so also assert `results` carries NO entry at all.
  test("a fully passing file contributes no items", () => {
    writeUat(ALL_PASS_ROWS);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry at all, got ${JSON.stringify(entry)}`);
  });

  // CONTROL: the plain, pre-existing single-line `expected:` + `result:
  // pending` shape must keep working unchanged.
  test("an existing single-line expected + result: pending file is unchanged", () => {
    writeUat(CLASSIC_PENDING_ROW);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].category, "pending");
  });
});

describe("#3707 review: end-anchored result matcher regressed trailing-text rows", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const HEADER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

`;

  // BLOCKER 1: the end-anchored `^result:\s*\[?(\w+)\]?\s*$` matcher yielded
  // NO match — and so silently dropped the row — for any `result:` line
  // carrying trailing text. Each of these three shapes returned an item on
  // origin/next and [] on the regressed commit.
  test("a result: line with a trailing parenthetical is surfaced", () => {
    writeUat(`${HEADER}### 1. Trailing Paren\nexpected: x\nresult: pending (blocked on staging)\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, "pending");
  });

  test("a bracketed result: with a trailing comment is surfaced", () => {
    writeUat(`${HEADER}### 1. Bracket Comment\nexpected: x\nresult: [skipped] # no device\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, "skipped");
  });

  test("a result: line with a trailing dash-clause is surfaced", () => {
    writeUat(`${HEADER}### 1. Dash Clause\nexpected: x\nresult: blocked - waiting\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, "blocked");
  });

  // MAJOR: case-handling split — categorizeItem compared case-sensitively
  // while the PASS check lowercased, so `result: PENDING` / `result: Blocked`
  // fell through to 'unknown' instead of their real category.
  test("result: PENDING categorizes as pending, not unknown", () => {
    writeUat(`${HEADER}### 1. Casing\nexpected: x\nresult: PENDING\n`);
    const output = runAudit();
    assert.strictEqual(output.results[0].items[0].category, "pending");
  });

  test("result: Blocked categorizes as blocked, not unknown", () => {
    writeUat(`${HEADER}### 1. Casing\nexpected: x\nresult: Blocked\n`);
    const output = runAudit();
    assert.strictEqual(output.results[0].items[0].category, "blocked");
  });

  // MINOR: the block previously ended only at the next NUMBERED level-3
  // heading, so a trailing `## Gaps` section was absorbed into the
  // preceding test's block and its unanchored `reason:` scan bled a Gaps
  // entry's own reason onto the last test row.
  test("a trailing ## Gaps section's reason does not bleed onto the prior test", () => {
    writeUat(`${HEADER}### 1. Prior Test\nexpected: x\nresult: pending\n\n## Gaps\n\n- truth: "unrelated finding"\n  status: open\n  reason: GAPS-REASON\n`);
    const output = runAudit();
    const testItem = output.results[0].items.find((i) => i.name === "Prior Test");
    assert.ok(testItem, `expected an item for 'Prior Test', got ${JSON.stringify(output.results[0].items)}`);
    assert.strictEqual(testItem.reason, undefined, `expected no bled reason, got ${JSON.stringify(testItem)}`);
  });
});

describe("#3707 review: parse_gap must reflect headings seen vs. items yielded", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // A Gaps-only UAT file whose sole entry is already resolved must yield no
  // items AND no parse_gap entry — the old `items.length === 0 && status !==
  // 'complete'` signal fired on this fixture even though nothing is
  // outstanding and nothing failed to parse.
  test("a Gaps-only file with 0 unresolved entries yields no items and no parse_gap", () => {
    writeUat(`${FRONTMATTER}## Gaps\n\n- truth: "already handled"\n  status: resolved\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.parse_gap_files, 0);
    assert.strictEqual(output.results.find((r) => r.file === "01-UAT.md"), undefined);
  });

  // An empty `## Gaps` section (heading present, zero bullets) must not
  // throw and must not register as a parse gap.
  test("an empty Gaps section yields 0 items without throwing and no parse_gap", () => {
    writeUat(`${FRONTMATTER}## Gaps\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.parse_gap_files, 0);
    assert.strictEqual(output.results.find((r) => r.file === "01-UAT.md"), undefined);
  });

  // A file whose `### N.` blocks have no `result:` line at all is a genuine
  // parse gap (headings were seen, no item was yielded for any of them, and
  // it was not because they passed).
  test("a file whose test blocks have no result: line at all is a parse_gap", () => {
    writeUat(`${FRONTMATTER}## Tests\n\n### 1. Undrafted\nexpected: something\nnotes: result not yet recorded\n`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.parse_gap, true);
    assert.strictEqual(output.summary.parse_gap_files, 1);
  });
});

describe("#3707 follow-up BLOCKER: a MIXED file must not drop its unparseable rows", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // The old `else if (items.length > 0)` branch discarded `headingsSeen`
  // entirely the instant ANY item existed anywhere in the file — a file with
  // one parseable row plus two unparseable blocks reported total_items: 1,
  // parse_gap_files: 0, parse_gap: undefined, silently losing the two
  // outstanding rows with zero trace.
  test("a mixed file reports the real item AND parse_gap true AND unparsed_blocks 2", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Real Row
expected: x
result: pending

### 2. Missing Result
expected: y
notes: none

### 3. Missing Result Too
expected: z
notes: none
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.items.length, 1);
    assert.strictEqual(entry.items[0].name, "Real Row");
    assert.strictEqual(entry.parse_gap, true);
    assert.strictEqual(entry.unparsed_blocks, 2);
    assert.strictEqual(output.summary.parse_gap_files, 1);
  });

  // Same hole reachable via the Gaps union: all `### N.` test blocks are
  // unparseable but the file also has one open `## Gaps` entry, so
  // `items.length` is 1 via the Gaps path alone — the old guard's
  // `items.length > 0` check never distinguished the SOURCE of the items,
  // so the flag never set even though two test blocks are still unaccounted
  // for.
  test("all test blocks unparseable plus one open Gaps entry also flags parse_gap", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Missing Result
expected: y
notes: none

### 2. Missing Result Too
expected: z
notes: none

## Gaps

- truth: "something open"
  status: open
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.items[0].name, "something open");
    assert.strictEqual(entry.parse_gap, true);
    assert.strictEqual(entry.unparsed_blocks, 2);
    assert.strictEqual(output.summary.parse_gap_files, 1);
  });
});

describe("#3707 follow-up MAJOR: a result: inside a fenced code block must not be read as real", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // `block` was raw slice text and only HEADINGS were fence-stripped, so a
  // fenced code sample's own `result: pending` line was read as the test's
  // real outcome, hiding a genuinely PASSING test behind an outstanding row
  // sourced from an example. origin/next returned null here (a regression).
  test("a fenced result: pending followed by a real result: pass is NOT surfaced", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Fenced Then Real
expected: x
\`\`\`
result: pending
\`\`\`
result: pass
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry at all, got ${JSON.stringify(entry)}`);
  });

  // A fenced-only `result:` with no real one must fabricate no item AND
  // still count as an unparsed block (headingsSeen), not silently vanish.
  test("a fenced-only result: with no real result: yields no item and counts as an unparsed block", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Fenced Only
expected: x
\`\`\`
result: pending
\`\`\`
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.items.length, 0);
    assert.strictEqual(entry.parse_gap, true);
    assert.strictEqual(entry.unparsed_blocks, 1);
  });
});

describe("#3707 follow-up MINOR: headings without a name are still surfaced", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // `^\d+\.\s+` excluded `### 3.` (no name at all) — the heading contributed
  // neither an item nor headingsSeen, so a file made only of these vanished
  // entirely with no trace, the original symptom still reachable.
  test("a file of nameless `### N.` headings with real result: lines is surfaced", () => {
    writeUat(`${FRONTMATTER}## Tests

### 3.
expected: x
result: pending
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].test, 3);
  });

  // Same exclusion for `### 3.Foo` (no space between the number and name).
  test("a file of no-space `### N.Name` headings with real result: lines is surfaced", () => {
    writeUat(`${FRONTMATTER}## Tests

### 3.Foo
expected: x
result: pending
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].test, 3);
    assert.strictEqual(output.results[0].items[0].name, "Foo");
  });
});

describe("#3707 follow-up MINOR: trailing-text-to-reason synthesis is removed", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // `extractTrailingReason` stripped only `#-:`, so `result: [skipped] # no
  // device` yielded reason ", needs device"-shaped text and categorized as
  // device_needed on the regressed commit, where origin/next gave
  // skipped_unresolved. The row must still be surfaced (that's what the
  // blocker required) but with NO synthesized reason, restoring the
  // origin/next categorization.
  test("result: [skipped] # no device is surfaced, has no reason, and categorizes as skipped_unresolved", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Bracket Comment
expected: x
result: [skipped] # no device
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1);
    const item = output.results[0].items[0];
    assert.strictEqual(item.result, "skipped");
    assert.strictEqual(item.reason, undefined);
    assert.strictEqual(item.category, "skipped_unresolved");
  });
});

describe("#3707 follow-up: unparsed_blocks and by_phase 0-valued keys", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // A parse-gap-only phase (zero real items) still gains a `by_phase` key
  // with value 0 — deliberate (see the doc comment at the accumulation
  // site): it distinguishes "scanned, nothing countable" from "never
  // scanned at all".
  test("a parse-gap-only phase gains a by_phase key with value 0", () => {
    writeUat(`${FRONTMATTER}## Tests\n\n### 1. Undrafted\nexpected: something\nnotes: result not yet recorded\n`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0);
    assert.ok(
      Object.prototype.hasOwnProperty.call(output.summary.by_phase, "01"),
      `expected phase '01' in by_phase, got ${JSON.stringify(output.summary.by_phase)}`,
    );
    assert.strictEqual(output.summary.by_phase["01"], 0);
  });
});

describe("#3707 round-3 review: unterminated fence and decimal sub-headings", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  // MINOR 1: an UNTERMINATED fence (opened, never closed, so it runs to the
  // end of this test's own block) must not swallow the real `result:` line
  // that follows it into a false parse_gap. Pre-fix: `stripFencedCode`
  // drops everything from the opener to EOF (including `result: pending`),
  // the field-line scan finds nothing, and the row is silently downgraded to
  // a `headingsSeen`-only parse gap instead of a surfaced item.
  test("an unterminated fence does not swallow a real result: line", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Broken Fence
expected: sample
\`\`\`
sample code
result: pending
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 1, `expected 1 item, got ${JSON.stringify(output)}`);
    assert.strictEqual(output.results[0].items[0].test, 1);
    assert.strictEqual(output.results[0].items[0].name, "Broken Fence");
    assert.strictEqual(output.results[0].items[0].result, "pending");
    // #3078 DEFECT D amends this expectation: the ROW is still surfaced (that
    // is this test's original point — the unterminated fence must not swallow
    // the real `result:` line), but the FILE is now additionally flagged as a
    // parse gap. An unterminated fence swallows everything after it for every
    // downstream markdown consumer — later `### N.` rows and any trailing
    // `## Gaps` section alike — so "some rows parsed" is not evidence the file
    // was read completely. `uat-predicate.cts` already refuses such a file
    // (src/uat-predicate.cts:278-281); the audit now agrees rather than
    // reporting a partially-read file as clean.
    assert.strictEqual(output.results[0].parse_gap, true, JSON.stringify(output.results[0]));
    assert.ok(output.results[0].unparsed_blocks >= 1);
  });

  // MINOR 2: `### 1.2.3 Rollback` is a decimal-numbered level-3 sub-heading,
  // not a `### N.` test heading — the widened `^\d+\.` filter (without the
  // negative lookahead) matched its leading `1.` and parsed it as test 1
  // named "2.3 Rollback", a phantom row. Requiring `^\d+\.(?!\d)` excludes
  // it: the "1." is followed by another digit, so it is not a bare
  // integer-dot heading at all.
  test("a decimal-numbered sub-heading like `### 1.2.3 Rollback` is not parsed as a test row", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1.2.3 Rollback
result: pending
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 0, `expected 0 items, got ${JSON.stringify(output)}`);
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry, got ${JSON.stringify(entry)}`);
  });

  // Regression guard: `### 3.` (no name) and `### 3.Foo` (no space) must
  // still be recognised as test headings after the `(?!\d)` tightening —
  // neither has a digit immediately after the `N.`, so the lookahead does
  // not exclude them.
  test("`### 3.` and `### 3.Foo` are still parsed as test rows", () => {
    writeUat(`${FRONTMATTER}## Tests

### 3.
expected: x
result: pending

### 3.Foo
expected: y
result: blocked
`);
    const output = runAudit();
    assert.strictEqual(output.summary.total_items, 2, `expected 2 items, got ${JSON.stringify(output)}`);
  });
});

// ─── #3078 security review: fence/scalar boundary defects ─────────────────────
//
// Four correctness defects in `parseUatItemsWithStats` (src/uat.cts), all of
// which end the same way: a genuinely outstanding UAT row disappears with NO
// trace and the file reports CLEAN.
//
// Every assertion below checks the row's IDENTITY (test number AND name) and
// not merely the item COUNT plus a result token — a phantom row that STEALS a
// real row's `result:` satisfies count-and-token assertions exactly, which is
// how blocker B was previously (wrongly) cleared.
describe("#3078: fenced/scalar boundaries must never silently drop a UAT row", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

  const FENCE = "```";

  // Renders the FULL item list so a misattribution (a row publishing another
  // row's field) is visible in the failure message rather than hidden behind a
  // bare count mismatch.
  function describeItems(entry) {
    return JSON.stringify(entry ? entry.items : null, null, 2);
  }

  // BLOCKER A. `tokenizeHeadings` is fence-aware, so a BALANCED fence pair
  // opened after test 1 and closed before test 3 makes `### 2.` invisible AS A
  // HEADING — it never enters the token stream, so the per-block loop cannot
  // count it either. Pre-fix: items for 1 and 3 only, headingsSeen 0, no
  // parse_gap, no unparsed_blocks — test 2's `result: blocked` vanishes with
  // ZERO trace, which origin/next's whole-file regex DID surface (a
  // regression, not merely a gap).
  test("a balanced fence straddling `### 2.` flags the file instead of silently dropping the row", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
result: pending

${FENCE}
### 2. Beta
result: blocked
${FENCE}

### 3. Gamma
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);

    // The suppressed row is accounted for, not silently absent.
    assert.strictEqual(entry.parse_gap, true, `expected parse_gap, items were ${describeItems(entry)}`);
    assert.ok(
      entry.unparsed_blocks >= 1,
      `expected unparsed_blocks >= 1, got ${entry.unparsed_blocks}; items ${describeItems(entry)}`,
    );
    assert.strictEqual(output.summary.parse_gap_files, 1);

    // The two VISIBLE rows keep their own identities.
    const byNumber = new Map(entry.items.filter((i) => i.test !== undefined).map((i) => [i.test, i]));
    assert.strictEqual(byNumber.get(1).name, "Alpha", describeItems(entry));
    assert.strictEqual(byNumber.get(1).result, "pending", describeItems(entry));
    assert.strictEqual(byNumber.get(3).name, "Gamma", describeItems(entry));
  });

  // BLOCKER B. A `### N.` line indented 2 spaces inside an `expected: |`
  // block scalar IS a valid ATX heading to markdown (<= 3 leading spaces), so
  // the tokenizer emitted a PHANTOM row that consumed the REAL row's
  // `result:` line. Pre-fix this file yielded exactly
  // `{"test":3,"name":"Fake Row","result":"pending"}` with headingsSeen 0 —
  // one item, result "pending", so a count-and-token assertion passed while
  // test 1 had disappeared entirely. Hence the identity assertions here.
  test("a `### 3.` indented inside an `expected: |` scalar does not steal the real row", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  ### 3. Fake Row
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);

    assert.strictEqual(entry.items.length, 1, describeItems(entry));
    assert.strictEqual(entry.items[0].test, 1, describeItems(entry));
    assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
    assert.strictEqual(entry.items[0].result, "pending", describeItems(entry));
    // The scalar's contents are the row's VALUE, read verbatim.
    assert.strictEqual(entry.items[0].expected, "### 3. Fake Row", describeItems(entry));

    // No phantom row numbered 3 anywhere.
    assert.deepStrictEqual(
      entry.items.filter((i) => i.test === 3),
      [],
      `phantom row 3 present: ${describeItems(entry)}`,
    );
    // Scalar body is VALUE text, never a suppressed heading, so it must not
    // inflate the parse-gap tally either.
    assert.strictEqual(entry.unparsed_blocks, undefined, describeItems(entry));
    assert.strictEqual(entry.parse_gap, undefined, describeItems(entry));
    assert.strictEqual(output.summary.parse_gap_files, 0);
  });

  // BLOCKER C (same root as B, opposite direction). `parseExpectedFromTestBlock`
  // received the RAW slice while the field scans used a fence-STRIPPED copy, so
  // row 1's raw block ran straight into fence-hidden row 2 and published row
  // 2's `expected:` as its own. Pre-fix: row 1 carried
  // `expected: "SECRET-FROM-ROW-2"` and row 2 was silently absent.
  test("a fence-hidden later row's `expected:` is not published by the preceding row", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
result: pending
${FENCE}
### 2. Beta
expected: SECRET-FROM-ROW-2
result: blocked
${FENCE}
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);

    const row1 = entry.items.find((i) => i.test === 1);
    assert.ok(row1, `row 1 missing: ${describeItems(entry)}`);
    assert.strictEqual(row1.name, "Alpha", describeItems(entry));
    assert.notStrictEqual(row1.expected, "SECRET-FROM-ROW-2", `row 1 stole row 2's expected: ${describeItems(entry)}`);
    assert.strictEqual(row1.expected, undefined, describeItems(entry));

    // Row 2 is either surfaced or counted — never silently absent.
    const row2 = entry.items.find((i) => i.test === 2);
    if (!row2) {
      assert.strictEqual(entry.parse_gap, true, `row 2 dropped with no parse gap: ${describeItems(entry)}`);
      assert.ok(entry.unparsed_blocks >= 1, `unparsed_blocks was ${entry.unparsed_blocks}`);
    } else {
      assert.strictEqual(row2.name, "Beta", describeItems(entry));
    }
  });

  // DEFECT D. An unterminated fence swallows the remainder of the document —
  // every later row AND a trailing `## Gaps` section — so pre-fix the file
  // yielded `{items: [], headingsSeen: 0}`, never entered `results` at all, and
  // `parse_gap_files` stayed 0: a WHOLE-FILE false clean. `uat-predicate.cts`
  // already refuses such a file via `analyzeMarkdown(raw).unterminatedFence`
  // (src/uat-predicate.cts:278-281); the audit must agree.
  test("an unterminated fence makes the file a parse gap, not a clean file", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
result: pass

${FENCE}
oops, never closed

## Gaps

- truth: "the export silently truncates"
  status: open
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `unterminated-fence file vanished entirely: ${JSON.stringify(output)}`);
    assert.strictEqual(entry.parse_gap, true, describeItems(entry));
    assert.ok(entry.unparsed_blocks >= 1, `unparsed_blocks was ${entry.unparsed_blocks}`);
    assert.strictEqual(output.summary.parse_gap_files, 1, JSON.stringify(output.summary));
  });

  // DEFECT D, scalar variant. When the unterminated fence opens INSIDE an
  // `expected:` scalar the pre-fix parser reported `unparsed_blocks: 1` while
  // TWO rows had been lost — an undercount that reads as "one minor gap".
  // The unterminated-fence signal is deliberately measured on the RAW document
  // (a masked copy would hide the opener), so this file is flagged AND both
  // rows keep their identities.
  test("an unterminated fence inside an `expected:` scalar still flags the file", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  ${FENCE}
  sample
result: pending

### 2. Beta
result: blocked
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.parse_gap, true, describeItems(entry));
    assert.ok(entry.unparsed_blocks >= 1, `unparsed_blocks was ${entry.unparsed_blocks}`);
    assert.strictEqual(output.summary.parse_gap_files, 1);

    const byNumber = new Map(entry.items.filter((i) => i.test !== undefined).map((i) => [i.test, i]));
    assert.strictEqual(byNumber.get(1).name, "Alpha", describeItems(entry));
    assert.strictEqual(byNumber.get(1).result, "pending", describeItems(entry));
    assert.strictEqual(byNumber.get(2).name, "Beta", describeItems(entry));
    assert.strictEqual(byNumber.get(2).result, "blocked", describeItems(entry));
  });

  // Regression guard for the fixes above: a LEGITIMATE `expected: |` scalar
  // carrying indented prose AND a fenced code sample must still yield its own
  // full value. This is the case that forbids either (a) fence-STRIPPING the
  // block before reading `expected:`, or (b) clipping it at ANY fence opener —
  // the clipper only recognises a COLUMN-0 fence precisely so a nested,
  // necessarily-indented sample cannot truncate the field.
  // Note the sample's own `result: pending` line must NOT become the row's
  // outcome; the real `result: blocked` does.
  test("a legitimate `expected: |` scalar with prose and a fenced sample is read in full", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  The banner renders.
  Then:
  ${FENCE}
  result: pending
  ${FENCE}
  Done.
result: blocked

### 2. Beta
expected: plain inline
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.parse_gap, undefined, describeItems(entry));

    const byNumber = new Map(entry.items.filter((i) => i.test !== undefined).map((i) => [i.test, i]));
    assert.strictEqual(byNumber.get(1).name, "Alpha", describeItems(entry));
    assert.strictEqual(byNumber.get(1).result, "blocked", describeItems(entry));
    assert.strictEqual(
      byNumber.get(1).expected,
      ["The banner renders.", "Then:", FENCE, "result: pending", FENCE, "Done."].join("\n"),
      describeItems(entry),
    );
    assert.strictEqual(byNumber.get(2).name, "Beta", describeItems(entry));
    assert.strictEqual(byNumber.get(2).expected, "plain inline", describeItems(entry));
  });

  // Found while proving the fixes above (#3078): `parseExpectedFromTestBlock`'s
  // block-scalar opener demanded a BARE `\n` after the `|`, so on a CRLF
  // document `expected: |\r\n` never matched it and control fell through to the
  // INLINE arm, which captured the pipe character itself — the row published
  // `expected: "|"` and the whole multi-line value was discarded silently.
  test("a CRLF `expected: |` scalar is read as its value, not as the literal `|`", () => {
    writeUat(
      `${FRONTMATTER}## Tests\n\n### 1. Alpha\nexpected: |\n  first line\n  second line\nresult: pending\n`
        .replace(/\n/g, "\r\n"),
    );
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.items.length, 1, describeItems(entry));
    assert.strictEqual(entry.items[0].test, 1, describeItems(entry));
    assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
    assert.strictEqual(entry.items[0].result, "pending", describeItems(entry));
    assert.strictEqual(entry.items[0].expected, "first line\nsecond line", describeItems(entry));
  });

  // Sibling of the CRLF case: `|-` / `|+` chomping indicators. The READER's
  // opener grammar must admit them — otherwise the field falls through to the
  // inline arm and publishes the literal `"|-"` instead of the value.
  test("an `expected: |-` chomped scalar is read as its value, not as the literal `|-`", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: |-
  chomped value
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
    assert.strictEqual(entry.items[0].expected, "chomped value", describeItems(entry));
  });

  // #3078 follow-up (security review): the reader's opener grammar admitted
  // the chomping indicator (`|-`, `|+`) but not YAML's explicit INDENTATION
  // indicator (`1`-`9`), which may appear before OR after the chomping
  // indicator (`|2`, `|2-`, `|-2`, `>2`, `>2+`, ...). A body under an
  // unrecognised opener was read as the literal opener string, and its
  // `### N.`-shaped lines fed the row-theft class this row-identity assertion
  // guards. Row IDENTITY (number AND name) is asserted for every variant,
  // never just a count, per the finding.
  for (const opener of ["|2", "|2-", "|-2", ">2"]) {
    test(`an \`expected: ${opener}\` scalar with an explicit indentation indicator does not let its body steal row identity`, () => {
      writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: ${opener}
  ### 2. Phantom
  result: pending
result: blocked
`);
      const output = runAudit();
      const entry = output.results.find((r) => r.file === "01-UAT.md");
      assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);

      assert.strictEqual(entry.items.length, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].test, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
      assert.strictEqual(entry.items[0].result, "blocked", describeItems(entry));

      // No phantom row numbered 2, and specifically none named "Phantom".
      assert.deepStrictEqual(
        entry.items.filter((i) => i.test === 2),
        [],
        `phantom row 2 present: ${describeItems(entry)}`,
      );
      assert.ok(
        !entry.items.some((i) => i.name === "Phantom"),
        `a row named Phantom was surfaced: ${describeItems(entry)}`,
      );
    });
  }

  // Regression guard: the plain (no indentation indicator) openers this
  // module already handled must behave exactly as before the fix above.
  for (const opener of ["|", "|-", "|+", ">"]) {
    test(`regression: an \`expected: ${opener}\` scalar (no indentation indicator) keeps its body inert`, () => {
      writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: ${opener}
  ### 2. Phantom
  result: pending
result: blocked
`);
      const output = runAudit();
      const entry = output.results.find((r) => r.file === "01-UAT.md");
      assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);

      assert.strictEqual(entry.items.length, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].test, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
      assert.strictEqual(entry.items[0].result, "blocked", describeItems(entry));
      assert.deepStrictEqual(
        entry.items.filter((i) => i.test === 2),
        [],
        `phantom row 2 present: ${describeItems(entry)}`,
      );
    });
  }

  // #3078 follow-up: the `>` FOLDED-scalar family hit the same
  // silent-field-loss class already fixed twice in this file for `|` — the
  // opener grammar only ever matched `|`, so `expected: >` fell through to
  // the INLINE arm and published the literal `">"` as the value. Assert the
  // EXACT extracted value (not merely non-empty) for every reproduced
  // opener, in both LF and CRLF form.
  for (const [opener, crlf] of [
    ["|", false], ["|-", false], ["|+", false], ["|2", false], ["|2-", false], ["|-2", false],
    [">", false], [">-", false], [">+", false], [">2", false], [">2+", false],
    ["|", true], [">", true],
  ]) {
    test(`\`expected: ${opener}\`${crlf ? " (CRLF)" : ""} extracts the exact value, not the literal opener`, () => {
      let doc = `${FRONTMATTER}## Tests

### 1. Alpha
expected: ${opener}
  first line
  second line
result: pending
`;
      if (crlf) doc = doc.replace(/\n/g, "\r\n");
      writeUat(doc);
      const output = runAudit();
      const entry = output.results.find((r) => r.file === "01-UAT.md");
      assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
      assert.strictEqual(entry.items.length, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].test, 1, describeItems(entry));
      assert.strictEqual(entry.items[0].name, "Alpha", describeItems(entry));
      assert.notStrictEqual(entry.items[0].expected, opener, describeItems(entry));

      const expectedValue = opener.startsWith(">")
        ? "first line second line"
        : "first line\nsecond line";
      assert.strictEqual(entry.items[0].expected, expectedValue, describeItems(entry));
    });
  }

  // #3078 follow-up: `>` folding — a blank line in the body becomes a literal
  // `\n` in the folded output, per YAML's fold semantics (distinct from `|`,
  // which preserves every newline).
  test("an `expected: >` scalar folds a blank line in its body to a newline", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: >
  first paragraph
  still first

  second paragraph
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(
      entry.items[0].expected,
      "first paragraph still first\nsecond paragraph",
      describeItems(entry),
    );
  });
});

// ─── #3078 follow-up: parseFirstPendingTest shares the same exposure ──────────
//
// `parseFirstPendingTest` (src/uat.cts) feeds `cmdRenderCheckpoint` — the same
// tokenizeHeadings-on-raw + raw-block `parseExpectedFromTestBlock` shape as
// `parseUatItemsWithStats`, on the render-checkpoint path a human is shown and
// answers. A phantom row here means the user is asked to confirm a test that
// does not exist, or the real pending test is skipped.
describe("#3078 follow-up: parseFirstPendingTest must not steal rows on the render-checkpoint path", () => {
  let tmpDir;
  let uatPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    const phaseDir = path.join(tmpDir, ".planning", "phases", "01-test-phase");
    fs.mkdirSync(phaseDir, { recursive: true });
    uatPath = path.join(phaseDir, "01-UAT.md");
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const FENCE = "```";
  const FRONTMATTER = `---
status: partial
phase: 01-test-phase
---

## Current Test

[testing paused — 1 item outstanding]

`;

  function renderCheckpoint() {
    const result = runGsdTools(["uat", "render-checkpoint", "--file", ".planning/phases/01-test-phase/01-UAT.md"], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  // BLOCKER B, render-checkpoint surface. A `### 3.` line indented inside an
  // `expected: |` scalar is a valid ATX heading to markdown, so the tokenizer
  // emits a PHANTOM row that steals the real row's `result:` line and the
  // checkpoint would resume/confirm test 3 "Fake Row" instead of test 1
  // "Alpha" — which never disappeared, it just never got a chance to render.
  test("a `### 3.` indented inside an `expected: |` scalar does not become the rendered checkpoint", () => {
    fs.writeFileSync(uatPath, `${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  ### 3. Fake Row
result: pending
`);
    const output = renderCheckpoint();
    // Row identity: the checkpoint is for test 1 "Alpha" — never test 3 /
    // "Fake Row" as the subject under test. `### 3. Fake Row` legitimately
    // appears as row 1's own `expected:` scalar body, so its presence in the
    // checkpoint text is correct and is NOT asserted against here.
    assert.strictEqual(output.test_number, 1, JSON.stringify(output));
    assert.strictEqual(output.test_name, "Alpha", JSON.stringify(output));
    assert.ok(
      output.checkpoint.includes("**Test 1: Alpha**"),
      `checkpoint subject header missing/wrong: ${output.checkpoint}`,
    );
    assert.ok(
      !/\*\*Test 3: Fake Row\*\*/.test(output.checkpoint),
      `checkpoint rendered test 3 "Fake Row" as the subject: ${output.checkpoint}`,
    );
  });

  // BLOCKER C, render-checkpoint surface. `parseExpectedFromTestBlock` reading
  // the RAW block let row 1 run into fence-hidden row 2 and publish row 2's
  // `expected:` as its own in the rendered checkpoint.
  test("a fence-hidden later row's `expected:` is not published in the rendered checkpoint", () => {
    // Row 1 carries its OWN `expected:`. Row 2's `expected:` lives inside a
    // fence and must never leak into row 1's rendered checkpoint.
    fs.writeFileSync(uatPath, `${FRONTMATTER}## Tests

### 1. Alpha
expected: ALPHA-OWN-VALUE
result: pending
${FENCE}
### 2. Beta
expected: SECRET-FROM-ROW-2
result: blocked
${FENCE}
`);
    const output = renderCheckpoint();
    assert.strictEqual(output.test_number, 1, JSON.stringify(output));
    assert.strictEqual(output.test_name, "Alpha", JSON.stringify(output));
    assert.ok(output.checkpoint.includes("ALPHA-OWN-VALUE"), `row 1's own expected missing: ${output.checkpoint}`);
    assert.ok(!/SECRET-FROM-ROW-2/.test(output.checkpoint), `row 1 stole row 2's expected: ${output.checkpoint}`);
  });

  // Honest error path: when row 1 has NO `expected:` of its own and the only
  // reachable `expected:` line lives inside a fence (originally row 2's),
  // render-checkpoint must fail cleanly rather than leak the hidden row's text.
  test("a row whose only reachable expected is fence-hidden fails cleanly instead of leaking it", () => {
    fs.writeFileSync(uatPath, `${FRONTMATTER}## Tests

### 1. Alpha
result: pending
${FENCE}
### 2. Beta
expected: SECRET-FROM-ROW-2
result: pending
${FENCE}
`);
    const result = runGsdTools(["uat", "render-checkpoint", "--file", ".planning/phases/01-test-phase/01-UAT.md"], tmpDir);
    assert.strictEqual(result.success, false, `expected failure, got: ${result.output}`);
    assert.ok(/missing an expected field/.test(result.error), `unexpected error: ${result.error}`);
    assert.ok(!/SECRET-FROM-ROW-2/.test(result.error), `hidden row leaked into error: ${result.error}`);
  });

  // Regression guard: a LEGITIMATE `expected: |` scalar carrying indented
  // prose and a fenced code sample must still render its own full value.
  test("a legitimate `expected: |` scalar with prose and a fenced sample renders in full", () => {
    fs.writeFileSync(uatPath, `${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  The banner renders.
  Then:
  ${FENCE}
  result: pending
  ${FENCE}
  Done.
result: pending
`);
    const output = renderCheckpoint();
    assert.strictEqual(output.test_number, 1, JSON.stringify(output));
    assert.strictEqual(output.test_name, "Alpha", JSON.stringify(output));
    assert.ok(output.checkpoint.includes("The banner renders."), output.checkpoint);
    assert.ok(output.checkpoint.includes(`${FENCE}\nresult: pending\n${FENCE}`), output.checkpoint);
    assert.ok(output.checkpoint.includes("Done."), output.checkpoint);
  });

  // #3078 follow-up (security review), render-checkpoint surface: an
  // `expected: |2` scalar (explicit indentation indicator) must mask its body
  // on this path too — otherwise the rendered checkpoint would confirm a
  // phantom test 2 "Phantom" instead of the real, pending test 1 "Alpha".
  test("an `expected: |2` scalar with an explicit indentation indicator does not become the rendered checkpoint", () => {
    fs.writeFileSync(uatPath, `${FRONTMATTER}## Tests

### 1. Alpha
expected: |2
  ### 2. Phantom
  result: pending
result: pending
`);
    const output = renderCheckpoint();
    assert.strictEqual(output.test_number, 1, JSON.stringify(output));
    assert.strictEqual(output.test_name, "Alpha", JSON.stringify(output));
    assert.ok(
      output.checkpoint.includes("**Test 1: Alpha**"),
      `checkpoint subject header missing/wrong: ${output.checkpoint}`,
    );
    assert.ok(
      !/\*\*Test 2: Phantom\*\*/.test(output.checkpoint),
      `checkpoint rendered a phantom test 2 "Phantom": ${output.checkpoint}`,
    );
  });
});

// ─── #3078 review follow-up: astral (surrogate-pair) characters in a row name ──
//
// A test NAME carrying emoji plus an `expected: |` scalar body containing a
// `### 3.` line and a `result:` line once published a phantom row 3 and stole
// the real row's fields: the scalar masker measured offsets in UTF-16 units but
// spliced into a CODE POINT array, so every astral character earlier in the
// document shifted a later mask write one slot right. The masker is gone — the
// `### 3.` line is inert because it is INDENTED, and no character-splicing
// happens anywhere — so this class is now structurally unreachable. These
// fixtures stay as the behavioural pin.
describe("#3078 review: an astral (emoji) row name never yields a phantom row", () => {
  function fixtureWithEmoji(emojiCount) {
    const emoji = "\u{1F600}".repeat(emojiCount);
    return `## Tests

### 1. Row ${emoji}
expected: |
  ### 3. Phantom
result: blocked
`;
  }

  for (const emojiCount of [1, 3, 6, 10]) {
    test(`a name with ${emojiCount} emoji keeps row 1 intact with no phantom row 3`, () => {
      const { items, headingsSeen } = parseUatItemsWithStats(fixtureWithEmoji(emojiCount));
      const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

      assert.strictEqual(items.length, 1, describeAll());
      assert.strictEqual(items[0].test, 1, describeAll());
      assert.strictEqual(items[0].name, `Row ${"\u{1F600}".repeat(emojiCount)}`, describeAll());
      assert.strictEqual(items[0].result, "blocked", describeAll());
      assert.strictEqual(items[0].expected, "### 3. Phantom", describeAll());

      assert.deepStrictEqual(
        items.filter((i) => i.test === 3),
        [],
        `phantom row 3 present: ${describeAll()}`,
      );
      assert.strictEqual(headingsSeen, 0, describeAll());
    });
  }

  // Same fixture through the render-checkpoint path (`parseFirstPendingTest`
  // shares the column-0 heading rule) must resume test 1, never a phantom.
  describe("render-checkpoint path", () => {
    let tmpDir;
    let uatPath;

    beforeEach(() => {
      tmpDir = createTempProject();
      const phaseDir = path.join(tmpDir, ".planning", "phases", "01-test-phase");
      fs.mkdirSync(phaseDir, { recursive: true });
      uatPath = path.join(phaseDir, "01-UAT.md");
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    const FRONTMATTER = `---
status: partial
phase: 01-test-phase
---

## Current Test

[testing paused — 1 item outstanding]

`;

    test("renders test 1 with its emoji name intact, not a phantom row 3", () => {
      const emoji = "\u{1F600}\u{1F601}\u{1F602}";
      fs.writeFileSync(
        uatPath,
        `${FRONTMATTER}## Tests

### 1. Row ${emoji}
expected: |
  ### 3. Phantom
result: pending
`,
      );
      const result = runGsdTools(
        ["uat", "render-checkpoint", "--file", ".planning/phases/01-test-phase/01-UAT.md"],
        tmpDir,
      );
      assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.test_number, 1, JSON.stringify(output));
      assert.strictEqual(output.test_name, `Row ${emoji}`, JSON.stringify(output));
      assert.ok(
        output.checkpoint.includes(`**Test 1: Row ${emoji}**`),
        `checkpoint subject header missing/wrong: ${output.checkpoint}`,
      );
      assert.ok(
        !/\*\*Test 3: Phantom\*\*/.test(output.checkpoint),
        `checkpoint rendered a phantom test 3 "Phantom": ${output.checkpoint}`,
      );
    });
  });

});

// ─── #3078 review follow-up: shortfall counter must not over-count documentation ──
//
// MINOR 1: `TEST_HEADING_LINE_RE` used to be scanned over the scalar-masked
// copy but not fence-stripped, so a `### N.`-shaped line inside a properly
// CLOSED fenced code sample — the ordinary way to document the UAT row format
// inside a UAT file — counted as a "suppressed row" `tokenizeHeadings`
// correctly hid, flagging a `parse_gap` against nothing.
describe("#3078 review MINOR 1: a documented row-format sample inside a closed fence must not inflate the shortfall counter", () => {
  test("a clean pending row plus a `## Notes` fence containing `### 9. Example row` yields no parse_gap", () => {
    const content = `## Tests

### 1. Alpha
result: pending

## Notes

\`\`\`
### 9. Example row
result: pending
\`\`\`
`;
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(items[0].name, "Alpha", describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // Regression guard: the fence-straddle BLOCKER this same counter exists to
  // catch is ALSO a "properly closed" fence — closedness alone cannot
  // distinguish documentation from a genuinely hidden row, so this must still
  // flag. What differs is section: the straddle lives INSIDE `## Tests`.
  test("a fence straddling two real rows INSIDE `## Tests` still flags a parse_gap", () => {
    const FENCE = "```";
    const content = `## Tests

### 1. Alpha
result: pending

${FENCE}
### 2. Beta
result: blocked
${FENCE}

### 3. Gamma
result: pending
`;
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.ok(headingsSeen >= 1, `expected a flagged shortfall, got ${describeAll()}`);
    const byNumber = new Map(items.filter((i) => i.test !== undefined).map((i) => [i.test, i]));
    assert.strictEqual(byNumber.get(1).name, "Alpha", describeAll());
    assert.strictEqual(byNumber.get(3).name, "Gamma", describeAll());
  });
});

// ─── #3078 review follow-up: clipBlockAtFirstFence must not drop a late expected: ──
//
// MINOR 2: clipping was unconditional on field order, so an `expected:`
// appearing AFTER a fenced sample in the same block was discarded even when it
// sat entirely outside the fence. Fix distinguishes "expected after the fence
// closes" from "expected inside the fence" by tracking fence open/close state
// (on the scalar-masked copy) and reconstructing the block with every
// TOP-LEVEL fenced region dropped: an `expected:` that survives that
// reconstruction was outside every fence (i.e. after one closed); an
// `expected:` that never survives it was inside one and stays unreachable —
// the anti-theft property is unchanged.
describe("#3078 review MINOR 2: an expected: after a closed fence must survive; one inside a fence must not", () => {
  const FENCE = "```";

  test("an `expected:` after a closed fence is preserved", () => {
    const content = `## Tests

### 1. Alpha
result: pending
${FENCE}
sample
${FENCE}
expected: THE REAL VALUE
`;
    const { items } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify(items, null, 2);
    const row1 = items.find((i) => i.test === 1);
    assert.ok(row1, describeAll());
    assert.strictEqual(row1.expected, "THE REAL VALUE", describeAll());
  });

  test("an `expected:` living strictly inside a fence is still not stolen", () => {
    const content = `## Tests

### 1. Alpha
result: pending
${FENCE}
expected: SECRET-INSIDE
${FENCE}
`;
    const { items } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify(items, null, 2);
    const row1 = items.find((i) => i.test === 1);
    assert.ok(row1, describeAll());
    assert.notStrictEqual(row1.expected, "SECRET-INSIDE", `fence-hidden expected was stolen: ${describeAll()}`);
    assert.strictEqual(row1.expected, undefined, describeAll());
  });
});

// ─── #3078 follow-up: indented fence delimiter must not reach tokenizeHeadings ──
//
// Escalated design call, answered as option (b): dropping the scalar masker
// for the column-0 heading filter fixed the phantom-heading theft, but
// exposed a SECOND thing masking used to do — hide an indented fence
// delimiter from `tokenizeHeadings` itself. `tokenizeHeadings` is a
// CommonMark scanner with its own {0,3}-space fence tolerance, so a 2-space
// fence opener inside an `expected: |` scalar body still opens a real fence
// AS FAR AS THE TOKENIZER IS CONCERNED — the fence's matching closer (also
// indented, also inside a LATER row's own scalar body, so the pair reads as
// TERMINATED at the whole-document level) sits past `### 2. Beta`'s heading
// line, which is never returned as a token at all. This is a DIFFERENT
// failure mode from every other #3078 fixture above: it does not trip the
// document-wide `unterminatedFence` DEFECT-D signal (a real closer exists),
// so the row is not merely a counted parse-gap shortfall — pre-fix it is
// swallowed cleanly, with `parse_gap` never even set. Option (a) — asserting
// row 2 as "counted, not surfaced" — would have shipped exactly this
// silent-drop as permanent, intended behaviour; asserting row IDENTITY here
// (number AND name, not merely a count) is what forbids that.
describe("#3078 follow-up: an indented fence delimiter must not reach tokenizeHeadings", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;
  const FENCE = "```";

  function writeUat(content, phaseDirName = "01-foundation", fileName = "01-UAT.md") {
    const phaseDir = path.join(tmpDir, ".planning", "phases", phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, fileName), content);
  }

  function runAudit() {
    const result = runGsdTools("audit-uat --raw", tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  test("an indented fence opener inside an `expected:` scalar, closed inside a LATER row's own scalar, still surfaces the row between them by identity", () => {
    writeUat(`${FRONTMATTER}## Tests

### 1. Alpha
expected: |
  ${FENCE}
  sample
result: pending

### 2. Beta
result: blocked

### 3. Gamma
expected: |
  ${FENCE}
result: pending
`);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.parse_gap, undefined, JSON.stringify(entry, null, 2));

    const byNumber = new Map(entry.items.filter((i) => i.test !== undefined).map((i) => [i.test, i]));
    assert.strictEqual(byNumber.get(1).name, "Alpha", JSON.stringify(entry, null, 2));
    assert.strictEqual(byNumber.get(2).name, "Beta", JSON.stringify(entry, null, 2));
    assert.strictEqual(byNumber.get(2).result, "blocked", JSON.stringify(entry, null, 2));
    assert.strictEqual(byNumber.get(3).name, "Gamma", JSON.stringify(entry, null, 2));
  });
});
