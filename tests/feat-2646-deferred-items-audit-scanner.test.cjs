/**
 * #2646 (c) — `deferred-items.md` has no reader at MILESTONE close.
 *
 * `auditOpenArtifacts` (src/audit.cts) is the pre-close gate behind
 * `/gsd-complete-milestone`. It scanned eight categories — debug sessions,
 * quick tasks, threads, todos, seeds, UAT gaps, verification gaps, context
 * questions — and `deferred-items.md` was not among them.
 *
 * #2287 made that file readable at the PHASE boundary (`audit-uat`,
 * `/gsd-progress` check 7). One boundary up it was still invisible, and phase
 * directories archive to `milestones/vX.Y-phases/` by default (#1871) — so an
 * out-of-scope discovery a phase agent correctly recorded rather than fixed
 * left the live tree at milestone close without ever reaching the existing
 * `[R] Resolve / [A] Acknowledge / [C] Cancel` prompt.
 *
 * This adds `deferred_items` as a ninth scanner, its count, its `items` entry
 * and its report section. The resolved/unresolved predicate is NOT
 * reimplemented — the scanner lazily requires `uat.cjs`'s exported
 * `parseDeferredItems`, so both boundaries agree by construction about what
 * "open" means.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/** Write a phase-directory deferred-items.md and return its phase dir. */
function writeDeferred(tmpDir, phaseDirName, lines) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseDirName);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), lines.join('\n') + '\n');
  return phaseDir;
}

function auditJson(tmpDir) {
  const result = runGsdTools('audit-open --json', tmpDir);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#2646 auditOpenArtifacts: deferred-items.md is a scanned category', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('the category exists in the contract even when empty', () => {
    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 0);
    assert.deepStrictEqual(out.items.deferred_items, []);
  });

  test('no deferred-items.md in a phase dir → no false positive', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '.gitkeep'), '');

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 0);
    assert.strictEqual(out.has_open_items, false);
  });

  test('an unresolved entry is surfaced with its phase and counted', () => {
    writeDeferred(tmpDir, '01-foundation', [
      '## Deferred Items',
      '',
      '- getUserById() has a pre-existing N+1 in the members join.',
    ]);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 1);
    assert.strictEqual(out.items.deferred_items.length, 1);

    const [item] = out.items.deferred_items;
    assert.strictEqual(item.phase, '01');
    assert.strictEqual(item.file, 'deferred-items.md');
    assert.match(item.text, /pre-existing N\+1/);
  });

  test('an entry marked `status: resolved` is NOT surfaced', () => {
    writeDeferred(tmpDir, '01-foundation', [
      '## Deferred Items',
      '',
      '- Already handled unrelated lint warning.',
      '  status: resolved',
    ]);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 0);
  });

  test('resolved and unresolved entries in one file → only the unresolved surfaces', () => {
    writeDeferred(tmpDir, '02-api', [
      '## Deferred Items',
      '',
      '- Fixed already.',
      '  status: resolved',
      '- Still open: config loader swallows a parse error.',
    ]);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 1);
    assert.match(out.items.deferred_items[0].text, /swallows a parse error/);
  });

  test('a headless deferred-items.md still surfaces (fail-safe, inherited from #2287)', () => {
    writeDeferred(tmpDir, '03-ui', [
      '- No level-2 heading here, but this is still a real discovery.',
    ]);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 1);
  });

  test('entries across multiple phases are all surfaced', () => {
    writeDeferred(tmpDir, '01-foundation', ['## Deferred Items', '', '- One.']);
    writeDeferred(tmpDir, '02-api', ['## Deferred Items', '', '- Two.', '- Three.']);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.counts.deferred_items, 3);
    assert.deepStrictEqual(
      [...new Set(out.items.deferred_items.map(i => i.phase))].sort(),
      ['01', '02'],
    );
  });

  test('deferred items contribute to counts.total and flip has_open_items', () => {
    writeDeferred(tmpDir, '01-foundation', ['## Deferred Items', '', '- A real discovery.']);

    const out = auditJson(tmpDir);

    assert.strictEqual(out.has_open_items, true);
    assert.strictEqual(out.counts.total, 1);
  });
});

describe('#2646 formatAuditReport: deferred items render in the report', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('the section and its entry appear in the human-readable report', () => {
    writeDeferred(tmpDir, '01-foundation', [
      '## Deferred Items',
      '',
      '- getUserById() has a pre-existing N+1 in the members join.',
    ]);

    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.match(result.output, /Deferred Items \(1 unresolved\)/);
    assert.match(result.output, /Phase 01: getUserById\(\) has a pre-existing N\+1/);
    assert.match(result.output, /1 item requires? decisions? before close\./);
  });

  test('a clean tree still reports all-clear (no empty section emitted)', () => {
    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.doesNotMatch(result.output, /Deferred Items/);
    assert.match(result.output, /All artifact types clear/);
  });
});
