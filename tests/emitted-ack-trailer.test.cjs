'use strict';

/**
 * tests/emitted-ack-trailer.test.cjs — #3942 commit-trailer acknowledgment reader/parser.
 *
 * FAILING-FIRST against the #3942 stubs in tests/helpers/emitted-diff.cjs
 * (`parseAckTrailers`, `renderAckTrailer`, `ACK_TRAILER_HASH`, `ACK_TRAILER_GROWTH`,
 * `ACK_TRAILER_DELIM`, `MAX_ACK_TRAILERS`) and tests/helpers/emitted-runtime.cjs
 * (`readAckTrailers`). See `.gsd/phase/chore-3942-ack-commit-trailer/40-design.md` for
 * the grammar/behavior table and `50-test-matrix.md` for the 37-row matrix this file
 * covers.
 *
 * Every one of those exports is a STUB today: it returns a benign, empty-shaped value
 * and NEVER throws. So every row below that requires real parsing, real git I/O, a
 * thrown error, or a bijective round-trip is RED for the right reason — missing
 * implementation, not a test bug. A handful of rows (25, 31, 34) legitimately assert
 * an EMPTY result and so pass trivially today; that is the correct, non-vacuous
 * behavior for those specific inputs both before and after the real implementation
 * lands, not a weak assertion.
 *
 * Three rows (8, 34, 35) describe diffEmitted's future CONSUMER-side gating
 * (`staleAcks` naming a space, shrinkage never needing a trailer, `NEW_FILE_CAP` never
 * being excusable) — behavior that depends on diffEmitted being rewired to accept
 * separate `ackHash`/`ackGrowth` maps, which is a later step per 40-design.md's blast
 * radius table and out of scope for this stub-only change. Each is expressed here as
 * the reader-level analog it reduces to (namespace separation, or "the reader has no
 * opinion on X"), with a comment explaining the narrowing. See the dispatch report for
 * the precise accounting.
 *
 * ── Row -> describe block map ────────────────────────────────────────────────
 *   grammar and hostile keys (pure parser)      rows  8, 9-18, 28-30
 *   boundary: MAX_ACK_TRAILERS cap              rows 19-21
 *   real fixture reads via readAckTrailers      rows  1-7, 25-27, 31, 34, 35
 *   hostile IO: range/subprocess/timeout        rows 22-24
 *   round-trip and properties                   rows 33, 36, 37
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const {
  ACK_TRAILER_HASH,
  ACK_TRAILER_GROWTH,
  ACK_TRAILER_DELIM,
  MAX_ACK_TRAILERS,
  parseAckTrailers,
  renderAckTrailer,
} = require('./helpers/emitted-diff.cjs');
const { readAckTrailers } = require('./helpers/emitted-runtime.cjs');

// Mirrors emitted-diff.cjs's (unexported) RESERVED_ACK_KEYS — 40-design.md's "Trailer
// key is __proto__ / constructor / prototype" row is explicitly carried over verbatim
// from that JSON-ack design, so the three literal values are pinned here rather than
// imported (nothing in the #3942 stub surface re-exports the JSON-ack constant).
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

// ─── fixture helpers ──────────────────────────────────────────────────────────

/** A throwaway git repo: `init -b main`, deterministic identity, no GPG prompts. */
function makeTempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitOrThrow(['init', '-q', '-b', 'main'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.email', 'ack-trailer-fixture@example.com'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.name', 'Ack Trailer Fixture'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  return dir;
}

/**
 * Commit an --allow-empty commit from a message written to a file (never `-m`, so the
 * trailer block lands exactly where git's own trailer parser expects it).
 */
function commitMessage(dir, message, { branch } = {}) {
  if (branch) {
    gitOrThrow(['checkout', '-q', '-b', branch], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  }
  const msgFile = path.join(os.tmpdir(), `gsd-ack-trailer-msg-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(msgFile, message);
  try {
    gitOrThrow(['commit', '-q', '--allow-empty', '-F', msgFile], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  } finally {
    cleanup(msgFile);
  }
}

function headSha(dir) {
  return gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
}

function checkout(dir, ref) {
  gitOrThrow(['checkout', '-q', ref], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

/** One rendered trailer LINE — not `renderAckTrailer` (a stub today), but the literal
 *  grammar it will produce, so fixtures stay correct independent of the stub's state. */
function trailerLine(name, key, reason) {
  return `${name}: ${key}${ACK_TRAILER_DELIM}${reason}`;
}

function withCleanup(t, dir) {
  t.after(() => cleanup(dir));
}

/**
 * Build `commitCount` trivial linear commits on `refs/heads/main` via a
 * single `git fast-import` stream (one subprocess spawn, not one per
 * commit) and return the root commit's sha.
 *
 * Used by row 24 to force `git log`'s real formatting work comfortably
 * past a small `timeoutMs`, without racing real subprocess completion
 * time the way a razor-thin `timeoutMs: 1` against a trivial 2-commit
 * repo does (#3985: `process-seam.cjs`'s own documented at-the-boundary
 * case — a child finishing right at the deadline can report a real
 * `status` alongside `error.code === 'ETIMEDOUT'`, which the seam
 * correctly classifies as EXITED, not TIMED_OUT). A large real-work
 * margin (tens of thousands of commits vs a ~20ms bound) is reliable on
 * any real hardware and any platform — no PATH/PATHEXT/shebang concerns,
 * unlike an approach that tries to intercept the `git` binary itself.
 */
function growHistoryFastImport(dir, commitCount) {
  let stream = '';
  for (let i = 1; i <= commitCount; i++) {
    const message = `c${i}\n`;
    stream += 'commit refs/heads/main\n';
    stream += `mark :${i}\n`;
    stream += `committer Ack Trailer Fixture <ack-trailer-fixture@example.com> ${1700000000 + i} +0000\n`;
    stream += `data ${Buffer.byteLength(message, 'utf-8')}\n`;
    stream += message;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += '\n';
  }
  gitOrThrow(['fast-import', '--quiet'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS, input: stream });
  return gitOrThrow(['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
}

// ─── grammar and hostile keys (pure parser) — rows 8, 9-18, 28-30 ────────────

describe('grammar and hostile keys (pure parser)', () => {
  test('trailer without a delimiter is rejected — row 9', () => {
    const { hash, errors } = parseAckTrailers({ hash: ['no-delimiter-here'], growth: [] });
    assert.equal(hash.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /delimiter/i);
  });

  test('empty reason is rejected — row 10', () => {
    const { hash, errors } = parseAckTrailers({ hash: ['some/path — '], growth: [] });
    assert.equal(hash.has('some/path'), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reason/i);
  });

  test('one-character reason is accepted — row 11', () => {
    const { hash, errors } = parseAckTrailers({ hash: ['some/path — x'], growth: [] });
    assert.deepEqual(errors, []);
    assert.equal(hash.get('some/path').reason, 'x');
  });

  test('empty key is rejected — row 12', () => {
    const { hash, errors } = parseAckTrailers({ hash: [' — reason text'], growth: [] });
    assert.equal(hash.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /key/i);
  });

  test('reserved keys are rejected — row 13', () => {
    const values = RESERVED_KEYS.map((k) => `${k} — ok`);
    const { hash, errors } = parseAckTrailers({ hash: values, growth: [] });
    assert.equal(hash.size, 0);
    assert.equal(errors.length, RESERVED_KEYS.length);
    for (const k of RESERVED_KEYS) {
      assert.ok(errors.some((e) => e.includes(k)), `errors must name ${k}`);
    }
  });

  test('placeholder-shaped key is rejected — row 14', () => {
    const { hash, errors } = parseAckTrailers({ hash: ['<emitted/path> — reason'], growth: [] });
    assert.equal(hash.size, 0);
    assert.equal(errors.length, 1);
  });

  test('key with whitespace is rejected — row 15', () => {
    const { hash, errors } = parseAckTrailers({ hash: ['foo bar.md — reason'], growth: [] });
    assert.equal(hash.size, 0);
    assert.equal(errors.length, 1);
  });

  test('identical duplicate trailer is deduped — row 16', () => {
    const { hash, errors } = parseAckTrailers({
      hash: ['dup/path — same reason', 'dup/path — same reason'],
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.size, 1);
    assert.equal(hash.get('dup/path').reason, 'same reason');
  });

  test('conflicting duplicate trailer is rejected — row 17', () => {
    const { hash, errors } = parseAckTrailers({
      hash: ['dup/path — reason A', 'dup/path — reason B'],
      growth: [],
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ambiguous|conflict/i);
    assert.equal(hash.has('dup/path'), false, 'an ambiguous declaration must not silently pick a winner');
  });

  test('same key in both spaces is legal — row 18', () => {
    const { hash, growth, errors } = parseAckTrailers({
      hash: ['shared-key — hash reason'],
      growth: ['shared-key — growth reason'],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.get('shared-key').reason, 'hash reason');
    assert.equal(growth.get('shared-key').reason, 'growth reason');
  });

  test(
    'stale trailer fails and names its space — row 8 '
    + '(reader-level analog: the two spaces stay in separate maps so a downstream '
    + 'consumer can name which space an unconsumed key belongs to; the staleAcks '
    + 'gating itself is diffEmitted\'s job and is not rewired by this stub-only change)',
    () => {
      const { hash, growth } = parseAckTrailers({
        hash: ['a/b.md — hash-space reason'],
        growth: ['c.md — growth-space reason'],
      });
      assert.equal(hash.has('a/b.md'), true);
      assert.equal(growth.has('c.md'), true);
      assert.equal(hash.has('c.md'), false, 'growth-space key must not leak into the hash map');
      assert.equal(growth.has('a/b.md'), false, 'hash-space key must not leak into the growth map');
    },
  );

  test('trailer value is trimmed — row 28', () => {
    const { hash, errors } = parseAckTrailers({
      hash: ['  padded/path  —  reason with padding  '],
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.get('padded/path').reason, 'reason with padding');
  });

  test('reason may contain an em dash — row 29', () => {
    const { hash, errors } = parseAckTrailers({
      hash: ['path/em — reason — with another em dash'],
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.get('path/em').reason, 'reason — with another em dash');
  });

  test('invisible characters cannot fake a distinct reason — row 30', () => {
    // A zero-width space (U+200B) inserted inside an otherwise-identical reason. Once
    // stripped, both entries read as the SAME prose — this must dedupe (row 16's rule),
    // never register as a genuinely distinct (and therefore ambiguous, row 17) reason.
    const { hash, errors } = parseAckTrailers({
      hash: ['inv/path — same reason', 'inv/path — sam​e reason'],
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.size, 1);
    assert.equal(hash.get('inv/path').reason, 'same reason');
  });
});

// ─── boundary: MAX_ACK_TRAILERS cap — rows 19-21 ─────────────────────────────

function buildUniqueHashValues(n) {
  return Array.from({ length: n }, (_, i) => `k${i}/path.md — reason ${i}`);
}

describe('boundary: MAX_ACK_TRAILERS cap', () => {
  test('trailer count below the cap is accepted — row 19', () => {
    const { hash, errors } = parseAckTrailers({
      hash: buildUniqueHashValues(MAX_ACK_TRAILERS - 1),
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.size, MAX_ACK_TRAILERS - 1);
  });

  test('trailer count at the cap is accepted — row 20', () => {
    const { hash, errors } = parseAckTrailers({
      hash: buildUniqueHashValues(MAX_ACK_TRAILERS),
      growth: [],
    });
    assert.deepEqual(errors, []);
    assert.equal(hash.size, MAX_ACK_TRAILERS);
  });

  test('trailer count above the cap throws, never truncates — row 21', () => {
    assert.throws(
      () => parseAckTrailers({ hash: buildUniqueHashValues(MAX_ACK_TRAILERS + 1), growth: [] }),
      (err) => {
        assert.match(err.message, new RegExp(String(MAX_ACK_TRAILERS + 1)), 'must name the actual count');
        assert.match(
          err.message.replace(String(MAX_ACK_TRAILERS + 1), ''),
          new RegExp(String(MAX_ACK_TRAILERS)),
          'must name the cap',
        );
        return true;
      },
      'one over the cap must throw rather than silently truncating the listing',
    );
  });

  test(
    '100 identical repeats of ONE trailer do not throw — the cap is counted AFTER '
    + 'same-key dedup, not on the raw input count. A commit trailer, unlike the pre-'
    + '#3942 fragment-directory listing this cap descends from, legitimately survives a '
    + "rebase: `git log` over the range reports the SAME trailer text once per rebased "
    + 'commit it still lives on, so counting raw occurrences would throw on an entirely '
    + 'legitimate branch that never declared more than one distinct acknowledgment.',
    () => {
      const values = Array.from(
        { length: 100 },
        () => 'rebased/path.md — identical reason on every rebased commit',
      );
      const { hash, errors } = parseAckTrailers({ hash: values, growth: [] });
      assert.deepEqual(errors, []);
      assert.equal(hash.size, 1, 'all 100 raw values collapse to the one distinct declaration they represent');
      assert.equal(hash.get('rebased/path.md').reason, 'identical reason on every rebased commit');
    },
  );
});

// ─── real fixture reads via readAckTrailers — rows 1-7, 25-27, 31, 34, 35 ────

describe('real fixture reads via readAckTrailers', () => {
  test('hash trailer excuses a rippled path — row 1', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-1-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    commitMessage(
      dir,
      `ripple the workflow\n\n${trailerLine(ACK_TRAILER_HASH, 'gsd-core/workflows/foo.md', 'deliberate ripple, #3942')}\n`,
    );
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.hash.get('gsd-core/workflows/foo.md')?.reason, 'deliberate ripple, #3942');
    assert.equal(r.growth.size, 0);
  });

  test('growth trailer excuses a grown file — row 2', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-2-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    commitMessage(
      dir,
      `grow the workflow\n\n${trailerLine(ACK_TRAILER_GROWTH, 'plan-phase.md', 'grew for a new step, #3942')}\n`,
    );
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.growth.get('plan-phase.md')?.reason, 'grew for a new step, #3942');
    assert.equal(r.hash.size, 0);
  });

  test('both spaces coexist in one range — row 3', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-3-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    commitMessage(
      dir,
      'hash and growth together\n\n'
      + `${trailerLine(ACK_TRAILER_HASH, 'gsd-core/workflows/bar.md', 'ripple reason')}\n`
      + `${trailerLine(ACK_TRAILER_GROWTH, 'bar.md', 'growth reason')}\n`,
    );
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.hash.get('gsd-core/workflows/bar.md')?.reason, 'ripple reason');
    assert.equal(r.growth.get('bar.md')?.reason, 'growth reason');
  });

  test(
    'two trailers of the SAME name on one commit arrive as separate entries, not '
    + 'joined into one value (regression: `separator=1d` in the git --format string was '
    + 'a literal two-character value, not the `%x1d` escape — the record NEVER split on '
    + 'the real \\x1d byte the code expects, silently collapsing multiple same-key '
    + 'trailers into one joined string). The existing "both spaces coexist" test (row 3) '
    + 'uses Hash+Growth — two DIFFERENT trailer names — so it only exercises the field '
    + 'separator, never the value separator between multiple values of the SAME key; '
    + 'this test is what actually exercises `separator=` in the git --format string.',
    (t) => {
      const dir = makeTempRepo('gsd-ack-trailer-sep-');
      withCleanup(t, dir);
      commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
      const baseSha = headSha(dir);
      commitMessage(
        dir,
        'two same-name trailers, different keys\n\n'
        + `${trailerLine(ACK_TRAILER_HASH, 'one/path.md', 'reason one')}\n`
        + `${trailerLine(ACK_TRAILER_HASH, 'two/path.md', 'reason two')}\n`,
      );
      const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
      assert.equal(r.errors.length, 0);
      assert.equal(r.hash.size, 2, 'two distinct trailers of the same name must arrive as two entries');
      assert.equal(r.hash.get('one/path.md')?.reason, 'reason one');
      assert.equal(r.hash.get('two/path.md')?.reason, 'reason two');
    },
  );

  test(
    'two trailers of the SAME name and the SAME key with different reasons on one '
    + 'commit are surfaced as an ambiguous-conflict error, not silently merged '
    + '(regression, same root cause as the test immediately above: under the broken '
    + 'separator, this exact input produced NO error and a corrupted reason string like '
    + '"reason one1dtwo/path.md — reason two" — a truncation the ambiguous-duplicate '
    + 'error exists to catch, but never fired because the value never reached the '
    + 'parser split into two pieces)',
    (t) => {
      const dir = makeTempRepo('gsd-ack-trailer-sep-conflict-');
      withCleanup(t, dir);
      commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
      const baseSha = headSha(dir);
      commitMessage(
        dir,
        'two same-name trailers, same key, conflicting reasons\n\n'
        + `${trailerLine(ACK_TRAILER_HASH, 'same/path.md', 'reason A')}\n`
        + `${trailerLine(ACK_TRAILER_HASH, 'same/path.md', 'reason B')}\n`,
      );
      const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
      assert.equal(r.hash.has('same/path.md'), false, 'an ambiguous declaration must not silently pick a winner');
      assert.equal(r.errors.length, 1, 'the split must yield exactly two distinct raw values, not one merged one');
      assert.match(r.errors[0], /ambiguous|conflict/i);
    },
  );

  test('clean tree needs no trailer — row 4', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-4-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    commitMessage(dir, 'no-op change\n\nnothing to acknowledge\n');
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.hash.size, 0);
    assert.equal(r.growth.size, 0);
  });

  test('growth trailer does not excuse a hash ripple — row 5', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-5-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    // A Growth trailer naming a slash-shaped emitted PATH, as if trying to excuse a
    // hash ripple from the wrong namespace — the latent defect this row closes.
    commitMessage(
      dir,
      `mis-scoped ack\n\n${trailerLine(ACK_TRAILER_GROWTH, 'gsd-core/workflows/baz.md', 'wrong space')}\n`,
    );
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.growth.get('gsd-core/workflows/baz.md')?.reason, 'wrong space');
    assert.equal(r.hash.has('gsd-core/workflows/baz.md'), false, 'the growth space must never leak into the hash space');
  });

  test('hash trailer does not excuse growth — row 6', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-6-');
    withCleanup(t, dir);
    commitMessage(dir, 'init\n\nbaseline commit, no trailer\n');
    const baseSha = headSha(dir);
    commitMessage(dir, `mis-scoped ack\n\n${trailerLine(ACK_TRAILER_HASH, 'qux.md', 'wrong space')}\n`);
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.hash.get('qux.md')?.reason, 'wrong space');
    assert.equal(r.growth.has('qux.md'), false, 'the hash space must never leak into the growth space');
  });

  test('trailer before the merge-base is out of range — row 7', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-7-');
    withCleanup(t, dir);
    commitMessage(dir, 'fork point\n\nnothing to acknowledge yet\n');
    commitMessage(
      dir,
      `topic ripple\n\n${trailerLine(ACK_TRAILER_HASH, 'topic-key.md', 'on the topic branch')}\n`,
      { branch: 'topic' },
    );
    checkout(dir, 'main');
    commitMessage(dir, `main ripple\n\n${trailerLine(ACK_TRAILER_HASH, 'main-key.md', 'on main, after the fork')}\n`);
    checkout(dir, 'topic');

    const r = readAckTrailers({ baseRef: 'main', headRef: 'HEAD', cwd: dir });
    assert.equal(r.hash.has('topic-key.md'), true, 'the topic-side trailer is in range via the merge-base');
    assert.equal(r.hash.has('main-key.md'), false, 'the main-side trailer, off the fork, must be out of range');
  });

  test('empty range yields no acks — row 25', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-25-');
    withCleanup(t, dir);
    commitMessage(dir, 'only commit\n\nno trailer\n');
    const sha = headSha(dir);
    const r = readAckTrailers({ baseRef: sha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.hash.size, 0);
    assert.equal(r.growth.size, 0);
  });

  test('single-commit range is read — row 26', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-26-');
    withCleanup(t, dir);
    commitMessage(dir, 'base\n\nno trailer\n');
    const baseSha = headSha(dir);
    commitMessage(dir, `only one commit\n\n${trailerLine(ACK_TRAILER_HASH, 'single.md', 'only one commit in range')}\n`);
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.hash.get('single.md')?.reason, 'only one commit in range');
    assert.equal(r.hash.size, 1);
  });

  test('CRLF commit message parses identically — row 27', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-27-');
    withCleanup(t, dir);
    commitMessage(dir, 'base\n\nno trailer\n');
    const baseSha = headSha(dir);
    const crlfMessage =
      `crlf commit\r\n\r\n${trailerLine(ACK_TRAILER_HASH, 'crlf-key.md', 'same reason regardless of line ending')}\r\n`;
    const msgFile = path.join(os.tmpdir(), `gsd-ack-trailer-crlf-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(msgFile, crlfMessage);
    try {
      gitOrThrow(['commit', '-q', '--allow-empty', '-F', msgFile], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    } finally {
      cleanup(msgFile);
    }
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(
      r.hash.get('crlf-key.md')?.reason,
      'same reason regardless of line ending',
      'a CRLF commit message must parse identically to LF — no stray \\r in the reason',
    );
  });

  test('merge commit without a trailer is ignored — row 31', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-31-');
    withCleanup(t, dir);
    commitMessage(dir, 'fork\n\nno trailer\n');
    const forkSha = headSha(dir);
    commitMessage(dir, 'topic change\n\nno trailer\n', { branch: 'topic' });
    checkout(dir, 'main');
    commitMessage(dir, 'main change\n\nno trailer\n');

    const mergeMsgFile = path.join(os.tmpdir(), `gsd-ack-trailer-merge-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(mergeMsgFile, "Merge branch 'topic'\n\nno trailer here either\n");
    try {
      gitOrThrow(['merge', '--no-ff', '-q', '-F', mergeMsgFile, 'topic'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    } finally {
      cleanup(mergeMsgFile);
    }

    const r = readAckTrailers({ baseRef: forkSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.errors.length, 0);
    assert.equal(r.hash.size, 0);
    assert.equal(r.growth.size, 0);
  });

  test('mid-body mention is not a trailer — row 32', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-32-');
    withCleanup(t, dir);
    commitMessage(dir, 'base\n\nno trailer\n');
    const baseSha = headSha(dir);
    const message =
      'docs: teach the trailer syntax\n\n'
      + `This body mentions ${trailerLine(ACK_TRAILER_HASH, 'fake/path.md', 'sneaky inline mention')} inline, `
      + 'as an example within a sentence.\n\n'
      + 'A trailing paragraph that is not trailer-shaped, so the mention above cannot be '
      + 'mistaken for the trailer block.\n';
    commitMessage(dir, message);
    const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
    assert.equal(r.hash.has('fake/path.md'), false, 'a mid-body mention must never parse as a live trailer');
    assert.equal(r.errors.length, 0);
  });

  test(
    'shrinkage needs no trailer — row 34 '
    + '(reader-level analog: the reader is diff-content-agnostic; the "never gated" '
    + 'behavior itself lives in diffEmitted, not rewired by this stub-only change)',
    (t) => {
      const dir = makeTempRepo('gsd-ack-trailer-34-');
      withCleanup(t, dir);
      commitMessage(dir, 'large\n\nno trailer\n');
      const baseSha = headSha(dir);
      commitMessage(dir, 'shrunk\n\nno trailer needed for shrinkage\n');
      const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
      assert.equal(r.errors.length, 0);
      assert.equal(r.hash.size, 0);
      assert.equal(r.growth.size, 0);
    },
  );

  test(
    'NEW_FILE_CAP is not excusable by a trailer — row 35 '
    + '(reader-level analog: the reader has no opinion on NEW_FILE_CAP and must read '
    + 'the trailer like any other hash entry; refusing to let it excuse the cap is '
    + 'diffEmitted\'s job, not rewired by this stub-only change)',
    (t) => {
      const dir = makeTempRepo('gsd-ack-trailer-35-');
      withCleanup(t, dir);
      commitMessage(dir, 'base\n\nno trailer\n');
      const baseSha = headSha(dir);
      commitMessage(
        dir,
        'new oversized file\n\n'
        + `${trailerLine(ACK_TRAILER_HASH, 'gsd-core/workflows/huge-new-file.md', 'trying to excuse a new-file-cap violation')}\n`,
      );
      const r = readAckTrailers({ baseRef: baseSha, headRef: 'HEAD', cwd: dir });
      assert.equal(
        r.hash.get('gsd-core/workflows/huge-new-file.md')?.reason,
        'trying to excuse a new-file-cap violation',
      );
    },
  );
});

// ─── hostile IO: uncomputable range, subprocess failure, timeout — rows 22-24 ─

describe('hostile IO: uncomputable range, subprocess failure, timeout', () => {
  test('uncomputable range throws, never passes vacuously — row 22', (t) => {
    const origin = makeTempRepo('gsd-ack-trailer-22-origin-');
    withCleanup(t, origin);
    commitMessage(origin, 'origin A\n\nfirst commit\n');
    const shaA = headSha(origin);
    commitMessage(origin, 'origin B\n\nsecond commit\n');
    commitMessage(origin, 'origin C\n\nthird commit\n');

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ack-trailer-22-clone-'));
    t.after(() => cleanup(clone));
    gitOrThrow(['clone', '-q', '--depth', '1', `file://${origin}`, clone], {
      cwd: origin,
      timeoutMs: GIT_FIXTURE_TIMEOUT_MS,
    });

    assert.throws(
      () => readAckTrailers({ baseRef: shaA, headRef: 'HEAD', cwd: clone }),
      /./,
      'a genuinely uncomputable merge-base (shallow clone missing the base object) must '
      + 'throw, never return an empty result',
    );
  });

  test('git failure surfaces, not swallowed — row 23', (t) => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ack-trailer-23-'));
    t.after(() => cleanup(notARepo));
    assert.throws(
      () => readAckTrailers({ baseRef: 'main', headRef: 'HEAD', cwd: notARepo }),
      /./,
      'a git failure (not a repository) must throw with the failure surfaced, never be '
      + 'read as "no trailers"',
    );
  });

  test('git log is bounded by a timeout — row 24', (t) => {
    const dir = makeTempRepo('gsd-ack-trailer-24-');
    withCleanup(t, dir);
    const rootSha = growHistoryFastImport(dir, 50000);

    const start = Date.now();
    assert.throws(
      () => readAckTrailers({ baseRef: rootSha, headRef: 'HEAD', cwd: dir, timeoutMs: 20 }),
      /time/i,
      'an unreadable-in-time git call must throw a timeout, never hang',
    );
    assert.ok(
      Date.now() - start < GIT_FIXTURE_TIMEOUT_MS,
      'must fail fast — never ride out the full seam default',
    );
  });
});

// ─── round-trip and properties — rows 33, 36, 37 ─────────────────────────────

describe('round-trip and properties', () => {
  test('taught syntax round-trips through the reader — row 33', () => {
    const line = renderAckTrailer(ACK_TRAILER_HASH, 'gsd-core/workflows/plan-phase.md', 'converter change, #3942');
    const prefix = `${ACK_TRAILER_HASH}:`;
    assert.ok(line.startsWith(prefix), 'rendered line must start with its own trailer name');
    const value = line.slice(prefix.length).trimStart();
    const { hash, errors } = parseAckTrailers({ hash: [value], growth: [] });
    assert.deepEqual(errors, []);
    assert.equal(hash.get('gsd-core/workflows/plan-phase.md')?.reason, 'converter change, #3942');
  });

  const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_./-'.split('');
  const REASON_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.#-'.split('');

  const keyArb = fc.array(fc.constantFrom(...KEY_ALPHABET), { minLength: 1, maxLength: 24 })
    .map((chars) => chars.join(''))
    .filter((k) => !RESERVED_KEYS.includes(k));

  const reasonArb = fc.array(fc.constantFrom(...REASON_ALPHABET), { minLength: 1, maxLength: 40 })
    .map((chars) => chars.join('').trim())
    .filter((s) => s.length > 0);

  test('prop: trailer render/parse is bijective — row 36', () => {
    fc.assert(
      fc.property(keyArb, reasonArb, (key, reason) => {
        const line = renderAckTrailer(ACK_TRAILER_HASH, key, reason);
        const prefix = `${ACK_TRAILER_HASH}:`;
        assert.ok(line.startsWith(prefix), 'rendered line must start with the trailer name');
        const value = line.slice(prefix.length).trimStart();
        const { hash, errors } = parseAckTrailers({ hash: [value], growth: [] });
        assert.deepEqual(errors, []);
        assert.equal(hash.get(key)?.reason, reason);
      }),
      { seed: 3942, numRuns: 300 },
    );
  });

  const uniqueKeysArb = fc.uniqueArray(keyArb, { minLength: 1, maxLength: 10 });

  test(
    'prop: every parsed entry lands in exactly one space, never silently dropped — row 37 '
    + '(reader-level analog of "every moved path lands in exactly one bucket": the full '
    + 'attributed/unattributable/acked conservation law is diffEmitted\'s, not this reader\'s)',
    () => {
      fc.assert(
        fc.property(uniqueKeysArb, reasonArb, (keys, reason) => {
          const hashValues = keys.map((k) => `${k}${ACK_TRAILER_DELIM}${reason}`);
          const { hash, errors } = parseAckTrailers({ hash: hashValues, growth: [] });
          assert.deepEqual(errors, []);
          assert.equal(hash.size, keys.length, 'every unique, well-formed key must be conserved — none silently dropped');
          for (const k of keys) {
            assert.equal(hash.get(k).reason, reason);
          }
        }),
        { seed: 3942, numRuns: 300 },
      );
    },
  );
});
