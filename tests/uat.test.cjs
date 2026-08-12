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
  checkpointBoxLine,
  parseDeferredItems,
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

  // Regression: #2402 review medium finding — checkpointBoxLine() padded using
  // JS string `.length` (UTF-16 code units), not display width. The property
  // below supplies an independent, category-labelled cell-width oracle rather
  // than copying the implementation's Unicode range logic.
  describe('checkpoint banner padding uses terminal display width (#2402, #2530)', () => {
    test('property: category-labelled strings are padded to a 62-cell interior', () => {
      const oneCell = fc.constantFrom(
        { text: 'a', width: 1 },
        { text: '7', width: 1 },
        { text: ' ', width: 1 },
        { text: '\u093e', width: 1 }, // Mc: DEVANAGARI VOWEL SIGN AA
        { text: '\u093f', width: 1 }, // Mc: DEVANAGARI VOWEL SIGN I
        { text: '\u0949', width: 1 }, // Mc: DEVANAGARI VOWEL SIGN CANDRA O
      );
      const zeroCell = fc.constantFrom(
        { text: '\u0301', width: 0 }, // Mn: COMBINING ACUTE ACCENT
        { text: '\u093c', width: 0 }, // Mn: DEVANAGARI SIGN NUKTA
        { text: '\u20dd', width: 0 }, // Me: COMBINING ENCLOSING CIRCLE
        { text: '\u200d', width: 0 }, // Cf: ZERO WIDTH JOINER
        { text: '\u2066', width: 0 }, // Cf: LEFT-TO-RIGHT ISOLATE
        { text: '\u2069', width: 0 }, // Cf: POP DIRECTIONAL ISOLATE
      );
      const twoCell = fc.constantFrom(
        { text: '界', width: 2 },
        { text: '語', width: 2 },
        { text: '한', width: 2 },
      );

      fc.assert(fc.property(
        fc.array(fc.oneof(oneCell, zeroCell, twoCell), { maxLength: 35 }),
        (cells) => {
          const text = cells.map((cell) => cell.text).join('');
          const textWidth = cells.reduce((sum, cell) => sum + cell.width, 0);
          const padding = ' '.repeat(Math.max(0, 60 - textWidth));
          assert.strictEqual(
            checkpointBoxLine(text),
            `║  ${text}${padding}║`,
          );
        },
      ));
    });

    test('padding boundary: width limit-1, limit, and limit+1', () => {
      for (const width of [59, 60, 61]) {
        const text = 'a'.repeat(width);
        assert.strictEqual(
          checkpointBoxLine(text),
          `║  ${text}${' '.repeat(Math.max(0, 60 - width))}║`,
          `unexpected rendering at text width ${width}`,
        );
      }
    });

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
        `║  चेकपॉइंट: सत्यापन आवश्यक${' '.repeat(40)}║`,
      );
    });

    test('exact rendered Arabic frame is isolated inside the LTR checkpoint layout', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const arabic = buildCheckpoint(currentTest, 'Arabic');
      assert.strictEqual(
        arabic.split('\n')[1],
        `║  \u2067نقطة تحقق: المراجعة مطلوبة\u2069${' '.repeat(34)}║`,
      );
      assert.ok(arabic.includes('\u2067اكتب `pass` أو صف المشكلة.\u2069'));
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
