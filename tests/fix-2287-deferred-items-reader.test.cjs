/**
 * #2287 — deferred-items.md has no reader anywhere in gsd-core.
 *
 * The SCOPE BOUNDARY convention (`agents/gsd-executor.md`) instructs the
 * executor to log out-of-scope discoveries to `deferred-items.md` inside the
 * phase directory. Nothing read that file back: `cmdAuditUat` (src/uat.cts)
 * filtered phase-directory files down to `*-UAT.md` / `*-VERIFICATION.md`
 * only, and the `forensic_audit` workflow step (gsd-core/workflows/
 * progress.md) ran 6 checks, none of which globbed the phase-directory
 * `deferred-items.md` path. An entry written there was permanently invisible.
 *
 * This fix:
 * - `cmdAuditUat` gains a `deferred-items.md` scan per phase directory,
 *   surfacing every UNRESOLVED entry as a `type: 'deferred'` result. An
 *   entry is resolved only when it carries an explicit `status: resolved`
 *   field (mirroring the established `## Gaps` convention from #2286) — a
 *   missing/garbled status fails safe and is surfaced.
 * - `forensic_audit` gains a 7th check that globs the same path and reports
 *   unresolved entries with the same ✓/⚠ semantics as the other 6 checks.
 *
 * `deferred-items.md` remains the single source of truth — no duplicate
 * `.planning/todos/pending/*.md` entry is required.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { parseDeferredItems } = require('../gsd-core/bin/lib/uat.cjs');

// ─── cmdAuditUat behavioral coverage ───────────────────────────────────────

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

// ─── forensic_audit workflow-prose source-contract guard ──────────────────

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

// ─── parseDeferredItems property test ──────────────────────────────────────

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
