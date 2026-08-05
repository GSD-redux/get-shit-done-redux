/**
 * #2766 — three audit-uat false negatives.
 *
 * All three fail SILENTLY and in the reassuring direction: outstanding UAT work
 * is under-reported, so the command whose job is to be the backstop reports a
 * clean bill of health over real unresolved items.
 *
 * 1. `cmdAuditUat` scanned only `.planning/phases/`. On milestone completion
 *    `milestone.cts` MOVES each phase dir into
 *    `.planning/milestones/<version>-phases/` (archive-by-default since #1871),
 *    so a partly-archived project silently omitted the archived phases and a
 *    fully-archived one hard-errored with "No phases directory found",
 *    indistinguishable from a broken install.
 * 2. `parseDeferredItems` delegates entry splitting to `splitGapsEntries`, which
 *    keys entirely on `- ` bullet openers — so a `deferred-items.md` recording
 *    entries as a GFM table produced ZERO items. The SCOPE BOUNDARY convention
 *    mandates no shape, and a table is natural for "test → failing seeds".
 * 3. `parseGapsItems` has the identical blindness for the same shared reason, so
 *    a table-shaped `## Gaps` section surfaced nothing.
 *
 * Same false-negative family as #2286 and #2287, which fixed the first two
 * shapes; these are the next ones out.
 *
 * This fix:
 * - `cmdAuditUat` collects scan targets from the active tree AND
 *   `getArchivedPhaseDirs` (the canonical seam `findPhaseInternal` already uses),
 *   erroring only when both are empty. Archived dirs deliberately bypass
 *   `getMilestonePhaseFilter` — it derives the CURRENT milestone's phase numbers
 *   from ROADMAP.md, so applying it to archived dirs discards every one and
 *   silently reinstates the bug. Results gain `archived_milestone` for provenance.
 * - One shared `collectTableRows` walker (header/delimiter/boundary handling in
 *   one place) feeds table scans in BOTH parsers as a UNION with the existing
 *   bullet scan. A `|`-leading line is never a `- ` bullet opener, so mixed files
 *   surface both with no double-counting. Resolution semantics are unchanged
 *   from the bullet path: suppress only on an explicit marker.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const { parseDeferredItems } = require('../gsd-core/bin/lib/uat.cjs');

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

  test('no phases dir AND no archive still errors — no false all-clear', () => {
    // A bare temp dir with a .planning/ that has NO phases subdir and no
    // milestones archive — built from createTempDir rather than by deleting
    // createTempProject's phases dir, so nothing is torn down mid-test.
    const bare = createTempDir();
    try {
      fs.mkdirSync(path.join(bare, '.planning'), { recursive: true });

      const result = runGsdTools('audit-uat --raw', bare);
      assert.strictEqual(result.success, false, 'expected a failure when no phases exist at all');
    } finally {
      cleanup(bare);
    }
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
