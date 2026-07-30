'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyBucket,
  evaluatePrTitle,
} = require('../scripts/release-notes/conventional-title.cjs');

// The changelog classifier must consume the SAME matcher (single source of
// truth — see #1549). If someone forks the regex, this cross-check breaks.
const {
  classifyTitle,
} = require('../scripts/release-notes/format-github-release-notes.cjs');

// ---------------------------------------------------------------------------
// classifyBucket — the shared bucket matcher (operates on a clean title)
// ---------------------------------------------------------------------------

describe('classifyBucket', () => {
  test('feat(#N): -> Feature', () => {
    assert.equal(classifyBucket('feat(#39): milestone-prefixed phase IDs'), 'Feature');
  });

  test('feature(x): -> Feature', () => {
    assert.equal(classifyBucket('feature(x): something'), 'Feature');
  });

  test('feat: -> Feature', () => {
    assert.equal(classifyBucket('feat: some feature'), 'Feature');
  });

  test('fix(#N): -> Fix', () => {
    assert.equal(classifyBucket('fix(#1542): roadmap rollback'), 'Fix');
  });

  test('fix: -> Fix', () => {
    assert.equal(classifyBucket('fix: another fix'), 'Fix');
  });

  test('chore(#N): -> Internal (#2716 — non-user-facing type)', () => {
    assert.equal(classifyBucket('chore(#2): some chore'), 'Internal');
  });

  test('untyped title -> Enhancement (catch-all)', () => {
    assert.equal(classifyBucket('Main changes'), 'Enhancement');
  });

  // Documents the mis-bucket #1549 exists to prevent at the gate: a leading
  // tag defeats the `^fix` anchor, so a security fix silently files under
  // Enhancement. classifyBucket faithfully reproduces this — the FIX is the
  // PR-title gate (evaluatePrTitle) rejecting such titles before they land,
  // not changing this catch-all (that is out of scope, flagged in #1549).
  test('[security] fix(...) mis-buckets to Enhancement (the reason the gate exists)', () => {
    assert.equal(classifyBucket('[security] fix(config): the #1534 case'), 'Enhancement');
  });
});

// ---------------------------------------------------------------------------
// Single source of truth: the changelog classifier delegates to the shared
// matcher, so the gate and the changelog can never disagree on bucketing.
// ---------------------------------------------------------------------------

describe('classifyTitle delegates to classifyBucket', () => {
  for (const core of [
    'feat(#39): x',
    'fix(#1): x',
    'fix(core): x',
    '[security] fix(config): x',
    'chore(#2): x',
  ]) {
    test(`agree on bucket for ${JSON.stringify(core)}`, () => {
      // classifyTitle takes a full changelog bullet line (marker + ` by @`).
      const bullet = `* ${core} by @someone in https://github.com/open-gsd/gsd-core/pull/1`;
      assert.equal(classifyTitle(bullet), classifyBucket(core));
    });
  }
});

// ---------------------------------------------------------------------------
// evaluatePrTitle — the PR-title gate (#1549)
// ---------------------------------------------------------------------------

describe('evaluatePrTitle — valid titles', () => {
  for (const title of [
    'fix(#1542): roadmap rollback',
    'feat(#39): milestone-prefixed phase IDs',
    'enhance(#1549): add PR-title convention validator',
    'docs(#1234): clarify the title rule',
  ]) {
    test(`accepts ${JSON.stringify(title)}`, () => {
      assert.deepEqual(evaluatePrTitle({ title }), { valid: true, reason: 'valid' });
    });
  }
});

describe('evaluatePrTitle — rejected titles', () => {
  test('component scope without an issue ref -> missing-issue-ref', () => {
    const r = evaluatePrTitle({ title: 'fix(core): six PRs like this' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing-issue-ref');
  });

  test('type with colon but no scope -> missing-issue-ref', () => {
    const r = evaluatePrTitle({ title: 'fix: no scope at all' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing-issue-ref');
  });

  // Boundary: a scope with a `#` but zero digits. `/#\d+/` requires at least
  // one digit, so `(#)` is not an issue ref — pin it so a future regex tweak
  // can't silently start accepting linkless titles.
  test('scope with a hash but no digits -> missing-issue-ref', () => {
    const r = evaluatePrTitle({ title: 'fix(#): no digits after the hash' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing-issue-ref');
  });

  test('leading tag before the type -> bad-prefix (defeats bucketing)', () => {
    const r = evaluatePrTitle({ title: '[security] fix(#1534): the doubly-broken case' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'bad-prefix');
  });

  test('no clean type prefix (auto-revert title) -> bad-prefix', () => {
    const r = evaluatePrTitle({ title: 'Revert "fix(#1): something"' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'bad-prefix');
  });

  test('empty title -> bad-prefix', () => {
    const r = evaluatePrTitle({ title: '' });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'bad-prefix');
  });

  test('breaking-change marker feat(#N)!: is accepted', () => {
    assert.deepEqual(
      evaluatePrTitle({ title: 'feat(#42)!: drop the legacy flag' }),
      { valid: true, reason: 'valid' }
    );
  });

  test('invalid results carry a human-facing message', () => {
    const r = evaluatePrTitle({ title: 'fix(core): no ref' });
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// #2716: non-user-facing conventional types (test/chore/ci/docs/refactor/perf/
// revert) classify to 'Internal', NOT 'Enhancement' — they must not render under
// the user-facing Enhancement heading in release notes. Untyped and anchor-
// defeated titles stay in the visible Enhancement fallback (safety net).
// ---------------------------------------------------------------------------

describe('classifyBucket #2716: non-user-facing types → Internal', () => {
  for (const type of ['test', 'chore', 'ci', 'docs', 'refactor', 'perf', 'revert']) {
    test(`${type}(#N): → Internal (not Enhancement)`, () => {
      assert.equal(classifyBucket(`${type}(#100): some internal work`), 'Internal');
    });
    test(`${type}: (no scope) → Internal`, () => {
      assert.equal(classifyBucket(`${type}: some internal work`), 'Internal');
    });
  }

  test('feat/fix classification is unchanged', () => {
    assert.equal(classifyBucket('feat(#5): new thing'), 'Feature');
    assert.equal(classifyBucket('fix(#6): fix thing'), 'Fix');
  });

  test('untyped title stays in Enhancement (safety net)', () => {
    assert.equal(classifyBucket('Main changes'), 'Enhancement');
  });

  test('[security] fix(...) stays in Enhancement (anchor-defeated safety net)', () => {
    assert.equal(classifyBucket('[security] fix(config): the case'), 'Enhancement');
  });
});
