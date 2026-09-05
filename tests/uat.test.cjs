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
  parseDeferredItemsWithStatus,
  acknowledgeDeferredItem,
  parseUatItems,
  parseUatItemsWithStats,
  DEFERRED_MARKER_ALT,
  DEFERRED_BULLET_MARKERS,
  parseVerificationItems,
  parsedEntriesFor,
} = require('../gsd-core/bin/lib/uat.cjs');
const { iterateBullets } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

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
  describe('Gaps separator lines are not items (#3898)', () => {
    // The reporter's exact measurement table: every separator shape must
    // yield ONLY the real entry. A spaced hyphen break matched the item
    // opener regex (/^(\s*)-\s/) and fabricated a gap named '- -' with
    // result 'unknown' — unfixable by editing any entry, because there is
    // no entry, only the separator the author put there deliberately.
    const mkDoc = (sep) => [
      '---', 'status: partial', 'phase: 01-x', '---', '',
      '## Gaps', '',
      sep,
      '- truth: real', '  status: open', '',
    ].join('\n');

    const SEPARATORS = [
      '- - -',
      '- -',
      '-  -  -',
      '- - - -',
      '  - - -',
      // unaffected forms stay unaffected (accidentally today, by handling after the fix)
      '---',
      '----',
      '* * *',
      '___',
    ];
    for (const sep of SEPARATORS) {
      test(`separator ${JSON.stringify(sep)} yields only the real entry`, () => {
        const items = parseUatItems(mkDoc(sep));
        assert.deepStrictEqual(
          items.map((i) => i.name),
          ['real'],
          `a thematic break must be a separator, not an entry (#3898); got ${JSON.stringify(items.map((i) => i.name))}`,
        );
      });
    }

    test('property: any bullet line whose remainder is only hyphens/spaces (>=2 hyphens) yields no item', () => {
      // CLAUDE.md's parser-contract convention: table coverage above, property
      // coverage here — arbitrary spacings and counts, not just the table's nine.
      fc.assert(fc.property(
        fc.integer({ min: 2, max: 6 }),        // extra hyphens
        fc.integer({ min: 0, max: 3 }),        // leading indent
        fc.integer({ min: 1, max: 3 }),        // spaces between hyphens
        (hyphens, indent, gap) => {
          const pad = ' '.repeat(indent);
          const sep = pad + Array(hyphens + 1).fill('-').join(' '.repeat(gap));
          const items = parseUatItems(mkDoc(sep));
          return items.length === 1 && items[0].name === 'real';
        },
      ), { seed: 20260829, numRuns: 60 });
    });

    test('#3898 review: a separator inside a live entry keeps its span contiguous (ack-able)', () => {
      // Disposition (a): a separator deeper than baseIndent folds back as a
      // continuation line, so entry lines and the entry's byte span agree —
      // the ack writer's identity re-verification still matches.
      const items = parseUatItems([
        '---', 'status: partial', 'phase: 01-x', '---', '',
        '## Gaps', '',
        '- truth: real', '  - - -', '  status: open', '',
      ].join('\n'));
      assert.deepStrictEqual(items.map((i) => i.name), ['real']);
    });

    test('a real entry whose text starts with a hyphen is still an entry (no over-skip)', () => {
      const items = parseUatItems([
        '---', 'status: partial', 'phase: 01-x', '---', '',
        '## Gaps', '',
        '- truth: "-5 error budget remaining"', '  status: open', '',
      ].join('\n'));
      assert.deepStrictEqual(items.map((i) => i.name), ['-5 error budget remaining']);
    });
  });

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

    // ─── #3879 review round 4, Major: `status:` is authoritative ──────────────
    //
    // A `resolution:` note beside a status that is not `resolved` is an
    // authoring mistake, not a closure assertion — the rule `validateResolution`
    // (probe-core.cts) already applies to this same field pair, where it rejects
    // the combination outright rather than counting the item as closed. A
    // reporter cannot throw, so the fail-safe equivalent is to SURFACE the item.
    // Dropping it would be the silently-vanishing-item defect #3850 exists to
    // close, reached by field COMBINATION instead of file STATUS.

    test('a human_verification entry whose status contradicts its resolution still surfaces', () => {
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "Retry the upload"
    status: failed
    resolution: "attempted retry, still failing"
---
`, 'human_needed');
      assert.strictEqual(items.length, 1);
    });

    test('a gaps entry carrying only a resolution note surfaces — gaps closes on status alone', () => {
      // `parseGapsItems`, the `## Gaps` markdown reader, closes on
      // `status: resolved` and nothing else. This frontmatter reader takes that
      // rule verbatim so the same authored entry cannot read closed in one and
      // open in the other.
      const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "The widget renders"
    resolution: "a note, not a closure assertion"
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].result, 'unknown');
    });

    test('a gaps entry whose status contradicts its resolution still surfaces', () => {
      const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "The widget renders"
    status: failed
    resolution: "attempted retry, still failing"
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].result, 'failed');
    });

    // ─── #3879 review round 4, Minor 2: the alignment guard ──────────────────
    //
    // `parsedEntriesFor` pairs the display array with the parsed array BY INDEX
    // and degrades to all-null if their lengths disagree, so a mis-paired index
    // can never close the wrong row. That branch is unreachable through the two
    // readers — both parsers share `frontmatterRegion`, and the display step is
    // 1:1 — so it is asserted against the function directly. Called with the
    // real content the readers pass, plus a `flattened` array of the wrong
    // length, which is exactly the drift the guard exists to catch.

    describe('parsedEntriesFor: index pairing and its degradation', () => {
      const doc = `---
status: gaps_found
gaps:
  - truth: "first"
    status: failed
  - truth: "second"
    status: resolved
---
`;

      test('pairs each display entry with its own parsed object', () => {
        const paired = parsedEntriesFor(doc, 'gaps', ['first-display', 'second-display']);
        assert.equal(paired.length, 2);
        assert.equal(paired[0].truth, 'first');
        assert.equal(paired[1].truth, 'second');
      });

      test('a length disagreement degrades to all-null — no entry is skipped as closed', () => {
        // Over-reporting is the correct degradation: a wrong index would name a
        // DIFFERENT entry's fields and close the wrong row.
        const shorter = parsedEntriesFor(doc, 'gaps', ['only-one']);
        assert.deepEqual(shorter, [null]);
        const longer = parsedEntriesFor(doc, 'gaps', ['a', 'b', 'c']);
        assert.deepEqual(longer, [null, null, null]);
      });

      test('a non-object entry is null at its own index, not dropped', () => {
        const mixed = `---
gaps:
  - truth: "an object"
  - a bare scalar
---
`;
        const paired = parsedEntriesFor(mixed, 'gaps', ['x', 'y']);
        assert.equal(paired.length, 2);
        assert.equal(paired[0].truth, 'an object');
        assert.equal(paired[1], null);
      });

      test('an absent key degrades to all-null rather than throwing', () => {
        assert.deepEqual(parsedEntriesFor('---\nother: 1\n---\n', 'gaps', ['a', 'b']), [null, null]);
      });
    });

    test('both closure spellings still close a human_verification entry', () => {
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "Answered"
    resolution: "RESOLVED"
  - test: "Also answered"
    status: resolved
  - test: "Still open"
    status: partial
---
`, 'human_needed');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].test, 3, 'the surfaced entry keeps its original row');
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
      // ADR-3473 §8.1 (#3881): pre-migration, extractFrontmatter's hand-rolled array-item
      // scanner had no notion of nested key/value objects — a `- test: "..."` entry was
      // flattened via a REGEX quote-strip (`.replace(/^["']|["']$/g, '')`) that only ever
      // matches a quote at the very start or very end of the WHOLE post-"- " string. Since
      // this string starts with `test:` (not a quote), only the regex's END anchor matched,
      // stripping the trailing `"` but leaving the opening one embedded mid-string — a
      // documented but genuinely ugly artifact (`test: "Confirm the widget renders correctly`,
      // unbalanced quote and all).
      //
      // Under js-yaml (ADR-3473 §8.1), `- test: "..."` is parsed as real YAML — a proper
      // mapping `{test: "Confirm the widget renders correctly"}` — and `flattenObjectListItem`
      // re-joins it as `key: value` with the value's OWN quoting already resolved by the real
      // parser, not re-derived by a second regex. The embedded quote is gone because it was
      // never data to begin with; it was YAML's own value-delimiter syntax. This is strictly
      // more correct (no unbalanced-quote artifact) and the `normalizeHumanVerificationEntry`
      // consumer is unaffected — it still receives a `name` string of the same shape (still not
      // lossy of the `test:` label prefix, which is a deliberate, documented, and unrelated
      // decision — see normalizeHumanVerificationEntry's doc comment).
      assert.strictEqual(output.results[0].items[0].name, 'test: Confirm the widget renders correctly');
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

// ─── parseDeferredItems property test (#2287, widened by #3702 round 2) ─────

describe('#2287 parseDeferredItems: property (status: resolved fail-safe) × marker × shape × line ending', () => {
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
  // `statusFirst` matters on the heading shape: round 1's only CRLF test put
  // `**Status:**` LAST, the one line `collectSection`'s `.trimEnd()` had
  // already de-CR'd, and the B1 regression hid behind it.
  // `decoy` adds a prose line that BEGINS with a non-1 ordinal (`7. …`): under
  // the start-at-1 rule (B2) it is never an item, never evidence and never a
  // field — round 1 read it as an opener. Placed where it cannot end a run:
  // before the first headless entry, and first in a heading body.
  const entryArb = fc.record({ text: textArb, resolved: fc.boolean(), statusFirst: fc.boolean(), decoy: fc.boolean() });
  const decoyOrdinal = fc.integer({ min: 2, max: 999999999 });

  // #3702 round 2 (B3): the marker set is an enumerated domain — exactly what a
  // property is for. Ordered markers are numbered from 1 (the ordered-run
  // rule, B2); the two shapes exercise both splitters; CRLF exercises the
  // heading path's CR handling (B1).
  const markerArb = fc.constantFrom('-', '*', '+', 'ordered');
  const shapeArb = fc.constantFrom('headless', 'heading');
  const eolArb = fc.constantFrom('\n', '\r\n');
  const mk = (marker, i) => (marker === 'ordered' ? `${i + 1}.` : marker);

  const render = (entries, marker, shape, eol, ordinal = 7) => {
    const lines = ['## Deferred Items', ''];
    if (shape === 'headless' && entries.some((e) => e.decoy)) {
      // Pre-first-entry prose: a rejected ordinal is discarded, an accepted
      // one (round 1) opens a phantom entry and breaks the count.
      lines.push(`${ordinal}. ${entries.find((e) => e.decoy).text} status: resolved`, '');
    }
    entries.forEach((e, i) => {
      if (shape === 'headless') {
        lines.push(`${mk(marker, i)} ${e.text}`);
        if (e.resolved) lines.push('  status: resolved');
      } else {
        lines.push(`### ${e.text}`, '');
        // A decoy ordinal line FIRST in the body: never stripped, so the
        // `status: resolved` after it can never become a field.
        if (e.decoy) lines.push(`${ordinal}. ${e.text} status: resolved`);
        const what = (n) => `${mk(marker, n)} **What:** ${e.text}`;
        const status = (n) => `${mk(marker, n)} **Status:** resolved`;
        if (!e.resolved) lines.push(what(0));
        else if (e.statusFirst) lines.push(status(0), what(1));
        else lines.push(what(0), status(1));
        lines.push('');
      }
    });
    return lines.join(eol);
  };
  const idOf = (name) => { const m = /E(\d+)_/.exec(name); return m ? Number(m[1]) : -1; };

  test('property: an entry is surfaced iff it is NOT marked status: resolved; surfaced count == non-resolved count', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 20 }), markerArb, shapeArb, eolArb, decoyOrdinal,
        (rawEntries, marker, shape, eol, ordinal) => {
          // Index-prefix for uniqueness so surfaced items can be mapped back
          // to their source entry unambiguously even with colliding random text.
          const entries = rawEntries.map((e, i) => ({ ...e, text: `E${i}_${e.text}` }));
          const content = render(entries, marker, shape, eol, ordinal);
          const where = `${shape} ${JSON.stringify(marker)} ${JSON.stringify(eol)} decoy=${ordinal}`;

          const items = parseDeferredItems(content);
          const surfacedIds = new Set(items.map((it) => idOf(it.name)));

          const expectedUnresolved = entries.filter((e) => !e.resolved);

          // Total surfaced count equals the count of non-resolved entries.
          assert.strictEqual(items.length, expectedUnresolved.length, where);

          // Every non-resolved entry IS surfaced (including status:-shaped
          // decoy substrings embedded mid-line — those must not flip the
          // outcome).
          for (const [i, e] of entries.entries()) {
            assert.strictEqual(surfacedIds.has(i), !e.resolved, `${where}: ${e.resolved ? 'resolved entry must never surface' : 'unresolved entry must surface'}: ${e.text}`);
          }

          // Headless: the surfaced NAME is the entry text with the marker gone,
          // whichever marker it was (the name is what acknowledge matches on).
          if (shape === 'headless') {
            for (const it of items) assert.strictEqual(it.name, entries[idOf(it.name)].text, where);
          }
          // A heading body carrying ONLY a decoy ordinal line is prose, not an entry.
          if (shape === 'heading' && entries.length > 0) {
            const decoyOnly = `## Deferred Items${eol}${eol}### only-decoy${eol}${eol}${ordinal}. ${entries[0].text} status: resolved${eol}`;
            assert.deepStrictEqual(parseDeferredItems(decoyOnly), [], `${where}: decoy-only body`);
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

  test('property: acknowledge reaches and rewrites every unresolved headless entry, whichever marker or line ending', () => {
    // The writer refuses the heading shape by design (`unsupported_heading_shape`),
    // so this ranges over the headless shape only. It is the property that
    // reaches M4 (CRLF rewrite reported ok and wrote nothing) and m2 (indent).
    fc.assert(
      fc.property(
        fc.array(entryArb, { minLength: 1, maxLength: 12 }), markerArb, eolArb,
        (rawEntries, marker, eol) => {
          const entries = rawEntries.map((e, i) => ({ ...e, text: `E${i}_${e.text}` }));
          let content = render(entries, marker, 'headless', eol);
          const where = `${JSON.stringify(marker)} ${JSON.stringify(eol)}`;

          for (const e of entries.filter((x) => !x.resolved)) {
            const got = acknowledgeDeferredItem(content, e.text);
            assert.strictEqual(got.status, 'ok', `${where}: ${e.text}`);
            assert.notStrictEqual(got.content, content, `${where}: an ok must have written: ${e.text}`);
            content = got.content;
          }
          const after = parseDeferredItemsWithStatus(content);
          assert.strictEqual(after.length, entries.length, where);
          for (const it of after) {
            const e = entries[idOf(it.name)];
            assert.strictEqual(it.status, e.resolved ? 'resolved' : 'acknowledged', `${where}: ${it.name}`);
          }
          // `acknowledged` is suppressed at the AUDIT layer, not the parser's:
          // only `resolved` leaves the outstanding list here, so the count is
          // unchanged by the writes above.
          assert.strictEqual(parseDeferredItems(content).length, entries.filter((x) => !x.resolved).length, where);
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

describe('#3702 parseDeferredItems: list-marker grammar', () => {
  // `deferred-items.md` has no template and no mandated shape, but the parser
  // recognised only the hyphen marker — so `*`, `+` and ordered lists (all
  // lists in CommonMark and GFM) contributed ZERO entries on both the headless
  // and the heading-delimited path. A mixed file dropped its non-hyphen entries
  // while keeping their hyphenated siblings, under-reporting without ever
  // looking empty.
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);
  const count = (md) => names(md).length;

  // The marker set the ruling widened to. `1)` is deliberately absent — the
  // paren-terminated ordered form is out of scope for this fix, and the
  // `1) still yields zero` case below pins that as intended, not as an oversight.
  const MARKERS = ['-', '*', '+', '1.'];

  test('AC1 headless: every marker yields the same count as the hyphen form', () => {
    const shape = (m) => `${m} alpha\n${m} beta\n`;
    const hyphen = count(shape('-'));

    assert.strictEqual(hyphen, 2, 'baseline: the hyphen form must yield 2');
    for (const m of MARKERS) {
      assert.strictEqual(count(shape(m)), hyphen, `marker ${JSON.stringify(m)}: ${JSON.stringify(names(shape(m)))}`);
    }
  });

  test('AC1 headless: the entry NAME drops the marker, whichever marker it is', () => {
    // rawGapEntryText renders the name acknowledgeDeferredItem later matches on,
    // so a marker left in the rendered name would make the entry unreachable.
    for (const m of MARKERS) {
      assert.deepStrictEqual(names(`${m} alpha\n`), ['alpha'], `marker ${JSON.stringify(m)}`);
    }
  });

  test('AC2 heading-delimited: a body carrying any marker is KEPT (was dropped)', () => {
    const shape = (m) => `### Entry\n\n${m} **What:** x.\n`;

    for (const m of MARKERS) {
      assert.strictEqual(count(shape(m)), 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(names(shape(m)))}`);
    }
  });

  test('AC2 heading-delimited: a mixed file no longer drops its non-hyphen entry', () => {
    // The row that bites hardest in the wild: the file never looks empty, it
    // just silently under-reports.
    const got = names('### Hyphen entry\n\n- x.\n\n### Asterisk entry\n\n* y.\n');

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^Hyphen entry/);
    assert.match(got[1], /^Asterisk entry/);
  });

  test('AC3: a resolved-status field under any marker resolves its entry', () => {
    // The lockstep property: widening what OPENS an entry without widening the
    // marker STRIP feeding field extraction would surface the entry and then
    // never resolve it — permanently unresolved, which is worse than dropped.
    //
    // Asserted through parseDeferredItemsWithStatus, NOT through an empty
    // parseDeferredItems: "no outstanding item" is also what a DROPPED entry
    // looks like, so the weaker form passes against the unfixed parser for
    // precisely the reason under test. The entry must exist AND read resolved.
    for (const m of MARKERS) {
      for (const [shape, md] of [
        ['heading', `${SECTION}### Entry\n\n${m} **What:** x.\n${m} **Status:** resolved\n`],
        ['headless', `${SECTION}${m} alpha\n  status: resolved\n`],
      ]) {
        const where = `${shape} shape, marker ${JSON.stringify(m)}`;
        const withStatus = parseDeferredItemsWithStatus(md);

        assert.strictEqual(withStatus.length, 1, `${where}: entry must be parsed at all — ${JSON.stringify(withStatus)}`);
        assert.strictEqual(withStatus[0].status, 'resolved', `${where}: ${JSON.stringify(withStatus)}`);
        assert.deepStrictEqual(parseDeferredItems(md), [], `${where}: resolved entries are not outstanding`);
      }
    }
  });

  test('AC3: the acknowledge writer reaches an entry written under any marker', () => {
    for (const m of MARKERS) {
      const content = `${SECTION}${m} alpha\n`;
      const got = acknowledgeDeferredItem(content, 'alpha');

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.match(got.content, /status: acknowledged/, `marker ${JSON.stringify(m)}`);
      assert.strictEqual(
        parseDeferredItemsWithStatus(got.content)[0].status,
        'acknowledged',
        `marker ${JSON.stringify(m)}: the written marker must parse back`,
      );
    }
  });

  test('AC3: an already-acknowledged entry under any marker is not double-written', () => {
    for (const m of MARKERS) {
      const original = `${SECTION}${m} alpha\n`;
      const once = acknowledgeDeferredItem(original, 'alpha').content;
      const twice = acknowledgeDeferredItem(once, 'alpha').content;

      // Anti-vacuity: an unreachable entry is also idempotent, so pin that the
      // first call actually wrote before pinning that the second did not.
      assert.notStrictEqual(once, original, `marker ${JSON.stringify(m)}: first acknowledge must write`);
      assert.strictEqual(twice, once, `marker ${JSON.stringify(m)}`);
    }
  });

  test('AC4: prose-only and bare headings still contribute nothing', () => {
    // The "prose is not an item" contract is untouched: an asterisk bullet is
    // not prose, so widening the marker set cannot start counting prose.
    assert.deepStrictEqual(names('### Musings\n\njust prose here.\n'), []);
    assert.deepStrictEqual(names('### A bare heading with no body\n'), []);
    assert.deepStrictEqual(names('### Notes\n\nwe considered * and + as options.\n'), []);
  });

  test('AC4: a bolded field key is not mistaken for an asterisk bullet', () => {
    // `**Status:**` opens with `*` but supplies no whitespace after it, so the
    // widened marker declines and the bolded-key path still owns the line.
    const got = parseDeferredItemsWithStatus(`${SECTION}### Entry\n\n- **What:** x.\n**Status:** resolved\n`);

    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.strictEqual(got[0].status, 'resolved', JSON.stringify(got));
  });

  test('AC5: a table under a leaf heading still yields exactly its rows', () => {
    // The anti-double-count property (#2766): table lines are skipped before
    // the body-marker flag can be set, and a `|` row is not a list marker, so
    // the heading still contributes no phantom entry.
    const oneRow = names('### Discovered\n\n| Test | Seeds |\n|---|---|\n| test_a | 0, 1 |\n');
    assert.deepStrictEqual(oneRow, ['test_a — 0, 1'], JSON.stringify(oneRow));

    const twoRows = names('### Discovered\n\n| Test | Seeds |\n|---|---|\n| test_a | 0 |\n| test_b | 1 |\n');
    assert.strictEqual(twoRows.length, 2, JSON.stringify(twoRows));
  });

  test('the paren-terminated ordered marker `1)` remains out of scope', () => {
    // Pinned so a later reader sees this as the ruling's scope, not a miss.
    assert.deepStrictEqual(names('1) alpha\n2) beta\n'), []);
  });

  test('CRLF files: widened markers split and resolve identically', () => {
    for (const m of MARKERS) {
      const crlf = `## Deferred Items\r\n\r\n### Entry\r\n\r\n${m} **What:** x.\r\n${m} **Status:** resolved\r\n`;
      const withStatus = parseDeferredItemsWithStatus(crlf);

      // Same anti-vacuity as AC3: an empty outstanding list would also be
      // satisfied by the entry never being parsed.
      assert.strictEqual(withStatus.length, 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(withStatus)}`);
      assert.strictEqual(withStatus[0].status, 'resolved', `marker ${JSON.stringify(m)}`);
      assert.deepStrictEqual(parseDeferredItems(crlf), [], `marker ${JSON.stringify(m)}`);
    }
  });

  test('nested sub-lists under any marker stay folded into their parent entry', () => {
    // splitGapsEntries' indent rule (#2286) is marker-agnostic: only a marker at
    // or shallower than the first one seen opens a new entry.
    for (const m of MARKERS) {
      const got = names(`${m} alpha\n    ${m} nested one\n    ${m} nested two\n${m} beta\n`);
      assert.strictEqual(got.length, 2, `marker ${JSON.stringify(m)}: ${JSON.stringify(got)}`);
    }
  });
});

describe('#3702 round 2: CRLF on the heading path and in the acknowledge writer', () => {
  const MARKERS = ['-', '*', '+', '1.'];
  const CRLF_SECTION = '## Deferred Items\r\n\r\n';

  test('B1: a CRLF heading entry resolves when **Status:** is NOT the last line', () => {
    // Round-1's CRLF test put `**Status:**` on the fixture's LAST line, where
    // `collectSection`'s `.trimEnd()` had already removed the one `\r` that
    // mattered — a false green. Every other line of a CRLF body still carries
    // its `\r`, and a `$`-anchored marker strip fails on it, so the marker
    // survived into field extraction and the field was silently lost.
    for (const m of MARKERS) {
      const statusFirst = `${CRLF_SECTION}### Entry\r\n\r\n${m} **Status:** resolved\r\n${m} **What:** x.\r\n`;
      const withStatus = parseDeferredItemsWithStatus(statusFirst);

      assert.strictEqual(withStatus.length, 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(withStatus)}`);
      assert.strictEqual(withStatus[0].status, 'resolved', `marker ${JSON.stringify(m)}: status-first CRLF must resolve`);
      assert.deepStrictEqual(parseDeferredItems(statusFirst), [], `marker ${JSON.stringify(m)}`);

      // And the mirror: a field ABOVE a trailing status line is not lost either.
      const whatFirst = `${CRLF_SECTION}### Entry\r\n\r\n${m} **What:** x.\r\n${m} **Status:** resolved\r\n${m} **Why:** y.\r\n`;
      assert.strictEqual(parseDeferredItemsWithStatus(whatFirst)[0].status, 'resolved', `marker ${JSON.stringify(m)}: mid-body status`);
    }
  });

  test('B1: a CRLF heading entry parses byte-for-byte like its LF twin', () => {
    for (const m of MARKERS) {
      const body = `### Entry\n\n${m} **Status:** resolved\n${m} **What:** x.\n`;
      const lf = parseDeferredItemsWithStatus(`## Deferred Items\n\n${body}`);
      const crlf = parseDeferredItemsWithStatus(`${CRLF_SECTION}${body.replace(/\n/g, '\r\n')}`);
      assert.deepStrictEqual(crlf, lf, `marker ${JSON.stringify(m)}`);
    }
  });

  test('M4: acknowledge REWRITES an existing status line on a CRLF file (was: ok + no write)', () => {
    // Pre-existing on `next`: the finder tested a CR-stripped copy, the rewrite
    // ran on the raw `\r`-terminated line with a `$`-anchored regex, `replace`
    // returned the input unchanged, and the writer reported `ok` over content
    // that was byte-identical — the item then resurfaced on every audit.
    for (const m of MARKERS) {
      const content = `${CRLF_SECTION}${m} alpha\r\n  status: pending\r\n${m} beta\r\n`;
      const target = parseDeferredItemsWithStatus(content)[0].name;
      const got = acknowledgeDeferredItem(content, target);

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.notStrictEqual(got.content, content, `marker ${JSON.stringify(m)}: an ok must have written`);
      assert.strictEqual(parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged', `marker ${JSON.stringify(m)}`);
    }
  });

  test('m2: the inserted status line takes the entry indent on a CRLF file', () => {
    for (const m of MARKERS) {
      const content = `${CRLF_SECTION}    ${m} alpha\r\n    ${m} beta\r\n`;
      const got = acknowledgeDeferredItem(content, 'alpha');

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.match(got.content, /\n {6}status: acknowledged/, `marker ${JSON.stringify(m)}: indent 4 + 2, not the indent-0 fallback`);
    }
  });
});

describe('#3702 round 3: detect/strip symmetry on the acknowledge path (B1, B2)', () => {
  // The round-3 blocker. Round 2 widened the WRITER's status-line finder to
  // the deferred marker set while the reader still de-bulleted line 0 only, so
  // a nested `  * status:` was selectable by the writer and invisible to the
  // reader: acknowledge rewrote it, returned `ok`, and the item stayed
  // outstanding on every later audit. Measured against a `next` build, `*`,
  // `+` and `1.` all resolved on base and stopped resolving at round 2's head
  // — a regression, not a gap in new behaviour.
  for (const marker of ['-', '*', '+', '1.']) {
    test(`a nested "${marker} status:" line acknowledges and READS BACK`, () => {
      const doc = `## Deferred Items\n\n- alpha thing\n  ${marker} status: pending\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1);
      const got = acknowledgeDeferredItem(doc, items[0].name);
      assert.strictEqual(got.status, 'ok', `${marker}: acknowledge reported`);
      assert.notStrictEqual(got.content, doc, `${marker}: content actually changed`);
      const after = parseDeferredItemsWithStatus(got.content);
      assert.strictEqual(
        after[0].status, 'acknowledged',
        `${marker}: the entry must read back as acknowledged — reporting ok over a line the reader skips is the defect`,
      );
    });
  }

  // The hyphen row above is NOT a widened marker: it was already broken on
  // `next`, for the same reason. One classifier cannot be right for three
  // markers and wrong for the fourth, so it is fixed here rather than left as
  // a pre-existing defect found while working.
  test('a bare capitalised "Status:" resolves rather than reporting a write nothing reads', () => {
    // The reader stores a bare key case-sensitively, so `Status:` is not
    // `status:`. The writer must therefore NOT select it — it falls to the
    // insert branch, which writes a line the reader does read.
    const doc = '## Deferred Items\n\n- alpha\n  Status: pending\n';
    const items = parseDeferredItemsWithStatus(doc);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged');
  });

  test('a fenced "status:" line does not make the entry un-acknowledgeable', () => {
    // Found by the pre-push review, and a regression THIS round introduced:
    // the reader applied the fence gate before classifying and the writer did
    // not, so the writer selected a fenced `status:` line the reader skips.
    // The read-back guard then refused the write and the entry could not be
    // acknowledged at all — `audit acknowledge` raised an internal error and
    // `complete-milestone` halted. It acknowledged cleanly on `next`.
    const F = '`'.repeat(3);
    const doc = `## Deferred Items\n\n- alpha\n  ${F}\n  status: pending\n  ${F}\n`;
    const items = parseDeferredItemsWithStatus(doc);
    assert.strictEqual(items.length, 1);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok', 'a fenced status line must not refuse the write');
    assert.strictEqual(
      parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged',
      'the insert branch must write a line the reader reads, rather than rewriting one it skips',
    );
  });

  test('CONTROL: a bolded line-0 key keeps its ** wrapper and spelling through the rewrite', () => {
    // Held before this round too — it is a control on the NEW offset-based
    // rewrite, not a regression test for a reported defect. The rewrite
    // replaces the VALUE at the offset the classifier reported, so the key is
    // untouched by construction; a key-matching regex would have to reproduce
    // the wrapper to preserve it, which is the thing that could regress.
    const doc = '## Deferred Items\n\n- **Status:** pending alpha\n';
    const items = parseDeferredItemsWithStatus(doc);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok');
    assert.match(got.content, /- \*\*Status:\*\* acknowledged/);
  });

  test('acknowledge is idempotent across a re-read', () => {
    // The failure this guards is the one the defect actually produced: the
    // item resurfaces, gets acknowledged again, and never settles.
    const doc = '## Deferred Items\n\n- alpha\n  * status: pending\n';
    const first = acknowledgeDeferredItem(doc, parseDeferredItemsWithStatus(doc)[0].name);
    const reread = parseDeferredItemsWithStatus(first.content);
    assert.strictEqual(reread[0].status, 'acknowledged');
    const second = acknowledgeDeferredItem(first.content, reread[0].name);
    assert.strictEqual(second.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(second.content)[0].status, 'acknowledged');
  });
});

describe('#3702 round 4: ONE end-of-file CRLF algorithm, adopted from #3773 with its B4 closed (M1)', () => {
  // Two open PRs shipped two different answers to "what line ending does an
  // entry that ENDS THE FILE get?", and the maintainer's round-4 ruling was
  // that the disagreement "needs one answer, not two". Neither shipped answer
  // was that one. Measured, on builds of both heads, over the fixtures below:
  //
  //   case                                     #3739 r3   #3773   here
  //   undelimited single entry, CRLF preamble    pass      FAIL    pass
  //   LF-dominant list, one stray CRLF at EOF    FAIL      pass    pass
  //   (the other five)                           pass      pass    pass
  //
  // #3739's `content.endsWith('\r\n', matchIndexInContent)` reads the
  // terminator of the PREVIOUS line, so it propagated an isolated CRLF into an
  // LF-dominant list. #3773's `crlfAtEof` asks the right question but over a
  // scope that goes EMPTY for an undelimited single-entry list, so it inserted
  // a bare `\n` into a CRLF document — its own B4, and a violation of the
  // uniform-CRLF invariant the fix exists to hold. What lands here is
  // `crlfAtEof`'s semantics over a scope that widens instead of going empty.
  //
  // Every fixture below is a counterexample that killed a simpler algorithm,
  // four of them ported from #3773 along with the function. They are not
  // decoration: drop any one and a refuted algorithm passes again.
  const endings = (text) => (text.match(/\r?\n/g) || []).map((b) => (b === '\r\n' ? 'CRLF' : 'LF'));
  const assertUniformCrlf = (text) => {
    assert.ok(!/[^\r]\n/.test(text) && !/^\n/.test(text), `mixed line endings: ${JSON.stringify(text)}`);
  };

  test('B4: an UNDELIMITED single-entry list at EOF inserts CRLF, not a bare LF', () => {
    // #3773's B4, the defect this PR must not inherit while absorbing that PR.
    // With no `## Deferred Items` heading and exactly ONE entry, the entry-list
    // region runs from the first entry's start to the insertion point — and
    // those are the same offset, so the region is empty and `crlfAtEof('')` is
    // `false` by its own `before.length > 0` guard. The scope widens to
    // everything before the insertion point rather than asserting LF from no
    // evidence at all.
    const content = 'preamble\r\n\r\n- alpha';
    const ack = acknowledgeDeferredItem(content, 'alpha');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.content, 'preamble\r\n\r\n- alpha\r\n  status: acknowledged');
    assert.strictEqual(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
    assertUniformCrlf(ack.content);
  });

  test('B4 control: the same shape under LF stays LF', () => {
    const content = 'preamble\n\n- alpha';
    const ack = acknowledgeDeferredItem(content, 'alpha');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.content, 'preamble\n\n- alpha\n  status: acknowledged');
  });

  test('an LF-dominant document with ONE stray CRLF: the EOF entry does not inherit it', () => {
    // Ported from #3773, and the fixture that refutes THIS PR's round-3
    // algorithm. `delta`'s CRLF terminates DELTA, not the unterminated `beta`
    // after it, so copying the preceding separator propagates an isolated CRLF
    // into an otherwise-LF file — strictly worse than the bare `\n` it
    // replaced. Only a scope with no contradicting bare `\n` may assert CRLF.
    const content = '## Deferred Items\n\n- alpha\n- gamma\n- delta\r\n- beta';
    const ack = acknowledgeDeferredItem(content, 'beta');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(ack.content)[3].status, 'acknowledged');
    assert.strictEqual(ack.content, '## Deferred Items\n\n- alpha\n- gamma\n- delta\r\n- beta\n  status: acknowledged');
    assert.deepStrictEqual(endings(ack.content), ['LF', 'LF', 'LF', 'LF', 'CRLF', 'LF'],
      'the inserted break must not duplicate the unrelated CRLF above it');
  });

  test('a DELIMITED single-entry list still has evidence: the section preamble is in scope', () => {
    // Ported from #3773. The scope must not shrink to the entry list alone; a
    // delimited section's own preamble belongs to that section and counts.
    const content = '## Deferred Items\r\n\r\n- alpha thing';
    const ack = acknowledgeDeferredItem(content, 'alpha thing');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.content, '## Deferred Items\r\n\r\n- alpha thing\r\n  status: acknowledged');
    assertUniformCrlf(ack.content);
    const lf = '## Deferred Items\n\n- alpha thing';
    assert.strictEqual(
      acknowledgeDeferredItem(lf, 'alpha thing').content,
      '## Deferred Items\n\n- alpha thing\n  status: acknowledged',
    );
  });

  test('a bare LF OUTSIDE the deferred section does not veto the CRLF insert', () => {
    // Ported from #3773, and the fixture that rules out scanning the whole
    // DOCUMENT: an unrelated bare LF inside a fenced block in another section
    // would reject CRLF and drop an isolated LF into an otherwise-CRLF list.
    const content = '# Notes\r\n\r\n```text\r\nfirst\nsecond\r\n```\r\n\r\n'
      + '## Deferred Items\r\n\r\n- alpha\r\n- beta';
    const ack = acknowledgeDeferredItem(content, 'beta');
    assert.strictEqual(ack.status, 'ok');
    assert.match(ack.content, /- beta\r\n {2}status: acknowledged$/);
    const section = ack.content.slice(ack.content.indexOf('## Deferred Items'));
    assert.ok(!/(^|[^\r])\n/.test(section), `bare LF in the deferred section: ${JSON.stringify(section)}`);
    assert.ok(ack.content.includes('first\nsecond'), 'the unrelated bare LF must not be rewritten');
  });

  test('an UNDELIMITED list with entries reads only the entry list, not the preamble', () => {
    // Ported from #3773, and the fixture that rules out the SECTION as the
    // scope: with no heading the section body IS the whole document, so a
    // section-scoped scan silently becomes the whole-document scan the case
    // above already refuted. The preamble is consulted ONLY when the entry
    // list is empty (the B4 case) — here it is not, so the fence's bare LF is
    // out of scope and must not veto.
    const content = '```text\r\nfirst\nsecond\r\n```\r\n\r\n- alpha\r\n- beta';
    const ack = acknowledgeDeferredItem(content, 'beta');
    assert.strictEqual(ack.status, 'ok');
    assert.match(ack.content, /- beta\r\n {2}status: acknowledged$/);
    assert.ok(ack.content.includes('first\nsecond'), 'the unrelated bare LF must not be rewritten');
  });

  test('no evidence under EITHER scope: an entry at offset 0 stays LF', () => {
    // The widened scope terminates rather than recursing outward forever. A
    // document that is exactly one unterminated entry has no line ending
    // anywhere; LF is the floor, not an invented CRLF.
    const ack = acknowledgeDeferredItem('- alpha', 'alpha');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.content, '- alpha\n  status: acknowledged');
  });

  test('mixed-ending document: the insert branch reads the ENTRY\'s ending, not the file\'s', () => {
    // Ported from #3773. M1 asks for the mixed-ending fixture this PR lacked:
    // every CRLF test it shipped used UNIFORM CRLF, so the motivating case
    // could not fail. A CRLF heading over an LF entry — the opener's own `\n`
    // must survive, and a document-wide sniff would rewrite it.
    const content = '## Deferred Items\r\n\r\n- alpha\n  reason: x\n';
    const ack = acknowledgeDeferredItem(content, parseDeferredItemsWithStatus(content)[0].name);
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.content, '## Deferred Items\r\n\r\n- alpha\n  status: acknowledged\n  reason: x\n');
    // The single-line twin: a CRLF entry whose only evidence is the separator
    // that FOLLOWS it, inside an otherwise-LF document.
    const single = '## Deferred Items\n\n- alpha\r\n';
    assert.strictEqual(
      acknowledgeDeferredItem(single, parseDeferredItemsWithStatus(single)[0].name).content,
      '## Deferred Items\n\n- alpha\r\n  status: acknowledged\r\n',
    );
  });

  test('the widened EOF grammar carries the CRLF rule for every marker', () => {
    // The EOF fixtures above are all hyphen-shaped because they were inherited
    // from a hyphen-only PR. This PR's whole subject is the widened marker set,
    // so the EOF rule has to hold across it or the two changes are only
    // accidentally compatible.
    for (const marker of ['-', '*', '+', '1.']) {
      const content = `preamble\r\n\r\n${marker} alpha`;
      const ack = acknowledgeDeferredItem(content, 'alpha');
      assert.strictEqual(ack.status, 'ok', `marker ${JSON.stringify(marker)}`);
      assert.strictEqual(ack.content, `preamble\r\n\r\n${marker} alpha\r\n  status: acknowledged`,
        `marker ${JSON.stringify(marker)}: EOF insert must be CRLF`);
      assertUniformCrlf(ack.content);
    }
  });

  test('acknowledging twice at EOF is idempotent', () => {
    const first = acknowledgeDeferredItem('preamble\r\n\r\n- alpha', 'alpha');
    const again = acknowledgeDeferredItem(first.content, parseDeferredItemsWithStatus(first.content)[0].name);
    assert.strictEqual(again.status, 'ok');
    assert.strictEqual(again.content, first.content, 'a second acknowledge must not append a second line ending');
    assert.deepStrictEqual(endings(again.content), ['CRLF', 'CRLF', 'CRLF']);
  });
});

describe('#3702 round 4: the fence gate is indent-unbounded, like the rest of the grammar (M2)', () => {
  // `scanFencedBlocks` is CommonMark, which caps a fence delimiter's indent at
  // three spaces. This grammar opted out of that cliff for entry openers
  // (`[ \t]*`) and thematic breaks (`^[ \t]*`) but not for fences, so a fence
  // at four spaces was not a fence to the gate and a `status: resolved` inside
  // it RESOLVED the entry containing it. That is reached by ordinary
  // documents, not exotic ones: a fenced block written under a nested bullet
  // sits at four spaces. Driven before the fix at indents 4, 5, 8 and a
  // leading tab — all four silently resolved.
  //
  // `gsd-core/references/executor-examples.md` states flatly that "nothing
  // inside a fenced code block is an entry or a field". These pin that claim
  // instead of quietly bounding it.
  const H = '## Deferred Items\n\n';
  const fencedStatusDoc = (pad, delim = '```') =>
    `${H}- alpha\n${pad}${delim}text\n${pad}status: resolved\n${pad}${delim}\n`;

  for (const [label, pad] of [
    ['0 spaces', ''], ['1 space', ' '], ['2 spaces', '  '], ['3 spaces (CommonMark cap)', '   '],
    ['4 spaces (past the cap)', '    '], ['5 spaces', '     '], ['8 spaces', '        '],
    ['a leading tab', '\t'],
  ]) {
    test(`a fenced "status: resolved" at ${label} does not resolve the entry`, () => {
      const items = parseDeferredItemsWithStatus(fencedStatusDoc(pad));
      assert.strictEqual(items.length, 1, `${label}: expected exactly one entry`);
      assert.notStrictEqual(String(items[0].status || '').toLowerCase(), 'resolved',
        `${label}: the fenced status line must not resolve the entry`);
    });
  }

  test('the same rule holds for tilde fences past the cap', () => {
    const items = parseDeferredItemsWithStatus(fencedStatusDoc('     ', '~~~'));
    assert.strictEqual(items.length, 1);
    assert.notStrictEqual(String(items[0].status || '').toLowerCase(), 'resolved');
  });

  test('an entry-shaped line inside a deep fence is content, not an entry', () => {
    // The other half of the doc's claim: not an entry EITHER. #3702's wild
    // records carry reproduction blocks whose `- ` and `1. ` lines are prose.
    const doc = `${H}- alpha\n      \`\`\`diff\n      - not an entry\n      1. also not an entry\n      \`\`\`\n- beta\n`;
    const names = parseDeferredItems(doc).map((i) => i.name);
    assert.ok(names.some((n) => n.startsWith('alpha')), `alpha missing: ${JSON.stringify(names)}`);
    assert.ok(names.includes('beta'), `beta missing: ${JSON.stringify(names)}`);
    assert.ok(!names.includes('not an entry'), `fenced content became an entry: ${JSON.stringify(names)}`);
    assert.ok(!names.includes('also not an entry'), `fenced content became an entry: ${JSON.stringify(names)}`);
  });

  test('an UNTERMINATED deep fence runs to the end of its ENTRY (round 5, B1) — the status inside it stays gated, the next entry does not', () => {
    // Round 4 titled this "runs to end-of-file, exactly as CommonMark says";
    // CommonMark bounds a fence by its container, and the review's B1 showed
    // the end-of-file reading swallowing the entries after a stray delimiter.
    // The engine still classifies; the walk bounds it at the entry.
    const doc = `${H}- alpha\n        \`\`\`text\n        status: resolved\n`;
    const items = parseDeferredItemsWithStatus(doc);
    assert.strictEqual(items.length, 1);
    assert.notStrictEqual(String(items[0].status || '').toLowerCase(), 'resolved');
    const two = parseDeferredItemsWithStatus(`${doc}- beta\n  status: resolved\n`);
    assert.deepStrictEqual(two.map((i) => [i.name, i.status]), [['alpha ```text status: resolved', ''], ['beta status: resolved', 'resolved']]);
  });

  test('a deep fence still CLOSES: fields after it are read again', () => {
    // The gate must not swallow the rest of the entry. If the closer at the
    // same deep indent were not recognised, everything after it would stay
    // fenced to EOF and the real status line would be invisible.
    const doc = `${H}- alpha\n    \`\`\`text\n    status: resolved\n    \`\`\`\n  status: acknowledged\n`;
    const items = parseDeferredItemsWithStatus(doc);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(String(items[0].status).toLowerCase(), 'acknowledged',
      'the post-fence status line must still be read');
  });

  test('acknowledge agrees with the reader about a deep fence', () => {
    // Reader and writer share one classifier; a fence the reader honours must
    // be one the writer refuses to rewrite into. Otherwise acknowledge writes
    // inside the code block and reports ok.
    const doc = `${H}- alpha\n      \`\`\`text\n      status: pending\n      \`\`\`\n`;
    const ack = acknowledgeDeferredItem(doc, parseDeferredItemsWithStatus(doc)[0].name);
    assert.strictEqual(ack.status, 'ok');
    assert.ok(ack.content.includes('      status: pending'),
      'the fenced line must be left exactly as written');
    assert.strictEqual(String(parseDeferredItemsWithStatus(ack.content)[0].status).toLowerCase(), 'acknowledged',
      'the entry must read back acknowledged through an inserted line, not a rewritten fenced one');
  });

  test('GUARD: `## Gaps` is untouched — it opts out of block structure entirely', () => {
    // Both marker-parameterised call sites gate on `markers.blockStructure`,
    // which the Gaps set does not set, so Gaps reaches an EMPTY fenced set and
    // this change cannot reach it. Pinned rather than asserted: a future
    // "consistency" edit that dropped that gate would silently move Gaps, and
    // this PR's central claim is that Gaps keeps its `next` behaviour.
    //
    // The observable form of "no fence gate": Gaps folds the fenced lines into
    // the entry's NAME rather than hiding them, and does so identically at an
    // indent inside CommonMark's cap and one past it. If the deferred gate
    // ever leaked into Gaps, the deep form would start differing from the
    // shallow one.
    const deep = '## Gaps\n\n- alpha\n    ```text\n    status: open\n    ```\n';
    const shallow = '## Gaps\n\n- alpha\n  ```text\n  status: open\n  ```\n';
    assert.deepStrictEqual(parseUatItems(deep), parseUatItems(shallow),
      'Gaps must read a fence at 4 spaces exactly as it reads one at 2');
    assert.deepStrictEqual(parseUatItems(deep), [
      { name: 'alpha ```text status: open ```', result: 'open', category: 'unknown' },
    ], 'Gaps folds fenced lines into the entry name — no fence gate at any indent');

    // And the entry-shaped twin: a `- ` line inside a deep fence is still not
    // a separate Gaps entry, because Gaps never split on it to begin with.
    const entryShaped = '## Gaps\n\n- alpha\n    ```diff\n    - fenced line\n    ```\n- beta\n';
    assert.deepStrictEqual(parseUatItems(entryShaped).map((i) => i.name),
      ['alpha ```diff - fenced line ```', 'beta']);
  });
});

describe('#3702 round 4: the minors (m1, m2, m3, m5)', () => {
  const H = '## Deferred Items\n\n';
  const names = (doc) => parseDeferredItems(doc).map((i) => i.name);

  // ── m1: the ordinal digit cap needs the limit-1 case ──────────────────────
  // RULESET.TESTS.boundary-coverage asks for N ∈ {limit-1, limit, limit+1}.
  // The limit (`999999999.`) and limit+1 (`1234567890.`) were already pinned;
  // limit-1 was the missing third. It is not a formality: an off-by-one in the
  // `\d{1,9}` bound shows up at eight digits, not at nine.
  test('m1: an EIGHT-digit ordinal (limit-1) is a marker', () => {
    assert.deepStrictEqual(names(`${H}1. a\n12345678. b\n`), ['a', 'b']);
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('12345678. x'), true);
  });

  test('m1: the three boundary points read consistently through the marker set', () => {
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('12345678. x'), true, 'limit-1');
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('999999999. x'), true, 'limit');
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('1234567890. x'), false, 'limit+1');
  });

  // ── m2: the hand-rolled CommonMark copies, checked against CommonMark ─────
  // `THEMATIC_BREAK_RE` and the tab-expanding indent counter are fresh
  // implementations of rules CommonMark already specifies, and this repo has
  // no sectionizer helper for either to be compared against. So the parity
  // assertion is against the SPEC, with the two deliberate divergences named
  // rather than left for a later reader to discover and "fix" back.
  test('m2: THEMATIC_BREAK_RE agrees with CommonMark on `-`, `*` and `_`', () => {
    const isBreak = (line) => {
      const doc = `${H}- alpha\n${line}\n- beta\n`;
      // A separator closes the list, so `beta` opens a NEW list rather than
      // continuing alpha's. If the line is not a break, it is swallowed as
      // alpha's continuation text.
      return names(doc).length === 2 && names(doc)[0] === 'alpha';
    };
    // `-- -` belongs in the YES list: CommonMark asks for three or more
    // matching characters "each followed optionally by any number of spaces or
    // tabs", so the spacing between them is free. It was in the NO list on the
    // first cut of this test and the parser was right, not the fixture.
    for (const yes of ['---', '***', '___', '- - -', '* * *', '_ _ _', '-----', '   ---', '-- -']) {
      assert.strictEqual(isBreak(yes), true, `CommonMark thematic break not recognised: ${JSON.stringify(yes)}`);
    }
    for (const no of ['--', '**', '__', '- -', 'a---']) {
      assert.strictEqual(isBreak(no), false, `not a CommonMark thematic break, but treated as one: ${JSON.stringify(no)}`);
    }
  });

  test('m2: the two DELIBERATE divergences from CommonMark are pinned, not accidental', () => {
    const isBreak = (line) => {
      const doc = `${H}- alpha\n${line}\n- beta\n`;
      return names(doc).length === 2 && names(doc)[0] === 'alpha';
    };
    // (1) `+` is NOT a CommonMark thematic-break character. It is one here,
    // because `+` IS a list marker in this grammar, so `+ + +` would otherwise
    // open a phantom entry named `+ +` — the same reason `* * *` is a break
    // rather than an entry named `* *`.
    assert.strictEqual(isBreak('+ + +'), true,
      '`+ + +` must be a separator here even though CommonMark says otherwise');
    // (2) Indent is UNBOUNDED. CommonMark stops recognising a thematic break at
    // four spaces (it becomes indented code); this grammar reads entries and
    // breaks at any indent, so the break must follow the entries.
    assert.strictEqual(isBreak('       ---'), true, 'a 7-space break must still close the list');
    assert.strictEqual(isBreak('\t---'), true, 'a tab-indented break must still close the list');
  });

  test('m2: the indent counter expands tabs to CommonMark 4-column stops', () => {
    // Not directly exported, so it is measured through its observable effect:
    // a continuation line must land at or past its opener's indent column. A
    // tab counted as ONE column instead of expanding to the next stop of four
    // puts a 3-space continuation "outside" a tab-indented bullet.
    const tabOpener = `${H}\t- alpha\n\t  status: acknowledged\n`;
    assert.deepStrictEqual(
      parseDeferredItemsWithStatus(tabOpener).map((i) => i.status),
      ['acknowledged'],
      'a tab-indented entry must read its own tab-indented field',
    );
    // A 4-space opener and a tab opener occupy the same column, so the same
    // continuation depth works for both.
    const spaceOpener = `${H}    - alpha\n      status: acknowledged\n`;
    assert.deepStrictEqual(
      parseDeferredItemsWithStatus(spaceOpener).map((i) => i.status),
      ['acknowledged'],
    );
  });

  // ── m3: the result union is declared twice; check it BEHAVIOURALLY ────────
  // `src/audit.cts` carries a hand-written structural view of `uat.cjs`,
  // including its own copy of the result union. That decoupling is deliberate
  // (the CLI does not take a type dependency on the module it `require()`s),
  // so the fix is not to delete one copy but to make drift observable: every
  // status the writer can actually PRODUCE is driven here, so a status added
  // to one union and not the other shows up as a fixture with no counterpart
  // rather than as a silent fall-through to the write.
  //
  // Four of these had no assertion anywhere in the suite before this test.
  test('m3: every reachable acknowledge status is driven from a fixture', () => {
    const reached = new Map();
    const drive = (label, doc, target) => {
      const r = acknowledgeDeferredItem(doc, target);
      reached.set(r.status, label);
      return r;
    };

    drive('ok', `${H}- alpha\n`, 'alpha');
    drive('not_found', `${H}- alpha\n`, 'no such entry');
    drive('ambiguous', `${H}- alpha\n- alpha\n`, 'alpha');
    const resolvedDoc = `${H}- alpha\n  status: resolved\n`;
    drive('already_resolved', resolvedDoc, parseDeferredItemsWithStatus(resolvedDoc)[0].name);
    // #3781 (merged round 5): the heading shape acks; the refusal is reached
    // only by a span with a GFM table row INSIDE it, which no write can anchor.
    const headingDoc = `${H}### Entry one\n\n- **Status:** open\n| a | b |\n- more\n`;
    drive('unsupported_heading_shape', headingDoc, parseDeferredItemsWithStatus(headingDoc)[0].name);

    assert.deepStrictEqual(
      [...reached.keys()].sort(),
      ['already_resolved', 'ambiguous', 'not_found', 'ok', 'unsupported_heading_shape'],
      'a reachable status stopped being reachable, or a new one appeared',
    );

    // `match_verification_failed` is the sixth member and is NOT driven here.
    // It is a defensive re-verify of the matched span against the target text,
    // computed by an independent code path, and no fixture reaches it — the
    // same position `rewrite_not_readable` was in before round 4 removed it.
    // Stated rather than quietly omitted: if this union is ever pruned to what
    // tests reach, that member is the one to weigh, and the answer is the same
    // one round 4 gave for the other — an assertion nothing can drive is a
    // specification nothing holds.
  });

  test('m3: each reachable status produces a DISTINCT outcome, so a merge of two would show', () => {
    const doc = `${H}- alpha\n`;
    const ok = acknowledgeDeferredItem(doc, 'alpha');
    const notFound = acknowledgeDeferredItem(doc, 'nope');
    assert.notStrictEqual(ok.content, doc, 'ok must change the content');
    assert.strictEqual(notFound.content, doc, 'a refusal must return the content untouched');
    // Every non-ok status returns the ORIGINAL content: that is the property
    // the CLI relies on when it refuses rather than writes.
    for (const [label, d, t] of [
      ['ambiguous', `${H}- alpha\n- alpha\n`, 'alpha'],
      ['not_found', doc, 'nope'],
    ]) {
      const r = acknowledgeDeferredItem(d, t);
      assert.strictEqual(r.content, d, `${label}: refusal must not mutate content`);
    }
  });

  // ── m5: DECLINED, with the measurement that refutes it ───────────────────
  // The review is right that `markers.open`'s `(\s*)` indent group and the
  // `/^[ \t]*/` reader disagree about `\f`, `\v` and NBSP. Its prescribed fix
  // — "narrow to `([ \t]*)`" — was implemented, measured, and REVERTED,
  // because the disagreement is not currently doing any harm and the narrowing
  // is.
  //
  // Driven, both directions:
  //   indent    as shipped                               narrowed to [ \t]*
  //   \f        entry, status open, ack ok, reads back    NO ENTRY
  //   \v        entry, status open, ack ok, reads back    NO ENTRY
  //   NBSP      entry, status open, ack ok, reads back    NO ENTRY
  //
  // The whole round-trip already works for these: the entry surfaces, its
  // field parses, `acknowledgeDeferredItem` returns ok and the result reads
  // back acknowledged. Narrowing turns three working shapes into three
  // SILENTLY DROPPED ones — which is the #3702 defect class itself, and the
  // opposite of the fail-safe rule this file states ("never silently drop a
  // possibly-open item"). A latent inconsistency in the safe direction is not
  // worth trading for a live regression in the unsafe one.
  //
  // Pinned here so the prescription cannot be re-applied without failing a
  // test that explains why. If the inconsistency is ever to be closed, the
  // direction is to make the READERS agree with the opener — `indentOf` counts
  // non-tab whitespace as a column instead of terminating on it — not to make
  // the opener reject lines it currently accepts.
  for (const [label, indent] of [['a form feed', '\f'], ['a vertical tab', '\v'], ['an NBSP', '\u00a0']]) {
    test(`m5: an entry indented with ${label} still round-trips (narrowing would drop it)`, () => {
      const doc = `${H}${indent}- alpha\n  status: open\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1, `${label}: the entry must surface`);
      assert.strictEqual(items[0].status, 'open', `${label}: its field must parse`);
      const ack = acknowledgeDeferredItem(doc, items[0].name);
      assert.strictEqual(ack.status, 'ok', `${label}: it must be acknowledgeable`);
      assert.strictEqual(
        String(parseDeferredItemsWithStatus(ack.content)[0].status).toLowerCase(),
        'acknowledged',
        `${label}: and the acknowledgement must read back`,
      );
    });
  }

  test('m5 GUARD: `## Gaps` and the deferred set read exotic indent IDENTICALLY today', () => {
    // The two sets differing here is what a narrowing would introduce. Both
    // use `\s*` now, so a form-feed-indented bullet is an item on both paths.
    // If a later edit narrows only one, this fails.
    const gaps = parseUatItems('## Gaps\n\n\f- alpha\n').map((i) => i.name);
    const deferred = parseDeferredItems('## Deferred Items\n\n\f- alpha\n').map((i) => i.name);
    assert.deepStrictEqual(gaps, ['alpha'], 'Gaps must read a form-feed-indented bullet');
    assert.deepStrictEqual(deferred, ['alpha'], 'the deferred set must read it too');
  });
});

describe('#3702 round 3: heading-path reader/namer inputs (m7, m8)', () => {
  test('a bullet whose CONTENT is a fence opener does not suppress the entry\'s fields', () => {
    // m7: the fence re-scan used to run on already-marker-stripped lines, so
    // `- ```sh` — an ordinary bullet to the splitter — stripped to a fence
    // opener that existed in no other pass, and the `**Status:** resolved`
    // after it was suppressed as fence content. A RESOLVED entry resurfaced.
    const doc = '## Deferred Items\n\n### Entry\n\n- ```sh\n- **Status:** resolved\n- ```\n';
    // The status field must be READ (the round-2 fence suppression is for a
    // fence the SPLITTER saw, which this is not) ...
    assert.strictEqual(parseDeferredItemsWithStatus(doc)[0].status, 'resolved');
    // ... and a resolved entry must therefore not surface as outstanding.
    assert.deepStrictEqual(parseDeferredItems(doc), []);
  });

  test('a heading that begins with a list marker keeps it in the entry name', () => {
    // m8: line 0 of a heading entry is the heading TEXT, not a bullet.
    // Stripping a marker off it silently renamed the entry — and the name is
    // the key acknowledge matches on.
    for (const [heading, expected] of [
      ['### 1. Race in the writer', '1. Race in the writer'],
      ['### * starred title', '* starred title'],
      ['### Race in the writer', 'Race in the writer'],
    ]) {
      const doc = `## Deferred Items\n\n${heading}\n\n- **What:** x\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1, heading);
      assert.ok(items[0].name.startsWith(expected), `${heading} -> ${items[0].name}`);
    }
  });

  test('CONTROL: a body bullet keeps its marker in the entry name', () => {
    // Held before this round too — a control on the opener-flag threading, not
    // a reported defect. The flags say which lines CARRY a marker, but only
    // line 0's is part of the entry's identity; wiring the flags into the namer
    // wholesale strips the body lines too, which is a rename of the key
    // acknowledge matches on. This pins that it did not happen.
    const doc = '## Deferred Items\n\n### Entry\n\n- **What:** x\n';
    assert.strictEqual(parseDeferredItemsWithStatus(doc)[0].name, 'Entry  - **What:** x');
  });
});

describe('#3702 round 2: marker-grammar parity (M3, N1, N2)', () => {
  test('every deferred-items marker regex derives from the one alternation source', () => {
    // Structural, not behavioural: both splitter regexes embed the SAME
    // source string, so a marker added to one cannot be absent from the other.
    // Round 2 ran this over four regexes; the two writer-side ones are gone.
    for (const [name, re] of [
      ['open', DEFERRED_BULLET_MARKERS.open],
      ['strip', DEFERRED_BULLET_MARKERS.strip],
    ]) {
      assert.ok(re.source.includes(DEFERRED_MARKER_ALT), `${name}: ${re.source}`);
    }
  });

  // #3702 round 3 (M6): the structural assertion above is kept for the two
  // SPLITTER regexes, which really are two copies of one alternation. It is no
  // longer asked to stand in for the writer/reader agreement — it never could.
  // Sharing a source string says nothing about whether the line the writer
  // selects is a line the reader reads, which is precisely the asymmetry that
  // shipped. The replacement is BEHAVIOURAL and drives the real seam.
  test('every marker that OPENS an entry also resolves it through acknowledge', () => {
    for (const m of ['-', '*', '+', '1.']) {
      assert.ok(DEFERRED_BULLET_MARKERS.open.test(`${m} x`), `open: ${m}`);
      // The marker goes on BOTH the opener and the nested status line. Round
      // 2's structural test could not reach B1; a replacement that only marks
      // the opener cannot either — it is green on the defective build.
      const doc = `## Deferred Items\n\n${m} alpha\n  ${m} status: pending\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1, `entry surfaced: ${m}`);
      const got = acknowledgeDeferredItem(doc, items[0].name);
      assert.strictEqual(got.status, 'ok', `ack ok: ${m}`);
      const after = parseDeferredItemsWithStatus(got.content);
      assert.strictEqual(
        after[0].status, 'acknowledged',
        `${m}: acknowledge must be READ BACK, not merely written — a status line the reader skips leaves the item outstanding forever`,
      );
    }
  });

  test('parity with markdown-sectionizer iterateBullets on the shared vocabulary', () => {
    // `iterateBullets` is the repo's other list-marker grammar. On everything
    // both grammars are meant to agree on, they do — including the negatives.
    const opens = (line) => DEFERRED_BULLET_MARKERS.open.test(line);
    const sectionizerOpens = (line) => iterateBullets(line).length === 1;
    const shared = [
      ['- x', true], ['* x', true], ['+ x', true], ['1. x', true], ['12. x', true], ['01. x', true],
      ['  - x', true], ['- [ ] x', true], ['- [x] x', true],
      ['**Status:** x', false], ['1) x', false], ['-x', false], ['*x', false], ['1.x', false],
      ['prose', false], ['| a | b |', false], ['2026 was a year', false],
    ];
    for (const [line, expected] of shared) {
      assert.strictEqual(opens(line), expected, `deferred: ${JSON.stringify(line)}`);
      assert.strictEqual(sectionizerOpens(line), expected, `sectionizer: ${JSON.stringify(line)}`);
    }
  });

  test('the two deliberate divergences from iterateBullets are exactly these', () => {
    // N2 — a tab after the marker is CommonMark-legal; `iterateBullets`
    // requires a literal space. Kept, and pinned so the difference is visible.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('-\tx'), true);
    assert.strictEqual(iterateBullets('-\tx').length, 0);
    // N1 — CommonMark caps an ordered start at 9 digits; `iterateBullets` is
    // `\d+`. Ten digits is not a list marker here.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('1234567890. x'), false);
    assert.strictEqual(iterateBullets('1234567890. x').length, 1);
    // And `\r` is no longer whitespace after a marker (round 1's `\s` was) —
    // nor are NBSP, form-feed or vertical-tab, which `\s` also accepted and
    // CommonMark does not: only a space or a tab follows a marker. This is
    // the assertion that fails on a `[ \t]` → `\s` revert on its own.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('-\r'), false);
    for (const ws of ['\u00a0', '\f', '\v']) {
      assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test(`-${ws}x`), false, JSON.stringify(ws));
    }
  });
});

describe('#3702 round 2: the ordered marker and the prose contract (B2, m1)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);

  test('B2: a sentence that happens to open with `<number>.` is prose, not an item', () => {
    // Both were items on round 1 — `\d+\.` accepted any digit run. CommonMark
    // §5.3's own prose/list discriminator is that an ordered list interrupting
    // a paragraph must START AT 1; this parser applies that rule everywhere
    // an ordered marker is seen (see `matchListOpener`).
    assert.deepStrictEqual(names('2026. was a bad year for this module\n'), []);
    assert.deepStrictEqual(names('### Notes\n\n3. is the number of retries we settled on.\n'), []);
    // And the mixed heading case: prose under one heading, a list under another.
    const got = names('### Notes\n\n3. is the number of retries.\n\n### Steps\n\n1. do this\n2. then this\n');
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /^Steps/);
  });

  test('B2: an ordered list that starts at 1. counts, at any later number in the run', () => {
    assert.deepStrictEqual(names('1. alpha\n2. beta\n3. gamma\n'), ['alpha', 'beta', 'gamma']);
    // CommonMark ignores the numbers after the first — so does the run.
    assert.deepStrictEqual(names('1. alpha\n3. gamma\n7. delta\n'), ['alpha', 'gamma', 'delta']);
    assert.deepStrictEqual(names('01. alpha\n02. beta\n'), ['alpha', 'beta']);
    // Heading shape: the run is per entry body.
    assert.strictEqual(names('### Steps\n\n1. do\n2. then\n').length, 1);
    // Status fields under an ordered run still resolve their entry.
    assert.deepStrictEqual(names('1. alpha\n   status: resolved\n2. beta\n'), ['beta']);
  });

  test('B2: the rule\'s stated cost — a run that does not start at 1 is prose', () => {
    // Pinned so the trade is visible: a hand-numbered list starting at 2 is
    // read as prose, the same way CommonMark refuses it as a paragraph
    // interruption. The wild records (#3702) all start at 1.
    assert.deepStrictEqual(names('2. alpha\n3. beta\n'), []);
    // A bullet does NOT end the list for this purpose (round 5, M2): a list is
    // open at the level, so the following non-1 ordinal is an item — CommonMark
    // reads `2. gamma` there as a fresh ordered list (start=2), not as text.
    assert.deepStrictEqual(names('1. alpha\n- beta\n2. gamma\n'), ['alpha', 'beta', 'gamma']);
  });

  test('round 5 (M1): the ordered-start threshold — `0.` and `1.` open a list, `2.` does not', () => {
    // CommonMark §5.2 permits any 1-9-digit start; a `0.`-numbered list is
    // ordinary. Refusing `0.` dropped ONLY the first item, because the run
    // then started at `1.` — the mixed under-report that looks like a clean
    // parse. Boundary: limit-1 / limit / limit+1 of the threshold itself.
    assert.deepStrictEqual(names('0. alpha\n1. beta\n2. gamma\n'), ['alpha', 'beta', 'gamma']);
    assert.deepStrictEqual(names('1. alpha\n2. beta\n'), ['alpha', 'beta']);
    assert.deepStrictEqual(names('2. alpha\n3. beta\n'), []);
    assert.deepStrictEqual(names('0. only\n'), ['only']);
    assert.deepStrictEqual(names('00. alpha\n01. beta\n'), ['alpha', 'beta']);
    // The cost, stated accurately: a list starting at 2 or more reads as
    // prose UNTIL its first `0.`/`1.` line — the loss is the prefix.
    assert.deepStrictEqual(names('2. alpha\n3. beta\n1. gamma\n'), ['gamma']);
  });

  test('round 5 (M2): a non-1 ordinal is an item wherever a list is already open at its level', () => {
    // `1. a` / `- b` / `5. c` folded `5. c` into `b` on round 4 — the
    // ordered-run memory was cleared by the bullet. In CommonMark `5. c` there
    // is a fresh ordered list (start=5): a non-1 start is refused only where
    // it would interrupt a PARAGRAPH, and after a list item it interrupts none.
    assert.deepStrictEqual(names('1. a\n- b\n5. c\n'), ['a', 'b', 'c']);
    assert.deepStrictEqual(names('- a\n5. c\n'), ['a', 'c']);
    // Across a blank line the list is still open (CommonMark: a loose list).
    assert.deepStrictEqual(names('- a\n\n5. c\n'), ['a', 'c']);
    // A paragraph after the blank ENDS the list; the ordinal after it is prose
    // — the round-2 B2 contract, now placed where CommonMark places it.
    assert.deepStrictEqual(names('- a\n\nprose here\n5. c\n'), ['a  prose here 5. c']);
    // Doc start and after a heading are paragraph positions: the B2 pins hold.
    assert.deepStrictEqual(names('5. c\n'), []);
    assert.deepStrictEqual(names('### Notes\n\n5. c\n'), []);
  });

  test('m1: the 9-digit boundary of an ordered start', () => {
    // `999999999.` is a legal CommonMark ordered marker; ten digits is not.
    assert.deepStrictEqual(names('1. a\n999999999. b\n'), ['a', 'b']);
    // Ten digits: not a marker at all — a lazy continuation of the open item.
    assert.deepStrictEqual(names('1. a\n1234567890. b\n'), ['a 1234567890. b']);
    // And a ten-digit line cannot open a run on its own.
    assert.deepStrictEqual(names('1234567890. b\n'), []);
  });

  test('m1: the indentation cliff is deliberately NOT applied — indent-lenient by design', () => {
    // CommonMark reads a 4-space-indented line outside a list as indented
    // code. This parser does not: `deferred-items.md` is hand-written with no
    // mandated shape, and surfacing a questionable entry beats dropping a real
    // one (the #2766 stance). Pinned as a decision, with the 3-space twin that
    // both readings agree on.
    assert.deepStrictEqual(names('   - x\n'), ['x']);
    assert.deepStrictEqual(names('    - x\n'), ['x']);
    // Nesting still folds by the indent rule at the 2-space depth executors
    // actually write, not only at the 4-space depth round 1 tested.
    assert.deepStrictEqual(names('- alpha\n  - nested\n- beta\n'), ['alpha - nested', 'beta']);
  });
});

describe('#3702 round 2: thematic breaks and fenced code are not list items (M1, M2)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);

  test('M1: a thematic break opens no entry, whichever character it is drawn with', () => {
    // `- - -` was a phantom `"- -"` entry on base already; round 1 added
    // `* * *` and `+ + +` to the class — and `* * *` is the separator an
    // author writing in the `*` style is most likely to use.
    for (const hr of ['* * *', '+ + +', '- - -', '***', '---', '___', ' * * *', '*  *  *  ', '- - - - -']) {
      assert.deepStrictEqual(names(`${hr}\n`), [], JSON.stringify(hr));
      assert.deepStrictEqual(names(`### Entry\n\n${hr}\n`), [], `heading: ${JSON.stringify(hr)}`);
    }
  });

  test('M1: a thematic break ENDS the open entry rather than joining it', () => {
    // CommonMark: a thematic break closes the list. The separator is neither a
    // phantom item nor a continuation line of the item above it.
    assert.deepStrictEqual(names('- alpha\n\n* * *\n\n- beta\n'), ['alpha', 'beta']);
    assert.deepStrictEqual(names('* alpha\n* * *\n* beta\n'), ['alpha', 'beta']);
    // Under a heading the break stays a BODY line (round 5, m3): the entry's
    // name is what `next` reports for that body, and its span stays contiguous
    // for the writer. It is still not evidence — a break alone is no entry.
    assert.deepStrictEqual(names('### Entry\n\n- **What:** x.\n\n* * *\n'), ['Entry  - **What:** x.  * * *']);
    assert.deepStrictEqual(names('### Entry\n\n* * *\n'), []);
    // `- - - x` is NOT a break (trailing text); it is a `- ` item whose text is `- - x`.
    assert.deepStrictEqual(names('- - - x\n'), ['- - x']);
  });

  test('M2: lines inside a fenced code block never open an entry', () => {
    // #3702's wild records carry reproduction blocks — `+`-prefixed diff lines
    // and `1.`-numbered repro steps are the NORMAL content of such a file.
    assert.deepStrictEqual(names('### Entry\n\n```sh\n1. run this\n2. then this\n```\n'), []);
    assert.deepStrictEqual(names('```diff\n+ added\n- removed\n```\n'), []);
    assert.deepStrictEqual(names('~~~\n* not an item\n~~~\n'), []);
    // An unterminated fence runs to the end of its ENTRY, never past it
    // (round 5, B1): a stray delimiter before the first item hides nothing.
    assert.deepStrictEqual(names('```\n- still fenced\n'), ['still fenced']);
  });

  test('B1 (round 5): an unterminated fence runs to the end of its entry — a stray delimiter cannot swallow later entries', () => {
    // The exact review reproduction, at indent 0 and at 4: `next` reports two
    // entries and round 4 reported ONE, with `- b` swallowed into `a`'s name.
    assert.deepStrictEqual(names('- a\n\n```\n\n- b\n'), ['a  ```', 'b']);
    assert.deepStrictEqual(names('- a\n\n    ```\n\n- b\n'), ['a  ```', 'b']);
    // A TERMINATED deep fence still gates what it encloses (round 4, M2 holds).
    assert.deepStrictEqual(names('- a\n    ```\n    - not b\n    ```\n- b\n'), ['a ``` - not b ```', 'b']);
    // Inside its own entry the stray fence still gates: a `status:` under it
    // does not resolve the entry, and the NEXT entry is read on its own terms.
    const statusesOf = (md) => parseDeferredItemsWithStatus(SECTION + md).map((i) => i.status);
    assert.deepStrictEqual(statusesOf('- alpha\n    ```\n    status: resolved\n- beta\n  status: resolved\n'), ['', 'resolved']);
    // A delimiter after the bound is a fence in its own right: without the
    // rescan the `~~~` pair below would be invisible and beta would resolve.
    assert.deepStrictEqual(statusesOf('- a\n```\n- b\n  ~~~\n  status: resolved\n  ~~~\n- c\n'), ['', '', '']);
    assert.deepStrictEqual(names('- a\n```\n- b\n  ~~~\n  status: resolved\n  ~~~\n- c\n'), ['a ```', 'b ~~~ status: resolved ~~~', 'c']);
    // Heading shape: a heading ends the entry, and the fence with it. (At
    // indent 0 the heading TOKENIZER applies CommonMark's own fence rule, so
    // `### Next` after a stray delimiter is body text there, exactly as on
    // `next`; at four spaces the tokenizer sees no fence and the heading holds.)
    assert.deepStrictEqual(names('### Entry\n\n- **What:** x\n\n```\n\n### Next\n\n- y\n'), ['Entry  - **What:** x  ```  ### Next  - y']);
    assert.deepStrictEqual(names('### Entry\n\n- **What:** x\n\n    ```\n\n### Next\n\n- y\n'), ['Entry  - **What:** x  ```', 'Next  - y']);
    // And in the headless region before the first heading (four spaces, for
    // the tokenizer reason above — at indent 0 the section has no heading).
    assert.deepStrictEqual(names('    ```\n- a\n\n### Entry\n\n- b\n'), ['a', 'Entry  - b']);
    assert.deepStrictEqual(names('```\n- a\n\n### Entry\n\n- b\n'), ['a  ### Entry', 'b']);
  });

  test('M2: a fence inside an entry is continuation, and the entry still parses around it', () => {
    const md = '- alpha\n  ```sh\n  1. step\n  + diff\n  ```\n  status: resolved\n- beta\n';
    const withStatus = parseDeferredItemsWithStatus(SECTION + md);
    assert.strictEqual(withStatus.length, 2, JSON.stringify(withStatus));
    assert.strictEqual(withStatus[0].status, 'resolved');
    assert.deepStrictEqual(names(md), ['beta']);
    // Heading shape: the fenced lines are body text, not evidence — the `-`
    // line outside the fence is what keeps the entry.
    assert.strictEqual(names('### Entry\n\n- **What:** x.\n\n```\n1. repro\n```\n').length, 1);
    // And the acknowledge writer's span survives a fenced continuation.
    const ack = acknowledgeDeferredItem(SECTION + '- alpha\n  ```\n  + diff\n  ```\n- beta\n', 'alpha ``` + diff ```');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
  });
});

describe('#3702 round 2: indent measure is grammar-scoped (review round 6)', () => {
  // The deferred grammar measures CommonMark columns (a tab is a jump to the
  // next multiple of 4); the Gaps grammar keeps `next`'s raw character count.
  // Sharing one measure silently changed Gaps entry boundaries in BOTH
  // directions on tab-indented input, breaking the `blockStructure: false`
  // opt-out's byte-for-byte promise.
  const gapsNames = (body) => parseUatItems(['# UAT', '', '## Gaps', '', body, ''].join('\n')).map((i) => i.name);
  const deferredNames = (body) => parseDeferredItems('## Deferred Items\n\n' + body + '\n').map((i) => i.name);

  test('Gaps: a tab-indented item followed by a two-space one stays ONE entry, as on `next`', () => {
    assert.deepEqual(gapsNames('\t- first item\n  - second item'), ['first item - second item']);
  });

  test('Gaps: a two-space item followed by a tab-indented one stays TWO entries, as on `next`', () => {
    assert.deepEqual(gapsNames('  - first item\n\t- second item'), ['first item', 'second item']);
  });

  test('Gaps: four spaces then two spaces splits, and a tab pair splits — unchanged either way', () => {
    assert.deepEqual(gapsNames('    - first item\n  - second item'), ['first item', 'second item']);
    assert.deepEqual(gapsNames('\t- first item\n\t- second item'), ['first item', 'second item']);
  });

  test('deferred: the SAME tab/space pairs measure in columns — the opposite verdict, by design', () => {
    assert.deepEqual(deferredNames('\t- first\n  - second'), ['first', 'second']);
    assert.deepEqual(deferredNames('  - first\n\t- second'), ['first - second']);
  });
});

describe('#3702 round 2: round-review refinements (ordered run, rejected ordinals, breaks, fenced fields, Gaps scope)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);
  const statuses = (md) => parseDeferredItemsWithStatus(SECTION + md).map((i) => i.status);

  test('an ordered run ENDS at a paragraph that follows a blank line (CommonMark §5.3), but survives lazy continuation', () => {
    // A blank line then a non-indented, non-list line is a paragraph: the list
    // is over, and `5. x` after it is prose folded into the open entry.
    const got = names('1. a\n\nparagraph\n\n5. x\n');
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /^a/);
    // No blank line → lazy continuation → the list is still open and `2. b` is an item.
    assert.deepStrictEqual(names('1. a\nlazy continuation\n2. b\n'), ['a lazy continuation', 'b']);
    // Heading shape carries the same rule per body.
    assert.strictEqual(names('### Steps\n\n1. do\n\nsome prose.\n\n4. not an item\n').length, 1);
  });

  test('an accepted opener clears the blank-line memory — lazy continuation right after it keeps the run', () => {
    // Round-review continuation: `blankSeen` survived the opener branch, so
    // `2. b` + a lazy line ended the run and `3. c` folded into `b`.
    assert.deepStrictEqual(names('1. a\n\n2. b\nlazy continuation\n3. c\n'), ['a', 'b lazy continuation', 'c']);
  });

  test('a headless region of a heading-shaped file applies the SAME paragraph reset — opener flags come from the splitter, not a re-derivation', () => {
    // Round-review continuation: a re-derived flag set re-accepted `3.` under a
    // stale run after the paragraph had ended it, and stripped it into a field.
    const md = '1. alpha\n\nparagraph\n\n3. status: resolved\n\n### Entry\n\n- **What:** x\n';
    assert.deepStrictEqual(statuses(md), ['', '']);
    assert.strictEqual(names(md).length, 2);
  });

  test('an ordered run is per INDENT: a nested `1. / 2.` run resolves (round-1 parity), and a nested ordinal after a nested bullet continues that level\'s list', () => {
    // Round-review continuation 2: nested openers read the top-level run and
    // never wrote their own.
    for (const eol of ['\n', '\r\n']) {
      const nestedRun = '- alpha\n  1. what: detail\n  2. status: resolved\n\n### Entry\n\n- **What:** x\n'.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(nestedRun), ['resolved', ''], JSON.stringify(eol));
      // Round 5 (M2): a list is open at the nested level, so `3.` is an item
      // there — a fresh ordered list in CommonMark — and a nested item that
      // reads `status: resolved` is a field line, as `- status: resolved` is.
      const nestedAfterBullet = '1. alpha\n  - nested item\n  3. status: resolved\n\n### Entry\n\n- **What:** x\n'.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(nestedAfterBullet), ['resolved', ''], JSON.stringify(eol));
      // With NO list open at the nested level the ordinal is prose (round 2).
      const leak = '1. alpha\n  nested prose\n  3. status: resolved\n\n### Entry\n\n- **What:** x\n'.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(leak), ['', ''], JSON.stringify(eol));
    }
    // A new top-level item resets the nested levels: `2.` under beta does not continue alpha's nested run.
    assert.deepStrictEqual(statuses('- alpha\n  1. a\n- beta\n  2. status: resolved\n'), ['', '']);
    // Under a heading the same per-indent rule applies.
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n  1. step\n  2. **Status:** resolved\n'), ['resolved']);
  });

  test('a DEDENTING top-level list keeps its entry boundaries — every indent at or above the base is one level', () => {
    // Round-review continuation 3: the exact-indent run lookup rejected the
    // shallower ordinals, collapsing three entries into one.
    assert.deepStrictEqual(names('    1. alpha\n  2. beta\n3. gamma\n'), ['alpha', 'beta', 'gamma']);
    assert.deepStrictEqual(names('  - alpha\n- beta\n    - gamma\n'), ['alpha', 'beta - gamma']);
  });

  test('indent is measured in CommonMark COLUMNS (a tab advances to the next multiple of 4), so a tab and a space are different levels', () => {
    // Round-review continuation 3: character counting aliased `\t` and ` `.
    // Heading shape, where every ACCEPTED nested opener is marker-stripped
    // before field extraction (the headless path strips line 0 only — #3740).
    for (const eol of ['\n', '\r\n']) {
      const body = (nested) => `### Entry\n\n- **What:** x\n${nested}`.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(body('\t1. nested\n 2. **Status:** resolved\n')), [''], JSON.stringify(eol));
      assert.deepStrictEqual(statuses(body('\t1. nested\n\t2. **Status:** resolved\n')), ['resolved'], JSON.stringify(eol));
      assert.deepStrictEqual(statuses(body('    1. nested\n\t2. **Status:** resolved\n')), ['resolved'], JSON.stringify(eol));
    }
  });

  test('a fenced block ends the runs at its indent and deeper, like a paragraph does', () => {
    // Round-review continuation 3: a nested run stayed open across a fence,
    // so a post-fence `2. status: resolved` resolved the entry. Heading shape,
    // for the reason the columns test states.
    const body = (nested) => `### Entry\n\n- **What:** x\n${nested}`;
    assert.deepStrictEqual(statuses(body('  1. a\n  ```\n  code\n  ```\n  2. **Status:** resolved\n')), ['']);
    // A deeper fence (3 spaces — the sectionizer's CommonMark `{0,3}` limit) leaves the shallower run alone.
    assert.deepStrictEqual(statuses(body('  1. a\n   ```\n   code\n   ```\n  2. **Status:** resolved\n')), ['resolved']);
    // Control: without the fence the run continues and resolves.
    assert.deepStrictEqual(statuses(body('  1. a\n  2. **Status:** resolved\n')), ['resolved']);
  });

  test('a REJECTED ordinal line under a heading is not marker-stripped, so it cannot manufacture a field', () => {
    // `3. status: resolved` at a PARAGRAPH position is prose by the
    // ordered-start rule; before this fix the heading path stripped its marker
    // anyway and read a resolved field off it. (Round 5, M2: directly after a
    // list item it is an item instead — a list is open there.)
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n\nSome prose.\n3. status: resolved\n'), ['']);
    assert.strictEqual(names('### Entry\n\n- **What:** x\n\nSome prose.\n3. status: resolved\n').length, 1);
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n3. status: resolved\n'), ['resolved']);
    // An ACCEPTED ordered status line still resolves, as `- status: resolved` does.
    assert.deepStrictEqual(statuses('### Entry\n\n1. **What:** x\n2. **Status:** resolved\n'), ['resolved']);
    // Same rule in a headless region of a heading-shaped file.
    assert.deepStrictEqual(statuses('- alpha\n  3. status: resolved\n\n### Entry\n\n- **What:** x\n'), ['', '']);
  });

  test('a thematic break is recognised at any indent — the parser is indent-lenient for breaks as it is for items', () => {
    assert.deepStrictEqual(names('    * * *\n'), []);
    assert.deepStrictEqual(names('- alpha\n\n      - - -\n\n- beta\n'), ['alpha', 'beta']);
  });

  test('a status line orphaned after a break leaves its entry OPEN — the fail-safe polarity, pinned', () => {
    // `- alpha\n---` is a list then a thematic break in CommonMark; the indented
    // line after it belongs to nothing. Surfacing alpha is the safe direction.
    assert.deepStrictEqual(names('- alpha\n---\n  status: resolved\n'), ['alpha']);
  });

  test('fenced lines carry no FIELDS either — a fenced `status: resolved` does not resolve the entry', () => {
    assert.deepStrictEqual(statuses('- alpha\n```\nstatus: resolved\n```\n'), ['']);
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n```\n- **Status:** resolved\n```\n'), ['']);
    assert.deepStrictEqual(statuses('- alpha\n  ```yaml\n  status: resolved\n  ```\n  status: acknowledged\n'), ['acknowledged']);
  });

  test('`## Gaps` keeps its round-1 grammar byte-for-byte: no fence or break awareness there', () => {
    // Block structure (M1/M2) is scoped to the deferred grammar via
    // `BulletMarkers.blockStructure`; the Gaps section is template-mandated and
    // out of #3702's blast radius, so a fenced hyphen line still counts there,
    // and a fenced field is still read — exactly as on `next`.
    //
    // THE SECOND ASSERTION tracks `next`'s #3898 fix, which landed in the
    // base range this branch merged (b431ae9f0): a spaced hyphen thematic
    // break in `## Gaps` is a SEPARATOR — skipped between entries — so
    // `- - -` no longer surfaces a phantom open gap named `- -`. Until that
    // fix this line pinned the phantom on purpose (round 4, m4), because it
    // was the only assertion that would notice the Gaps path moving; it still
    // is, and it now pins the fixed reading. The full separator table lives in
    // the #3898 describe block above; this one keeps the Gaps opt-out honest.
    const uat = ['---', 'status: partial', 'phase: 01-x', '---', '', '## Gaps', '', '```', '- truth: phantom', '  status: open', '```', ''].join('\n');
    const got = parseUatItems(uat);
    assert.deepStrictEqual(got.map((i) => i.name), ['phantom'], JSON.stringify(got));
    const withBreak = ['---', 'status: partial', 'phase: 01-x', '---', '', '## Gaps', '', '- - -', '- truth: real', '  status: open', ''].join('\n');
    assert.deepStrictEqual(parseUatItems(withBreak).map((i) => i.name), ['real']);
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

  // #3078 security review: a terminal `complete` file that still contains
  // `### N.` blocks the parser could not read. The author's claim of
  // completeness cannot be verified against rows nobody could read, so this
  // IS surfaced, with parse_gap.
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

  // The genuinely-terminal case the old `status !== 'complete'` guard was
  // really protecting: `complete` with NO `### N.` test blocks at all, so
  // `headingsSeen === 0` and there is nothing unread to contradict the
  // author's claim. Must stay omitted entirely.
  const NO_BLOCKS_COMPLETE = `---
status: complete
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

All scenarios were exercised manually and signed off; nothing left to record.

## Notes

Closed out at the milestone review.
`;

  // The other must-not-regress terminal case: `complete` where every row DID
  // parse and every row passed. `headingsSeen` is never set for a parsed row,
  // so this file stays quiet — a genuinely finished file must not become
  // noise just because the status guard was removed.
  const ALL_PASS_ROWS_COMPLETE = `---
status: complete
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. First Scenario
expected: Works fine
result: pass

### 2. Second Scenario
expected: Also works fine
result: pass
`;

  // The security reviewer's verbatim repro: a `status: complete` file with a
  // column-0 fence that straddles a `### 2. ... result: blocked` row. The
  // straddled row is hidden from the tokenizer, so it yields no item — under
  // the old guard the terminal status ALSO suppressed the parse-gap entry and
  // the audit reported the file totally clean with a `blocked` sitting in it.
  const FENCE_STRADDLED_BLOCKED_COMPLETE = `---
status: complete
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Alpha
expected: Alpha works
result: pass

\`\`\`
### 2. Straddled Blocked
expected: Beta works
result: blocked
blocked_by: server team
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

  // #3078 security review — REPLACES "a zero-item file with a complete status
  // is still omitted". That test used ALL_UNPARSEABLE_ROWS_COMPLETE, whose
  // `### 1.` block carries no `result:` line, so it is NOT a zero-item file in
  // the sense the name claimed: it is a file with one block the parser could
  // not read (`headingsSeen === 1`). Under the old `status !== 'complete'`
  // guard the terminal status suppressed the entry anyway, which is the
  // self-declared kill switch this change closes. The intent the old test
  // meant to protect — a genuinely finished file stays quiet — is preserved
  // and made STRICTER below, split across the two cases that actually differ:
  // `headingsSeen === 0` (nothing unread) still omits, `headingsSeen > 0`
  // (rows the tool could not read) now surfaces.
  //
  // Round-3 review MAJOR 2 still applies to all of these: the fixture must be
  // written as `01-UAT.md` into `01-foundation`, because under #3511 phase
  // scoping `selectPhaseUatFiles` filters files against the phase dir's own
  // token, and a mismatched pair is never opened at all — making any
  // "expected undefined" assertion vacuously green. `writeUat`'s defaults
  // give the matching pairing.

  // REPLACEMENT 1 — preserves the original intent, unweakened: terminal
  // `complete` with no test blocks at all is omitted entirely.
  test("a complete file with no test blocks at all is still omitted", () => {
    writeUat(NO_BLOCKS_COMPLETE);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry for 01-UAT.md, got ${JSON.stringify(entry)}`);
    assert.strictEqual(output.summary.total_items, 0);
  });

  // REPLACEMENT 1b — the same intent for the other genuinely-finished shape:
  // every row parsed and every row passed. This is the important
  // non-regression for removing the status guard.
  test("a complete file whose rows all parse and all pass is still omitted", () => {
    writeUat(ALL_PASS_ROWS_COMPLETE);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.strictEqual(entry, undefined, `expected no results entry for 01-UAT.md, got ${JSON.stringify(entry)}`);
    assert.strictEqual(output.summary.total_items, 0);
  });

  // REPLACEMENT 2 — the new distinction: terminal `complete` with `### N.`
  // blocks the parser could not read IS surfaced. The author's assertion of
  // completeness cannot be verified against rows nobody could read.
  test("a complete file with unparseable test blocks is surfaced with parse_gap", () => {
    writeUat(ALL_UNPARSEABLE_ROWS_COMPLETE);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry for 01-UAT.md, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.status, "complete");
    assert.strictEqual(entry.parse_gap, true);
    assert.strictEqual(entry.unparsed_blocks, 1);
    assert.deepStrictEqual(entry.items, []);
  });

  // The security reviewer's actual repro. A column-0 fence straddles
  // `### 2. ... result: blocked`, hiding it from the tokenizer; the terminal
  // status used to suppress the resulting parse-gap entry too, so the audit
  // reported nothing at all for a file with a `blocked` row in it.
  test("a complete file with a fence-straddled blocked row is flagged, not silent", () => {
    writeUat(FENCE_STRADDLED_BLOCKED_COMPLETE);
    const output = runAudit();
    const entry = output.results.find((r) => r.file === "01-UAT.md");
    assert.ok(entry, `expected a results entry for 01-UAT.md, got ${JSON.stringify(output.results)}`);
    assert.strictEqual(entry.status, "complete");
    assert.strictEqual(entry.parse_gap, true);
    // Both `### N.` headings are counted by the whole-document shortfall
    // comparison: row 1 parsed but passed (so yields no item) and row 2 is
    // hidden by the unterminated fence entirely.
    assert.strictEqual(entry.unparsed_blocks, 2);
    // The gap counter is the straddled row's only trace. Assert by identity
    // that the blocked row did NOT sneak through as an item.
    assert.strictEqual(
      entry.items.find((i) => i.test === 2),
      undefined,
      `the straddled row must not appear as an item, got ${JSON.stringify(entry.items)}`,
    );
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

// ─── #3078 round 7 HIGH: the shortfall scan is symmetric, and over-reports ────
//
// The `## Tests`-section scoping that used to keep a documentation sample quiet
// (review MINOR 1) is RETIRED. Scoping the raw line scan while the PARSE side
// stayed whole-document produced two separate HIGH-severity SILENT FALSE
// CLEANS (see the round-7 describe block at the end of this file). Both sides
// of the comparison are now whole-document, and the documented consequence —
// pinned here so it is visible rather than surprising — is that a closed-fence
// row-format sample in `## Notes` raises a parse gap on a file with nothing
// missing. That is an OVER-report: noisy, visible, fail-safe. It is the
// deliberate trade; do not "optimise" it back into a scope.
describe("#3078 round 7: a documented row-format sample inside a closed fence is an ACCEPTED over-report", () => {
  test("a clean pending row plus a `## Notes` fence containing `### 9. Example row` raises a parse gap (accepted over-report, not a false clean)", () => {
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
    // The `### 9.` sample line is heading-SHAPED at column 0 but hidden from
    // the tokenizer by its fence, so it registers as a shortfall of exactly 1.
    assert.strictEqual(headingsSeen, 1, describeAll());
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

// ─── #3078 round 4 MAJOR 1: an indented delimiter may be a COLUMN-0 fence's closer ──
//
// `blankIndentedFenceDelimiters` blanked every indented delimiter LINE on
// sight, with no notion of open/closed state. CommonMark lets a column-0 fence
// be CLOSED by a delimiter indented up to three spaces, so the pass perturbed
// fence pairing in BOTH directions and swallowed a genuinely outstanding row:
//   - column-0 opener + indented closer: the closer was blanked, the fence
//     never closed for `tokenizeHeadings`, and the row after it vanished —
//     `{items: [], headingsSeen: 1}` pre-fix, where the identical document with
//     a column-0 closer returned the row;
//   - indented opener + column-0 closer: the opener was blanked, PROMOTING the
//     closer into an opener, same vanishing row, same `{items: [],
//     headingsSeen: 1}`.
// Both documents are legal CommonMark that renders correctly, so the row's
// CONTENT — not merely a count — must survive. Every assertion below is on row
// IDENTITY (number AND name) plus its result/blocked_by, never on a count:
// pre-fix these files reported a parse-gap shortfall of 1, so a count-only
// assertion would have shipped the content loss as intended behaviour.
describe('#3078 round 4 MAJOR 1: an indented fence delimiter must not perturb column-0 fence pairing', () => {
  const BACKTICK = '```';
  const TILDE = '~~~';
  const LONG_BACKTICK = '`````';

  function documentWith(opener, closer) {
    return `## Tests

### 1. Alpha
result: pass

${opener}
hidden sample text
${closer}
### 2. Outstanding Row
result: blocked
blocked_by: server
`;
  }

  function assertOutstandingRowSurfaced(content) {
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    const row = items.find((i) => i.test === 2);
    assert.ok(row, `outstanding row 2 absent: ${describeAll()}`);
    assert.strictEqual(row.name, 'Outstanding Row', describeAll());
    assert.strictEqual(row.result, 'blocked', describeAll());
    assert.strictEqual(row.blocked_by, 'server', describeAll());
    assert.strictEqual(row.category, 'server_blocked', describeAll());
    return { items, headingsSeen, describeAll };
  }

  test('a column-0 opener closed by a 3-space-indented closer still surfaces the row after it', () => {
    const { headingsSeen, describeAll } = assertOutstandingRowSurfaced(
      documentWith(BACKTICK, `   ${BACKTICK}`),
    );
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('the same document with a column-0 closer is unchanged (control)', () => {
    const { headingsSeen, describeAll } = assertOutstandingRowSurfaced(
      documentWith(BACKTICK, BACKTICK),
    );
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('a 2-space-indented opener closed by a column-0 closer still surfaces the row after it', () => {
    const { headingsSeen, describeAll } = assertOutstandingRowSurfaced(
      documentWith(`  ${BACKTICK}`, BACKTICK),
    );
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // Same two pairings on the OTHER delimiter character and at a run length
  // longer than 3, so the fix cannot be a backtick-and-exactly-3 special case:
  // the delimiter rules come from the shared `scanFencedBlocks` engine.
  test('a column-0 `~~~` opener closed by a 2-space-indented `~~~` closer still surfaces the row after it', () => {
    assertOutstandingRowSurfaced(documentWith(TILDE, `  ${TILDE}`));
  });

  test('a 3-space-indented `~~~` opener closed by a column-0 `~~~` closer still surfaces the row after it', () => {
    assertOutstandingRowSurfaced(documentWith(`   ${TILDE}`, TILDE));
  });

  test('a column-0 5-backtick opener closed by a 3-space-indented 5-backtick closer still surfaces the row after it', () => {
    assertOutstandingRowSurfaced(documentWith(LONG_BACKTICK, `   ${LONG_BACKTICK}`));
  });

  test('a 2-space-indented opener closed by a column-0 LONGER-run closer still surfaces the row after it', () => {
    assertOutstandingRowSurfaced(documentWith(`  ${BACKTICK}`, LONG_BACKTICK));
  });

  // The case the helper EXISTS for must not regress: an indented fence PAIR
  // living wholly inside an `expected: |` value is neutralised, so a later
  // column-0 row is still tokenised — and the scalar itself is still published
  // verbatim, fences and all.
  test('an indented fence PAIR wholly inside an `expected: |` body still leaves a later row visible', () => {
    const content = `## Tests

### 1. Alpha
expected: |
  ${BACKTICK}
  sample
  ${BACKTICK}
result: pending

### 2. Beta
result: blocked
`;
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    const alpha = items.find((i) => i.test === 1);
    const beta = items.find((i) => i.test === 2);
    assert.ok(alpha, `row 1 absent: ${describeAll()}`);
    assert.strictEqual(alpha.name, 'Alpha', describeAll());
    assert.strictEqual(alpha.expected, `${BACKTICK}\nsample\n${BACKTICK}`, describeAll());
    assert.ok(beta, `row 2 absent: ${describeAll()}`);
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('an indented `~~~` PAIR wholly inside an `expected: |` body still leaves a later row visible', () => {
    const content = `## Tests

### 1. Alpha
expected: |
  ${TILDE}
  sample
  ${TILDE}
result: pending

### 2. Beta
result: blocked
`;
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    const beta = items.find((i) => i.test === 2);
    assert.ok(beta, `row 2 absent: ${describeAll()}`);
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });
});

// ─── #3078 round 4 MAJOR 2: an indented row must be COUNTED, not dropped ──
//
// `isColumnZeroHeading` refusing to PARSE an indented `### N.` row is
// deliberate. But `TEST_HEADING_LINE_RE` — the shortfall scan that exists to
// count rows the parser could not read — inherited the same column-0 anchor,
// so a heading the parse gate rejected could never reach `headingsSeen`
// either. origin/next's unanchored `###\s*(\d+)\.` surfaced
// `  ### 1. Indented Row` with its `result: pending`; pre-fix this HEAD
// returned `{items: [], headingsSeen: 0}` — no item, no gap, no count, no
// trace. Refusing to parse is defensible; vanishing silently is the defect
// class this issue exists to close.
describe('#3078 round 4 MAJOR 2: an indented test row surfaces as a parse gap instead of vanishing', () => {
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

  function writeUat(content) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), content);
  }

  test('a file whose only test row is indented yields no item but IS flagged as a parse gap', () => {
    writeUat(`${FRONTMATTER}## Tests

  ### 1. Indented Row
result: pending
`);
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const entry = output.results.find((r) => r.file === '01-UAT.md');
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.ok(entry, `expected a results entry, got ${describeAll()}`);
    assert.deepStrictEqual(entry.items, [], describeAll());
    assert.strictEqual(entry.parse_gap, true, describeAll());
    assert.ok(entry.unparsed_blocks >= 1, describeAll());
    assert.strictEqual(output.summary.parse_gap_files, 1, describeAll());
  });

  test('the indented row is counted at the parser seam too', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

  ### 1. Indented Row
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  // Boundary coverage on the counter's indent tolerance: 1, 2 and 3 spaces are
  // heading-shaped and must be counted. 4+ spaces and a leading TAB are ALSO
  // counted since #3078 round 7 — see the replacement test below for why the
  // old "indented code block, not a row" carve-out was retired.
  for (const spaces of [1, 2, 3]) {
    test(`a row indented ${spaces} space(s) is counted as an unparsed block`, () => {
      const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

${' '.repeat(spaces)}### 1. Indented Row
result: pending
`);
      const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
      assert.deepStrictEqual(items, [], describeAll());
      assert.strictEqual(headingsSeen, 1, describeAll());
    });
  }

  // REPLACES the retired 'a line indented 4 spaces is an indented code block,
  // not a row, and is not counted' pin (#3078 round 7). That carve-out read
  // the line as CommonMark would and therefore dropped it with no trace at
  // all — items=[], headingsSeen=0 — which is exactly the vanishing-row class
  // this counter exists to close, and which origin/next's unanchored
  // `###\s*(\d+)\.` did surface. The counter now takes `^[ \t]+`, so a row
  // indented 4+ spaces or with a leading TAB is still refused by the PARSE
  // gate (`isColumnZeroHeading` is unchanged) but is visible as a parse gap.
  test('a line indented 4 spaces is still refused by the parse gate but IS counted, not dropped silently', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: blocked

    ### 2. Code Block Line
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].name, 'Alpha', describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  // The counting loosening must NOT reach an indented `### N.` that is the
  // VALUE of an `expected:` block scalar — that line is already published,
  // verbatim, as the row's own `expected` field, so counting it would flag a
  // parse gap against a document with nothing missing.
  test('an indented `### N.` that is `expected:` scalar VALUE text is still not counted', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ### 3. Fake Row
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(items[0].name, 'Alpha', describeAll());
    assert.strictEqual(items[0].expected, '### 3. Fake Row', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // Same exclusion across the whole opener family the reader accepts — the
  // line-level header grammar is derived from the reader's own source, so a
  // new opener shape cannot be admitted by one and refused by the other.
  for (const opener of ['|', '|-', '|+', '|2', '|2-', '|-2', '>', '>-', '>+', '>2', '>2+']) {
    test(`an indented \`### N.\` under an \`expected: ${opener}\` scalar is not counted`, () => {
      const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: ${opener}
  ### 3. Fake Row
result: pending
`);
      const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
      assert.strictEqual(items.length, 1, describeAll());
      assert.strictEqual(items[0].name, 'Alpha', describeAll());
      assert.strictEqual(headingsSeen, 0, describeAll());
    });
  }

  // An indented row following a CLOSED scalar body (the preceding column-0
  // line is an ordinary field, not a scalar header) is a row, not value text.
  test('an indented row after a completed row is still counted', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: pass

  ### 2. Indented Row
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
  });
});

// ─── #3078 round 5: COLUMN 0 IS STRUCTURE, INDENTATION IS CONTENT (PINNED) ────
//
// THE RULE, stated once so it stops being re-litigated: a delimiter at COLUMN 0
// is document structure; anything indented is content. `blankIndentedFenceDelimiters`
// therefore blanks the DELIMITER LINES of a wholly-indented fenced block and
// NOTHING ELSE — never the body.
//
// The consequence, which LOOKS like a bug and is not: a column-0 `### N.` line
// sitting BETWEEN two indented delimiters genuinely IS a heading, and a
// `result:` line after it genuinely belongs to it. There is no fence for that
// line to be "inside" of, because by the very rule that neutralised the block,
// an indented delimiter is not a fence. The document below is malformed; the
// parser reading it this way is CONSISTENT, not thieving.
//
// This was once "fixed" by blanking the whole block open-to-close. That was
// REVERTED: it destroys content legitimately living between the delimiters, and
// on an UNTERMINATED indented opener it blanks to EOF, dropping every later row
// in the file. The tests below therefore PIN the consistent reading by ROW
// IDENTITY so the next person does not flip it back — if you are here because
// this "looks wrong", read `blankIndentedFenceDelimiters`'s comment first.
//
// Nothing vanishes silently either way: the row that loses its `result:` is
// counted in `headingsSeen`, i.e. it surfaces as a parse gap.
describe('#3078 round 5: column 0 is structure, so a column-0 heading between indented delimiters is a heading', () => {
  const BACKTICK = '```';
  const TILDE = '~~~';
  const LONG_BACKTICK = '`````';

  function documentWith(opener, closer) {
    return `## Tests

### 1. Alpha
expected: x
${opener}
### 9. Phantom
${closer}
result: pending
`;
  }

  // Measured, not assumed: row 9 is real and owns the `result: pending` that
  // follows it, row 1 has no `result:` of its own left and is reported as an
  // unparsed block rather than dropped.
  function assertColumnZeroHeadingWon(content) {
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 9, describeAll());
    assert.strictEqual(items[0].name, 'Phantom', describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(items[0].category, 'pending', describeAll());
    assert.strictEqual(items[0].expected, undefined, describeAll());
    assert.strictEqual(
      items.find((i) => i.test === 1),
      undefined,
      `row 1 lost its result: line to the column-0 heading and must not yield an item: ${describeAll()}`,
    );
    // The pin that keeps this from being a silent drop.
    assert.strictEqual(headingsSeen, 1, describeAll());
    return { items, headingsSeen, describeAll };
  }

  test('a column-0 `### 9.` inside a 2-space-indented backtick pair IS a heading', () => {
    assertColumnZeroHeadingWon(documentWith(`  ${BACKTICK}`, `  ${BACKTICK}`));
  });

  test('the same document with an indented `~~~` pair behaves identically', () => {
    assertColumnZeroHeadingWon(documentWith(`  ${TILDE}`, `  ${TILDE}`));
  });

  test('the same document with an indented 5-backtick pair behaves identically', () => {
    assertColumnZeroHeadingWon(documentWith(`   ${LONG_BACKTICK}`, `   ${LONG_BACKTICK}`));
  });

  // The UNTERMINATED indented opener — the case that makes whole-block blanking
  // untenable, because its "body" is the whole rest of the file. Row 1 keeps its
  // own `result:` (which precedes the opener) and the later column-0 row keeps
  // ITS `result:`; blanking to EOF would have deleted both rows below the opener.
  test('an unterminated indented opener neutralises only itself: both later rows survive', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: x
result: pending
  ${BACKTICK}
### 9. Phantom
result: blocked
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const alpha = items.find((i) => i.test === 1);
    const phantom = items.find((i) => i.test === 9);
    assert.ok(alpha, `row 1 "Alpha" absent: ${describeAll()}`);
    assert.strictEqual(alpha.name, 'Alpha', describeAll());
    assert.strictEqual(alpha.result, 'pending', describeAll());
    assert.strictEqual(alpha.expected, 'x', describeAll());
    assert.ok(phantom, `the column-0 row after the opener was swallowed: ${describeAll()}`);
    assert.strictEqual(phantom.name, 'Phantom', describeAll());
    assert.strictEqual(phantom.result, 'blocked', describeAll());
    assert.strictEqual(items.length, 2, describeAll());
    // The unterminated opener is still reported on the RAW document.
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  // The case the helper EXISTS for, unchanged: blanking is done on a
  // tokenizer-only COPY, so `parseExpectedFromTestBlock` still reads the RAW
  // block and a legitimate `expected: |` scalar containing an indented fenced
  // sample still publishes that sample verbatim.
  test('a legitimate `expected: |` scalar with an indented fenced sample still yields its full text', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  intro line
  ${BACKTICK}js
  const x = 1;
  ${BACKTICK}
  outro line
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const alpha = items.find((i) => i.test === 1);
    assert.ok(alpha, `row 1 absent: ${describeAll()}`);
    assert.strictEqual(alpha.name, 'Alpha', describeAll());
    assert.strictEqual(
      alpha.expected,
      `intro line\n${BACKTICK}js\nconst x = 1;\n${BACKTICK}\noutro line`,
      describeAll(),
    );
    assert.strictEqual(headingsSeen, 0, describeAll());
  });
});

// ─── #3078 round 5 MAJOR: ONE test-row grammar, shared by BOTH parse paths ────
//
// `parseFirstPendingTest` (render-checkpoint) filtered level-3 headings with
// `/^\d+\.\s+/` while `parseUatItemsWithStats` (audit) used `/^\d+\.(?!\d)/`.
// So `### 3.Foo` WAS a test row to the audit and was NOT one to the checkpoint:
// two paths in one module disagreeing about the same grammar. Both now go
// through `isTestRowHeadingText` / `parseTestRowHeadingText`, and the AUDIT rule
// won — it admits `### 3.` and `### 3.Foo` and excludes the dotted-outline
// `### 1.2.3`.
describe('#3078 round 5 MAJOR: the audit and render-checkpoint paths agree on what a test row is', () => {
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

  // A NON-STRUCTURED `## Current Test` section is what routes `parseCurrentTest`
  // into `parseFirstPendingTest` — the path under test here.
  const FRONTMATTER = `---
status: partial
phase: 01-test-phase
---

## Current Test

[testing paused — 1 item outstanding]

`;

  function documentFor(headingText) {
    return `## Tests

### ${headingText}
expected: EXPECTED-VALUE
result: pending
`;
  }

  function renderCheckpoint(headingText) {
    fs.writeFileSync(uatPath, `${FRONTMATTER}${documentFor(headingText)}`);
    return runGsdTools(
      ['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'],
      tmpDir,
    );
  }

  function assertBothPathsYieldRow(headingText, expectedNumber, expectedName) {
    const { items, headingsSeen } = parseUatItemsWithStats(documentFor(headingText));
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, `audit path: ${describeAll()}`);
    assert.strictEqual(items[0].test, expectedNumber, `audit path: ${describeAll()}`);
    assert.strictEqual(items[0].name, expectedName, `audit path: ${describeAll()}`);

    const result = renderCheckpoint(headingText);
    assert.strictEqual(
      result.success,
      true,
      `render-checkpoint path did not treat "### ${headingText}" as a row: ${result.error}`,
    );
    const output = JSON.parse(result.output);
    assert.strictEqual(output.test_number, expectedNumber, JSON.stringify(output));
    assert.strictEqual(output.test_name, expectedName, JSON.stringify(output));
  }

  function assertNeitherPathYieldsRow(headingText) {
    const { items } = parseUatItemsWithStats(documentFor(headingText));
    assert.deepStrictEqual(
      items,
      [],
      `audit path parsed "### ${headingText}" as a row: ${JSON.stringify(items)}`,
    );

    const result = renderCheckpoint(headingText);
    assert.strictEqual(
      result.success,
      false,
      `render-checkpoint path parsed "### ${headingText}" as a row: ${result.output}`,
    );
  }

  // `### 3.Foo` — the name squished against the dot. This is the shape that
  // actually diverged: a row to the audit, silently NOT a row to the checkpoint.
  test('`### 3.Foo` is a row with the same identity on BOTH paths', () => {
    assertBothPathsYieldRow('3.Foo', 3, 'Foo');
  });

  // `### 3.` — no name at all; both paths fall back to the heading's own text.
  test('`### 3.` is a row with the same identity on BOTH paths', () => {
    assertBothPathsYieldRow('3.', 3, '3.');
  });

  // The control that keeps the shared rule from being "anything starting with a
  // digit": a dotted OUTLINE number is a document heading, not test row 1.
  test('`### 1.2.3` is excluded on BOTH paths', () => {
    assertNeitherPathYieldsRow('1.2.3');
  });

  test('`### 1.2.3 Overview` is excluded on BOTH paths', () => {
    assertNeitherPathYieldsRow('1.2.3 Overview');
  });

  // The conventional shape neither path ever disagreed about — proves the
  // shared predicate did not narrow the grammar while closing the divergence.
  test('`### 3. Foo` is a row with the same identity on BOTH paths (control)', () => {
    assertBothPathsYieldRow('3. Foo', 3, 'Foo');
  });
});

// ─── #3078 round 5 MINOR: parseUatItems is a documented, TESTED wrapper ───────
//
// `parseUatItems` has no in-tree caller left (`cmdAuditUat` and
// `src/planning-inspect.cts` both use `parseUatItemsWithStats`) but is a public
// export of a shipped module, so it stays — removing an exported symbol is a
// contract change. It must not therefore be untested dead weight: this pins the
// one thing it promises, that it is the items-only projection of the stats form.
describe('#3078 round 5 MINOR: parseUatItems is the items-only form of parseUatItemsWithStats', () => {
  test('it returns exactly the `items` the stats form returns, and drops `headingsSeen`', () => {
    // A document exercising both surfaces: a surfaced `### N.` row, a passing
    // row that yields nothing, a `## Gaps` entry, and a heading with no
    // `result:` line at all (which contributes to headingsSeen only).
    const content = `## Tests

### 1. Alpha
expected: A
result: pending

### 2. Beta
result: pass

### 3. Gamma
expected: G

## Gaps

- truth: "an open finding"
  status: open
`;
    const stats = parseUatItemsWithStats(content);
    const items = parseUatItems(content);
    const describeAll = () => JSON.stringify({ items, stats }, null, 2);

    assert.deepStrictEqual(items, stats.items, describeAll());
    assert.strictEqual(
      stats.headingsSeen,
      1,
      `row 3 has no result: line and should be the only unparsed block: ${describeAll()}`,
    );
    // Identity, not just count — the wrapper must not reorder or re-shape.
    assert.strictEqual(items.length, 2, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(items[0].name, 'Alpha', describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(items[1].name, 'an open finding', describeAll());
    assert.strictEqual(items[1].result, 'open', describeAll());
  });
});

// ─── #3078 round 5 MINOR: `result:` is lower-cased once, at extraction ────────
//
// The PASS-token check re-lowercased an already-lower-cased value. Removing the
// redundant call must leave mixed-case tokens behaving exactly as before: a
// mixed-case PASS is still suppressed, and a mixed-case non-pass token is still
// surfaced with a lower-cased `result` and a matching `category`.
describe('#3078 round 5 MINOR: mixed-case result tokens normalize at a single point', () => {
  test('`result: PASS` and `result: Passed` are suppressed', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: PASS

### 2. Beta
result: Passed
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('`result: PENDING` surfaces lower-cased with a matching category', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: PENDING

### 2. Beta
result: Blocked
blocked_by: Server team
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 2, describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(items[0].category, 'pending', describeAll());
    assert.strictEqual(items[1].result, 'blocked', describeAll());
    assert.strictEqual(items[1].category, 'server_blocked', describeAll());
  });
});

// ─── #3078 MINOR 1: the indented-row counter is not `expected:`-ONLY ──────────
//
// `countUnattributedIndentedRows` walked back from an indented `### N.`-shaped
// line to the nearest preceding column-0 line and tested it against an
// `expected:`-ONLY grammar. A `reported: |` or `reason: |` block scalar
// (both template-sanctioned — `reported:` ships in gsd-core/templates/UAT.md)
// holding free-form prose that happens to contain an indented `### N.`-shaped
// line was therefore miscounted as a lost row on a file with nothing missing.
describe('#3078 MINOR 1: indented-row counter recognizes ANY key\'s block scalar, not only expected:', () => {
  test('an indented `### N.`-shaped line inside `reported: |` is not counted', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: human_needed
reported: |
  The user said:
  ### 9. Section Nine
  looked wrong.
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('an indented `### N.`-shaped line inside `reason: |` is not counted', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: skipped
reason: |
  See report:
  ### 9. Section Nine
  for details.
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // The walk-back logic itself must stay sound: a genuinely indented row that
  // is NOT the value of any preceding block scalar is still counted — this
  // fix must not just switch the counter off entirely.
  test('a genuinely indented row OUTSIDE any scalar is still counted', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: pass

  ### 2. Indented Row
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.deepStrictEqual(items, [], describeAll());
    assert.ok(headingsSeen >= 1, describeAll());
  });
});

// ─── #3078 MINOR 2: `reason:`/`blocked_by:` gain block-scalar grammar ─────────
//
// `reason:` and `blocked_by:` had no block-scalar grammar at all: `reason: |`
// published the literal string `"|"`, discarding the entire multi-line value;
// `reason: >` gave `">"`; `blocked_by: |` gave `"|"`. Not a regression
// (origin/next captures the same `"|"` on this fixture) but fixed anyway
// because `categorizeItem` reads exactly this field, so a discarded `reason`
// can silently change an item's category.
describe('#3078 MINOR 2: reason: and blocked_by: support block-scalar (|, >) values', () => {
  test('`reason: |` with a two-line body yields the exact multi-line value', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: skipped
reason: |
  Line one.
  Line two.
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].reason, 'Line one.\nLine two.', describeAll());
  });

  test('`reason: >` folds a two-line body into one space-joined line', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: skipped
reason: >
  Line one
  continues here.
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].reason, 'Line one continues here.', describeAll());
  });

  test('`blocked_by: |` with a multi-line body yields the exact value', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: blocked
blocked_by: |
  Waiting on the
  staging server team.
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].blocked_by, 'Waiting on the\nstaging server team.', describeAll());
  });

  test('a plain inline `reason: text` is unchanged', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: skipped
reason: not running locally
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].reason, 'not running locally', describeAll());
  });

  test('a plain inline `blocked_by: text` is unchanged', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: blocked
blocked_by: #123
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].blocked_by, '#123', describeAll());
  });

  // Categorization consequence: a `reason:` block scalar whose text mentions
  // "server" must categorize as `server_blocked` — impossible before this fix
  // because the value was thrown away and replaced with the literal `"|"`.
  test('a reason: block scalar mentioning "server" categorizes as server_blocked', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: skipped
reason: |
  The staging
  server is down.
`);
    const describeAll = () => JSON.stringify(items, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].reason, 'The staging\nserver is down.', describeAll());
    assert.strictEqual(items[0].category, 'server_blocked', describeAll());
  });
});

// ─── #3078 round 6 HIGH: the shortfall scan must compare ONE surface ──────────
//
// `countUnattributedIndentedRows` / the shortfall logic compared a
// SECTION-SCOPED raw line count (the `## Tests` body) against a DOCUMENT-WIDE
// token count (`subHeadings`, built from `allHeadings` over the whole file).
// Any legal `### N.` row living OUTSIDE `## Tests` therefore decremented the
// shortfall by one and SILENTLY DISABLED the fence-straddle detector: two
// byte-identical `## Tests` bodies audited differently purely because of a row
// somewhere else in the document. Same unit-mismatch class as the earlier
// UTF-16-vs-code-point defect, relocated from code units to scope.
describe('#3078 round 6 HIGH: the fence-straddle detector survives legal rows outside ## Tests', () => {
  const BACKTICK = '```';

  // The `## Tests` body is byte-identical in every document below. A plain
  // column-0 fence straddle hides `### 2. Blocked` with an outstanding result.
  const TESTS_BODY = `## Tests

### 1. Alpha
result: pass

${BACKTICK}
### 2. Blocked
result: blocked
${BACKTICK}
`;

  const PRIOR = `## Prior

### 9. Old
result: pass

`;

  const NOTES = `
## Notes

### 7. Note Row
result: pass

### 6. Note Row Two
result: pass
`;

  function assertStraddleReported(label, content) {
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => `${label}: ${JSON.stringify({ items, headingsSeen }, null, 2)}`;
    assert.ok(
      headingsSeen >= 1,
      `the fence-straddled row was not counted, so the file audits as clean: ${describeAll()}`,
    );
    // parse_gap is exactly `headingsSeen > 0` at the caller (#3078: the
    // `status !== 'complete'` term was removed — a self-declared terminal
    // status may not switch off this detector).
    assert.strictEqual(headingsSeen > 0, true, describeAll());
    // The straddled row is HIDDEN from the tokenizer by construction, so it
    // must not appear as an item — the gap counter is the only trace it has.
    assert.strictEqual(items.find((i) => i.test === 2), undefined, describeAll());
    return { items, headingsSeen, describeAll };
  }

  test('D1: the straddle alone is reported', () => {
    const { headingsSeen, describeAll } = assertStraddleReported('D1', TESTS_BODY);
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  test('D2: one legal row in a PRECEDING ## Prior section does not disable the detector', () => {
    const { items, headingsSeen, describeAll } = assertStraddleReported('D2', PRIOR + TESTS_BODY);
    assert.strictEqual(headingsSeen, 1, describeAll());
    // The out-of-section row legitimately passed, so it yields no item — but it
    // must not have been spent cancelling the in-section shortfall either.
    assert.strictEqual(items.length, 0, describeAll());
  });

  test('D3: rows in ## Prior, ## Tests AND ## Notes — the scoping is not merely off-by-one', () => {
    const { headingsSeen, describeAll } = assertStraddleReported(
      'D3',
      `${PRIOR}### 8. Older
result: pass

${TESTS_BODY}${NOTES}`,
    );
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  // #3078 round 7: this pin is INVERTED, deliberately. It used to assert that
  // a fenced row sample outside `## Tests` contributed nothing — which is only
  // achievable by scoping the raw scan, and scoping the raw scan is precisely
  // what produced the round-7 silent false cleans. A fence-hidden `### N.`
  // line outside `## Tests` is indistinguishable, by any fence- or
  // closedness-based rule, from a genuinely suppressed row living there (see
  // `## Regression Tests` in the round-7 block below), so it is now counted.
  test('a fenced row sample living only in ## Notes DOES inflate the tally — the accepted over-report', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: pass

## Notes

${BACKTICK}
### 4. Sample Row
result: blocked
${BACKTICK}
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(headingsSeen, 1, describeAll());
    assert.strictEqual(items.length, 0, describeAll());
  });
});

// ─── #3078 round 6 MAJOR: the two fence engines must agree on the text ────────
//
// `scanFencedBlocks` classifies the ORIGINAL lines; `tokenizeHeadings` re-runs
// its own state machine over the MUTATED (neutralised) copy. A COLUMN-0
// delimiter run that was fence CONTENT in the original — a ```-run inside an
// indented ````-pair — was PROMOTED to an opener once the enclosing indented
// delimiters were blanked, hiding every later heading to EOF.
describe('#3078 round 6 MAJOR: neutralising a block must not promote its own content into a fence', () => {
  const BACKTICK = '```';
  const QUAD = '````';

  // The run must be ODD inside the pair — an even number of column-0 runs
  // pairs up with itself once promoted and hides nothing, so this repro would
  // vacuously pass against the unfixed code. Measured: unfixed, this document
  // yields items=[] with headingsSeen=2; rows 2 and 3 are absent from the
  // token stream entirely.
  test('a column-0 ``` run inside an indented ```` pair does not swallow the later rows', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
   ${QUAD}
${BACKTICK}
   ${QUAD}
result: pass

### 2. Bravo
result: blocked
reason: server down

### 3. Charlie
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const bravo = items.find((i) => i.test === 2);
    const charlie = items.find((i) => i.test === 3);
    assert.ok(bravo, `row 2 was swallowed by a promoted fence: ${describeAll()}`);
    assert.strictEqual(bravo.name, 'Bravo', describeAll());
    assert.strictEqual(bravo.result, 'blocked', describeAll());
    assert.strictEqual(bravo.reason, 'server down', describeAll());
    assert.ok(charlie, `row 3 was swallowed by a promoted fence: ${describeAll()}`);
    assert.strictEqual(charlie.name, 'Charlie', describeAll());
    assert.strictEqual(charlie.result, 'pending', describeAll());
    assert.strictEqual(items.length, 2, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // COMPOUNDED WITH THE HIGH ABOVE, the promoted fence used to go completely
  // SILENT: the two legal `## Prior` rows cancelled the in-section shortfall,
  // so the document audited as totally clean while hiding two outstanding
  // rows. Measured against the unfixed code: items=[], headingsSeen=0.
  test('compounded with an out-of-section row, the promoted fence is still not silent', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Prior

### 8. Older
result: pass

### 9. Old
result: pass

## Tests

### 1. Alpha
expected: |
   ${QUAD}
${BACKTICK}
   ${QUAD}
result: pass

### 2. Bravo
result: blocked
reason: server down

### 3. Charlie
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.deepStrictEqual(items.map((i) => i.test), [2, 3], describeAll());
    assert.strictEqual(items[0].result, 'blocked', describeAll());
    assert.strictEqual(items[1].result, 'pending', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // The blanking widening is DELIMITER-SHAPED LINES ONLY. These two pins are
  // the constraints it must not trade away — both are also covered by the
  // round-4/round-5 suites above; asserted here against the new shape so the
  // widening cannot regress them silently.
  test('a column-0 `### N.` between neutralised delimiters is STILL a heading', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: x
  ${BACKTICK}
### 9. Phantom
  ${BACKTICK}
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 9, describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  test('field lines between two neutralised scalars still reach their own row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ${BACKTICK}
  sample one
  ${BACKTICK}
result: blocked
blocked_by: Server team

### 2. Bravo
expected: |
  ${BACKTICK}
  sample two
  ${BACKTICK}
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const alpha = items.find((i) => i.test === 1);
    const bravo = items.find((i) => i.test === 2);
    assert.ok(alpha, describeAll());
    assert.strictEqual(alpha.result, 'blocked', describeAll());
    assert.strictEqual(alpha.blocked_by, 'Server team', describeAll());
    assert.strictEqual(alpha.expected, `${BACKTICK}\nsample one\n${BACKTICK}`, describeAll());
    assert.ok(bravo, describeAll());
    assert.strictEqual(bravo.result, 'pending', describeAll());
    assert.strictEqual(bravo.expected, `${BACKTICK}\nsample two\n${BACKTICK}`, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });
});

// ─── #3078 round 6 MINOR: a scalar header may carry a trailing comment ────────
//
// `expected: | # sample` and `expected: >- # note` are legal YAML block-scalar
// headers. The shared header grammar was `$`-anchored right after the
// indicator, so those headers matched neither the reader's opener (the value
// fell through to the INLINE arm and published the literal `"|"`) nor the
// indented-row counter's walk-back test (so the scalar's own indented body
// heading was counted as a lost row — a FALSE parse gap).
describe('#3078 round 6 MINOR: a block-scalar header with a trailing comment still opens a scalar', () => {
  test('`expected: | # sample` extracts the body and raises no false parse gap', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: | # sample
  first line
  second line
result: blocked
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].expected, 'first line\nsecond line', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('`expected: >- # note` folds its body exactly as the bare `>-` form does', () => {
    const commented = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: >- # note
  folded one
  folded two
result: blocked
`);
    const bare = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: >-
  folded one
  folded two
result: blocked
`);
    const describeAll = () => JSON.stringify({ commented, bare }, null, 2);
    assert.strictEqual(commented.items[0].expected, 'folded one folded two', describeAll());
    assert.deepStrictEqual(commented.items, bare.items, describeAll());
    assert.strictEqual(commented.headingsSeen, 0, describeAll());
  });

  test('an indented `### N.`-shaped line inside a COMMENTED header\'s body is not a lost row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: | # sample
  ### 9. Section Nine
result: blocked
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].expected, '### 9. Section Nine', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('`reason:` and `blocked_by:` share the same commented-header grammar', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: blocked
reason: | # why
  staging is down
blocked_by: >- # who
  Server
  team
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items[0].reason, 'staging is down', describeAll());
    assert.strictEqual(items[0].blocked_by, 'Server team', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // A `#` that is NOT after a scalar indicator must stay an ordinary inline
  // value — the comment allowance must not swallow a plain `key: value`.
  test('an inline value containing a `#` is untouched by the comment allowance', () => {
    const { items } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: build #42 succeeds
result: blocked
`);
    assert.strictEqual(items[0].expected, 'build #42 succeeds', JSON.stringify(items, null, 2));
  });
});

// ─── #3078 round 7 MAJOR: the inner delimiter sweep tolerates indented shapes ──
//
// The sweep that blanks delimiter-shaped lines strictly BETWEEN a neutralised
// block's own delimiters tested `FENCE_OPENER_RE` — column-0-anchored — so an
// INDENTED delimiter-shaped line inside that block (mere content in the
// original, since CommonMark tolerates 1-3 spaces on an opener) was NOT
// blanked, and got promoted to a real fence opener the instant the enclosing
// pair was blanked, swallowing every later row to EOF.
describe('#3078 round 7 MAJOR: the inner delimiter sweep tolerates indented delimiter shapes', () => {
  const BACKTICK = '```';
  const TILDE = '~~~';
  const QUAD = '````';
  const LONG_BACKTICK = '`````';

  // Reproduced against the unfixed code: items=[], headingsSeen=1 — row 2's
  // `result: blocked` / `blocked_by: server team` vanish entirely.
  test('an indented ``` run inside an indented ````` pair does not swallow the later row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ${LONG_BACKTICK}
  ${BACKTICK}
  ${LONG_BACKTICK}
result: pass

### 2. Outstanding
result: blocked
blocked_by: server team
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const outstanding = items.find((i) => i.test === 2);
    assert.ok(outstanding, `row 2 was swallowed by a promoted indented fence: ${describeAll()}`);
    assert.strictEqual(outstanding.name, 'Outstanding', describeAll());
    assert.strictEqual(outstanding.result, 'blocked', describeAll());
    assert.strictEqual(outstanding.blocked_by, 'server team', describeAll());
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // Byte-identical document except the inner run sits at column 0 — this
  // already worked pre-fix, which isolates the defect to the ANCHOR, not to
  // the sweep's existence.
  test('control: the byte-equivalent column-0 inner run already surfaces the row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ${LONG_BACKTICK}
${BACKTICK}
  ${LONG_BACKTICK}
result: pass

### 2. Outstanding
result: blocked
blocked_by: server team
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const outstanding = items.find((i) => i.test === 2);
    assert.ok(outstanding, describeAll());
    assert.strictEqual(outstanding.result, 'blocked', describeAll());
    assert.strictEqual(outstanding.blocked_by, 'server team', describeAll());
  });

  // Same defect, mixed delimiter characters — an indented `~~~` run inside an
  // indented ```` pair — so the fix cannot be a backtick-only special case.
  test('an indented ~~~ run inside an indented ```` pair reproduces identically', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ${QUAD}
  ${TILDE}
  ${QUAD}
result: pass

### 2. Outstanding
result: blocked
blocked_by: server team
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const outstanding = items.find((i) => i.test === 2);
    assert.ok(outstanding, describeAll());
    assert.strictEqual(outstanding.result, 'blocked', describeAll());
    assert.strictEqual(outstanding.blocked_by, 'server team', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  // GUARD: the pinned "column 0 is structure" behaviour is unaffected — a
  // column-0 `### N.` between neutralised delimiters is STILL a heading.
  test('GUARD: a column-0 `### N.` between neutralised delimiters is still a heading', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: x
  ${BACKTICK}
### 9. Phantom
  ${BACKTICK}
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 9, describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
  });

  // GUARD: field lines between two neutralised scalars still reach their own
  // row — the widened sweep must add ONLY delimiter-shaped lines.
  test('GUARD: field lines between two neutralised scalars still reach their own row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
expected: |
  ${BACKTICK}
  sample one
  ${BACKTICK}
result: blocked
blocked_by: Server team

### 2. Bravo
expected: |
  ${BACKTICK}
  sample two
  ${BACKTICK}
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    const alpha = items.find((i) => i.test === 1);
    const bravo = items.find((i) => i.test === 2);
    assert.ok(alpha, describeAll());
    assert.strictEqual(alpha.result, 'blocked', describeAll());
    assert.strictEqual(alpha.blocked_by, 'Server team', describeAll());
    assert.strictEqual(alpha.expected, `${BACKTICK}\nsample one\n${BACKTICK}`, describeAll());
    assert.ok(bravo, describeAll());
    assert.strictEqual(bravo.result, 'pending', describeAll());
    assert.strictEqual(bravo.expected, `${BACKTICK}\nsample two\n${BACKTICK}`, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });
});

// ─── #3078 round 7 MINOR: the indented-row counter is not limited to 1-3 spaces ──
//
// `INDENTED_TEST_HEADING_LINE_RE` matched `^ {1,3}`, so a test row indented 4+
// spaces, or with a leading TAB, was neither parsed nor counted — origin/next's
// unanchored `###\s*(\d+)\.` surfaced every indent width; this HEAD silently
// dropped anything past 3 spaces with no trace at all (items=[], headingsSeen=0).
// The parse gate (`isColumnZeroHeading`) is unchanged: refusing to PARSE an
// indented row stays correct; only the COUNTER is widened.
describe('#3078 round 7 MINOR: the indented-row counter surfaces every indent width, not just 1-3 spaces', () => {
  const cases = [
    ['1 space', ' '],
    ['3 spaces', '   '],
    ['4 spaces', '    '],
    ['8 spaces', '        '],
    ['a leading tab', '\t'],
  ];

  for (const [label, indent] of cases) {
    test(`a row indented with ${label} is counted, not parsed`, () => {
      const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: pass

${indent}### 2. Deep Indented Row
result: pending
`);
      const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
      assert.deepStrictEqual(items, [], describeAll());
      assert.ok(headingsSeen >= 1, describeAll());
    });
  }

  // GUARD: a column-0 row is unaffected — still parsed normally, not counted
  // as a gap.
  test('GUARD: a column-0 row is still parsed normally', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(`## Tests

### 1. Alpha
result: pass

### 2. Normal
result: pending
`);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 2, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });
});

// ─── #3078 round 7 HIGH: the shortfall scan is whole-document on BOTH sides ───
//
// Round 6 scoped the RAW LINE SCAN to the first `## Tests` section body while
// the token count stayed whole-document. Round 7's first attempt "equalized"
// that by ALSO scoping the token side to the section's offset span — which made
// the two counters agree with each other but left the PARSE side
// whole-document. A `### N.` row living OUTSIDE the first `## Tests` section is
// parsed and surfaced normally when visible, yet vanished with NO item AND NO
// parse_gap the moment a fence straddled it: neither side of the comparison
// covered it. Both sides are now whole-document. Symmetry is the property that
// matters; every attempt to be clever about scope has produced a silent false
// clean.
//
// `parse_gap` at the caller (`cmdAuditUat`) is exactly `headingsSeen > 0`,
// independent of frontmatter status, so these documents flag iff
// `headingsSeen > 0`.
describe('#3078 round 7 HIGH: a fence-straddled row outside the first ## Tests section still flags', () => {
  const BACKTICK = '```';

  const parseGapOf = (headingsSeen) => headingsSeen > 0;

  function report(label, content) {
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const parseGap = parseGapOf(headingsSeen);
    const describeAll = () =>
      `${label}: ${JSON.stringify({ items, headingsSeen, parse_gap: parseGap }, null, 2)}`;
    return { items, headingsSeen, parseGap, describeAll };
  }

  // CASE 1 — the reported repro. Before the fix this yielded items: [],
  // headingsSeen: 0, so the file never entered `results` and the audit
  // reported totally clean with a `result: blocked` sitting in it.
  const REGRESSION_SECTION_DOC = `## Tests

### 1. Alpha
result: pass

## Regression Tests

${BACKTICK}
### 2. Straddled Blocked
result: blocked
blocked_by: server team

### 3. Straddled Pending
result: pending
${BACKTICK}
`;

  test('CASE 1: a straddle inside a `## Regression Tests` section is FLAGGED, not silently clean', () => {
    const { items, headingsSeen, parseGap, describeAll } = report('C1', REGRESSION_SECTION_DOC);
    // Both straddled rows are hidden from the tokenizer by construction, so the
    // gap counter is the only trace they have — but it MUST exist.
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 2, describeAll());
    assert.ok(headingsSeen >= 1, describeAll());
    assert.strictEqual(parseGap, true, describeAll());
  });

  // The same document WITHOUT the fence parses both rows normally, with full
  // identity — which is what makes the fenced form a REGRESSION (origin/next's
  // whole-file regex surfaced them) rather than an intentional exclusion.
  test('CASE 1 twin: the identical document without the fence surfaces both rows with full identity', () => {
    const { items, headingsSeen, parseGap, describeAll } = report(
      'C1-twin',
      REGRESSION_SECTION_DOC.split('\n').filter((l) => l !== BACKTICK).join('\n'),
    );
    assert.strictEqual(items.length, 2, describeAll());
    assert.strictEqual(items[0].test, 2, describeAll());
    assert.strictEqual(items[0].name, 'Straddled Blocked', describeAll());
    assert.strictEqual(items[0].result, 'blocked', describeAll());
    assert.strictEqual(items[0].blocked_by, 'server team', describeAll());
    assert.strictEqual(items[0].category, 'server_blocked', describeAll());
    assert.strictEqual(items[1].test, 3, describeAll());
    assert.strictEqual(items[1].name, 'Straddled Pending', describeAll());
    assert.strictEqual(items[1].result, 'pending', describeAll());
    assert.strictEqual(items[1].category, 'pending', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
    assert.strictEqual(parseGap, false, describeAll());
  });

  // CASE 2 — `collectSection` takes the FIRST match only, so a SECOND
  // `## Tests` section was outside the scan span for the same reason.
  test('CASE 2: a straddle in a SECOND `## Tests` section is FLAGGED', () => {
    const { items, headingsSeen, parseGap, describeAll } = report(
      'C2',
      `## Tests

### 1. Alpha
result: pass

## Other

prose.

## Tests

${BACKTICK}
### 2. Straddled Blocked
result: blocked
${BACKTICK}
`,
    );
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
    assert.strictEqual(parseGap, true, describeAll());
  });

  // CASE 3 — the control. This one reported correctly even before the fix
  // (no `## Tests` heading meant the scan fell back to the whole document),
  // which is what isolated the defect to the SCOPING rather than to the
  // straddle detector itself. It must keep reporting.
  test('CASE 3 (control): the identical straddle with NO `## Tests` heading at all still flags', () => {
    const { items, headingsSeen, parseGap, describeAll } = report(
      'C3',
      `# Phase 1 UAT

${BACKTICK}
### 2. Straddled Blocked
result: blocked
${BACKTICK}
`,
    );
    assert.deepStrictEqual(items, [], describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
    assert.strictEqual(parseGap, true, describeAll());
  });

  // CASE 4 — THE ACCEPTED OVER-REPORT, pinned so the trade is visible rather
  // than surprising. A `### N.`-shaped line inside a properly CLOSED fence in
  // a `## Notes` section is a DOCUMENTATION SAMPLE of the row format, and
  // nothing is missing from this file — yet it raises a parse gap, because no
  // fence- or closedness-based rule can tell it apart from CASE 1's genuinely
  // suppressed row, and the only rule that could (scope) is what produced two
  // HIGH-severity silent false cleans. Noisy-but-visible beats invisible: this
  // whole issue exists to eliminate false cleans, so the trade goes this way
  // deliberately. If this test starts failing, the scoping has been
  // reintroduced and CASES 1 and 2 have silently regressed with it.
  test('CASE 4: a `## Notes` closed-fence documentation sample raises a parse gap — the ACCEPTED over-report', () => {
    const { items, headingsSeen, parseGap, describeAll } = report(
      'C4',
      `## Tests

### 1. Alpha
result: pending

## Notes

Write each row like this:

${BACKTICK}
### 9. Example Row
result: pending
${BACKTICK}
`,
    );
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 1, describeAll());
    assert.strictEqual(items[0].name, 'Alpha', describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(items[0].category, 'pending', describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
    assert.strictEqual(parseGap, true, describeAll());
  });

  // CASE 5 — regression guard: the ordinary single-`## Tests` straddle, the
  // case the counter was built for, is unchanged by the widening.
  test('CASE 5 (regression): a normal single-`## Tests` straddle still flags exactly as before', () => {
    const { items, headingsSeen, parseGap, describeAll } = report(
      'C5',
      `## Tests

### 1. Alpha
result: pass

${BACKTICK}
### 2. Straddled Blocked
result: blocked
${BACKTICK}

### 3. Gamma
result: pending
`,
    );
    assert.strictEqual(items.length, 1, describeAll());
    assert.strictEqual(items[0].test, 3, describeAll());
    assert.strictEqual(items[0].name, 'Gamma', describeAll());
    assert.strictEqual(items[0].result, 'pending', describeAll());
    assert.strictEqual(items.find((i) => i.test === 2), undefined, describeAll());
    assert.strictEqual(headingsSeen, 1, describeAll());
    assert.strictEqual(parseGap, true, describeAll());
  });
});

// ─── #3707 fix: parse_gap_files is ONE counter, archived or not ────────────────
//
// A live/archived split on `parse_gap_files` was tried in this branch and
// reverted (#3707 follow-up, #2766's own rationale): "Outstanding UAT items do
// not stop mattering when a milestone closes: a deferred human-UAT scenario or
// a `skipped` live-stack test is exactly what gets archived still-open." So
// "archived UAT files are complete by definition" — the split's premise — is
// false, and `total_items` (`summary.total_items`) has never had such a split
// either. Two regressions were executed under the split:
//   (a) a phase belonging to the CURRENT milestone, but filed under
//       `.planning/milestones/<version>-phases/` (getArchivedPhaseDirs scans
//       that whole tree regardless of which milestone ROADMAP.md currently
//       names), was classified "archived" and demoted out of the gate —
//       live in-progress work reported as closed history.
//   (b) an archived outstanding row that PARSES gives `total_items: 1` and
//       trips Verification Debt; the SAME row made unparseable gave
//       `parse_gap_files: 0` under the split — the parse failure buried the
//       debt, the exact bug class #3707 exists to fix.
// `parse_gap_files` now counts EVERY entry with `parse_gap: true`, unfiltered
// by `archived_milestone` — mirroring `total_items` exactly.
describe('#3707 fix: parse_gap_files counts every parse gap, archived or not', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // A `### N.` block with NO `result:` line at all — the parser counts the
  // heading (headingsSeen) but yields no item, which is exactly a parse gap.
  const UNPARSEABLE_BLOCK = `---
status: complete
---

## Tests

### 1. Unreadable Row
expected: something observable
`;

  const LIVE_PENDING = `---
status: testing
---

## Tests

### 1. Real Outstanding Row
expected: something observable
result: pending
`;

  function writeFile(...parts) {
    const body = parts.pop();
    const target = path.join(tmpDir, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  function audit() {
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  // The merged-semantics replacement for the old "stays out of the live gate"
  // assertion: four archived milestones with unparseable blocks ALL count.
  test('archived milestones with unparseable blocks are counted in parse_gap_files, not hidden from it', () => {
    writeFile('.planning', 'phases', '01-live', '01-UAT.md', LIVE_PENDING);
    const archived = [
      ['v0.1.0', '01-alpha'],
      ['v0.2.0', '02-bravo'],
      ['v0.3.0', '03-charlie'],
      ['v0.4.0', '04-delta'],
    ];
    for (const [milestone, phaseDir] of archived) {
      writeFile('.planning', 'milestones', `${milestone}-phases`, phaseDir,
        `${phaseDir.slice(0, 2)}-UAT.md`, UNPARSEABLE_BLOCK);
    }

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    // ONE counter: all four archived gaps plus none from the live pending row.
    assert.strictEqual(output.summary.parse_gap_files, 4, describeAll());
    assert.strictEqual(output.summary.archived_parse_gap_files, undefined, describeAll());
    assert.strictEqual(output.summary.total_items, 1, describeAll());
    assert.strictEqual(output.summary.total_files, 5, describeAll());

    // NOTHING IS HIDDEN: all four archived entries are still in `results`,
    // each still flagged `parse_gap: true` and still carrying its
    // `archived_milestone`, per file identity.
    const archivedEntries = output.results.filter((r) => r.archived_milestone !== undefined);
    assert.strictEqual(archivedEntries.length, 4, describeAll());
    for (const entry of archivedEntries) {
      assert.strictEqual(entry.parse_gap, true, describeAll());
      assert.strictEqual(entry.unparsed_blocks, 1, describeAll());
    }
    assert.deepStrictEqual(
      archivedEntries.map((r) => r.archived_milestone).sort(),
      ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.4.0'],
      describeAll(),
    );
  });

  // Baseline: a live phase whose block cannot be read is still a real,
  // actionable gap and must still trip the gate the workflows read.
  test('a live phase with an unparseable block is counted in parse_gap_files', () => {
    writeFile('.planning', 'phases', '01-live', '01-UAT.md', UNPARSEABLE_BLOCK);

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.strictEqual(output.summary.parse_gap_files, 1, describeAll());
    assert.strictEqual(output.summary.total_items, 0, describeAll());
    assert.strictEqual(output.summary.total_files, 1, describeAll());

    const [entry] = output.results;
    assert.strictEqual(entry.parse_gap, true, describeAll());
    assert.strictEqual(entry.unparsed_blocks, 1, describeAll());
    assert.strictEqual(entry.archived_milestone, undefined, describeAll());
    // Status-independence is preserved: this file declares `complete` and is
    // STILL reported. A self-declared terminal status must not switch off the
    // detector that would contradict it.
    assert.strictEqual(entry.status, 'complete', describeAll());
  });

  test('a mixed project sums live and archived parse gaps into one counter', () => {
    writeFile('.planning', 'phases', '01-live', '01-UAT.md', UNPARSEABLE_BLOCK);
    writeFile('.planning', 'phases', '02-also-live', '02-UAT.md', LIVE_PENDING);
    writeFile('.planning', 'milestones', 'v0.9.0-phases', '09-old', '09-UAT.md', UNPARSEABLE_BLOCK);

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.strictEqual(output.summary.parse_gap_files, 2, describeAll());
    assert.strictEqual(output.summary.total_items, 1, describeAll());
    assert.strictEqual(output.summary.total_files, 3, describeAll());

    const liveGap = output.results.find(
      (r) => r.parse_gap && r.archived_milestone === undefined,
    );
    const archivedGap = output.results.find(
      (r) => r.parse_gap && r.archived_milestone !== undefined,
    );
    assert.ok(liveGap, describeAll());
    assert.strictEqual(liveGap.phase, '01', describeAll());
    assert.ok(archivedGap, describeAll());
    assert.strictEqual(archivedGap.phase, '09', describeAll());
    assert.strictEqual(archivedGap.archived_milestone, 'v0.9.0', describeAll());

    // The phase carrying a genuine outstanding item is a parse gap on
    // NEITHER side.
    const pendingEntry = output.results.find((r) => r.phase === '02');
    assert.ok(pendingEntry, describeAll());
    assert.strictEqual(pendingEntry.parse_gap, undefined, describeAll());
    assert.strictEqual(pendingEntry.items.length, 1, describeAll());
  });

  // REGRESSION (a): a phase under `.planning/milestones/v<ver>-phases/` whose
  // milestone IS the ROADMAP's "## Current Milestone" must still count in
  // `parse_gap_files` — live in-progress work must never be demoted to
  // closed history merely because of which directory it happens to live
  // under. Asserts IDENTITY: exact count, plus the entry's own phase/file.
  test('a phase under the CURRENT milestone but filed in the milestones/ archive tree still counts', () => {
    writeFile('.planning', 'ROADMAP.md', `# Roadmap

## Current Milestone

v1.1 - Example Milestone

### Phase 1: Alpha
`);
    writeFile('.planning', 'milestones', 'v1.1-phases', '01-alpha', '01-UAT.md', UNPARSEABLE_BLOCK);

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.strictEqual(output.summary.parse_gap_files, 1, describeAll());
    assert.strictEqual(output.summary.total_files, 1, describeAll());

    const [entry] = output.results;
    assert.strictEqual(entry.phase, '01', describeAll());
    assert.strictEqual(entry.file, '01-UAT.md', describeAll());
    assert.strictEqual(entry.parse_gap, true, describeAll());
    assert.strictEqual(entry.archived_milestone, 'v1.1', describeAll());
  });

  // REGRESSION (b): an archived outstanding row that fails to parse must not
  // be buried relative to the identical row when it happens to parse — the
  // same file, parseable, gives `total_items: 1`; unparseable, it must give
  // `parse_gap_files: 1`, not 0. Asserts IDENTITY: exact counts, plus the
  // entry's own phase/file.
  test('an archived row that fails to parse counts exactly like the identical row that parses', () => {
    writeFile('.planning', 'milestones', 'v0.5.0-phases', '05-old', '05-UAT.md', LIVE_PENDING);
    const parseableOutput = audit();
    assert.strictEqual(parseableOutput.summary.total_items, 1, JSON.stringify(parseableOutput, null, 2));
    assert.strictEqual(parseableOutput.summary.parse_gap_files, 0, JSON.stringify(parseableOutput, null, 2));

    writeFile('.planning', 'milestones', 'v0.5.0-phases', '05-old', '05-UAT.md', UNPARSEABLE_BLOCK);
    const gapOutput = audit();
    const describeAll = () => JSON.stringify(gapOutput, null, 2);

    assert.strictEqual(gapOutput.summary.total_items, 0, describeAll());
    assert.strictEqual(gapOutput.summary.parse_gap_files, 1, describeAll());
    assert.strictEqual(gapOutput.summary.total_files, 1, describeAll());

    const [entry] = gapOutput.results;
    assert.strictEqual(entry.phase, '05', describeAll());
    assert.strictEqual(entry.file, '05-UAT.md', describeAll());
    assert.strictEqual(entry.archived_milestone, 'v0.5.0', describeAll());
  });
});

// ─── #3707-CR security review MEDIUM: a lone CR is not a line boundary anywhere ──
//
// [FAILING-FIRST, DO NOT "FIX" src/ TO MAKE THIS PASS — see dispatch brief]
//
// CommonMark treats a lone CR (no paired LF) as a line ending — a document
// using it RENDERS as separate lines to a human reader. This parser's row
// scan (`content.split('\n')` feeding both `tokenizeHeadings` and the
// column-0 `TEST_HEADING_LINE_RE` shortfall scan, uat.cjs:1193/869) and the
// #3078 round-7 symmetry invariant (both sides of the shortfall comparison
// are whole-document, uat.cjs:1137-1166) both key on `\n` alone. A lone CR
// never becomes a boundary on EITHER side, so a `### N.` row separated from
// its predecessor only by CR is invisible to `tokenizeHeadings` (no token),
// to the raw-line shortfall scan (`TEST_HEADING_LINE_RE.test(line)` only
// matches `^`, and the whole multi-row chunk is now ONE unsplit "line" whose
// `^` sits before earlier content, not before the buried heading), AND to
// `parseGapsItems`'s own `content.split('\n')` walk. No item, no shortfall,
// no headingsSeen: a TOTAL false-clean, not merely a missed row.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

describe('#3707-CR: a lone CR line ending must not hide an outstanding UAT row', () => {
  /**
   * `join(sep)` on lines already containing an embedded body — used so the
   * fixture text itself stays free of literal CR characters that an editor
   * or a diff viewer could silently rewrite (CLAUDE.md IO-injection rule).
   */
  function bodyWith(sep) {
    return [
      '---',
      'status: partial',
      'phase: 01-a',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Alpha',
      'expected: ok',
      'result: pass',
      '',
      'Notes.',
      '### 2. Beta',
      'expected: the export works',
      'result: blocked',
      '',
    ].join(sep);
  }

  test('[RED] a lone-CR document should surface the hidden `### 2. Beta` row by full identity', () => {
    const { items, headingsSeen, shortfallBlocks } = parseUatItemsWithStats(bodyWith(CR));
    const describeAll = () => JSON.stringify({ items, headingsSeen, shortfallBlocks }, null, 2);

    const beta = items.find((i) => i.name === 'Beta');
    assert.ok(beta, `hidden row 2 "Beta" absent from items: ${describeAll()}`);
    assert.strictEqual(beta.test, 2, describeAll());
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
  });

  test('[GREEN] CONTROL: the LF equivalent of the same body surfaces the identical row identity', () => {
    const { items } = parseUatItemsWithStats(bodyWith(LF));
    const describeAll = () => JSON.stringify(items, null, 2);

    const beta = items.find((i) => i.name === 'Beta');
    assert.ok(beta, `row 2 "Beta" absent from LF control: ${describeAll()}`);
    assert.strictEqual(beta.test, 2, describeAll());
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
  });

  test('[GREEN] CONTROL: CRLF still parses exactly as today — no double-count, no strip', () => {
    const { items, headingsSeen, shortfallBlocks } = parseUatItemsWithStats(bodyWith(CRLF));
    const describeAll = () => JSON.stringify({ items, headingsSeen, shortfallBlocks }, null, 2);

    assert.strictEqual(items.length, 1, describeAll());
    const [beta] = items;
    assert.strictEqual(beta.test, 2, describeAll());
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
    assert.strictEqual(shortfallBlocks, 0, describeAll());
  });

  test('[GREEN] CONTROL: a literal CR inside a fenced block is not torn into extra rows', () => {
    const content = [
      '## Tests',
      '',
      '### 1. Alpha',
      'expected: |',
      '```',
      `sample${CR}line`,
      '```',
      'result: pass',
      '',
      '### 2. Beta',
      'result: blocked',
      '',
    ].join(LF);
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    // Row 1 ("Alpha") carries `result: pass`, which is deliberately excluded
    // from `items` by design (a PASS token is the one case a heading yields
    // no item without being a parse gap) — so exactly ONE item is expected
    // here, not two. Asserting `headingsSeen === 0` is what proves Alpha's
    // heading was still correctly SEEN and attributed, not silently dropped
    // by the embedded CR splitting its fence/scalar content into extra rows.
    assert.strictEqual(items.length, 1, describeAll());
    const beta = items.find((i) => i.test === 2);
    assert.ok(beta, `row 2 absent: ${describeAll()}`);
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('[GREEN] CONTROL: a literal CR inside an `expected: |` block-scalar body is not torn into extra rows', () => {
    const content = [
      '## Tests',
      '',
      '### 1. Alpha',
      'expected: |',
      `  line one${CR}still the scalar`,
      '  line two',
      'result: pass',
      '',
      '### 2. Beta',
      'result: blocked',
      '',
    ].join(LF);
    const { items, headingsSeen } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    // Same PASS-exclusion rule as the fenced-CR control above: Alpha's
    // `result: pass` yields no item by design, so exactly ONE item (Beta) is
    // expected, and `headingsSeen === 0` proves Alpha was still attributed.
    assert.strictEqual(items.length, 1, describeAll());
    const beta = items.find((i) => i.test === 2);
    assert.ok(beta, `row 2 absent: ${describeAll()}`);
    assert.strictEqual(beta.name, 'Beta', describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('[RED] boundary: a lone CR at the very start of the document also hides the very first row', () => {
    // A second manifestation of the same defect, not a distinct one: the
    // leading CR is not a `\n`, so `content.split('\n')` yields a single
    // first "line" of `"\r### 1. Alpha"` — the heading text no longer sits
    // at column 0 of that split unit, so `TEST_HEADING_LINE_RE`'s `^#{3}`
    // anchor and the tokenizer's own column-0 check both refuse it.
    const content = CR + [
      '### 1. Alpha',
      'result: blocked',
      '',
    ].join(LF);
    const { items } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify(items, null, 2);

    const alpha = items.find((i) => i.name === 'Alpha');
    assert.ok(alpha, `row "Alpha" absent: ${describeAll()}`);
    assert.strictEqual(alpha.test, 1, describeAll());
    assert.strictEqual(alpha.result, 'blocked', describeAll());
  });

  test('[GREEN] boundary: a lone CR at the very end of the document is harmless', () => {
    const content = [
      '### 1. Alpha',
      'result: blocked',
    ].join(LF) + CR;
    const { items } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify(items, null, 2);

    const alpha = items.find((i) => i.name === 'Alpha');
    assert.ok(alpha, `row "Alpha" absent: ${describeAll()}`);
    assert.strictEqual(alpha.test, 1, describeAll());
    assert.strictEqual(alpha.result, 'blocked', describeAll());
  });

  test('[RED] boundary: two consecutive lone CRs between rows still hides the row, though the whole-document shortfall scan happens to flag it', () => {
    // With no `\n` anywhere in this fixture, `content.split('\n')` returns
    // ONE line: the entire document text. That single line legitimately
    // starts with `### 1. Alpha` (true string start, column 0), so the raw
    // `TEST_HEADING_LINE_RE` shortfall scan (uat.cjs:1193) counts exactly one
    // shaped heading line for the WHOLE document, while the tokenizer-backed
    // `subHeadings` side finds none it can attribute — `headingsSeen`/
    // `shortfallBlocks` land at 1, so this shape is not a TOTAL silent
    // false-clean like the primary repro. But `items` is still empty: the
    // "Beta" row's own identity (number, name, result) is not recovered by
    // that shortfall count, which is why this assertion is on identity, not
    // presence of a nonzero counter.
    const content = [
      '### 1. Alpha',
      'result: pass',
      '',
      '### 2. Beta',
      'result: blocked',
      '',
    ].join(CR + CR);
    const { items } = parseUatItemsWithStats(content);
    const describeAll = () => JSON.stringify(items, null, 2);

    const beta = items.find((i) => i.name === 'Beta');
    assert.ok(beta, `row 2 "Beta" absent: ${describeAll()}`);
    assert.strictEqual(beta.test, 2, describeAll());
    assert.strictEqual(beta.result, 'blocked', describeAll());
  });
});

// ─── #3707-CR follow-up MAJOR: the two OTHER cmdAuditUat ingresses ─────────────
//
// The original #3707-CR fix normalized line endings inside two of
// `cmdAuditUat`'s FOUR parsers (`parseUatItemsWithStats`, `parseCurrentTest`)
// and declared the class closed. It was not: `parseVerificationItems`
// (VERIFICATION.md) and `parseDeferredItems` (deferred-items.md) are reached
// from the SAME function via their own, separately unnormalized
// `fs.readFileSync` calls, so a lone-CR VERIFICATION.md or deferred-items.md
// hit the identical total false-clean this issue exists to close. The fix
// this time is at the READ BOUNDARY (`readNormalizedDocument` in
// src/uat.cts), not per-parser — these tests drive the full CLI end-to-end so
// they exercise that boundary, not a parser function directly.
describe('#3707-CR follow-up MAJOR: VERIFICATION.md and deferred-items.md ingresses normalize at the read boundary', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function audit() {
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  function deferredBody(eol) {
    return [
      '## Deferred Items',
      '',
      '- First deferred item, still open.',
      '- Second deferred item, still open.',
    ].join(eol);
  }

  test('[RED] a lone-CR deferred-items.md surfaces both items by identity', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), deferredBody(CR));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.file === 'deferred-items.md');
    assert.ok(entry, `deferred-items.md entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => ({ name: i.name, result: i.result }));
    assert.deepStrictEqual(names, [
      { name: 'First deferred item, still open.', result: 'unresolved' },
      { name: 'Second deferred item, still open.', result: 'unresolved' },
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('[GREEN] CONTROL: the LF twin of the same deferred-items.md surfaces the identical items', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), deferredBody(LF));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.file === 'deferred-items.md');
    assert.ok(entry, `deferred-items.md entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => ({ name: i.name, result: i.result }));
    assert.deepStrictEqual(names, [
      { name: 'First deferred item, still open.', result: 'unresolved' },
      { name: 'Second deferred item, still open.', result: 'unresolved' },
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('[GREEN] CONTROL: a CRLF deferred-items.md is unchanged (no double-count, no strip)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), deferredBody(CRLF));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.file === 'deferred-items.md');
    assert.ok(entry, `deferred-items.md entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => ({ name: i.name, result: i.result }));
    assert.deepStrictEqual(names, [
      { name: 'First deferred item, still open.', result: 'unresolved' },
      { name: 'Second deferred item, still open.', result: 'unresolved' },
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  function verificationBody(eol) {
    return [
      '---',
      'status: human_needed',
      'phase: 02-auth',
      '---',
      '',
      '## Human Verification',
      '',
      '1. Test SSO login with Google account',
      '2. Test password reset flow end-to-end',
      '',
    ].join(eol);
  }

  test('[RED] a lone-CR VERIFICATION.md (status: human_needed) surfaces both human-verification items by identity', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), verificationBody(CR));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.type === 'verification');
    assert.ok(entry, `VERIFICATION entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => i.name);
    assert.deepStrictEqual(names, [
      'Test SSO login with Google account',
      'Test password reset flow end-to-end',
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('[GREEN] CONTROL: the LF twin of the same VERIFICATION.md surfaces the identical items', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), verificationBody(LF));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.type === 'verification');
    assert.ok(entry, `VERIFICATION entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => i.name);
    assert.deepStrictEqual(names, [
      'Test SSO login with Google account',
      'Test password reset flow end-to-end',
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('[GREEN] CONTROL: a CRLF VERIFICATION.md is unchanged (no double-count, no strip)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), verificationBody(CRLF));

    const output = audit();
    const describeAll = () => JSON.stringify(output, null, 2);

    const entry = output.results.find((r) => r.type === 'verification');
    assert.ok(entry, `VERIFICATION entry absent: ${describeAll()}`);
    const names = entry.items.map((i) => i.name);
    assert.deepStrictEqual(names, [
      'Test SSO login with Google account',
      'Test password reset flow end-to-end',
    ], describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  // The end-to-end phase carrying BOTH a VERIFICATION.md and a
  // deferred-items.md, written twice from one source (LF and lone-CR),
  // exercising ALL FOUR ingresses in one audit-uat run at once.
  test('[RED] a phase with both VERIFICATION.md and deferred-items.md: lone-CR and LF produce identical audit output', () => {
    function build(eol) {
      const dir = createTempProject();
      const phaseDir = path.join(dir, '.planning', 'phases', '03-combo');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), verificationBody(eol));
      fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), deferredBody(eol));
      return dir;
    }

    const lfDir = build(LF);
    const crDir = build(CR);
    try {
      const lfResult = runGsdTools('audit-uat --raw', lfDir);
      const crResult = runGsdTools('audit-uat --raw', crDir);
      assert.ok(lfResult.success, `LF run failed: ${lfResult.error}`);
      assert.ok(crResult.success, `CR run failed: ${crResult.error}`);
      const lfOutput = JSON.parse(lfResult.output);
      const crOutput = JSON.parse(crResult.output);
      const describeAll = () => JSON.stringify({ lf: lfOutput, cr: crOutput }, null, 2);

      assert.strictEqual(lfOutput.summary.total_files, 2, describeAll());
      assert.strictEqual(lfOutput.summary.total_items, 4, describeAll());
      assert.strictEqual(crOutput.summary.total_files, lfOutput.summary.total_files, describeAll());
      assert.strictEqual(crOutput.summary.total_items, lfOutput.summary.total_items, describeAll());
      assert.strictEqual(crOutput.summary.parse_gap_files, lfOutput.summary.parse_gap_files, describeAll());

      const rowIdentity = (r) => ({
        type: r.type,
        items: r.items.map((i) => ({ name: i.name, result: i.result })).sort((a, b) => a.name.localeCompare(b.name)),
      });
      assert.deepStrictEqual(
        crOutput.results.map(rowIdentity).sort((a, b) => a.type.localeCompare(b.type)),
        lfOutput.results.map(rowIdentity).sort((a, b) => a.type.localeCompare(b.type)),
        describeAll(),
      );
    } finally {
      cleanup(lfDir);
      cleanup(crDir);
    }
  });
});

// #3078-CR: a column-0 line-terminator boundary defect in
// `parseUatItemsWithStats`'s `result:` scan, reproduced directly against the
// LIVE built copy (`../gsd-core/bin/lib/uat.cjs`, imported at the top of this
// file) rather than through a rebuilt fixture, so these rows fail against the
// ACTUAL shipped parser, not a stale mental model of it.
//
// DEFECT A (fixed): `/^result:.../im` treats U+2028 LINE SEPARATOR and U+2029
// PARAGRAPH SEPARATOR as line-start boundaries (native JS `/m` behaviour),
// but `normalizeLineEndings` (core-utils.cjs) folds only `\r`/`\r\n` and never
// touches U+2028/U+2029, and neither does `split('\n')` or the heading
// tokenizer. A `result:`-shaped line living INSIDE an `expected: |` scalar
// body, immediately after one of these separators, was therefore read as a
// real line start by the regex engine and — because `.match()` without `/g`
// returns the LEFTMOST match in the whole string — won over a genuine
// column-0 `result:` line appearing later, discarding it with no gap raised.
// Fixed by testing each `split('\n')`-produced line individually instead of
// running an `/m`-anchored regex over the whole block: `split('\n')` never
// treats U+2028/U+2029 as a delimiter, so neither can manufacture a line
// start.
//
// A "defect B" (more than one column-0 `result:` line reported as an
// ambiguous parse gap rather than resolving to the first) was attempted and
// REVERTED: its boundary-truncation heuristic mistook an indented `### N.`
// living inside a legitimate block scalar for a heading boundary, which
// broke every scalar/indent guard this module has (see the `#3078` scalar
// guard tests elsewhere in this file). Two column-0 `result:` lines resolve
// to the FIRST one — the pre-existing, pinned behaviour — see controls B3/B4
// below.
describe('parseUatItemsWithStats — result: line-scan boundary defects (#3078-CR)', () => {
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

  // Row 1 ("### 1. Alpha") by IDENTITY: test number AND name AND result.
  // A bare count or a bare `result` check both pass for the wrong reason —
  // e.g. a phantom row from the scalar's OWN `result: pass` clause matching
  // `items.length === 1` just as readily as the real blocked row would.
  function findAlphaBlocked(items) {
    return items.find((i) => i.test === 1 && i.name === 'Alpha' && i.result === 'blocked');
  }
  function findAnyPassItem(items) {
    return items.find((i) => i.result === 'pass' || i.result === 'passed');
  }

  function defectADoc(marker) {
    // An `expected: |` scalar body whose text ends in "...x<marker>result:
    // pass", followed by the block's REAL column-0 "result: blocked" line.
    return '## Tests\n\n### 1. Alpha\nexpected: |\n  x' + marker + 'result: pass\nresult: blocked\n';
  }

  test('[RED] A1: U+2028 inside an expected scalar must not swallow the column-0 blocked row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(defectADoc(LINE_SEPARATOR));
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.ok(findAlphaBlocked(items), `expected outstanding row 1/Alpha/blocked absent: ${describeAll()}`);
    assert.strictEqual(findAnyPassItem(items), undefined, `a phantom pass item must not be emitted: ${describeAll()}`);
  });

  test('[RED] A2: U+2029 inside an expected scalar must not swallow the column-0 blocked row', () => {
    const { items, headingsSeen } = parseUatItemsWithStats(defectADoc(PARAGRAPH_SEPARATOR));
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.ok(findAlphaBlocked(items), `expected outstanding row 1/Alpha/blocked absent: ${describeAll()}`);
    assert.strictEqual(findAnyPassItem(items), undefined, `a phantom pass item must not be emitted: ${describeAll()}`);
  });

  test('[CONTROL] A3: an ordinary (non-line-terminator) marker in the same position still yields the blocked row', () => {
    // Proves A1/A2 are a SEPARATOR defect, not a content defect: swap the
    // exotic separator for two literal "@@" characters, which JS never
    // treats as a line terminator under any regex flag.
    const { items, headingsSeen } = parseUatItemsWithStats(defectADoc('@@'));
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.ok(findAlphaBlocked(items), `control document must still surface 1/Alpha/blocked: ${describeAll()}`);
    assert.strictEqual(findAnyPassItem(items), undefined, describeAll());
  });

  test('[CONTROL] A4: U+2028 living in ordinary prose (not faking a line start) parses unaffected', () => {
    // The separator sits between two prose words, never immediately before a
    // "result:"-shaped token, so it cannot fake a line start that matters —
    // this must parse exactly as it does today, both before and after any
    // future fix to the boundary handling.
    const doc = '## Tests\n\n### 1. Alpha\nexpected: |\n  some prose' + LINE_SEPARATOR + 'continues here\nresult: blocked\n';
    const { items, headingsSeen } = parseUatItemsWithStats(doc);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.ok(findAlphaBlocked(items), `legitimate U+2028 content must not perturb parsing: ${describeAll()}`);
    assert.strictEqual(items.length, 1, `no extra/phantom item may appear: ${describeAll()}`);
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('[CONTROL] B3: a block with exactly one result: line is unchanged', () => {
    const doc = '### 1. Alpha\nexpected: ok\nresult: blocked\n';
    const { items, headingsSeen } = parseUatItemsWithStats(doc);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.strictEqual(items.length, 1, describeAll());
    assert.ok(findAlphaBlocked(items), `unambiguous single-result block must still surface 1/Alpha/blocked: ${describeAll()}`);
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('[CONTROL] B4: a result: line inside a fenced code sample does not count as a second column-0 occurrence', () => {
    // The fenced "result: pass" sample line is document content (a fenced
    // code block is stripped before the result-line scan runs), not a
    // second real result declaration — only the genuine column-0
    // "result: blocked" line below the fence is the row's outcome.
    const doc = '### 1. Alpha\nexpected: ok\n```\nresult: pass\n```\nresult: blocked\n';
    const { items, headingsSeen } = parseUatItemsWithStats(doc);
    const describeAll = () => JSON.stringify({ items, headingsSeen }, null, 2);

    assert.strictEqual(items.length, 1, describeAll());
    assert.ok(findAlphaBlocked(items), `fenced sample result: line must not compete with the real row: ${describeAll()}`);
    assert.strictEqual(findAnyPassItem(items), undefined, describeAll());
    assert.strictEqual(headingsSeen, 0, describeAll());
  });

  test('[REGRESSION] a column-0 result: line whose trailing text contains U+2028 parses identically to its plain-LF twin', () => {
    // Final review MINOR 1: the per-line pattern kept `.*$` after the fix
    // above dropped `/m`, and `.` never matches U+2028/U+2029, so `$` was
    // unreachable on a line whose TRAILING text (after the token) contained
    // one of these separators — the line failed to match at all. Compare by
    // IDENTITY (test number AND name AND result) against the plain-LF
    // equivalent, not just presence/count, per this suite's own convention.
    const withSeparator = '### 1. Alpha\nexpected: ok\nresult: blocked' + LINE_SEPARATOR + 'trailing note\n';
    const plainLf = '### 1. Alpha\nexpected: ok\nresult: blocked trailing note\n';

    const withSeparatorResult = parseUatItemsWithStats(withSeparator);
    const plainLfResult = parseUatItemsWithStats(plainLf);
    const describeAll = () => JSON.stringify({ withSeparatorResult, plainLfResult }, null, 2);

    assert.ok(findAlphaBlocked(withSeparatorResult.items), `expected outstanding row 1/Alpha/blocked absent: ${describeAll()}`);
    assert.deepStrictEqual(withSeparatorResult.items, plainLfResult.items, `must match the plain-LF twin by identity: ${describeAll()}`);
    assert.strictEqual(withSeparatorResult.headingsSeen, plainLfResult.headingsSeen, describeAll());
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3740: acknowledgeDeferredItem must agree with the field extractor on
// what a status-field line is. The writer's search regex was marker-optional
// while the reader (extractGapEntryFields) deliberately strips a bullet
// marker on line 0 ONLY — a later `- ` line is a nested sub-list, not a
// field. Pre-fix, a nested `  - status: open` line was rewritten and `ok`
// returned, but no reader ever saw the rewrite: the entry stayed outstanding
// after a "successful" acknowledgement.
// ────────────────────────────────────────────────────────────────────────
describe('#3740: acknowledge round-trips through the reader (parse → acknowledge → parse)', () => {
  function roundTrip(body) {
    const content = '## Deferred Items\n\n' + body + '\n';
    const before = parseDeferredItemsWithStatus(content);
    assert.equal(before.length, 1, `fixture must parse to exactly one entry, got ${before.length}`);
    const ack = acknowledgeDeferredItem(content, before[0].name);
    const after = parseDeferredItemsWithStatus(ack.content);
    assert.equal(after.length, 1, 'acknowledged file must still parse to one entry');
    return { ack, before: before[0], after: after[0], content: ack.content };
  }

  test('nested-marker status line: ack returns ok and the entry is no longer outstanding', () => {
    const r = roundTrip('- alpha\n  - status: open');
    assert.equal(r.ack.status, 'ok');
    assert.equal(r.after.status, 'acknowledged',
      '#3740: a nested `- status:` line is not a field line to the reader; the ack must take the insert branch the reader parses');
  });

  test('nested-marker status line, CRLF variant: same outcome', () => {
    const r = roundTrip('- alpha\r\n  - status: open');
    assert.equal(r.ack.status, 'ok');
    assert.equal(r.after.status, 'acknowledged');
  });

  test('line-0 entry-line status (`- status: open`) is still rewritten in place', () => {
    // The reader de-bullets line 0, so a status field on the entry line IS a
    // real field there — and first-wins means the insert branch could never
    // outrank it. The search must keep matching this shape (#3740 review).
    const r = roundTrip('- status: open\n  reason: flaky');
    assert.equal(r.ack.status, 'ok');
    assert.equal(r.after.status, 'acknowledged');
    const statusLines = r.content.split('\n').filter((l) => /status:\s*/.test(l));
    assert.equal(statusLines.length, 1, `exactly one status line must remain, got ${JSON.stringify(statusLines)}`);
  });

  test('control: marker-free status line is still rewritten in place, not duplicated', () => {
    const r = roundTrip('- alpha\n  status: open');
    assert.equal(r.ack.status, 'ok');
    assert.equal(r.after.status, 'acknowledged');
    const statusLines = r.content.split('\n').filter((l) => /status:\s*/.test(l));
    assert.equal(statusLines.length, 1, `exactly one status line must remain, got ${JSON.stringify(statusLines)}`);
    assert.match(statusLines[0], /status:\s*acknowledged/);
  });

  test('control: entry with no status line keeps the insert branch', () => {
    const r = roundTrip('- alpha');
    assert.equal(r.ack.status, 'ok');
    assert.equal(r.after.status, 'acknowledged');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3781: acknowledge on the heading-delimited (#3457) entry shape. The
// writer refused EVERY entry in any heading-shaped deferred-items.md
// (`unsupported_heading_shape`) because the reader carried no character
// spans to anchor a write. The fix adds a span-carrying sibling of the
// heading walk; leaves rewrite in place / insert after their last
// non-blank line, and pending (preamble / container-direct) bullets reuse
// the headless span machinery with a baseOffset translation. Entries with
// an embedded GFM table row still refuse — a table line makes the span
// non-contiguous.
describe('#3781: acknowledge supports the heading-delimited entry shape', () => {
  const leafDoc = [
    '## Deferred Items',
    '',
    '### Finding one',
    '- did a thing',
    '- evidence gathered',
    '',
  ].join('\n');

  test('leaf entry without status acks via the insert branch the reader reads', () => {
    const before = parseDeferredItemsWithStatus(leafDoc);
    assert.equal(before.length, 1);
    assert.equal(before[0].status, '');

    const ack = acknowledgeDeferredItem(leafDoc, before[0].name);
    assert.equal(ack.status, 'ok', `pre-fix this refused unsupported_heading_shape; got ${ack.status}`);

    const after = parseDeferredItemsWithStatus(ack.content);
    assert.equal(after.length, 1);
    assert.equal(after[0].status, 'acknowledged', 'the entry must read acknowledged afterward');

    // AC7 sentence trap: the marker goes after the LAST non-blank line, never
    // spliced mid-entry after the heading line.
    const lines = ack.content.split('\n');
    const markerIdx = lines.findIndex((l) => /status: acknowledged/.test(l));
    const lastBodyIdx = lines.findIndex((l) => l === '- evidence gathered');
    assert.ok(markerIdx > lastBodyIdx, 'marker must follow the entry\'s last non-blank line');
    assert.ok(lines.includes('- did a thing') && lines.includes('- evidence gathered'),
      'the soft-wrapped body must remain intact');
  });

  test('leaf entry with an existing Status field is replaced in place', () => {
    const doc = leafDoc.replace('- did a thing', '- **Status:** open\n- did a thing');
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before[0].status, 'open');

    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok');

    const statusLines = ack.content.split('\n').filter((l) => /status:/i.test(l) && l.trim() !== '');
    assert.equal(statusLines.length, 1, `exactly one status line, got ${JSON.stringify(statusLines)}`);
    assert.match(statusLines[0], /\*\*Status:\*\*\s*acknowledged/);
    assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
  });

  test('pending bullets alongside heading entries ack without disturbing siblings', () => {
    // Inner headings must be H3+ — a sibling H2 would end the level-bounded
    // '## Deferred Items' section (collectSection), so the realistic shapes
    // are H3 containers with H4 leaves.
    const doc = [
      '## Deferred Items',
      '',
      '- loose preamble item',
      '',
      '### Findings group',
      '',
      '- container-direct item',
      '',
      '#### Finding one',
      '- did a thing',
      '',
    ].join('\n');
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before.length, 3, `fixture must parse to three entries, got ${JSON.stringify(before)}`);

    const ackPreamble = acknowledgeDeferredItem(doc, 'loose preamble item');
    assert.equal(ackPreamble.status, 'ok');
    let items = parseDeferredItemsWithStatus(ackPreamble.content);
    assert.equal(items[0].status, 'acknowledged');
    assert.equal(items[1].status, '', 'container-direct sibling untouched');
    assert.equal(items[2].status, '', 'leaf sibling untouched');

    const ackContainerDirect = acknowledgeDeferredItem(ackPreamble.content, 'container-direct item');
    assert.equal(ackContainerDirect.status, 'ok');
    items = parseDeferredItemsWithStatus(ackContainerDirect.content);
    assert.deepEqual(items.map((e) => e.status), ['acknowledged', 'acknowledged', ''],
      'each pending bullet acks independently');
    assert.ok(ackContainerDirect.content.includes('- did a thing'), 'leaf entry text untouched');
  });

  test('already_resolved / ambiguous / not_found semantics match the headless shape', () => {
    const resolvedDoc = leafDoc.replace('- did a thing', '- **Status:** resolved\n- did a thing');
    const resolved = acknowledgeDeferredItem(resolvedDoc, parseDeferredItemsWithStatus(resolvedDoc)[0].name);
    assert.equal(resolved.status, 'already_resolved');
    assert.equal(resolved.content, resolvedDoc, 'file unchanged');

    const dupDoc = [
      '## Deferred Items',
      '',
      '### Finding one',
      '- did a thing',
      '',
      '### Finding two',
      '- did a thing',
      '',
    ].join('\n');
    // Both leaves carry bullet `- did a thing`; identity text differs by heading,
    // so force ambiguity with identical heading+body.
    const dupDoc2 = [
      '## Deferred Items',
      '',
      '### Same',
      '- did a thing',
      '',
      '### Same',
      '- did a thing',
      '',
    ].join('\n');
    const dup = acknowledgeDeferredItem(dupDoc2, parseDeferredItemsWithStatus(dupDoc2)[0].name);
    assert.equal(dup.status, 'ambiguous');
    assert.equal(dup.content, dupDoc2, 'file unchanged');

    const missing = acknowledgeDeferredItem(leafDoc, 'no such entry');
    assert.equal(missing.status, 'not_found');
    assert.equal(missing.content, leafDoc);
    void dupDoc;
  });

  test('entries with embedded GFM table rows still refuse', () => {
    const doc = [
      '## Deferred Items',
      '',
      '### Finding one',
      '- did a thing',
      '| a | b |',
      '- more evidence',
      '',
    ].join('\n');
    const before = parseDeferredItemsWithStatus(doc);
    // The leaf entry AND the table row itself (parseDeferredTableItems unions
    // over the same section) both surface.
    assert.equal(before.length, 2, 'fixture self-check: leaf entry + table row');
    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'unsupported_heading_shape',
      'a table line inside the entry body makes its span non-contiguous — refuse');
    assert.equal(ack.content, doc, 'file unchanged');
  });

  test('a table row AFTER the entry\'s last line is outside its span — the write lands above it', () => {
    // #3781 refused any leaf whose heading-to-next-heading range held a table
    // row. The refusal exists because a row INSIDE the span makes it
    // non-contiguous; a row after the last entry line is not inside anything,
    // and refusing it halts `complete-milestone` over a write that is safe.
    const doc = '## Deferred Items\n\n### Finding one\n- did a thing\n| x | y |\n';
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before.length, 2, 'fixture self-check: leaf entry + table row');
    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok');
    assert.equal(ack.content, '## Deferred Items\n\n### Finding one\n- did a thing\n  status: acknowledged\n| x | y |\n');
    assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
  });

  test('an entry whose body ENDS in a fence acks readably — the marker lands before the fence, never inside it (round 5, RV6.5)', () => {
    // Unclosed fence: it runs to the entry's end, so "after the last
    // non-blank line" is fence content — the reader never sees the marker.
    const unclosed = '## Deferred Items\n\n### E\n- **What:** x\n```\ncode\n';
    let ack = acknowledgeDeferredItem(unclosed, parseDeferredItemsWithStatus(unclosed)[0].name);
    assert.equal(ack.status, 'ok');
    assert.equal(ack.content, '## Deferred Items\n\n### E\n- **What:** x\n  status: acknowledged\n```\ncode\n');
    assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged', 'the marker must be read back');
    // Closed fence at the end of the body: same placement, for the same reason.
    const closed = '## Deferred Items\n\n### E\n- **What:** x\n```\ncode\n```\n';
    ack = acknowledgeDeferredItem(closed, parseDeferredItemsWithStatus(closed)[0].name);
    assert.equal(ack.status, 'ok');
    assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
    assert.ok(ack.content.includes('- **What:** x\n  status: acknowledged\n```'), ack.content);
    // A pending (preamble) entry ending in an unclosed fence before a heading.
    const pending = '## Deferred Items\n\n- a\n```\ncode\n\n### E\n- b\n';
    const items = parseDeferredItemsWithStatus(pending);
    assert.equal(items.length, 2, JSON.stringify(items));
    ack = acknowledgeDeferredItem(pending, items[0].name);
    assert.equal(ack.status, 'ok');
    assert.deepStrictEqual(parseDeferredItemsWithStatus(ack.content).map((i) => i.status), ['acknowledged', '']);
    assert.ok(ack.content.startsWith('## Deferred Items\n\n- a\n  status: acknowledged\n```\ncode\n'), ack.content);
  });

  test('a heading whose TEXT is a fence delimiter is a heading, not a fence (round 5, RV6.5)', () => {
    // The entry-level fence scan saw line 0 (`\`\`\``, the heading text) as an
    // opener: every body line was fenced, the reader read no field, and the
    // writer's marker landed on a line nothing reads.
    for (const delim of ['```', '~~~']) {
      const doc = `## Deferred Items\n\n### ${delim}\n- x\n  status: resolved\n`;
      assert.deepStrictEqual(parseDeferredItemsWithStatus(doc).map((i) => i.status), ['resolved'], delim);
      const open = `## Deferred Items\n\n### ${delim}\n- x\n`;
      const ack = acknowledgeDeferredItem(open, parseDeferredItemsWithStatus(open)[0].name);
      assert.equal(ack.status, 'ok', delim);
      assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged', delim);
    }
  });

  test('leaf line-0 rewrite keeps a closing `#` sequence (round 5, RV6.5)', () => {
    const doc = '## Deferred Items\n\n### status: open ###\n- did a thing\n';
    const ack = acknowledgeDeferredItem(doc, parseDeferredItemsWithStatus(doc)[0].name);
    assert.equal(ack.status, 'ok');
    assert.ok(ack.content.includes('### status: acknowledged ###'), ack.content);
    assert.equal(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
  });

  test('leaf line-0 corner: a heading whose text parses as a status field', () => {
    const doc = '## Deferred Items\n\n### status: open\n- did a thing\n';
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before.length, 1);
    assert.equal(before[0].status, 'open', 'fixture self-check: the reader reads the heading text itself as the field');

    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok');
    assert.ok(ack.content.includes('### status: acknowledged'),
      'the ATX prefix must be preserved on the rewritten heading line');
    const after = parseDeferredItemsWithStatus(ack.content);
    assert.equal(after[0].status, 'acknowledged', 'first-wins must read the rewritten heading text');
  });

  test('CRLF pending entry verifies and acks (review finding)', () => {
    const doc = '## Deferred Items\r\n\r\n- alpha\r\n  continuation line\r\n\r\n### Finding one\r\n- did a thing\r\n';
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before.length, 2, 'fixture self-check: preamble pending + leaf');

    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok', 'a CRLF pending entry must not false-refuse match_verification_failed');
    const after = parseDeferredItemsWithStatus(ack.content);
    assert.equal(after[0].status, 'acknowledged');
  });

  test('flat and mixed heading-depth files ack their leaf entries', () => {
    const flatSection = '## Deferred Items\n\n### Notes\n\n#### Finding A\n- item one\n\n#### Finding B\n- item two\n';
    let items = parseDeferredItemsWithStatus(flatSection);
    assert.equal(items.length, 2, 'container group + two leaves');
    const ackA = acknowledgeDeferredItem(flatSection, 'Finding A - item one');
    assert.equal(ackA.status, 'ok');
    assert.equal(parseDeferredItemsWithStatus(ackA.content).map((e) => e.status).filter(Boolean).length, 1,
      'exactly one entry acknowledged');

    const mixed = '## Deferred Items\n\n### Childless group\n- solo item\n\n### Parent group\n#### Child one\n- child item\n';
    items = parseDeferredItemsWithStatus(mixed);
    assert.ok(items.length >= 2, 'fixture self-check: mixed depths parse');
    const ackSolo = acknowledgeDeferredItem(mixed, 'Childless group - solo item');
    assert.equal(ackSolo.status, 'ok', 'a childless ## leaf alongside a ## container acks');
  });

  test('leaf body status line keeps its bullet marker and indent on rewrite', () => {
    const doc = '## Deferred Items\n\n### Finding one\n- did a thing\n  - **Status:** open\n';
    const before = parseDeferredItemsWithStatus(doc);
    assert.equal(before[0].status, 'open');

    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok');
    assert.ok(ack.content.includes('  - **Status:** acknowledged'),
      `the raw line's bullet marker and indent must survive the rewrite; got:\n${ack.content}`);
  });

  test('fully-headless file is byte-for-byte unchanged by this feature', () => {
    const doc = '## Deferred Items\n\n- alpha\n  status: open\n';
    const before = parseDeferredItemsWithStatus(doc);
    const ack = acknowledgeDeferredItem(doc, before[0].name);
    assert.equal(ack.status, 'ok');
    assert.equal(ack.content, '## Deferred Items\n\n- alpha\n  status: acknowledged\n',
      'the pre-existing headless splice shape must be untouched');
  });
});

// ─── #3850: gaps_found VERIFICATION files ────────────────────────────────────
//
// cmdAuditUat admits `human_needed` OR `gaps_found`, but parseVerificationItems
// honoured only the first and returned [] for the second. Because cmdAuditUat
// pushes a file into `results` only when `items.length > 0`, a `gaps_found`
// report did not under-report — the whole file, and its phase's `by_phase` row,
// VANISHED. Every test below fails on base: the gate returns [] regardless of
// what the frontmatter holds.
describe('#3850 gaps_found VERIFICATION files', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  /** Write one VERIFICATION file and return the parsed audit-uat payload. */
  const auditWith = (body, phase = '01-demo') => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', phase);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, `${phase.split('-')[0]}-VERIFICATION.md`), body);
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  };

  const HV_TWO = `---
phase: 01-demo
status: gaps_found
human_verification:
  - test: "Confirm the widget renders on a physical device"
    expected: "Widget appears within 2s"
    why_human: "Needs real hardware"
  - test: "Confirm the audible alert fires"
    expected: "Alert is audible"
    why_human: "Needs a human ear"
---

# Verification
`;

  test('surfaces a gaps_found file\'s human_verification array (the #3850 defect)', () => {
    const output = auditWith(HV_TWO);
    assert.strictEqual(output.summary.total_items, 2);
    assert.strictEqual(output.summary.total_files, 1);
    assert.strictEqual(output.results[0].type, 'verification');
    assert.strictEqual(output.results[0].status, 'gaps_found');
    assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    // by_phase carries the phase — the omission mechanism this issue is about.
    assert.strictEqual(output.summary.by_phase['01'], 2);
  });

  test('the SAME file under human_needed and gaps_found yields identical human_verification items', () => {
    // The status token alone decided visibility; it must now decide nothing
    // about the human_verification reading itself.
    const asGaps = parseVerificationItems(HV_TWO, 'gaps_found');
    const asHuman = parseVerificationItems(HV_TWO.replace('status: gaps_found', 'status: human_needed'), 'human_needed');
    assert.deepStrictEqual(asGaps, asHuman);
    assert.strictEqual(asGaps.length, 2);
  });

  test('surfaces a gaps_found file\'s frontmatter gaps array', () => {
    const output = auditWith(`---
phase: 02-gaps
status: gaps_found
gaps:
  - truth: "The widget renders"
    status: partial
    reason: "Only observed on one platform"
    test: 7
---

# Verification
`, '02-gaps');
    assert.strictEqual(output.summary.total_items, 1);
    const item = output.results[0].items[0];
    assert.strictEqual(item.name, 'The widget renders');
    assert.strictEqual(item.result, 'partial');
    assert.strictEqual(item.reason, 'Only observed on one platform');
    // No `test:` number (#3879 review round 4, Minor 4). A `gaps:` entry has no
    // `test:` in its vocabulary, and reading one collided with the 1..N row
    // numbers `parseHumanVerificationItems` assigns by array position — two
    // items numbered 1 in a single file's combined list.
    assert.strictEqual(item.test, undefined);
  });

  test('a gaps entry with no parseable status surfaces as unknown, never dropped (fail-safe)', () => {
    const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "Garbled entry"
---
`, 'gaps_found');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'unknown');
  });

  test('folded >- scalars inside an entry do not break the entry (real verifier shape)', () => {
    const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "Gate is fail-open on absence of information"
    status: partial
    reason: >-
      The hub learns a collection's schema version only from a push carrying
      rows, so a zero-row collection is invisible and the RAM-only hub
      re-blinds itself on every host restart.
---
`, 'gaps_found');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].name, 'Gate is fail-open on absence of information');
    assert.strictEqual(items[0].result, 'partial');
  });

  describe('closed entries are excluded on the gaps_found path', () => {
    test('skips resolution:-marked human_verification entries, keeping original 1-based positions', () => {
      const items = parseVerificationItems(`---
status: gaps_found
human_verification:
  - test: "Already answered"
    resolution: "RESOLVED 2026-01-01 by the phase 4 rig run"
  - test: "Still outstanding"
    why_human: "Needs real hardware"
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1);
      // Entry 2 keeps position 2 so a surfaced item still names its row.
      assert.strictEqual(items[0].test, 2);
      assert.match(items[0].name, /Still outstanding/);
    });

    test('skips status: resolved gaps entries', () => {
      const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "Open"
    status: partial
  - truth: "Closed"
    status: resolved
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].name, 'Open');
    });

    test('a resolution:-shaped substring MID-LINE is not a closure marker', () => {
      // extractGapEntryFields anchors a field to the start of its own trimmed
      // line; a quoted value mentioning "resolution:" must never close an entry.
      const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "Deferred until the resolution: pending owner ruling"
    status: partial
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1);
    });

    test('closed entries are excluded on the human_needed path too', () => {
      // #3850 review m8: an earlier revision skipped closed entries only on
      // `gaps_found`, citing an acceptance criterion the issue does not
      // contain. #3850 has no AC section; its suggested fix (2) states the skip
      // unconditionally, and the file it cites — 14 of 16 entries resolved — is
      // a `human_needed` one. The asymmetry left the reporter's own scenario
      // over-reporting by 14. One rule, both statuses.
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "Already answered"
    resolution: "RESOLVED 2026-01-01"
  - test: "Still outstanding"
---
`, 'human_needed');
      assert.strictEqual(items.length, 1);
      // The display name keeps `extractFrontmatter`'s flattened shape verbatim
      // (`normalizeHumanVerificationEntry` strips wrapping quotes only) — this
      // fix derives the SAME string from the raw slice, it does not prettify it.
      assert.match(items[0].name, /Still outstanding/);
      // The surfaced entry keeps its ORIGINAL 1-based row, so it still names
      // its position in the file after a closed sibling was skipped.
      assert.strictEqual(items[0].test, 2);
    });

    test('B2: a nested block sequence at key indent does not drop an OPEN entry', () => {
      // The review's executed repro. `parseYamlRegion` is indent-blind and
      // `splitGapsEntries` is indent-anchored, so pairing them by ordinal
      // position made entry B inherit entry C's `resolution:` and disappear.
      // Both readings now come from one parse, so there is no index to skew.
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "A"
    steps:
    - s1
  - test: "B"
  - test: "C"
    resolution: "done"
---
`, 'human_needed');
      const names = items.map((i) => i.name).join(' | ');
      // The display rendering comes from `flattenObjectListItem`, which emits
      // `test: B` — unquoted — where the pre-#3881 flattener emitted `test: "B`.
      assert.match(names, /\btest: B\b/, `open entry "B" must survive; got ${JSON.stringify(names)}`);
      assert.ok(!/\btest: C\b/.test(names), `closed entry "C" must be skipped; got ${JSON.stringify(names)}`);
    });

    test('B2: a bare bullet does not skew the entry list', () => {
      // Round-3 Blocker. The original assertion matched `test: B` anywhere in a
      // joined name string, so it passed while "B" was reported at position 2 —
      // and would still have passed had the bare bullet been dropped entirely.
      // The defect was never about the NAME surviving; it was about the ROW
      // number and the row count. Assert both.
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "A"
  - 
  - test: "B"
---
`, 'human_needed');
      assert.deepStrictEqual(
        items.map((i) => [i.test, i.name]),
        [[1, 'test: A'], [2, ''], [3, 'test: B']],
        'every row surfaces at its own 1-based position, bare bullet included',
      );
    });

    test('B2b: a mixed object/non-object list keeps every row at its true position', () => {
      // The reviewer's own 6-entry fixture, verbatim. Against the filtered
      // implementation this returned THREE items — "A", "D", "F" numbered
      // 1, 2, 3 — with rows 2, 3 and 5 gone and no trace that anything had
      // been dropped. That is #3850's defect reached through entry SHAPE
      // rather than file STATUS, so it is pinned on `gaps_found` where the
      // union path runs.
      const items = parseVerificationItems(`---
status: gaps_found
human_verification:
  - test: "A"
  -
  - bare scalar
  - test: "D"
  -
    - nested
  - test: "F"
---
`, 'gaps_found');
      assert.deepStrictEqual(
        items.map((i) => [i.test, i.name]),
        [
          [1, 'test: A'],
          [2, ''],
          [3, 'bare scalar'],
          [4, 'test: D'],
          [5, '[nested]'],
          [6, 'test: F'],
        ],
        'all six rows surface, each at its own position, named as base named them',
      );
    });

    test('B2c: skipped-because-resolved rows leave the survivors numbered by FILE row', () => {
      // The property the positional index exists for, and the one a count-only
      // assertion cannot see: rows 2 and 4 are closed, so 1, 3 and 5 surface
      // with their own numbers rather than being renumbered 1, 2, 3.
      const items = parseVerificationItems(`---
status: human_needed
human_verification:
  - test: "A"
  - test: "B"
    resolution: done
  -
  - test: "D"
    status: resolved
  - test: "E"
---
`, 'human_needed');
      assert.deepStrictEqual(
        items.map((i) => [i.test, i.name]),
        [[1, 'test: A'], [3, ''], [5, 'test: E']],
        'closed rows are skipped and the survivors keep their file positions',
      );
    });

    test('B2d: a non-object gaps entry surfaces instead of vanishing', () => {
      // Same class, other reader. `gaps:` entries carry their own status, so a
      // non-object one has none to read — this module's documented fail-safe
      // (`parseGapsItems`' 'unknown' fallback) is to surface it rather than
      // drop it. It is named by the same renderer every other reader uses, so
      // a YAML null reads '' and not the string "null".
      const items = parseVerificationItems(`---
status: gaps_found
gaps:
  - truth: "G1"
    status: failed
  -
  - bare gap
  - truth: "G3"
    status: resolved
---
`, 'gaps_found');
      assert.deepStrictEqual(
        items.map((i) => [i.name, i.result]),
        [['G1', 'failed'], ['', 'unknown'], ['bare gap', 'unknown']],
        'every unresolved gaps row surfaces; the resolved one is skipped',
      );
    });

    test('B1: a BOM does not make a gaps_found report vanish', () => {
      // #2977's defect class. A hand-rolled fence regex re-asserts the byte-0
      // rule and slices nothing, which is this issue's symptom verbatim on the
      // platform the repo already has a named class for.
      const items = parseVerificationItems(`\uFEFF---
status: gaps_found
gaps:
  - truth: "G1"
    status: partial
---
`, 'gaps_found');
      assert.strictEqual(items.length, 1, 'a BOM-prefixed report must still surface its gaps');
      assert.strictEqual(items[0].name, 'G1');
    });

    test('M4: CRLF frontmatter surfaces gaps', () => {
      const crlf = ['---', 'status: gaps_found', 'gaps:', '  - truth: "G1"', '    status: partial', '---', ''].join('\r\n');
      const items = parseVerificationItems(crlf, 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].name, 'G1');
    });
  });

  describe('array-population boundaries', () => {
    const build = (hv, gaps) => [
      '---', 'status: gaps_found',
      ...(hv === null ? [] : ['human_verification:', ...hv.map((t) => `  - test: "${t}"`)]),
      ...(gaps === null ? [] : ['gaps:', ...gaps.map((t) => `  - truth: "${t}"\n    status: partial`)]),
      '---', '',
    ].join('\n');

    test('empty human_verification + populated gaps still surfaces the gaps', () => {
      const items = parseVerificationItems(build([], ['G1']), 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].name, 'G1');
    });

    test('populated human_verification + no gaps key surfaces only the hv entries', () => {
      const items = parseVerificationItems(build(['H1'], null), 'gaps_found');
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].category, 'human_uat');
    });

    test('both arrays populated surfaces the union, human_verification first', () => {
      const items = parseVerificationItems(build(['H1', 'H2'], ['G1']), 'gaps_found');
      assert.strictEqual(items.length, 3);
      assert.strictEqual(items[0].category, 'human_uat');
      assert.strictEqual(items[2].name, 'G1');
    });

    test('neither key present yields zero items', () => {
      assert.strictEqual(parseVerificationItems(build(null, null), 'gaps_found').length, 0);
    });

    test('a single entry (N=1) surfaces', () => {
      assert.strictEqual(parseVerificationItems(build(['H1'], null), 'gaps_found').length, 1);
    });

    test('every entry closed yields zero items, so the file is omitted — intended, not the #3850 bug', () => {
      // The omission this issue reports is a file with OUTSTANDING items
      // vanishing. A file whose every entry is closed has nothing outstanding,
      // so `items.length > 0` correctly drops it. Pinned to keep the two cases
      // distinguishable.
      const output = auditWith(`---
phase: 03-allclosed
status: gaps_found
human_verification:
  - test: "Answered"
    resolution: "RESOLVED"
gaps:
  - truth: "Closed"
    status: resolved
---
`, '03-allclosed');
      assert.strictEqual(output.summary.total_items, 0);
      assert.strictEqual(output.summary.total_files, 0);
    });
  });

  describe('property: the closed/open partition', () => {
    // Text that can never be mistaken for a field line or a closure marker.
    const bodyArb = fc.string({ minLength: 1, maxLength: 24 })
      .map((s) => s.replace(/["\\\r\n:]/g, ''))
      .filter((s) => s.trim().length > 0);

    // Closure is PER KEY (#3879 review round 4, Major), so the property is too.
    // `gaps:` takes `parseGapsItems`' rule verbatim — `status: resolved` and
    // nothing else — while `human_verification:` also honours a bare
    // `resolution:`. Generating one spelling set for both keys is what let the
    // old universal rule read green.
    //
    // `contradiction` is the round-4 Major itself: a `status:` that is not
    // `resolved` sitting beside a `resolution:` note. It is OPEN under both
    // keys — `status:` is authoritative wherever it is readable.
    const OPEN_SPELLINGS = {
      gaps: {
        plain: ['    status: partial'],
        // No `status:` at all. Under the gaps rule this is not closure, and
        // `parseGapsItems` already surfaces it via its 'unknown' fallback.
        resolutionOnly: ['    resolution: "a note, not a closure assertion"'],
        contradiction: ['    status: failed', '    resolution: "attempted retry, still failing"'],
      },
      human_verification: {
        plain: ['    status: partial'],
        contradiction: ['    status: failed', '    resolution: "attempted retry, still failing"'],
      },
    };
    const CLOSED_SPELLINGS = {
      gaps: {
        status: ['    status: resolved'],
      },
      human_verification: {
        status: ['    status: resolved'],
        resolutionOnly: ['    resolution: "closed upstream"'],
      },
    };

    const entryArb = (key) => fc.record({
      body: bodyArb,
      closed: fc.boolean(),
      openSpelling: fc.constantFrom(...Object.keys(OPEN_SPELLINGS[key])),
      closedSpelling: fc.constantFrom(...Object.keys(CLOSED_SPELLINGS[key])),
    });

    const renderEntry = (key, e) => {
      const nameLine = key === 'gaps' ? `  - truth: "${e.name}"` : `  - test: "${e.name}"`;
      const fields = e.closed
        ? CLOSED_SPELLINGS[key][e.closedSpelling]
        : OPEN_SPELLINGS[key][e.openSpelling];
      return [nameLine, ...fields];
    };

    test('property: a gaps entry surfaces iff its own status is not resolved; surfaced + skipped == total', () => {
      fc.assert(
        fc.property(
          fc.array(entryArb('gaps'), { maxLength: 12 }),
          (raw) => {
            // Index-prefix so surfaced names map back unambiguously even when
            // the generated bodies collide.
            const entries = raw.map((e, i) => ({ ...e, name: `E${i}_${e.body}` }));
            const lines = ['---', 'status: gaps_found', 'gaps:'];
            for (const e of entries) lines.push(...renderEntry('gaps', e));
            lines.push('---', '');

            const items = parseVerificationItems(lines.join('\n'), 'gaps_found');
            const surfaced = new Set(items.map((it) => it.name));
            const open = entries.filter((e) => !e.closed);
            const closed = entries.filter((e) => e.closed);

            // Partition: surfaced count is exactly the open count...
            assert.strictEqual(items.length, open.length);
            // ...every open entry surfaces, INCLUDING the two spellings the old
            // universal rule swallowed (a bare `resolution:`, and a
            // `resolution:` beside a non-resolved `status:`)...
            for (const e of open) assert.ok(surfaced.has(e.name), `open entry missing: ${e.name}`);
            // ...no closed entry ever does...
            for (const e of closed) assert.ok(!surfaced.has(e.name), `closed entry surfaced: ${e.name}`);
            // ...and the two parts account for the whole.
            assert.strictEqual(open.length + closed.length, entries.length);
          },
        ),
      );
    });

    test('property: a human_verification entry surfaces iff no readable status contradicts its closure', () => {
      fc.assert(
        fc.property(
          fc.array(entryArb('human_verification'), { maxLength: 12 }),
          (raw) => {
            const entries = raw.map((e, i) => ({ ...e, name: `E${i}_${e.body}` }));
            const lines = ['---', 'status: human_needed', 'human_verification:'];
            for (const e of entries) lines.push(...renderEntry('human_verification', e));
            lines.push('---', '');

            const items = parseVerificationItems(lines.join('\n'), 'human_needed');
            const open = entries.filter((e) => !e.closed);

            // Counts only: this reader names items through
            // `normalizeHumanVerificationEntry`'s display rendering, so asserting
            // the partition by NAME would pin that renderer rather than the
            // closure rule under test.
            assert.strictEqual(items.length, open.length);
            // Numbering stays the entry's ORIGINAL 1-based row even when a
            // closed sibling was skipped (the #3850 round-3 Blocker).
            const expectedRows = entries
              .map((e, i) => (e.closed ? null : i + 1))
              .filter((n) => n !== null);
            assert.deepStrictEqual(items.map((it) => it.test), expectedRows);
          },
        ),
      );
    });

    test('property: an all-open array surfaces every entry (no silent cap)', () => {
      fc.assert(
        fc.property(fc.array(bodyArb, { minLength: 1, maxLength: 20 }), (bodies) => {
          const names = bodies.map((b, i) => `E${i}_${b}`);
          const content = ['---', 'status: gaps_found', 'gaps:',
            ...names.map((n) => `  - truth: "${n}"\n    status: partial`), '---', ''].join('\n');
          assert.strictEqual(parseVerificationItems(content, 'gaps_found').length, names.length);
        }),
      );
    });
  });
});
