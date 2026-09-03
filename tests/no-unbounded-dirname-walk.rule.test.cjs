'use strict';

/**
 * no-unbounded-dirname-walk.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-unbounded-dirname-walk ESLint rule.
 *
 * Rule: flag a while/do-while loop that reassigns its condition variable
 * from path.dirname() without a fixed-point termination guard
 * (DEFECT.WINDOWS-TEST-PORTABILITY, the #4020 / #4220 Windows CI hang:
 * path.win32.dirname() is a no-op at the drive root, so a length- or
 * equality-only bound spins forever there).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-unbounded-dirname-walk.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

describe('no-unbounded-dirname-walk rule module', () => {
  test('exports a create function and the unboundedWalk message', () => {
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.unboundedWalk, 'unboundedWalk message must exist');
  });
});

describe('no-unbounded-dirname-walk: invalid — no fixed-point guard', () => {
  test('invalid: the real #4020/#4220 shape — length-bounded walk against a POSIX-only sentinel', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [],
      invalid: [
        {
          // The exact shipped shape: on Windows the repo is on D:\, the target
          // root on C:\ — `cur !== runTempRoot` holds forever and win32
          // dirname('D:\\') is a fixed point, so this spins at 100% CPU.
          code: `
            const { dirname } = require('path');
            const protectSet = new Set();
            let cur = f;
            while (cur && cur !== runTempRoot && cur.length > 1) {
              protectSet.add(cur);
              cur = dirname(cur);
            }
          `,
          errors: [{ messageId: 'unboundedWalk' }],
        },
      ],
    });
  });

  test('invalid: destructured dirname with equality-only bound', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const { dirname } = require('path');
            let cur = file;
            while (cur !== root) {
              cur = dirname(cur);
            }
          `,
          errors: [{ messageId: 'unboundedWalk' }],
        },
      ],
    });
  });

  test('invalid: path.dirname member form with equality-only bound', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const path = require('path');
            let cur = file;
            while (cur !== root) {
              cur = path.dirname(cur);
            }
          `,
          errors: [{ messageId: 'unboundedWalk' }],
        },
      ],
    });
  });

  test('invalid: do-while form with no fixed-point guard', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const path = require('path');
            let cur = file;
            do {
              cur = path.dirname(cur);
            } while (cur !== root && cur.length > 1);
          `,
          errors: [{ messageId: 'unboundedWalk' }],
        },
      ],
    });
  });
});

describe('no-unbounded-dirname-walk: valid — fixed-point guard present', () => {
  test('valid: the real fixed shape — dirname(cur) !== cur added to the condition', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [
        {
          code: `
            const { dirname } = require('path');
            const protectSet = new Set();
            let cur = f;
            while (cur && cur !== runTempRoot && dirname(cur) !== cur) {
              protectSet.add(cur);
              cur = dirname(cur);
            }
          `,
        },
      ],
      invalid: [],
    });
  });

  test('valid: walk bounded via path.parse(cur).root', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [
        {
          code: `
            const path = require('path');
            let cur = file;
            while (cur && cur !== path.parse(cur).root) {
              cur = path.dirname(cur);
            }
          `,
        },
      ],
      invalid: [],
    });
  });

  test('valid: a length-only bound is still unsafe in principle, but the fixed-point conjunct present here silences it', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [
        {
          code: `
            const { dirname } = require('path');
            let cur = file;
            while (cur && cur.length > 1 && dirname(cur) !== cur) {
              cur = dirname(cur);
            }
          `,
        },
      ],
      invalid: [],
    });
  });

  test('valid: not a dirname walk at all — a linked-list traversal must stay silent', () => {
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [
        {
          code: `
            let cur = list.head;
            while (cur && cur.length > 1) { cur = cur.next; }
          `,
        },
      ],
      invalid: [],
    });
  });

  test('invalid: a length comparison against another expression\'s length is still unguarded — no fixed-point conjunct present', () => {
    // Confirms the rule does not special-case a dynamic (non-literal) length
    // bound as an implicit guard: only an explicit fixed-point conjunct
    // silences it. This rule has NO comment-marker escape hatch (ADR-1703
    // zero-escape-hatch) — a loop shaped like this needs an added
    // `dirname(cur) !== cur` (or `path.parse(cur).root`) conjunct; there is
    // no annotation-based way to silence it instead.
    ruleTester.run('no-unbounded-dirname-walk', rule, {
      valid: [],
      invalid: [
        {
          code: `
            let cursor = path.dirname(path.resolve(target));
            const stop = path.resolve(root);
            while (cursor.length >= stop.length && cursor.startsWith(stop)) {
              if (check(cursor)) return true;
              cursor = path.dirname(cursor);
            }
          `,
          errors: [{ messageId: 'unboundedWalk' }],
        },
      ],
    });
  });
});
