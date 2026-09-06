/**
 * #3783 — `query audit-uat`'s summary must self-segment current-milestone
 * debt from archived-milestone debt instead of conflating both into
 * `total_items`/`by_phase`/`by_category`.
 *
 * The scan already stamps each archived result with `archived_milestone`
 * (`src/uat.cts` `UatFileResult.archived_milestone`, set from
 * `getAllArchivedPhaseDirs`'s per-version label) but previously discarded
 * that distinction when building `summary`. This adds two additive fields —
 * `summary.current_milestone: {files, items}` and
 * `summary.archived: {files, items, by_milestone}` — so a consumer reads one
 * field instead of re-deriving the `archived_milestone` filter itself (the
 * duplication class behind #3782, which fixed `progress.md`'s render-side
 * conflation independently and is not touched here).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

function uatBody(items) {
  let body = `${FRONTMATTER}## Tests\n\n`;
  items.forEach(({ name, result }, i) => {
    body += `### ${i + 1}. ${name}\nresult: ${result}\n\n`;
  });
  return body;
}

function writeActivePhaseUat(tmpDir, phaseSlug, fileName, items) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, fileName), uatBody(items));
}

function writeArchivedPhaseUat(tmpDir, version, phaseSlug, fileName, items) {
  const phaseDir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, fileName), uatBody(items));
}

function writeArchivedDeferred(tmpDir, version, phaseSlug, text) {
  const phaseDir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'deferred-items.md'),
    `## Deferred Items\n\n- ${text}\n`,
  );
}

function writeActiveDeferred(tmpDir, phaseSlug, text) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'deferred-items.md'),
    `## Deferred Items\n\n- ${text}\n`,
  );
}

function runAudit(tmpDir) {
  const result = runGsdTools('audit-uat --raw', tmpDir);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#3783: audit-uat summary self-segments current-milestone vs archived debt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('current-milestone-only results segment entirely into current_milestone', () => {
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
      { name: 'Beta', result: 'pass' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 1 },
      describeAll(),
    );
    assert.deepStrictEqual(
      output.summary.archived,
      { files: 0, items: 0, by_milestone: {} },
      describeAll(),
    );
    // Legacy fields untouched by the new segmentation.
    assert.strictEqual(output.summary.total_items, 1, describeAll());
    assert.strictEqual(output.summary.total_files, 1, describeAll());
  });

  test('archived-only results segment entirely into archived, keyed by version', () => {
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
      { name: 'Beta', result: 'blocked' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 0, items: 0 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 2, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 2 },
      describeAll(),
    );
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('mixed active + multiple archived milestones segments per version', () => {
    writeActivePhaseUat(tmpDir, '02-current', '02-UAT.md', [
      { name: 'Active Item', result: 'pending' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-foundation', '01-UAT.md', [
      { name: 'Old A', result: 'pending' },
      { name: 'Old B', result: 'blocked' },
      { name: 'Old C', result: 'skipped' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.2.0', '01-followup', '01-UAT.md', [
      { name: 'Newer A', result: 'pending' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 1 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 2, describeAll());
    assert.strictEqual(output.summary.archived.items, 4, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 3, 'v0.2.0': 1 },
      describeAll(),
    );
    // Cross-population legacy total is the sum of both buckets (unchanged shape).
    assert.strictEqual(
      output.summary.total_items,
      output.summary.current_milestone.items + output.summary.archived.items,
      describeAll(),
    );
  });

  test('a zero-item result still counts toward .files but not .items, in the correct bucket', () => {
    // A phase whose only test row has no `result:` line at all is a parse
    // gap: zero items, but the file WAS scanned. See UatFileResult.parse_gap.
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', []);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-UAT.md'),
      `${FRONTMATTER}## Tests\n\n### 1. Unparseable\n`,
    );
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-old', '01-UAT.md', []);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v0.1.0-phases', '01-old', '01-UAT.md'),
      `${FRONTMATTER}## Tests\n\n### 1. Unparseable Old\n`,
    );

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 0 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 0, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 0 },
      describeAll(),
    );
  });

  test('legacy summary fields stay unchanged (additive-only)', () => {
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-old', '01-UAT.md', [
      { name: 'Old', result: 'blocked' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.strictEqual(output.summary.total_files, 2, describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
    assert.strictEqual(output.summary.parse_gap_files, 0, describeAll());
    assert.deepStrictEqual(output.summary.by_category, { pending: 1, blocked: 1 }, describeAll());
    assert.ok(Object.prototype.hasOwnProperty.call(output.summary.by_phase, '01'), describeAll());
  });

  test('deferred-type results segment by archived_milestone the same as uat/verification', () => {
    writeActiveDeferred(tmpDir, '01-foundation', 'Some deferred follow-up.');
    writeArchivedDeferred(tmpDir, 'v0.1.0', '01-old', 'An old deferred item.');

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.strictEqual(output.summary.current_milestone.files, 1, describeAll());
    assert.strictEqual(output.summary.current_milestone.items, 1, describeAll());
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 1, describeAll());
    assert.deepStrictEqual(output.summary.archived.by_milestone, { 'v0.1.0': 1 }, describeAll());
  });

  test('an empty scan yields zeroed current_milestone and archived buckets', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 0, items: 0 },
      describeAll(),
    );
    assert.deepStrictEqual(
      output.summary.archived,
      { files: 0, items: 0, by_milestone: {} },
      describeAll(),
    );
  });
});
