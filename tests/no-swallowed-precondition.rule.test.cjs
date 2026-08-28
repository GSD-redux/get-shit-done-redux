'use strict';

/**
 * no-swallowed-precondition.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-swallowed-precondition ESLint rule.
 *
 * Rule: flag a try/catch whose catch handler SWALLOWS the error (no rethrow)
 * where the try-block calls a filesystem CREATION verb (mkdirSync / openSync /
 * platformEnsureDir), AND the enclosing function separately references an
 * identifier named `*_ERRNO`/`*_ERRNOS` (the retry/tolerate-errno naming
 * convention). All three conditions must hold — see eslint-rules/
 * no-swallowed-precondition.cjs for the measured predicate (911 -> 24 -> 0).
 *
 * DEFECT category: issue #1884 (verbatim pre-fix shape reproduced here as the
 * positive control), rule shipped under #3987.
 *
 * INVALID (violation expected):
 *  - the verbatim #1884 pre-fix shape: swallowed platformEnsureDir inside a
 *    function that references a *_ERRNOS set elsewhere
 *  - swallowed mkdirSync inside a function referencing a *_ERRNOS set
 *  - swallowed openSync inside a function referencing a *_ERRNO (singular) set
 *
 * VALID (no violation):
 *  - the post-#1884-fix shape (no try/catch at all — propagates)
 *  - swallowed CLEANUP verb (rmSync/unlinkSync/closeSync) — the FP class,
 *    even inside a function that references a *_ERRNOS set
 *  - swallowed creation verb with NO errno-set reference anywhere in the
 *    enclosing function
 *  - creation-verb catch that DOES rethrow (not a swallow)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const noSwallowedPrecondition = require('../eslint-rules/no-swallowed-precondition.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-swallowed-precondition rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof noSwallowedPrecondition.meta, 'object');
    assert.strictEqual(typeof noSwallowedPrecondition.create, 'function');
    assert.strictEqual(noSwallowedPrecondition.meta.type, 'problem');
    assert.ok(noSwallowedPrecondition.meta.messages.noSwallowedPrecondition);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('no-swallowed-precondition invalid cases', () => {
  test('invalid: the verbatim #1884 pre-fix shape (platformEnsureDir swallowed, function references *_ERRNOS)', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [],
      invalid: [
        {
          code: `const PLANNING_LOCK_RETRY_ERRNOS = new Set(['ENOENT']);
function withPlanningLock(cwd, fn) {
  // Ensure .planning/ exists
  try { platformEnsureDir(planningDir(cwd)); } catch { /* ok */ }
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (PLANNING_LOCK_RETRY_ERRNOS.has(err.code)) continue;
      throw err;
    }
  }
}`,
          errors: [{ messageId: 'noSwallowedPrecondition' }],
        },
      ],
    });
  });

  test('invalid: swallowed mkdirSync inside a function referencing a *_ERRNOS set', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [],
      invalid: [
        {
          code: `const LOCK_RETRY_ERRNOS = new Set(['EBUSY']);
function acquireLock(lockPath) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* best-effort */ }
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (LOCK_RETRY_ERRNOS.has(err.code)) return null;
    throw err;
  }
}`,
          errors: [{ messageId: 'noSwallowedPrecondition' }],
        },
      ],
    });
  });

  test('invalid: swallowed openSync inside a function referencing a *_ERRNO (singular) set', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [],
      invalid: [
        {
          code: `const TOLERATED_ERRNO = new Set(['EEXIST']);
function open(p) {
  try { fs.openSync(p, 'wx'); } catch (e) {}
  return TOLERATED_ERRNO.has('EEXIST');
}`,
          errors: [{ messageId: 'noSwallowedPrecondition' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation) ────────────────────────────────────────────────

describe('no-swallowed-precondition valid cases', () => {
  test('valid: the post-#1884-fix shape — no try/catch, propagates', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [
        `const PLANNING_LOCK_RETRY_ERRNOS = new Set(['ENOENT']);
function withPlanningLock(cwd, fn) {
  // A genuine failure here MUST surface immediately.
  platformEnsureDir(planningDir(cwd));
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (PLANNING_LOCK_RETRY_ERRNOS.has(err.code)) continue;
      throw err;
    }
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: swallowed CLEANUP verbs (rmSync/unlinkSync/closeSync) are NOT flagged, even alongside a *_ERRNOS set', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [
        `const RETRY_ERRNOS = new Set(['EBUSY']);
function cleanupRm(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
  return RETRY_ERRNOS.has('EBUSY');
}`,
        `const RETRY_ERRNOS = new Set(['EBUSY']);
function cleanupUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* already released */ }
  return RETRY_ERRNOS.has('EBUSY');
}`,
        `const RETRY_ERRNOS = new Set(['EBUSY']);
function cleanupClose(fd) {
  try { fs.closeSync(fd); } catch { /* best-effort */ }
  return RETRY_ERRNOS.has('EBUSY');
}`,
      ],
      invalid: [],
    });
  });

  test('valid: swallowed creation verb with NO errno-set reference in the enclosing function', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [
        `function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* best-effort, no errno set here */ }
  return true;
}`,
      ],
      invalid: [],
    });
  });

  test('valid: creation-verb catch that DOES rethrow is not a swallow', () => {
    ruleTester.run('no-swallowed-precondition', noSwallowedPrecondition, {
      valid: [
        `const RETRY_ERRNOS = new Set(['EBUSY']);
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { throw e; }
  return RETRY_ERRNOS.has('EBUSY');
}`,
      ],
      invalid: [],
    });
  });
});
