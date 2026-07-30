'use strict';

/**
 * Documentation parity for the declared reviewer roster (#2800; closes #2781, #2272).
 *
 * `checkReviewerDocsParity` answers a different question than its sibling
 * `checkReviewerLaneParity`: not "what runs" but "what is documented". #2781 was a real
 * regression this gate exists to prevent — `--kimi-code` landed in `docs/COMMANDS.md` and never
 * reached its four locale mirrors. Every synthetic-divergence row below feeds a targeted defect
 * to the pure checker and asserts the specific typed violation, per CONTRIBUTING.md "Tests assert
 * on typed structured values" — never on rendered prose.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const {
  REVIEWER_LANES,
  DOCS_PARITY_VIOLATION,
  checkReviewerDocsParity,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');

const ROOT = path.join(__dirname, '..');

/** Every declared flag, in descriptor order (13 across 12 lanes — antigravity carries two). */
const ALL_FLAGS = REVIEWER_LANES.flatMap((l) => l.flags);
/** Every declared reviewsSection title. */
const ALL_TITLES = REVIEWER_LANES.map((l) => l.reviewsSection);

/** Backtick every flag — the `COMMANDS.md` table-cell shape. */
function backtickAll(flags) {
  return flags.map((f) => `\`${f}\``).join(' ');
}

/** Bracket every flag — the `FEATURES.md` signature-line shape. */
function bracketAll(flags) {
  return flags.map((f) => `[${f}]`).join(' ');
}

/** A COMMANDS.md-shaped fixture: table cell listing flags, no signature line. */
function commandsDoc(flags) {
  return [
    '### `/gsd-review`',
    '',
    `Reviewer flags: ${backtickAll(flags)}`,
    '',
  ].join('\n');
}

/** A FEATURES.md-shaped fixture: signature line + Purpose line naming every title. */
function featuresDoc({ sigFlags = ALL_FLAGS, titles = ALL_TITLES, blanksBetween = 1 } = {}) {
  const lines = [
    `**Command:** \`/gsd-review --phase N ${bracketAll(sigFlags)} [--all]\``,
  ];
  for (let i = 0; i < blanksBetween; i += 1) lines.push('');
  lines.push(`**Purpose:** Invoke ${titles.join(', ')} to independently review phase plans.`);
  return lines.join('\n');
}

describe('reviewer docs parity — flag arm', () => {
  test('a doc listing every declared flag is clean', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(ALL_FLAGS) } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.violations, []);
  });

  test('the shipped locale drift is detected', () => {
    const missing = ALL_FLAGS.filter((f) => f !== '--kimi-code');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(missing) } });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'd', subject: '--kimi-code' }],
    );
  });

  test('every missing flag is named, not just the first', () => {
    const missing = ALL_FLAGS.filter((f) => f !== '--gemini' && f !== '--qwen');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(missing) } });
    assert.strictEqual(r.violations.length, 2);
    const subjects = r.violations.map((v) => v.subject).sort();
    assert.deepStrictEqual(subjects, ['--gemini', '--qwen']);
    for (const v of r.violations) {
      assert.strictEqual(v.reason, DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING);
    }
  });

  test('a section with no flags at all reports every lane', () => {
    const doc = ['### `/gsd-review`', '', 'Some prose with no flags.', ''].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.strictEqual(r.violations.length, ALL_FLAGS.length);
    assert.ok(r.violations.every((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING));
  });

  test('boundary: one flag short of the full roster', () => {
    const missing = ALL_FLAGS.slice(0, ALL_FLAGS.length - 1);
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(missing) } });
    assert.strictEqual(r.violations.length, 1);
  });

  test('a dual-flag lane requires both tokens present', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(ALL_FLAGS) } });
    assert.strictEqual(r.ok, true);
  });

  test('a dual-flag lane missing one alias is caught', () => {
    const missing = ALL_FLAGS.filter((f) => f !== '--agy');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: commandsDoc(missing) } });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'd', subject: '--agy' }],
    );
  });

  test('bracketed flags satisfy the gate too', () => {
    const rest = ALL_FLAGS.filter((f) => f !== '--gemini');
    const doc = [
      '### `/gsd-review`',
      '',
      `Reviewer flags: [--gemini] ${backtickAll(rest)}`,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.strictEqual(r.ok, true);
  });
});

describe('reviewer docs parity — signature arm', () => {
  test('a signature line is held to the full roster', () => {
    const doc = [
      backtickAll(ALL_FLAGS),
      '',
      '**Command:** `/gsd-review --phase N [--gemini] [--all]`',
      '',
      `**Purpose:** ${ALL_TITLES.join(', ')}.`,
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const omitted = ALL_FLAGS.filter((f) => f !== '--gemini');
    assert.strictEqual(r.violations.length, omitted.length);
    assert.ok(r.violations.every((v) => v.reason === DOCS_PARITY_VIOLATION.SIGNATURE_FLAG_MISSING));
    assert.deepStrictEqual(
      r.violations.map((v) => v.subject).sort(),
      [...omitted].sort(),
    );
    assert.ok(
      !r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING),
      'body already backticks every flag, so no DOC_FLAG_MISSING should fire',
    );
  });

  test('an undeclared bracketed flag on the signature is reported', () => {
    const doc = [
      backtickAll(ALL_FLAGS),
      '',
      `**Command:** \`/gsd-review --phase N ${bracketAll(ALL_FLAGS)} [--acme] [--all]\``,
      '',
      `**Purpose:** ${ALL_TITLES.join(', ')}.`,
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_UNDECLARED, doc: 'd', subject: '--acme' }],
    );
  });

  test('the --all control flag is inert on the signature', () => {
    const doc = [
      backtickAll(ALL_FLAGS),
      '',
      `**Command:** \`/gsd-review --phase N ${bracketAll(ALL_FLAGS)} [--all]\``,
      '',
      `**Purpose:** ${ALL_TITLES.join(', ')}.`,
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(
      !r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_FLAG_UNDECLARED && v.subject === '--all'),
    );
  });

  test('a doc with no signature line skips the signature arm', () => {
    const doc = [
      '| Command | Description |',
      '| --- | --- |',
      `| /gsd-review | ${backtickAll(ALL_FLAGS)} |`,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.SIGNATURE_FLAG_MISSING));
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING));
    assert.strictEqual(r.ok, true, 'flag arm alone should be satisfied by the table cell');
  });
});

describe('reviewer docs parity — title arm', () => {
  test('a Purpose line naming every title is clean', () => {
    const doc = featuresDoc();
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING));
  });

  test('the purpose-line drift is detected', () => {
    const titles = ALL_TITLES.filter((t) => t !== 'Kimi Code');
    const doc = featuresDoc({ titles });
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const titleViolations = r.violations.filter((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING);
    assert.deepStrictEqual(titleViolations, [
      { reason: DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING, doc: 'd', subject: 'Kimi Code' },
    ]);
  });

  test('titles are matched literally, not as a regex', () => {
    // Proves the `.` in `llama.cpp` is escaped: `llamaXcpp` must NOT satisfy it.
    const titles = ALL_TITLES.map((t) => (t === 'llama.cpp' ? 'llamaXcpp' : t));
    const doc = featuresDoc({ titles });
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const titleViolations = r.violations.filter((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING);
    assert.deepStrictEqual(titleViolations, [
      { reason: DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING, doc: 'd', subject: 'llama.cpp' },
    ]);
  });

  test('blank lines between signature and purpose are skipped', () => {
    const doc = featuresDoc({ blanksBetween: 3 });
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING));
  });

  test('a signature as the last line skips the title arm only', () => {
    const doc = [
      backtickAll(ALL_FLAGS),
      '',
      `**Command:** \`/gsd-review --phase N ${bracketAll(ALL_FLAGS)} [--all]\``,
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING));
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.SIGNATURE_FLAG_MISSING));
  });
});

describe('reviewer docs parity — table row arm', () => {
  test('deletingALaneTableRowIsCaughtEvenWhenAForwardingRowListsEveryFlag', () => {
    // Regression fixture for #2781: `docs/COMMANDS.md` and its locale mirrors carry a forwarding
    // row that lists every flag in its THIRD cell, satisfying the file-wide flag arm on its own.
    // The actual per-lane table row is what documents a lane, and deleting it — here `--kimi-code`
    // — is exactly the regression this arm exists to catch.
    const laneRows = REVIEWER_LANES.filter((l) => l.slug !== 'kimi-code').map(
      (l) => `| ${l.flags.map((f) => `\`${f}\``).join(' / ')} | ${l.reviewsSection} review |`,
    );
    const doc = [
      '### `/gsd-review`',
      '',
      '| Flag | Description | Notes |',
      '| --- | --- | --- |',
      `| Reviewer flags | No | ${backtickAll(ALL_FLAGS)} |`,
      ...laneRows,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const tableRowViolations = r.violations.filter(
      (v) => v.reason === DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING,
    );
    assert.deepStrictEqual(tableRowViolations, [
      { reason: DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING, doc: 'd', subject: '--kimi-code' },
    ]);
  });

  test('aDualFlagLaneRowSatisfiesBothItsFlags', () => {
    // A single row can declare TWO flags in its first cell — `--agy` / `--antigravity` — and must
    // satisfy both without a second, separate row.
    const laneRows = REVIEWER_LANES.map(
      (l) => `| ${l.flags.map((f) => `\`${f}\``).join(' / ')} | ${l.reviewsSection} review |`,
    );
    const doc = [
      '### `/gsd-review`',
      '',
      '| Flag | Description |',
      '| --- | --- |',
      ...laneRows,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.ok(
      !r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING),
      'a two-flag first cell must satisfy both flags, including antigravity/agy',
    );
  });

  test('aForwardingRowAloneDoesNotSatisfyTheTableArm', () => {
    const doc = [
      '### `/gsd-review`',
      '',
      '| Flag | Description | Notes |',
      '| --- | --- | --- |',
      `| Reviewer flags | No | ${backtickAll(ALL_FLAGS)} |`,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    // The forwarding row's flags sit in cell 3, never cell 1, so the doc has NO per-lane table at
    // all (rowFlags.size === 0) and arm 4 must not fire. Pinned as zero violations of this reason
    // rather than "no violations at all": if the guard were dropped and the arm fired
    // unconditionally, every one of the 13 declared flags would report TABLE_ROW_MISSING (none of
    // them sit in a first cell here), so this assertion would immediately fail.
    const tableRowViolations = r.violations.filter(
      (v) => v.reason === DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING,
    );
    assert.deepStrictEqual(tableRowViolations, []);
  });

  test('aFeaturesShapedDocIsUnaffectedByTheTableArm', () => {
    const doc = featuresDoc();
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING));
  });
});

describe('reviewer docs parity — combination', () => {
  test('a clean doc does not mask a dirty one', () => {
    const clean = commandsDoc(ALL_FLAGS);
    const dirty = commandsDoc(ALL_FLAGS.filter((f) => f !== '--codex'));
    const r = checkReviewerDocsParity({
      descriptor: REVIEWER_LANES,
      docs: { 'docs/COMMANDS.md': clean, 'docs/ja-JP/COMMANDS.md': dirty },
    });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'docs/ja-JP/COMMANDS.md', subject: '--codex' }],
    );
  });

  test('flag and title violations coexist', () => {
    const titles = ALL_TITLES.filter((t) => t !== 'Qwen');
    const doc = featuresDoc({ sigFlags: ALL_FLAGS.filter((f) => f !== '--qwen'), titles });
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const reasons = r.violations.map((v) => v.reason);
    assert.ok(reasons.includes(DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING));
    assert.ok(reasons.includes(DOCS_PARITY_VIOLATION.DOC_TITLE_MISSING));
  });

  test('an absent section skips without disabling others', () => {
    const noSection = ['# Some other doc', '', 'Nothing about reviewers here.', ''].join('\n');
    const clean = commandsDoc(ALL_FLAGS);
    const dirty = commandsDoc(ALL_FLAGS.filter((f) => f !== '--cursor'));
    const r = checkReviewerDocsParity({
      descriptor: REVIEWER_LANES,
      docs: { skip: noSection, clean, dirty },
    });
    assert.deepStrictEqual(r.skipped, ['skip']);
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'dirty', subject: '--cursor' }],
    );
  });
});

describe('reviewer docs parity — not-corruption (must NOT fire)', () => {
  test('a flag outside the section does not satisfy the gate', () => {
    const rest = ALL_FLAGS.filter((f) => f !== '--codex');
    const doc = [
      '### `/gsd-review`',
      '',
      `Reviewer flags: ${backtickAll(rest)}`,
      '',
      '```bash',
      '/gsd-plan-review-convergence 3 --codex',
      '```',
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'd', subject: '--codex' }],
    );
  });

  test('token matching is bounded', () => {
    const rest = ALL_FLAGS.filter((f) => f !== '--claude');
    const doc = commandsDoc(rest) + '\n`--claude-foo`\n';
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.deepStrictEqual(
      r.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'd', subject: '--claude' }],
    );
  });

  test('translated descriptions do not fail', () => {
    const doc = [
      '### `/gsd-review`',
      '',
      `Invoca CLIs de IA externas: ${backtickAll(ALL_FLAGS)}`,
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    assert.strictEqual(r.ok, true);
  });
});

describe('reviewer docs parity — HTML comment stripping (CodeQL js/incomplete-multi-character-sanitization)', () => {
  // stripNonProse's single-line-comment branch used to run `working.replace(/<!--[\s\S]*?-->/g,
  // '')` exactly ONCE per line. A single `.replace(/g, '')` pass only removes matches found in the
  // ORIGINAL string; it never rescans the text IT JUST PRODUCED. So when removing one self-
  // contained `<!--...-->` span joins the fragments on either side of it into a brand-new,
  // complete `<!--...-->` span, that new span survives the pass verbatim — including whatever
  // reviewer-flag row is wrapped inside it — and the row is (wrongly) counted as documented. This
  // is the classic "<scr<script>ipt>" class of defect (CodeQL js/incomplete-multi-character-
  // sanitization) applied to HTML comments instead of script tags. The fix iterates the same
  // regex to a fixed point, then treats anything still starting with a bare `<!--` as an
  // unterminated opener carried forward via `inComment`.
  const NON_KIMI_ROWS = ALL_FLAGS.filter((f) => f !== '--kimi-code').map((f) => `| \`${f}\` | d |`);

  test('aNestedCommentCannotSmuggleAFlagPastTheStrip', () => {
    // `<!-` + `<!--DUMMY-->` + `-| `--kimi-code`  | d  |-->`: one pass strips the self-contained
    // `<!--DUMMY-->` in the middle, which joins the leftover `<!-` and `-` into a brand-new
    // `<!--` opener immediately followed by the kimi-code row and a real `-->` closer. A
    // single-pass strip leaves that whole new span — row included — untouched in the output, so
    // the row reads as documented. Regressed exactly here: verified against the pre-fix
    // single-pass implementation, only `TABLE_ROW_MISSING` fired and `DOC_FLAG_MISSING` did not.
    const joinLine = '<!-<!--DUMMY-->-| `--kimi-code` | d |-->';
    const doc = ['### `/gsd-review`', '', ...NON_KIMI_ROWS, '', joinLine, ''].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const kimi = r.violations.filter((v) => v.subject === '--kimi-code');
    assert.ok(
      kimi.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING)
        || kimi.some((v) => v.reason === DOCS_PARITY_VIOLATION.TABLE_ROW_MISSING),
      '--kimi-code must still be reported missing once the join-trick comment is fully stripped',
    );
  });

  test('anUnterminatedCommentOpenerSwallowsTheRestOfTheDocument', () => {
    const doc = [
      '### `/gsd-review`',
      '',
      ...NON_KIMI_ROWS,
      '',
      '<!-- open, never closed',
      '| `--kimi-code` | d |',
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const kimi = r.violations.filter((v) => v.subject === '--kimi-code');
    assert.ok(kimi.length > 0, '--kimi-code sits inside an open comment and must be reported missing');
  });

  test('aCommentClosedOnALaterLineResumesCorrectly', () => {
    // Pins that the fix does not over-strip: prose AFTER a comment's real close is real prose
    // again, not swallowed along with the comment.
    const doc = [
      '### `/gsd-review`',
      '',
      ...NON_KIMI_ROWS,
      '',
      '<!-- opening',
      'hidden line',
      '-->',
      '| `--kimi-code` | d |',
      '',
    ].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const kimi = r.violations.filter((v) => v.subject === '--kimi-code');
    assert.deepStrictEqual(kimi, [], 'content after a real comment close must not be treated as commented out');
  });

  test('multipleIndependentCommentsOnOneLineAreAllStripped', () => {
    const line = 'A <!-- first --> B <!-- | `--kimi-code` | d | -->';
    const doc = ['### `/gsd-review`', '', ...NON_KIMI_ROWS, '', line, ''].join('\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const kimi = r.violations.filter((v) => v.subject === '--kimi-code');
    assert.ok(kimi.length > 0, 'both independent comment spans on one line must be stripped');
  });
});

describe('reviewer docs parity — hostile and malformed input', () => {
  test('an empty docs map is not a clean bill of health', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: {} });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.violations.length, ALL_FLAGS.length);
    assert.ok(r.violations.every((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING));
  });

  test('an absent docs map degrades to violations', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES });
    assert.strictEqual(r.ok, false);
    assert.ok(Array.isArray(r.violations));
  });

  test('non-string doc values are reported, not silently skipped', () => {
    for (const bad of [null, 0, [], {}, true]) {
      assert.doesNotThrow(() => {
        const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { bad } });
        assert.deepStrictEqual(
          r.violations,
          [{ reason: DOCS_PARITY_VIOLATION.DOC_UNREADABLE, doc: 'bad', subject: typeof bad }],
        );
        assert.ok(!r.skipped.includes('bad'), `expected ${JSON.stringify(bad)} NOT to be silently skipped`);
      });
    }
  });

  test('an empty string doc is skipped, unlike a non-string doc', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { empty: '' } });
    assert.deepStrictEqual(r.skipped, ['empty']);
    assert.ok(!r.violations.some((v) => v.reason === DOCS_PARITY_VIOLATION.DOC_UNREADABLE));

    const nonString = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { bad: null } });
    assert.deepStrictEqual(nonString.skipped, []);
    assert.deepStrictEqual(
      nonString.violations,
      [{ reason: DOCS_PARITY_VIOLATION.DOC_UNREADABLE, doc: 'bad', subject: 'object' }],
    );
  });

  test('a DOC_UNREADABLE violation never masks a real one', () => {
    const missing = ALL_FLAGS.filter((f) => f !== '--kimi-code');
    const r = checkReviewerDocsParity({
      descriptor: REVIEWER_LANES,
      docs: { bad: null, good: commandsDoc(missing) },
    });
    assert.deepStrictEqual(
      r.violations,
      [
        { reason: DOCS_PARITY_VIOLATION.DOC_UNREADABLE, doc: 'bad', subject: 'object' },
        { reason: DOCS_PARITY_VIOLATION.DOC_FLAG_MISSING, doc: 'good', subject: '--kimi-code' },
      ],
    );
  });

  test('a non-array descriptor is reported, not thrown', () => {
    assert.doesNotThrow(() => {
      checkReviewerDocsParity({ descriptor: 'nope', docs: { d: commandsDoc(ALL_FLAGS) } });
    });
  });

  test('a malformed lane is named', () => {
    const r = checkReviewerDocsParity({
      descriptor: [null, 'not-an-object', ...REVIEWER_LANES],
      docs: { d: commandsDoc(ALL_FLAGS) },
    });
    const malformed = r.violations.filter((v) => v.reason === DOCS_PARITY_VIOLATION.MALFORMED_LANE);
    assert.strictEqual(malformed.length, 2);
  });

  test('a prototype-key slug is inert', () => {
    const protoLane = { ...REVIEWER_LANES[0], slug: '__proto__', flags: ['--proto-lane'] };
    assert.doesNotThrow(() => {
      checkReviewerDocsParity({
        descriptor: [...REVIEWER_LANES, protoLane],
        docs: { d: commandsDoc([...ALL_FLAGS, '--proto-lane']) },
      });
    });
    assert.strictEqual(({}).polluted, undefined);
  });
});

describe('reviewer docs parity — cross-platform (CRLF)', () => {
  test('parity is CRLF-insensitive', () => {
    const doc = commandsDoc(ALL_FLAGS);
    const crlf = doc.split('\n').join('\r\n');
    const lf = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: doc } });
    const cr = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: crlf } });
    assert.deepStrictEqual(cr, lf);
  });

  test('a divergence is still caught under CRLF', () => {
    const missing = ALL_FLAGS.filter((f) => f !== '--kimi-code');
    const crlf = commandsDoc(missing).split('\n').join('\r\n');
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { d: crlf } });
    assert.strictEqual(r.violations.length, 1);
    assert.strictEqual(r.violations[0].subject, '--kimi-code');
  });
});

describe('reviewer docs parity — independence and properties', () => {
  const FC = { seed: 20260730, numRuns: 200 };

  test('repeated evaluation is stable', () => {
    const input = { descriptor: REVIEWER_LANES, docs: { d: commandsDoc(ALL_FLAGS) } };
    const a = checkReviewerDocsParity(input);
    const b = checkReviewerDocsParity(input);
    assert.deepStrictEqual(a, b);
  });

  test('verdict is independent of doc key insertion order', () => {
    const dirty = commandsDoc(ALL_FLAGS.filter((f) => f !== '--gemini'));
    const clean = commandsDoc(ALL_FLAGS);
    const forward = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { a: dirty, b: clean } });
    const reversed = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: { b: clean, a: dirty } });
    const sortViolations = (r) =>
      r.violations.map((v) => `${v.reason}:${v.doc}:${v.subject}`).sort();
    assert.deepStrictEqual(sortViolations(forward), sortViolations(reversed));
  });

  test('ok always agrees with violations and the function never throws', () => {
    fc.assert(
      fc.property(
        // Widened from the default (~10 chars) so the generator can occasionally reach
        // pathologically long keys/values, not just short ones — see the dedicated
        // pathological-length case below for the deterministic ~100k-char regression guard.
        fc.dictionary(fc.string({ maxLength: 5000 }), fc.anything()),
        fc.anything(),
        (docs, descriptor) => {
          let r;
          try {
            r = checkReviewerDocsParity({ descriptor, docs });
          } catch {
            return false;
          }
          return (
            typeof r.ok === 'boolean' &&
            Array.isArray(r.violations) &&
            Array.isArray(r.skipped) &&
            r.ok === (r.violations.length === 0)
          );
        },
      ),
      FC,
    );
  });

  // #2800 review finding: the "never throws" property above uses generators that top out
  // around 5,000 chars, so it could never structurally reach the ~100k-char threshold that,
  // until fixed, made the implementation throw `SyntaxError` from `new RegExp` (the fix
  // switched to literal `String.includes`). This case pins that specific regression with a
  // deterministic, explicit pathologically-long descriptor rather than relying on the property
  // generator to stumble into it.
  test('neverThrowsOnPathologicallyLongDeclaredStrings', () => {
    const pathologicalLane = {
      slug: 'pathological',
      flags: ['--' + 'a'.repeat(200000)],
      reviewsSection: 'T'.repeat(200000),
    };
    const doc = '/gsd-review some prose mentioning the command.';
    let result;
    assert.doesNotThrow(() => {
      result = checkReviewerDocsParity({ descriptor: [pathologicalLane], docs: { d: doc } });
    });
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.violations));
    assert.ok(Array.isArray(result.skipped));
  });

  test('the reason enum is locked', () => {
    assert.deepStrictEqual(Object.keys(DOCS_PARITY_VIOLATION).sort(), [
      'DOC_FLAG_MISSING',
      'DOC_FLAG_UNDECLARED',
      'DOC_TITLE_MISSING',
      'DOC_UNREADABLE',
      'MALFORMED_LANE',
      'SIGNATURE_FLAG_MISSING',
      'TABLE_ROW_MISSING',
    ]);
    assert.ok(Object.isFrozen(DOCS_PARITY_VIOLATION));
  });
});

describe('reviewer docs parity — the shipped repo', () => {
  const DOC_PATHS = [
    'docs/COMMANDS.md',
    'docs/ja-JP/COMMANDS.md',
    'docs/ko-KR/COMMANDS.md',
    'docs/pt-BR/COMMANDS.md',
    'docs/zh-CN/COMMANDS.md',
    'docs/FEATURES.md',
    'docs/ja-JP/FEATURES.md',
    'docs/ko-KR/FEATURES.md',
    'docs/pt-BR/FEATURES.md',
    'docs/zh-CN/FEATURES.md',
  ];

  function loadShippedDocs() {
    const docs = {};
    for (const rel of DOC_PATHS) {
      docs[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    }
    return docs;
  }

  test('the shipped descriptor is non-empty', () => {
    // Guards the vacuous-truth failure mode: an empty roster trivially satisfies every check below.
    assert.ok(REVIEWER_LANES.length >= 12, 'expected at least the 12 shipped lanes');
  });

  test('the shipped docs satisfy reviewer lane parity', () => {
    const r = checkReviewerDocsParity({ descriptor: REVIEWER_LANES, docs: loadShippedDocs() });
    assert.deepStrictEqual(
      r.violations,
      [],
      `shipped docs must satisfy reviewer docs parity; got: ${JSON.stringify(r.violations)}`,
    );
    assert.strictEqual(r.ok, true);
    // Bounded, not merely `.includes(...)`: an unbounded skipped set is exactly how a doc
    // silently drops out of coverage — if a real shipped doc lost its `/gsd-review` marker
    // (accidentally or via a bad edit), `checkReviewerDocsParity` would add it to `skipped`
    // instead of gating it, and an `.includes()`-only assertion would still pass green with
    // that doc no longer checked at all. Asserting the exact set closes that gap.
    assert.deepStrictEqual(
      r.skipped.slice().sort(),
      ['docs/pt-BR/FEATURES.md'].sort(),
      'the skipped set must be EXACTLY this one known stub (a 77-line doc with no /gsd-review ' +
        'section) — any other entry means a real doc silently dropped out of coverage',
    );
  });

  test('an unreadable doc fails loudly', (t) => {
    // Exercises the REAL doc-loading path (`loadShippedDocs`, the same helper the integration
    // test above drives) rather than invoking the monkeypatched mock directly — calling the mock
    // proves nothing about the actual reader and would pass regardless of behavior.
    const original = fs.readFileSync;
    t.after(() => {
      fs.readFileSync = original;
    });
    const targetPath = path.join(ROOT, 'docs', 'COMMANDS.md');
    fs.readFileSync = (p, ...rest) => {
      if (p === targetPath) throw new Error('injected read failure');
      return original(p, ...rest);
    };
    assert.throws(() => {
      loadShippedDocs();
    }, /injected read failure/);
  });
});

describe('review-lane flags — emitted shape', () => {
  const cp = require('node:child_process');
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  const runFlags = (args = []) =>
    cp.spawnSync(process.execPath, [TOOLS, 'review-lane', 'flags', ...args], { encoding: 'utf8' });

  test('emitsEveryDeclaredFlagInDescriptorOrder', () => {
    const r = runFlags();
    assert.strictEqual(r.status, 0);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.deepStrictEqual(lines, REVIEWER_LANES.flatMap((l) => l.flags));
  });

  test('everyEmittedTokenIsAWellFormedFlag', () => {
    const r = runFlags();
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'expected at least one emitted flag');
    for (const line of lines) {
      assert.match(line, /^--[a-z0-9][a-z0-9-]*$/);
    }
  });

  test('emitsNoTokenContainingWhitespaceOrGlobCharacters', () => {
    const r = runFlags();
    const lines = r.stdout.split('\n').filter(Boolean);
    const hostileChars = [' ', '\t', '*', '?', '[', ']', '$', '`', ';', '&', '|', '(', ')'];
    for (const line of lines) {
      for (const ch of hostileChars) {
        assert.ok(!line.includes(ch), `expected ${JSON.stringify(line)} not to contain ${JSON.stringify(ch)}`);
      }
    }
  });

  test('honorsSelected', () => {
    const r = runFlags(['--selected', 'antigravity']);
    assert.strictEqual(r.status, 0);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.deepStrictEqual(lines, ['--antigravity', '--agy']);
  });

  test('dropsUnknownSlugsAndExitsZero', () => {
    const r = runFlags(['--selected', 'nosuchlane']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.stdout.split('\n').filter(Boolean), []);
  });

  test('emitsNoTrailingNewlineWhenEmpty', () => {
    const r = runFlags(['--selected', 'nosuchlane']);
    assert.strictEqual(r.stdout, '');
  });

  test('defaultsToEveryLaneWhenSelectedIsEmpty', () => {
    const withEmpty = runFlags(['--selected', '']);
    const withNone = runFlags();
    assert.strictEqual(withEmpty.status, 0);
    assert.strictEqual(withEmpty.stdout, withNone.stdout);
  });

  test('doesNotInterpolateHostileSelectors', () => {
    const hostile = ';echo pwned;`id`;$(id)';
    const r = runFlags(['--selected', hostile]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(!r.stdout.includes('pwned'));
    assert.ok(!r.stdout.includes('uid='));
  });

  test('anUnknownSubcommandErrorsWithoutAStackTrace', () => {
    const r = cp.spawnSync(process.execPath, [TOOLS, 'review-lane', 'bogus'], { encoding: 'utf8' });
    const combined = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(combined, /flags/);
    assert.ok(!combined.includes('at Object.'));
    assert.ok(!combined.includes('    at '));
  });
});
