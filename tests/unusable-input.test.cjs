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
} = require('../gsd-core/bin/lib/unusable-input.cjs');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

/**
 * Run `fn` with stderr captured, and report how many NEW diagnostics it produced.
 *
 * The count comes from the dedup set, not from parsing what was written — that is the typed
 * surface. stderr is stubbed only to keep the suite's own output clean; the stub is restored
 * in a `finally` inside this standalone helper, which is the one place CONTRIBUTING.md
 * permits try/finally (a helper with no access to test context).
 */
function emissionsDuring(fn) {
  const before = _unusableInputWarningCountForTests();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return _unusableInputWarningCountForTests() - before;
}

/** Parse `content` under a path unique to the calling case, returning [result, emissions]. */
function parseUnder(content, sourcePath) {
  let result;
  const emitted = emissionsDuring(() => {
    result = extractFrontmatter(content, sourcePath);
  });
  return [result, emitted];
}

const TRUNCATED_LF = '---\ntitle: x\n';
const TRUNCATED_CRLF = '---\r\ntitle: x\r\n';

// ─── The reason vocabulary is a contract ─────────────────────────────────────

describe('UNUSABLE_REASON', () => {
  test('is frozen and holds exactly the reasons that have an emitting call site', () => {
    _resetUnusableInputWarningsForTests();
    assert.ok(Object.isFrozen(UNUSABLE_REASON), 'enum must be frozen');
    // Locking the key set is what makes adding a reason three coordinated changes
    // (enum + call site + this assertion) instead of a silent widening.
    assert.deepStrictEqual(Object.keys(UNUSABLE_REASON).sort(), ['FRONTMATTER_UNTERMINATED']);
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
  test('unterminated fence carrying one key is reported, and still returns {}', () => {
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
    const [result, emitted] = parseUnder('---\ntitle: x\n  ---\n', '/u/indented-close.md');
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
  ];

  for (const [label, content] of silentCases) {
    test(`${label} produces no diagnostic`, () => {
      _resetUnusableInputWarningsForTests();
      const [, emitted] = parseUnder(content, `/u/silent-${silentCases.findIndex(c => c[0] === label)}.md`);
      assert.strictEqual(emitted, 0, `${label} must not be reported as corruption`);
    });
  }

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

// ─── Boundary: the discriminator's threshold is ">= 1 parsed key" ────────────

describe('extractFrontmatter — key-count boundary around the >=1 threshold', () => {
  test('limit-1: zero keys in the unterminated region is silent', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\njust prose, no colon\n', '/u/boundary-0.md');
    assert.strictEqual(emitted, 0);
  });

  test('limit: exactly one key is reported', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\na: 1\n', '/u/boundary-1.md');
    assert.strictEqual(emitted, 1);
  });

  test('limit+1: two keys is reported exactly once, not once per key', () => {
    _resetUnusableInputWarningsForTests();
    const [, emitted] = parseUnder('---\na: 1\nb: 2\n', '/u/boundary-2.md');
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

  test('a Windows and a POSIX spelling of one path share a single key', () => {
    _resetUnusableInputWarningsForTests();
    const [, backslash] = parseUnder(TRUNCATED_LF, 'C:\\proj\\phases\\PLAN.md');
    const [, forward] = parseUnder(TRUNCATED_LF, 'C:/proj/phases/PLAN.md');
    assert.strictEqual(backslash, 1);
    assert.strictEqual(forward, 0, 'separator spelling must not double-report one file');
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
    const [, first] = parseUnder('---\nalpha: 1\n', undefined);
    const [, second] = parseUnder('---\nbeta: 2\n', undefined);
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 1);
  });

  test('an empty-string path falls back to the content key rather than keying on ""', () => {
    _resetUnusableInputWarningsForTests();
    const [, first] = parseUnder('---\ngamma: 1\n', '   ');
    const [, second] = parseUnder('---\ndelta: 2\n', '   ');
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
    assert.strictEqual(_unusableInputWarningCountForTests(), 1);
  });
});

// ─── Hostile input ───────────────────────────────────────────────────────────

describe('hostile input', () => {
  test('a NUL in the path cannot forge a collision with another key', () => {
    _resetUnusableInputWarningsForTests();
    // The key separator is NUL. If it were not stripped, "a\0frontmatter_unterminated"
    // supplied as a *path* would collide with the real key for path "a".
    const [, forged] = parseUnder(TRUNCATED_LF, '/u/collide\u0000frontmatter_unterminated');
    const [, genuine] = parseUnder(TRUNCATED_LF, '/u/collide');
    assert.strictEqual(forged, 1);
    assert.strictEqual(genuine, 1, 'a crafted path must not suppress a real report');
  });

  test('control characters in the path are never written through to the terminal', () => {
    _resetUnusableInputWarningsForTests();
    let written = '';
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written += String(chunk); return true; };
    try {
      extractFrontmatter(TRUNCATED_LF, '/u/ansi\u001b[31mred\u0007.md');
    } finally {
      process.stderr.write = original;
    }
    assert.ok(written.length > 0, 'a diagnostic should have been produced');
    // Structural assertion on the bytes emitted, not on the message wording.
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(written),
      'no raw control bytes may reach the operator terminal');
  });

  test('a large unterminated region completes without pathological behaviour', () => {
    _resetUnusableInputWarningsForTests();
    const big = '---\n' + Array.from({ length: 5000 }, (_, i) => `k${i}: v${i}`).join('\n') + '\n';
    const [result, emitted] = parseUnder(big, '/u/large-unterminated.md');
    assert.deepStrictEqual(result, {}, 'still returns the preserved sentinel');
    assert.strictEqual(emitted, 1);
  });

  test('a failing stderr write is swallowed and never escalates into a throw', () => {
    // Fault injection by method override + restore, never chmod 0o000: root bypasses mode
    // bits, so a permission-based version of this test would silently pass with zero
    // coverage in root Docker/CI.
    _resetUnusableInputWarningsForTests();
    const original = process.stderr.write;
    process.stderr.write = () => { throw new Error('EPIPE injected'); };
    let result;
    try {
      result = extractFrontmatter(TRUNCATED_LF, '/u/broken-stderr.md');
    } finally {
      process.stderr.write = original;
    }
    assert.deepStrictEqual(result, {}, 'a broken stderr must not change the return value');
  });
});
