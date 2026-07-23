/**
 * GSD Tools Tests - UAT Audit
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { buildCheckpoint } = require('../gsd-core/bin/lib/uat.cjs');

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
    // Structural lines (borders, separators, Test N heading, expected content) are untouched.
    assert.ok(japanese.includes('╔══════════════════════════════════════════════════════════════╗'));
    assert.ok(japanese.includes('╚══════════════════════════════════════════════════════════════╝'));
    assert.ok(japanese.includes('──────────────────────────────────────────────────────────────'));
    assert.ok(japanese.includes('**Test 1: Sample**'));
    assert.ok(japanese.includes('Something happens.'));
    assert.notStrictEqual(japanese, english);
  });

  test('buildCheckpoint: every extended-pack alias resolves its localized frame', () => {
    const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
    const english = buildCheckpoint(currentTest);
    // Exercise canonical names, ISO codes, endonyms, and transliterations so a
    // typo or duplicate alias cannot silently route a supported language back
    // to the English fallback.
    const cases = [
      [['Dutch', 'nl', 'nederlands', 'flemish', 'vlaams'], 'CONTROLEPUNT'],
      [['Polish', 'pl', 'polski'], 'PUNKT KONTROLNY'],
      [['Russian', 'ru', 'ru-ru', 'русский'], 'КОНТРОЛЬНАЯ ТОЧКА'],
      [['Ukrainian', 'uk', 'ua', 'українська'], 'КОНТРОЛЬНА ТОЧКА'],
      [['Turkish', 'tr', 'türkçe', 'turkce'], 'KONTROL NOKTASI'],
      [['Hindi', 'hi', 'हिन्दी', 'हिंदी'], 'चेकपॉइंट'],
      [['Arabic', 'ar', 'العربية'], 'نقطة تحقق'],
      [['Vietnamese', 'vi', 'tiếng việt', 'tieng viet'], 'ĐIỂM KIỂM TRA'],
      [['Indonesian', 'id', 'bahasa indonesia'], 'TITIK PEMERIKSAAN'],
    ];
    for (const [aliases, bannerFragment] of cases) {
      for (const alias of aliases) {
        const localized = buildCheckpoint(currentTest, alias);
        assert.ok(localized.includes(bannerFragment), `${alias} banner missing`);
        assert.ok(localized.includes('`pass`'), `${alias} instruction lost the \`pass\` literal`);
        assert.ok(localized.includes('**Test 1: Sample**'), `${alias} structural heading changed`);
        assert.notStrictEqual(localized, english, `${alias} fell back to the English frame`);
      }
    }
  });

  // Regression: #2402 review medium finding — checkpointBoxLine() padded using
  // JS string `.length` (UTF-16 code units), not display width. Japanese/
  // Chinese/Korean use full-width characters that render at 2 terminal
  // columns each, so the padded line was JS-length-correct (64) but visually
  // 8-15 columns too wide, misaligning the right `║` border relative to the
  // box's single-width border lines. Independently recomputes display width
  // (East Asian Width W/F ranges) rather than reading source, so this test
  // fails if the fix regresses even if the banner copy itself later changes.
  describe('checkpoint banner padding uses terminal display width (#2402, #2530)', () => {
    function isWideCodePoint(codePoint) {
      return (
        (codePoint >= 0x1100 && codePoint <= 0x115f) ||
        codePoint === 0x2329 || codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
        (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)
      );
    }
    function displayWidth(text) {
      let width = 0;
      for (const ch of text) {
        if (/\p{Mark}/u.test(ch)) continue;
        width += isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
      }
      return width;
    }

    for (const lang of ['Japanese', 'Chinese', 'Korean', 'Hindi']) {
      test(`${lang} checkpoint banner line renders at display-width 64, aligning the right border`, () => {
        const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
        const output = buildCheckpoint(currentTest, lang);
        const lines = output.split('\n');
        const topBorder = lines[0];
        const bannerLine = lines[1];
        const bottomBorder = lines[2];

        assert.strictEqual(displayWidth(topBorder), 64, 'top border is the 64-column reference width');
        assert.strictEqual(displayWidth(bottomBorder), 64, 'bottom border is the 64-column reference width');
        assert.strictEqual(displayWidth(bannerLine), 64,
          `${lang} banner line must render at the same 64-column display width as the borders — ` +
          'padding by UTF-16 .length under-pads full-width characters and overflows the box');
      });
    }

    test('exact rendered banner lines for Japanese/Chinese/Korean (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      assert.strictEqual(
        buildCheckpoint(currentTest, 'Japanese').split('\n')[1],
        '║  チェックポイント: 検証が必要です                            ║',
      );
      assert.strictEqual(
        buildCheckpoint(currentTest, 'Chinese').split('\n')[1],
        '║  检查点：需要验证                                            ║',
      );
      assert.strictEqual(
        buildCheckpoint(currentTest, 'Korean').split('\n')[1],
        '║  체크포인트: 검증 필요                                       ║',
      );
    });

    test('exact rendered Hindi banner line ignores combining-mark cell width (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      assert.strictEqual(
        buildCheckpoint(currentTest, 'Hindi').split('\n')[1],
        `║  चेकपॉइंट: सत्यापन आवश्यक${' '.repeat(42)}║`,
      );
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
    assert.ok(result.output.includes("Type `pass` or describe what's wrong."));
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

    // Structure/IDs stay untranslated: box borders, the Test N: name line, and the
    // expected content are preserved verbatim.
    assert.ok(result.output.includes('╔══════════════════════════════════════════════════════════════╗'));
    assert.ok(result.output.includes('╚══════════════════════════════════════════════════════════════╝'));
    assert.ok(result.output.includes('──────────────────────────────────────────────────────────────'));
    assert.ok(result.output.includes('**Test 2: Submit form validation**'));
    assert.ok(result.output.includes('Empty submit keeps controls visible.'));
    assert.ok(result.output.includes('Validation error copy is shown.'));
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
      '╔══════════════════════════════════════════════════════════════╗',
      '║  CHECKPOINT: Verification Required                           ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      '**Test 2: Submit form validation**',
      '',
      'Empty submit keeps controls visible.\nValidation error copy is shown.',
      '',
      '──────────────────────────────────────────────────────────────',
      'Type `pass` or describe what\'s wrong.',
      '──────────────────────────────────────────────────────────────',
    ].join('\n');

    assert.strictEqual(result.output, expected);
  });
});
