'use strict';

/**
 * Unusable-input diagnostic — the out-of-band half of ADR-1411's "corrupt is not absent"
 * amendment (epic #1879), and its first adopter, extractFrontmatter (#1882).
 *
 * What is under test is a BEHAVIOUR CHANGE ON A SILENT CHANNEL: every return value is
 * preserved exactly, and the only observable difference is that a genuinely-unusable input
 * now produces one diagnostic. So the assertions here are all on typed surfaces — the
 * frozen reason enum and the dedup-set size — never on the diagnostic prose, per
 * CONTRIBUTING.md's ban on raw text matching against stdout/stderr/file content.
 *
 * Independence note: the dedup set is process-global. Every case below resets it AND uses a
 * path unique to that case. #2674 is the cautionary precedent in this repo — a reset helper
 * that cleared two of three sets was a silent no-op for the very suite that existed to test
 * it, and the cases only passed because each happened to pick a key no other case reused.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  UNUSABLE_REASON,
  warnUnusableInput,
  _resetUnusableInputWarningsForTests,
  _unusableInputWarningCountForTests,
  _unusableInputEmissionCountForTests,
  _sanitizeSourceForTests,
} = require('../gsd-core/bin/lib/unusable-input.cjs');

const { extractFrontmatter, UNTERMINATED_KEY_THRESHOLD } = require('../gsd-core/bin/lib/frontmatter.cjs');

/**
 * Run `fn` with stderr captured, and report how many NEW diagnostics it produced.
 *
 * The count comes from the dedup set, not from parsing what was written — that is the typed
 * surface. stderr is stubbed only to keep the suite's own output clean; the stub is restored
 * in a `finally` inside this standalone helper, which is the one place CONTRIBUTING.md
 * permits try/finally (a helper with no access to test context).
 */
function emissionsDuring(fn) {
  const before = _unusableInputEmissionCountForTests();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return _unusableInputEmissionCountForTests() - before;
}

/** Parse `content` under a path unique to the calling case, returning [result, emissions]. */
function parseUnder(content, sourcePath) {
  let result;
  const emitted = emissionsDuring(() => {
    result = extractFrontmatter(content, sourcePath);
  });
  return [result, emitted];
}

const TRUNCATED_LF = '---\nphase: 01\nplan: 02\n';
const TRUNCATED_CRLF = '---\r\nphase: 01\r\nplan: 02\r\n';

// ─── The reason vocabulary is a contract ─────────────────────────────────────

describe('UNUSABLE_REASON', () => {
  test('is frozen and holds exactly the reasons that have an emitting call site', () => {
    _resetUnusableInputWarningsForTests();
    assert.ok(Object.isFrozen(UNUSABLE_REASON), 'enum must be frozen');
    // Locking the key set is what makes adding a reason three coordinated changes
    // (enum + call site + this assertion) instead of a silent widening.
    assert.deepStrictEqual(
      Object.keys(UNUSABLE_REASON).sort(),
      ['FRONTMATTER_UNTERMINATED', 'ROADMAP_UNREADABLE'],
    );
    assert.strictEqual(UNUSABLE_REASON.FRONTMATTER_UNTERMINATED, 'frontmatter_unterminated');
  });

  test('an unrecognised reason emits nothing rather than a diagnostic naming undefined', () => {
    _resetUnusableInputWarningsForTests();
    const emitted = emissionsDuring(() => {
      const wrote = warnUnusableInput({ reason: 'not_a_real_reason', source: '/u/unknown.md' });
      assert.strictEqual(wrote, false, 'unknown reason must report that it wrote nothing');
    });
    assert.strictEqual(emitted, 0);
  });
});

// ─── The discriminator: truncated vs. everything that merely looks like it ───

describe('extractFrontmatter — flags a genuinely truncated frontmatter', () => {
  test('unterminated fence carrying two keys is reported, and still returns {}', () => {
    _resetUnusableInputWarningsForTests();
    const [result, emitted] = parseUnder(TRUNCATED_LF, '/u/truncated-lf.md');
    assert.deepStrictEqual(result, {}, 'return value must be preserved exactly');
    assert.strictEqual(emitted, 1);
  });

  test('CRLF unterminated fence is reported identically to LF', () => {
    _resetUnusableInputWarningsForTests();
    const [result, emitted] = parseUnder(TRUNCATED_CRLF, '/u/truncated-crlf.md');
    assert.deepStrictEqual(result, {});
    assert.strictEqual(emitted, 1);
  });

  test('an indented "---" is not a closing fence, so the file is still truncated', () => {
    _resetUnusableInputWarningsForTests();
    const [result, emitted] = parseUnder('---\nphase: 01\nplan: 02\n  ---\n', '/u/indented-close.md');
    assert.deepStrictEqual(result, {});
    assert.strictEqual(emitted, 1);
  });
});

describe('extractFrontmatter — stays silent on everything that is not corruption', () => {
  // Each row here is a document that reaches, or nearly reaches, the same branch as a
  // truncated file. A diagnostic on any of them is a false positive on valid input.
  const silentCases = [
    ['a document with no frontmatter at all', 'plain body\nmore\n'],
    ['a Markdown thematic break at byte 0', '---\nSome heading text\n\nA paragraph, no more dashes.\n'],
    ['a thematic break followed by a second one', '---\nIntro\n\n---\n\nMore\n'],
    ['a well-formed but empty frontmatter block', '---\n---\nbody\n'],
    ['an opening fence with nothing after it', '---\n'],
    ['a bare "---" with no newline', '---'],
    ['an empty document', ''],
    ['a BOM before the fence', '\uFEFF---\ntitle: x\n---\nbody\n'],
    ['a blank line before the fence', '\n---\ntitle: x\n---\n'],
    ['an opening fence with a trailing space', '--- \ntitle: x\n---\n'],
    // #1882 review blocker: a thematic break above ONE labelled prose line is ordinary
    // technical writing and parses as exactly one key. Each of these was flagged as
    // corruption before the threshold moved to two.
    ['a thematic break above a Note: paragraph', '---\nNote: this is just a markdown paragraph, not frontmatter.\n'],
    ['a thematic break above an Author byline', '---\nAuthor: Jane Doe\n'],
    ['a thematic break above a TODO line', '---\nTODO: fix this later\n'],
    ['a thematic break above a See: link', '---\nSee: https://example.com\n'],
  ];

  silentCases.forEach(([label, content], caseIndex) => {
    test(`${label} produces no diagnostic`, () => {
      _resetUnusableInputWarningsForTests();
      const [, emitted] = parseUnder(content, `/u/silent-${caseIndex}.md`);
      assert.strictEqual(emitted, 0, `${label} must not be reported as corruption`);
    });
  });

  test('a thematic break above TWO labelled lines followed by prose stays silent', () => {
    // Review finding: raising the key threshold to 2 only moved the boundary — two labelled
    // lines are as common in ordinary prose as one. What separates a truncated write from a
    // document opening with a rule is that a truncated write ends mid-block, so EVERY line is
    // still frontmatter-shaped; this document goes on to prose.
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder(
      '---\nAuthor: Jane Doe\nReviewed-by: John Smith\n\nOrdinary prose, no other --- anywhere.\n',
      '/u/two-labelled-lines.md',
    );
    assert.strictEqual(emitted, 0, 'a labelled preamble above prose is not a truncated file');
  });

  // The shape check decides whether an unterminated region reads as an interrupted frontmatter
  // block or as a document that merely opened with a rule. These four pin each half of that
  // decision independently; without them the predicate's individual branches are unconstrained
  // and a mutation that drops any one of them still passes.
  test('a blank line inside an interrupted block does not disqualify it', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\nphase: 01\n\nplan: 02\n', '/u/shape-blank-line.md');
    assert.strictEqual(emitted, 1, 'blank lines are skipped, not treated as non-frontmatter');
  });

  test('an unindented list item counts as frontmatter-shaped', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\nphase: 01\nmust_haves:\n- alpha\n', '/u/shape-flat-list.md');
    assert.strictEqual(emitted, 1);
  });

  test('an indented folded-scalar continuation counts as frontmatter-shaped', () => {
    // This line is neither a key nor a list item, so it is the only case that exercises the
    // indented-continuation branch on its own.
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\nphase: 01\ndescription: >\n  folded text\n', '/u/shape-folded.md');
    assert.strictEqual(emitted, 1);
  });

  test('two keys followed by prose is NOT frontmatter-shaped', () => {
    // The negative half: enough keys to clear the threshold, but the region goes on to prose,
    // so it is a document opening with a rule rather than an interrupted write.
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder(
      '---\nphase: 01\nplan: 02\n\nOrdinary prose sentence here.\n',
      '/u/shape-then-prose.md',
    );
    assert.strictEqual(emitted, 0, 'key count alone must not be sufficient');
  });

  test('a truncated block whose values are nested lists is still reported', () => {
    // The shape check must not reject legitimate frontmatter: list items and indented
    // continuations are frontmatter-shaped too.
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\nphase: 01\nmust_haves:\n  - alpha\n  - beta\n', '/u/nested.md');
    assert.strictEqual(emitted, 1);
  });

  test('a well-formed document still parses its keys and stays silent', () => {
    _resetUnusableInputWarningsForTests();
    let parsed;
    const emitted = emissionsDuring(() => {
      parsed = extractFrontmatter('---\ntitle: x\nstatus: draft\n---\nbody\n', '/u/well-formed.md');
    });
    assert.deepStrictEqual(parsed, { title: 'x', status: 'draft' });
    assert.strictEqual(emitted, 0);
  });

  test('a four-dash close keeps its pre-existing lenient parse and stays silent', () => {
    _resetUnusableInputWarningsForTests();
    let parsed;
    const emitted = emissionsDuring(() => {
      parsed = extractFrontmatter('---\ntitle: x\n----\n', '/u/four-dash.md');
    });
    assert.deepStrictEqual(parsed, { title: 'x' });
    assert.strictEqual(emitted, 0);
  });
});

// ─── Boundary: the discriminator's threshold is ">= 2 parsed keys" ──────────

describe('extractFrontmatter — key-count boundary around the >=2 threshold', () => {
  test('below threshold: zero keys is silent', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\njust prose, no colon\n', '/u/boundary-0.md');
    assert.strictEqual(emitted, 0);
  });

  test('limit-1: exactly one key is silent — a labelled line under a thematic break', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\na: 1\n', '/u/boundary-1.md');
    assert.strictEqual(emitted, 0, 'one key is ambiguous with ordinary Markdown');
  });

  test('limit: exactly two keys is reported', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\na: 1\nb: 2\n', '/u/boundary-2.md');
    assert.strictEqual(emitted, UNTERMINATED_KEY_THRESHOLD - 1);
  });

  test('limit+1: three keys is reported exactly once, not once per key', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\na: 1\nb: 2\nc: 3\n', '/u/boundary-3.md');
    assert.strictEqual(emitted, 1);
  });
});

// ─── Deduplication: both halves of the composite key ────────────────────────

describe('diagnostic deduplication', () => {
  test('the same file reported twice yields one diagnostic', () => {
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder(TRUNCATED_LF, '/u/dedup-same.md');
    const [, second] = parseUnder(TRUNCATED_LF, '/u/dedup-same.md');
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 0, 'a repeat of the same fault must be suppressed');
  });

  test('a genuine second failure in a DIFFERENT file is never suppressed', () => {
    _resetUnusableInputWarningsForTests();
    const [, a] = parseUnder(TRUNCATED_LF, '/u/dedup-fileA.md');
    const [, b] = parseUnder(TRUNCATED_LF, '/u/dedup-fileB.md');
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1, 'keying too coarsely would hide a real second fault');
  });

  test('the key includes the cause, so one file can report two different causes', () => {
    _resetUnusableInputWarningsForTests();
    const source = '/u/dedup-two-causes.md';
    const emitted = emissionsDuring(() => {
      const first = warnUnusableInput({
        reason: UNUSABLE_REASON.FRONTMATTER_UNTERMINATED,
        source,
      });
      const repeat = warnUnusableInput({
        reason: UNUSABLE_REASON.FRONTMATTER_UNTERMINATED,
        source,
      });
      assert.strictEqual(first, true);
      assert.strictEqual(repeat, false, 'same (path, cause) must dedup');
    });
    assert.strictEqual(emitted, 1);
  });

  test('two spellings of one Windows path may report twice — the accepted trade', () => {
    // Separator folding was REMOVED: it collapsed genuinely distinct POSIX files whose
    // names contain a backslash. The residual cost is that one Windows file written two
    // ways can report twice. Mild noise is strictly preferable to a swallowed diagnostic,
    // and this test pins the direction of that trade so it is not silently reversed.
    _resetUnusableInputWarningsForTests();
    const [, backslash] = parseUnder(TRUNCATED_LF, 'C:\\proj\\phases\\PLAN.md');
    const [, forward] = parseUnder(TRUNCATED_LF, 'C:/proj/phases/PLAN.md');
    assert.strictEqual(backslash, 1);
    assert.strictEqual(forward, 1, 'noise is acceptable; a lost diagnostic is not');
  });

  test('path-less callers dedup on content, so identical content reports once', () => {
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder(TRUNCATED_LF, undefined);
    const [, second] = parseUnder(TRUNCATED_LF, undefined);
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 0);
  });

  test('path-less callers with DIFFERENT content each report', () => {
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder('---\nalpha: 1\na2: x\n', undefined);
    const [, second] = parseUnder('---\nbeta: 2\nb2: y\n', undefined);
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 1);
  });

  test('an empty-string path falls back to the content key rather than keying on ""', () => {
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder('---\ngamma: 1\ng2: x\n', '   ');
    const [, second] = parseUnder('---\ndelta: 2\nd2: y\n', '   ');
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 1, 'blank paths must not collapse distinct files into one key');
  });

  test('only the offending file is reported when a good file is parsed alongside it', () => {
    _resetUnusableInputWarningsForTests();
    const emitted = emissionsDuring(() => {
      extractFrontmatter('---\nok: 1\n---\nbody\n', '/u/mixed-good.md');
      extractFrontmatter(TRUNCATED_LF, '/u/mixed-bad.md');
      extractFrontmatter('---\nalso: 2\n---\nbody\n', '/u/mixed-good-2.md');
    });
    assert.strictEqual(emitted, 1);
  });

  test('anonymous-first then named reports twice — the documented asymmetry', () => {
    // Pinned deliberately. A path-less caller cannot identify its file, so suppressing the
    // later NAMED report would also suppress a genuine second failure in a DIFFERENT file
    // whenever two files share byte-identical truncated content. ADR-1411 ranks that swallow
    // the worse failure, so the duplicate is accepted and the named line carries the filename.
    _resetUnusableInputWarningsForTests();
    const [, anonymous] = parseUnder(TRUNCATED_LF, undefined);
    const [, named] = parseUnder(TRUNCATED_LF, '/u/anon-then-named.md');
    assert.strictEqual(anonymous, 1);
    assert.strictEqual(named, 1, 'the named report must still name the file');
  });

  test('one file parsed both with and without a path reports exactly once', () => {
    // A read wrapper knows the path; a pure core downstream (state-transition.cts, per
    // ADR-1769) is handed only the string. Keying those two parses separately reported the
    // SAME truncated file twice, under a path key and a digest key.
    _resetUnusableInputWarningsForTests();
    const [, named] = parseUnder(TRUNCATED_LF, '/u/both-identities.md');
    const [, anonymous] = parseUnder(TRUNCATED_LF, undefined);
    assert.strictEqual(named, 1);
    assert.strictEqual(anonymous, 0, 'the same file must not report twice under two keys');
  });

  test('widening the key does not merge two genuinely different files', () => {
    _resetUnusableInputWarningsForTests();
    const [, a] = parseUnder('---\nphase: 01\nplan: 02\n', '/u/widen-a.md');
    const [, b] = parseUnder('---\nphase: 09\nplan: 09\n', '/u/widen-b.md');
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1, 'distinct content in distinct files must still both report');
  });

  test('the reset seam actually clears state, so the same key can report again', () => {
    // #2674 shape: a reset that silently fails to clear turns every later dedup assertion
    // into a vacuous pass. Prove the seam by re-reporting a key that was just suppressed.
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder(TRUNCATED_LF, '/u/reset-seam.md');
    const [, suppressed] = parseUnder(TRUNCATED_LF, '/u/reset-seam.md');
    _resetUnusableInputWarningsForTests();
    const [, afterReset] = parseUnder(TRUNCATED_LF, '/u/reset-seam.md');
    assert.strictEqual(first, 1);
    assert.strictEqual(suppressed, 0);
    assert.strictEqual(afterReset, 1, 'reset must genuinely empty the dedup set');
    assert.strictEqual(_unusableInputEmissionCountForTests(), 1,
      'exactly one diagnostic was written after the reset');
    assert.ok(_unusableInputWarningCountForTests() >= 1,
      'and at least one identity was interned for it');
  });
});

// ─── Hostile input ───────────────────────────────────────────────────────────

describe('hostile input', () => {
  test('a literal backslash in a POSIX filename does not collide with a real directory', () => {
    // Review finding: folding backslashes to '/' unconditionally made these two GENUINELY
    // different files share one key on Linux/macOS, where '\\' is a legal filename
    // character, and silently swallowed the second diagnostic.
    _resetUnusableInputWarningsForTests();
    const [, withBackslash] = parseUnder(TRUNCATED_LF, '/repo/weird\\name/PLAN.md');
    const [, withSlash] = parseUnder(TRUNCATED_LF, '/repo/weird/name/PLAN.md');
    assert.strictEqual(withBackslash, 1);
    assert.strictEqual(withSlash, 1, 'two distinct files must never silence each other');
  });

  test('a path spelled like the unnamed-digest fallback cannot pre-seed suppression', () => {
    // Review finding: the digest of any predictable content can be computed and used as a
    // filename, so the two key namespaces must be disjoint by construction.
    _resetUnusableInputWarningsForTests();
    const crypto = require('node:crypto');
    const digest = crypto.createHash('sha256').update(TRUNCATED_LF).digest('hex').slice(0, 16);
    const [, forged] = parseUnder(TRUNCATED_LF, `<unnamed:${digest}>`);
    const [, realFile] = parseUnder(TRUNCATED_LF, '/u/forge-victim.md');
    assert.strictEqual(forged, 1);
    assert.strictEqual(realFile, 1,
      'a crafted filename must never suppress a real file reported by its own path');
    // The anonymous re-report of byte-identical content IS suppressed, deliberately: that is
    // the same-file guard (named read first, path-less re-parse second). The forged name buys
    // an attacker nothing there, because ANY path-ful report of that content does the same.
  });

  test('a NUL in the path cannot forge a collision with another key', () => {
    _resetUnusableInputWarningsForTests();
    // The key separator is NUL. If it were not stripped, "a\0frontmatter_unterminated"
    // supplied as a *path* would collide with the real key for path "a".
    const [, forged] = parseUnder(TRUNCATED_LF, '/u/collide\u0000frontmatter_unterminated');
    const [, genuine] = parseUnder(TRUNCATED_LF, '/u/collide');
    assert.strictEqual(forged, 1);
    assert.strictEqual(genuine, 1, 'a crafted path must not suppress a real report');
  });

  test('control characters are stripped from the source before it is used', () => {
    // Asserted on the sanitizer's RETURN VALUE, not by capturing what reached stderr.
    // Scraping the rendered stream and regex-testing it is the shape CONTRIBUTING.md bans
    // (Prohibited: Raw Text Matching on Test Outputs) — the rule targets the mechanism,
    // not just prose-wording checks, so the typed surface is the correct fix.
    _resetUnusableInputWarningsForTests();
    const cleaned = _sanitizeSourceForTests('/u/ansi\u001b[31mred\u0007\u0000.md');
    assert.strictEqual(cleaned, '/u/ansi[31mred.md');
    for (const ch of cleaned) {
      assert.ok(ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127,
        'sanitized source must contain no C0 or DEL bytes');
    }
  });

  test('a large unterminated region completes without pathological behaviour', () => {
    _resetUnusableInputWarningsForTests();
    const big = '---\n' + Array.from({ length: 5000 }, (_, i) => `k${i}: v${i}`).join('\n') + '\n';
    const [result, emitted] = parseUnder(big, '/u/large-unterminated.md');
    assert.deepStrictEqual(result, {}, 'still returns the preserved sentinel');
    assert.strictEqual(emitted, 1);
  });

  test('a failing stderr write is swallowed and never escalates into a throw', (t) => {
    // Fault injection by method override + restore, never chmod 0o000: root bypasses mode
    // bits, so a permission-based version of this test would silently pass with zero
    // coverage in root Docker/CI.
    _resetUnusableInputWarningsForTests();
    const original = process.stderr.write;
    t.after(() => { process.stderr.write = original; });
    process.stderr.write = () => { throw new Error('EPIPE injected'); };
    const result = extractFrontmatter(TRUNCATED_LF, '/u/broken-stderr.md');
    assert.deepStrictEqual(result, {}, 'a broken stderr must not change the return value');
    assert.strictEqual(_unusableInputEmissionCountForTests(), 0,
      'a write that threw must not be counted as a diagnostic the operator saw');
  });
});
