'use strict';

/**
 * no-unbounded-dirname-walk
 *
 * Flag an upward filesystem walk whose loop condition reassigns from
 * path.dirname() but has no fixed-point termination guard.
 *
 * ## Why (DEFECT.WINDOWS-TEST-PORTABILITY — the #4020 / #4220 Windows CI hang)
 *
 * `path.dirname()` is a NO-OP at the platform root, but the no-op VALUE
 * differs by platform: `path.posix.dirname('/') === '/'` (length 1), while
 * `path.win32.dirname('C:\\') === 'C:\\'` (length 3, NOT length 1). An
 * upward walk like
 *
 *   while (cur && cur !== someRoot && cur.length > 1) cur = dirname(cur);
 *
 * terminates on POSIX by accident — the walk reaches '/', whose length is 1
 * — but NEVER on Windows when the walk cannot equal `someRoot` (e.g. the
 * repo checkout on `D:\a\...` and a temp root on `C:\Users\...`): `cur !==
 * someRoot` holds forever, `dirname(cur)` reaches the drive root and stays
 * there, and a length check against a POSIX-shaped "root is length 1"
 * assumption never fires. The loop spins at 100% CPU with zero output until
 * something external kills it. That exact shape hung every scoped Windows
 * CI lane for a day — `scripts/run-tests.cjs`'s `sweepProtectSet` walk
 * (#4020, re-surfaced against a fresh Windows regression as #4220).
 *
 * ## What this enforces
 *
 * Any loop that reassigns its condition variable from a `dirname(...)` call
 * must ALSO test that the walk has reached a fixed point — the portable
 * root check — i.e. the condition set must include a comparison between the
 * variable and its own dirname:
 *
 *   while (cur && cur !== root && dirname(cur) !== cur) { ... }
 *
 * or compare against `path.parse(cur).root`, the other portable form. A
 * length-only or equality-only bound, with no fixed-point conjunct, is
 * reported as `unboundedWalk`.
 *
 * ## Recognized call shapes
 *
 * - Bare `dirname(...)` from a destructure (`const { dirname } = require('path')`)
 *   or an aliased one (`const { dirname: dir } = ...`).
 * - Chained `path.dirname(...)` / `require('path').dirname(...)`.
 * - `path.posix.dirname` / `path.win32.dirname` member chains.
 *
 * ## Zero escape hatches (ADR-1703)
 *
 * This rule joins the ADR-1703 `DEFECT.WINDOWS-TEST-PORTABILITY` catalog,
 * which deliberately carries no comment-based opt-out: a walk that is
 * bounded by some other genuinely portable mechanism (a hard iteration cap,
 * a dynamic non-literal boundary) must be structured so the rule recognizes
 * it — add the `dirname(cur) !== cur` (or `path.parse(cur).root`) conjunct
 * alongside the other bound, which costs nothing at runtime and is what the
 * shipped #4020/#4220 fix itself does. A false positive is a rule bug, fixed
 * in the rule — see `tests/portability-rule-disable-ban.test.cjs`, which
 * independently bans `eslint-disable` of this rule too.
 */

const DIAGNOSTIC = 'unboundedWalk';

const DIRNAME_RE = /^(?:dirname)$/;

/** Property chain tail of a member-ish callee: path.dirname -> 'dirname'. */
function propertyName(node) {
  return node && node.type === 'MemberExpression' && !node.computed
    ? node.property.name
    : null;
}

function isDirnameCall(expr) {
  if (!expr || expr.type !== 'CallExpression') return false;
  const callee = expr.callee;
  if (callee.type === 'Identifier') return DIRNAME_RE.test(callee.name);
  // path.dirname / path.posix.dirname / require('path').dirname
  return DIRNAME_RE.test(String(propertyName(callee) ?? ''));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'an upward dirname() walk must carry a fixed-point termination guard',
      category: 'Portability',
    },
    schema: [],
    messages: {
      [DIAGNOSTIC]:
        'This dirname() walk has no fixed-point termination guard (DEFECT.WINDOWS-TEST-PORTABILITY): ' +
        "path.dirname() is a no-op at the platform root (win32 dirname('D:\\\\') === 'D:\\\\'), so on " +
        'Windows a length- or equality-bounded walk over a path that never equals its target root ' +
        'spins forever at 100% CPU. Add `dirname(cur) !== cur` (or compare against ' +
        'path.parse(cur).root) to the loop condition. (#4020 / #4220 Windows CI hang)',
    },
  },

  create(context) {
    function checkWhile(node) {
      const test = node.test;
      // NOTE: test may be a single BinaryExpression (`while (cur !== root)`),
      // not only a compound LogicalExpression (`while (cur !== root && …)`)
      // — the minimal #4020/#4220 shape is a SINGLE unguarded condition, so
      // this must not require LogicalExpression up front. collect() below
      // already handles a non-LogicalExpression test correctly (pushes it as
      // the sole conjunct); only this early gate needs to admit that shape.
      if (!test) return;

      // The reassignment: cur = dirname(cur) somewhere in the body (or the
      // update clause of a for-loop shape routed through the same check).
      let reassignsFromDirname = false;
      const bodyStatements = node.body && node.body.type === 'BlockStatement'
        ? node.body.body
        : node.body
          ? [node.body]
          : [];
      for (const stmt of bodyStatements) {
        for (const child of [stmt, stmt.expression]) {
          if (
            child && child.type === 'AssignmentExpression' && child.operator === '=' &&
            child.left.type === 'Identifier' && isDirnameCall(child.right) &&
            child.right.arguments[0] && child.right.arguments[0].type === 'Identifier' &&
            child.right.arguments[0].name === child.left.name
          ) {
            reassignsFromDirname = true;
          }
        }
      }
      if (!reassignsFromDirname) return;

      // The guard: some conjunct compares the walked variable to its own
      // dirname, or to path.parse(<var>).root.
      let hasFixedPointGuard = false;
      const conjuncts = [];
      (function collect(e) {
        if (e && e.type === 'LogicalExpression') { collect(e.left); collect(e.right); }
        else if (e) conjuncts.push(e);
      })(test);
      for (const c of conjuncts) {
        if (c.type !== 'BinaryExpression' || !['!==', '!=', '===', '=='].includes(c.operator)) continue;
        // dirname(cur) <op> cur, or cur <op> dirname(cur)
        if ((isDirnameCall(c.left) && c.right.type === 'Identifier' &&
             isDirnameCall(c.right) === false && c.left.arguments[0] &&
             c.left.arguments[0].name === c.right.name) ||
            (isDirnameCall(c.right) && c.left.type === 'Identifier' &&
             c.right.arguments[0] && c.right.arguments[0].name === c.left.name)) {
          hasFixedPointGuard = true;
        }
        // path.parse(cur).root <op> cur — the other portable root sentinel.
        const isParseRoot = (n, other) =>
          n && n.type === 'MemberExpression' && !n.computed && n.property.name === 'root' &&
          n.object && n.object.type === 'CallExpression' &&
          /parse/.test(String(n.object.callee.property?.name ?? n.object.callee.name ?? '')) &&
          n.object.arguments[0] && n.object.arguments[0].type === 'Identifier' &&
          other && other.type === 'Identifier' &&
          n.object.arguments[0].name === other.name;
        if (isParseRoot(c.left, c.right) || isParseRoot(c.right, c.left)) {
          hasFixedPointGuard = true;
        }
      }
      if (hasFixedPointGuard) return;
      context.report({ node: test, messageId: DIAGNOSTIC });
    }

    return {
      WhileStatement: checkWhile,
      DoWhileStatement: checkWhile,
    };
  },
};
