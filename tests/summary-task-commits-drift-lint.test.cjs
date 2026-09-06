'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * SUMMARY task-commits drift lint (#3926).
 *
 * `gsd-core/workflows/code-review.md` derives a phase's commit set by slicing
 * each `*-SUMMARY.md` between `## Task Commits` and the next `## ` heading and
 * matching BACKTICK-delimited hex inside that slice. That parser replaced a
 * commit-message grep — the class that failed and was re-fixed five times
 * (#2989/#3191/#3503/#3995) — so its coupling to the template's line shape is
 * load-bearing, and `scripts/lint-summary-task-commits-drift.cjs` is what makes
 * the coupling explicit.
 *
 * These tests exercise the guard's pure driver against fixture trees
 * (fail-first, one fixture per pinned property) and confirm the live repo
 * passes. Fail-first is the point: a guard nobody has watched fire is a guard
 * that may not.
 *
 * The enumeration is also covered, because it is the guard's own domain: the
 * template set is read from `gsd-core/templates/` rather than hardcoded, so a
 * template added later is covered without editing the lint, and an enumeration
 * that matches nothing throws instead of reporting `ok` over an unguarded set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  findSummaryTaskCommitsDrift,
  listTemplates,
  TEMPLATE_DIR,
} = require(path.join(ROOT, 'scripts', 'lint-summary-task-commits-drift.cjs'));

/** A template body that satisfies both pinned properties. */
const CLEAN_TEMPLATE = [
  '# Phase Summary',
  '',
  '## Task Commits',
  '',
  '1. **Task 1: do the work** - `abc123f` (feat)',
  '2. **Task 2: do more work** - `def4567`',
  '',
  '## Files Created/Modified',
  '',
  '- src/thing.cts',
  '',
].join('\n');

/** Build a fixture tree carrying `templates` as `{ name: body }`. */
function fixture(templates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-summary-drift-'));
  fs.mkdirSync(path.join(root, TEMPLATE_DIR), { recursive: true });
  for (const [name, body] of Object.entries(templates)) {
    fs.writeFileSync(path.join(root, TEMPLATE_DIR, name), body);
  }
  return root;
}

describe('#3926 — SUMMARY task-commits drift lint', () => {
  test('a conforming template produces no findings', () => {
    const root = fixture({ 'summary.md': CLEAN_TEMPLATE });
    assert.deepEqual(findSummaryTaskCommitsDrift(root), []);
  });

  test('fail-first: a task line that drops the backtick delimiter is a finding', () => {
    // The exact drift the parser cannot survive — it matches `\`hex\``, so an
    // unbackticked hash is invisible to it and the phase scope silently empties.
    const drifted = CLEAN_TEMPLATE.replace(
      '1. **Task 1: do the work** - `abc123f` (feat)',
      '1. **Task 1: do the work** - abc123f (feat)',
    );
    const root = fixture({ 'summary.md': drifted });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /drops the backtick delimiter/);
  });

  test('fail-first: a missing `## Task Commits` heading is a finding', () => {
    const root = fixture({
      'summary.md': CLEAN_TEMPLATE.replace('## Task Commits', '## Commits'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /no '## Task Commits' heading/);
  });

  test('fail-first: an unterminated section is a finding — the parser slices to the next `## `', () => {
    const root = fixture({
      'summary.md': ['# Phase Summary', '', '## Task Commits', '', '1. **Task 1: x** - `abc123f`', ''].join('\n'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /is the last '## ' section/);
  });

  test('fail-first: a section with no backticked task line at all is a finding', () => {
    const root = fixture({
      'summary.md': ['# S', '', '## Task Commits', '', '_None recorded._', '', '## Next', ''].join('\n'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /carries no backtick-delimited task line/);
  });

  test('the template set is read from disk, so a NEW template is covered without editing the lint', () => {
    // The census property: the guard's enumeration must be the directory's set,
    // not a list fixed when the guard was written. A drifted template that did
    // not exist at author time must still be caught.
    const root = fixture({
      'summary.md': CLEAN_TEMPLATE,
      'summary-brand-new.md': CLEAN_TEMPLATE.replace('- `abc123f` (feat)', '- abc123f (feat)'),
    });
    assert.deepEqual(
      listTemplates(root),
      [`${TEMPLATE_DIR}/summary-brand-new.md`, `${TEMPLATE_DIR}/summary.md`],
    );
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /summary-brand-new\.md/);
  });

  test('an enumeration that matches nothing THROWS — it never reports a clean set', () => {
    // A guard that checks zero files reports `ok` over an unguarded domain,
    // which is the silent-false-clean shape this whole lint exists to refuse.
    const root = fixture({ 'not-a-summary.md': CLEAN_TEMPLATE });
    assert.throws(() => listTemplates(root), /would check nothing/);
  });

  test('the live repo passes its own guard', () => {
    assert.deepEqual(findSummaryTaskCommitsDrift(ROOT), []);
    assert.ok(listTemplates(ROOT).length >= 4);
  });

  test('the guard is reachable from `lint:ci`, so it actually runs in CI', () => {
    // It shipped wired only into the `lint:table-schema-drift` npm alias, which
    // `lint:ci` does not call — it invokes the sibling's .cjs directly — so the
    // guard never ran in CI. A guard that does not run is indistinguishable
    // from one that passes, and nothing here caught that; this is the tooth.
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );
    // `lint:ci` reaches other scripts via `npm run <name>`, so resolve the
    // chain transitively — a direct-substring check on `lint:ci` alone would
    // report the guard unreachable for every legitimately-aliased sibling.
    const seen = new Set();
    let chain = '';
    (function expand(name, depth) {
      if (depth > 8 || !scripts[name] || seen.has(name)) return;
      seen.add(name);
      chain += ` ${scripts[name]}`;
      for (const m of scripts[name].matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        expand(m[1], depth + 1);
      }
    }('lint:ci', 0));
    assert.ok(
      chain.includes('scripts/lint-summary-task-commits-drift.cjs'),
      'lint:ci must invoke scripts/lint-summary-task-commits-drift.cjs — '
        + 'the #3926 phase-scope parser depends on the template shape this guard pins',
    );
  });
});
