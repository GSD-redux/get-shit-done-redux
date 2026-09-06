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
  TEMPLATE_RE,
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
    assert.match(failures[0], /not the canonical/);
  });

  test('fail-first: the separator is not part of the pattern — an em-dash task line is still checked', () => {
    // The guard's first form keyed both its patterns on a literal ASCII `-`
    // between the label and the hash, so an em-dash row matched NEITHER and was
    // invisible: zero findings while the production parser silently dropped
    // that commit. The parser does not read the separator, so neither does this.
    const drifted = [
      '# Phase Summary', '',
      '## Task Commits', '',
      '1. **Task 1: fine** - `abc123f` (feat)',
      '2. **Task 2: drifted** — def4567',
      '', '## Files Created/Modified', '',
    ].join('\n');
    const root = fixture({ 'summary.md': drifted });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not the canonical/);
    assert.match(failures[0], /Task 2/);
  });

  test('fail-first: a code span inside the LABEL is not the hash — the anchor is positional', () => {
    // Presence alone is not the property. ``**Task 2: fix `parser`** - def4567``
    // carries a backticked token, but it sits in the label and the parser still
    // extracts no hash from the row. A presence-only test passed this.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: fix `parser`** - def4567',
        '', '## Next', '',
      ].join('\n'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not the canonical/);
  });

  test('fail-first: a code span AFTER an unbackticked hash does not satisfy the anchor either', () => {
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: fix parser** - def4567 (see `parser.cjs`)',
        '', '## Next', '',
      ].join('\n'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not the canonical/);
  });

  test('no false fire: prose opening `N. **Task N:` without closing the bold is not a task row', () => {
    // A guard that false-fires gets deleted. The closing `**` is what separates
    // a recorded task row from a sentence that merely quotes the prefix.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: is the prefix to recognize, not a complete recorded task.',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.deepEqual(findSummaryTaskCommitsDrift(root), []);
  });

  test('any punctuation may separate the label from the hash — dash, em dash, colon', () => {
    for (const sep of ['-', '—', '–', ':']) {
      const root = fixture({
        'summary.md': [
          '# S', '', '## Task Commits', '',
          `1. **Task 1: ok** ${sep} \`abc123f\` (feat)`,
          '', '## Next', '',
        ].join('\n'),
      });
      assert.deepEqual(findSummaryTaskCommitsDrift(root), [], `separator ${sep} should be accepted`);
    }
  });

  test('fail-first: a later bold phrase does not satisfy the hash position', () => {
    // ``**Task 2: fix parser** - def4567 (**see** `parser.cjs`)`` — a
    // presence-or-position test anchored on "a closing ** followed by a
    // backtick" matches the `**` of `see`, not the label's. Both production
    // fences omit def4567 here; the guard must not call it clean.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: fix parser** - def4567 (**see** `parser.cjs`)',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.equal(findSummaryTaskCommitsDrift(root).length, 1);
  });

  test('fail-first: a backticked token carrying two hashes is not a hash', () => {
    // `` `def4567, aaa1111` `` satisfies any naive backtick test, while the
    // parser's `[0-9a-f]{7,40}` match rejects the whole token and records
    // NEITHER commit.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: test and implement** - `def4567, aaa1111`',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.equal(findSummaryTaskCommitsDrift(root).length, 1);
  });

  test('every `## Task Commits` section is checked — the production awk reopens on a later heading', () => {
    // `sliceSection` read only the first section while the shipped awk sets
    // `inside=1` again on any later matching heading, so drift in a second
    // section — including one inside a fenced example — went unchecked while
    // the parser consumed it.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '', '## Other', '', '## Task Commits', '',
        '9. **Task 9: drifted** - def4567',
        '', '## Next', '',
      ].join('\n'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Task 9/);
  });

  test('a title may contain code spans and asterisks — the label is prose, not a constrained field', () => {
    // Both were excluded once, in opposite failure directions: banning backticks
    // false-fired on ``**Task 2: fix `parser`** - `def4567` `` (which the parser
    // reads fine), and banning asterisks made `migrate src/*.js` fail DETECTION,
    // so a genuinely missing hash on that row was never reported.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: fix `parser`** - `abc123f` (feat)',
        '2. **Task 2: migrate src/*.js** - `def4567`',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.deepEqual(findSummaryTaskCommitsDrift(root), []);
  });

  test('fail-first: an asterisk in the title does not exempt the row from the hash check', () => {
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: migrate src/*.js** - def4567 (**see** `parser.cjs`)',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.equal(findSummaryTaskCommitsDrift(root).length, 1);
  });

  test('fail-first: a token carrying a separator is not a hash slot', () => {
    // `` `B, C` `` and `` `B;C` `` satisfy any "there is a backticked thing here"
    // test; the parser's hex match rejects the whole token and records neither.
    for (const token of ['def4567, aaa1111', 'def4567;aaa1111']) {
      const root = fixture({
        'summary.md': [
          '# S', '', '## Task Commits', '',
          '1. **Task 1: ok** - `abc123f` (feat)',
          `2. **Task 2: two commits** - \`${token}\``,
          '', '## Next', '',
        ].join('\n'),
      });
      assert.equal(findSummaryTaskCommitsDrift(root).length, 1, `token ${token} should be a finding`);
    }
  });

  test('consecutive `## Task Commits` sections: the first is terminated by the second', () => {
    // A `## Task Commits` line is itself a `## ` line. Opening a new section
    // without closing the previous one reported the first as running to EOF —
    // a finding on a file both production fences read correctly.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: a** - `abc123f`',
        '', '## Task Commits', '',
        '2. **Task 2: b** - `def4567`',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.deepEqual(findSummaryTaskCommitsDrift(root), []);
  });

  test('a bare carriage return before the EOL is normalised, as the awk heading class accepts it', () => {
    const root = fixture({
      'summary.md': ['# S', '', '## Task Commits\r ', '', '1. **Task 1: a** - `abc123f`', '', '## Next', ''].join('\n'),
    });
    assert.deepEqual(findSummaryTaskCommitsDrift(root), []);
  });

  test('fail-first: the label cannot backtrack through a LATER bold phrase', () => {
    // A non-greedy `.*?` label BACKTRACKS: when the suffix fails at the first
    // `**`, the engine extends the label through a later bold phrase and tries
    // again, so ``- def4567 (**see** - `parser`)`` matched with `see` supplying
    // the closing `**` and read clean while both parsers omitted def4567. The
    // tempered form cannot cross a `**` at all.
    const root = fixture({
      'summary.md': [
        '# S', '', '## Task Commits', '',
        '1. **Task 1: ok** - `abc123f` (feat)',
        '2. **Task 2: migrate parser** - def4567 (**see** - `parser`)',
        '', '## Next', '',
      ].join('\n'),
    });
    assert.equal(findSummaryTaskCommitsDrift(root).length, 1);
  });

  test('the heading class mirrors the awk exactly — a CR mid-heading is not a heading', () => {
    // Normalising `\r` away before matching made `## Task\r Commits` a heading
    // here that neither production fence recognises, so the guard reported clean
    // over a section the parser never opens. Driven: the awk extracts 0 hashes
    // from this file and 1 from the `## Task Commits\r ` variant above.
    const root = fixture({
      'summary.md': '# S\n\n## Task\r Commits\n\n1. **Task 1: a** - `abc123f`\n\n## Next\n',
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /no '## Task Commits' heading/);
  });

  test('fail-first: a carriage return INSIDE the title does not exempt the row', () => {
    // `.` excludes `\r`, so a CR in the title made DETECTION skip the whole row
    // and its missing hash went unreported — the same silent-miss direction the
    // asterisk exclusion had. Cross-checked: the awk extracts only the first
    // row's hash from this file, so flagging the second is correct.
    const root = fixture({
      'summary.md': '# S\n\n## Task Commits\n\n1. **Task 1: a** - `abc123f`\n2. **Task 2: fix\r parser** - def4567\n\n## Next\n',
    });
    assert.equal(findSummaryTaskCommitsDrift(root).length, 1);
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
    assert.match(failures[0], /carries a canonical task line/);
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

  test('the template pattern covers EVERY `summary-*.md`, not just alphanumeric suffixes', () => {
    // `/^summary(-[A-Za-z0-9]+)*\.md$/` silently excluded ordinary filenames —
    // `summary-new_v2.md`, `summary-a.b.md` — so the "a fifth template is
    // covered automatically" property was only true for suffixes that happened
    // to be alphanumeric. Raised by the #3926 pre-push body audit.
    for (const name of ['summary.md', 'summary-minimal.md', 'summary-new_v2.md', 'summary-a.b.md']) {
      assert.ok(TEMPLATE_RE.test(name), `${name} should be enumerated`);
    }
    for (const name of ['not-summary.md', 'summary.txt', 'summaryx.md']) {
      assert.ok(!TEMPLATE_RE.test(name), `${name} should NOT be enumerated`);
    }
    // …and the widened pattern still finds a drifted one on disk.
    const root = fixture({
      'summary.md': CLEAN_TEMPLATE,
      'summary-new_v2.md': CLEAN_TEMPLATE.replace('- `abc123f` (feat)', '- abc123f (feat)'),
    });
    const failures = findSummaryTaskCommitsDrift(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /summary-new_v2\.md/);
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
