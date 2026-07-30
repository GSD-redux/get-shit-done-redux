'use strict';

/**
 * no-path-literal-in-assert
 *
 * Flag assertion calls where a path-returning function (path.join, path.resolve,
 * getGlobalConfigDir, …) is compared to a hardcoded POSIX-slash string literal.
 * These assertions FAIL on Windows because path.join emits backslashes.
 *
 * Triggers on:
 *   assert.equal|strictEqual|deepEqual|deepStrictEqual(actual, expected)
 *   expect(actual).toBe|toEqual|toStrictEqual(expected)
 *
 * Out of scope — intentionally NOT reported:
 *   assert.notEqual|notStrictEqual(actual, expected)
 *   expect(actual).not.toBe|not.toEqual|not.toStrictEqual(expected)
 *   A path-vs-POSIX-literal INEQUALITY passes on Windows regardless of separator
 *   differences, so it does not exhibit the portability-defect shape this rule
 *   targets.
 *
 * Suppressed when:
 *   - The path operand is wrapped by a POSIX normalizer (replace/replaceAll/toPosixPath/…)
 *   - The assertion is inside a Windows-excluded block (platform guard, early-return,
 *     hoisted isWindows) as detected by platform-guard.cjs
 *
 * DEFECT category: DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT
 *
 * ── Known boundaries ───────────────────────────────────────────────────────────
 *
 * (a) Name-based matching only.  The rule recognises `path`, `os`, and the
 *     project resolver names listed in PATH_RETURNING_FNS by spelling alone.  If
 *     a test file declares a LOCAL variable named `path` that shadows the real
 *     `path` module, that shadow is out of scope — the rule will still treat a
 *     `path.join(...)` call as path-returning.
 *
 * (b) Shallow operand inspection.  Only the direct first/second argument of the
 *     assert call is inspected, plus one level of `String(<x>)` cast and one
 *     level of non-normalizer method-chain peeling (`.replace()`, `.replaceAll()`,
 *     `.split().join()`).  Deeper wrapping — e.g. `.toLowerCase()` applied after
 *     a path call, or `fs.realpathSync(path.join(...))` — is NOT detected as a
 *     path-returning expression and will not trigger the rule.
 *
 * (c) Harmless no-op remedy.  For explicit dir-pass-through assertions (where the
 *     path really does contain forward-slashes even on Windows), wrapping with
 *     `String(<x>).replace(/\\\\/g, '/')` is the correct suppression; on POSIX
 *     systems where `\\` never appears, the replace is a no-op and has zero cost.
 *
 * (d) #2764 membership/substring shape — `.includes/.indexOf/.startsWith/.endsWith`
 *     (string-literal arg) and `.match` (regex-literal arg) over a receiver that
 *     traces to a path-returning call (directly or via `.map()` hops). For `.match`,
 *     ANY regex literal whose source contains a `/` is treated as a POSIX-path
 *     membership check; a non-path regex containing `/` on a path-returning receiver
 *     (e.g. `.match(/https:\/\//)`) will also fire. The rule is scoped to the
 *     `tests/` test-file glob, so every such call is a test assertion shape.
 */

const {
  isPathReturningCall,
  isPosixSlashStringLiteral,
  isPosixNormalizerCall,
  unwrapString,
  unwrapNonNormalizerMethodChain,
} = require('./lib/portability-vocab.cjs');

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow path-returning calls compared to hardcoded POSIX-slash literals in assertions (fails on Windows)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      pathLiteral:
        "Path-returning call compared to a hardcoded '/'-literal (DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT): " +
        "fails on Windows where path.join emits '\\\\'. " +
        "Normalize the actual: String(<expr>).replace(/\\\\\\\\/g, '/') or .replaceAll(path.sep, '/').",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** assert.equal / assert.strictEqual / assert.deepEqual / assert.deepStrictEqual */
    const ASSERT_EQUALITY_METHODS = new Set([
      'equal',
      'strictEqual',
      'deepEqual',
      'deepStrictEqual',
    ]);

    /** expect(actual).<matcher>(expected) */
    const EXPECT_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

    // ── #2764 helpers: membership / substring checks over a path-returner ──────
    // .includes / .indexOf / .startsWith / .endsWith / .match on a receiver that
    // traces to a path-returning call (directly, or through ONE .map(f => path-…)
    // hop). The receiver is unwrapped through String() and one non-normalizer
    // method chain, and may itself be a .map(...) whose callback returns a path
    // call — the exact #2728 shape (arr.map(f => path.relative(R, f)).includes(x)).
    const MEMBERSHIP_METHODS = new Set([
      'includes',
      'indexOf',
      'startsWith',
      'endsWith',
    ]);

    // True when `receiverNode` is (or traces to) a path-returning call, respecting
    // POSIX-normalizer suppression. Traces: String() cast → non-normalizer method
    // chain peel → .map(callback-returning-a-path-call) hops (recursively — nested
    // .map() is also traced, since each recursion descends into a smaller subtree).
    function receiverIsPathReturning(receiverNode) {
      if (!receiverNode) return false;
      // Suppressed if the receiver is already a valid POSIX normalizer.
      if (isPosixNormalizerCall(receiverNode)) return false;

      let probe = unwrapString(receiverNode);
      if (isPathReturningCall(probe)) return true;

      // Peel one non-normalizer method chain (.replace / .replaceAll / .split().join()).
      const peeled = unwrapNonNormalizerMethodChain(receiverNode);
      if (peeled != null) {
        const inner = unwrapString(peeled);
        if (isPathReturningCall(inner)) return true;
      }

      // ONE .map(callback) hop: arr.map(f => path.relative(...)) — the callback's
      // return expression is the path-returner. Arrow with a body, or arrow with a
      // single-expression concisereturn, or a `function` with a single return.
      if (
        receiverNode.type === 'CallExpression' &&
        receiverNode.callee.type === 'MemberExpression' &&
        !receiverNode.callee.computed &&
        receiverNode.callee.property.type === 'Identifier' &&
        receiverNode.callee.property.name === 'map' &&
        receiverNode.arguments.length >= 1
      ) {
        const cb = receiverNode.arguments[0];
        const retExpr = mapCallbackReturnExpression(cb);
        if (retExpr && receiverIsPathReturning(retExpr)) return true;
      }
      return false;
    }

    // Extracts the returned expression from a .map() callback (arrow concise body,
    // arrow block with one return, or function with one return). Null otherwise.
    function mapCallbackReturnExpression(cb) {
      if (!cb) return null;
      if (cb.type === 'ArrowFunctionExpression') {
        if (cb.body && cb.body.type !== 'BlockStatement') return cb.body; // concise
        const stmts = cb.body && cb.body.body ? cb.body.body : [];
        const ret = stmts.find((s) => s.type === 'ReturnStatement');
        if (ret && stmts.filter((s) => s.type === 'ReturnStatement').length === 1) {
          return ret.argument;
        }
      } else if (cb.type === 'FunctionExpression') {
        const stmts = cb.body && cb.body.body ? cb.body.body : [];
        const ret = stmts.find((s) => s.type === 'ReturnStatement');
        if (ret && stmts.filter((s) => s.type === 'ReturnStatement').length === 1) {
          return ret.argument;
        }
      }
      return null;
    }

    /**
     * Returns true when `pathNode` represents a path call and `literalNode` is
     * a POSIX slash literal, AND the path call is NOT already normalized.
     *
     * `rawPathNode` is the operand as-is (before unwrapping) — we check it for
     * normalizer wrapping before stripping String().
     *
     * Lookup order:
     *   1. If rawPathNode IS a valid POSIX normalizer → no violation.
     *   2. Unwrap String() cast → check if inner call is a path call.
     *   3. If rawPathNode is a non-normalizer method chain (e.g. .replace(/foo/g,'/'))
     *      peel one layer to find if the receiver is a path-returning call.
     */
    function isViolation(rawPathNode, rawLiteralNode) {
      // Is the path-side already wrapped by a POSIX normalizer?
      if (isPosixNormalizerCall(rawPathNode)) return false;

      // Unwrap String() cast to see the inner call
      const pathNode = unwrapString(rawPathNode);

      if (isPathReturningCall(pathNode)) {
        if (!isPosixSlashStringLiteral(rawLiteralNode)) return false;
        return true;
      }

      // C1: if rawPathNode is a non-normalizer method chain (.replace, .replaceAll,
      // .split().join()) wrapping a path call, that is still a violation — the method
      // chain does not perform a valid POSIX normalization.
      const peeled = unwrapNonNormalizerMethodChain(rawPathNode);
      if (peeled != null) {
        const innerPath = unwrapString(peeled);
        if (isPathReturningCall(innerPath) && isPosixSlashStringLiteral(rawLiteralNode)) {
          return true;
        }
      }

      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // ── assert.<method>(actual, expected) ──────────────────────────────
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'assert' &&
          callee.property.type === 'Identifier' &&
          ASSERT_EQUALITY_METHODS.has(callee.property.name)
        ) {
          const args = node.arguments;
          if (args.length < 2) return;
          const actual = args[0];
          const expected = args[1];
          // Ignore 3rd arg (message)

          const violated =
            isViolation(actual, expected) ||
            isViolation(expected, actual);

          if (violated && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'pathLiteral' });
          }
          return;
        }

        // ── expect(actual).<matcher>(expected) ─────────────────────────────
        // Shape: CallExpression{ callee: MemberExpression{ object: CallExpression{callee: Identifier{expect}}, property: Identifier{<matcher>} } }
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          EXPECT_MATCHERS.has(callee.property.name) &&
          callee.object.type === 'CallExpression' &&
          callee.object.callee.type === 'Identifier' &&
          callee.object.callee.name === 'expect' &&
          callee.object.arguments.length === 1
        ) {
          const actual = callee.object.arguments[0]; // the arg to expect(...)
          const matcherArgs = node.arguments;
          if (matcherArgs.length < 1) return;
          const expected = matcherArgs[0];

          const violated =
            isViolation(actual, expected) ||
            isViolation(expected, actual);

          if (violated && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'pathLiteral' });
          }
          return;
        }

        // ── #2764: <path-returning-expr>.<membership-method>(<posix-literal>) ──
        // .includes / .indexOf / .startsWith / .endsWith (and .match(/slashes/))
        // over a receiver that traces to a path-returning call (directly or via
        // one .map() hop). The rule runs on tests/**/*.test.cjs only, so every such
        // call is a test assertion shape that fails on Windows.
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          (MEMBERSHIP_METHODS.has(callee.property.name) ||
            callee.property.name === 'match')
        ) {
          const receiver = callee.object;
          if (!receiverIsPathReturning(receiver)) return;
          // The argument must be a POSIX-slash string literal (or, for .match, a
          // regex literal whose pattern contains a slash).
          const arg = node.arguments[0];
          const argIsPosix =
            arg && isPosixSlashStringLiteral(arg);
          const argIsSlashRegex =
            callee.property.name === 'match' &&
            arg &&
            arg.type === 'Literal' &&
            arg.regex &&
            typeof arg.regex.pattern === 'string' &&
            arg.regex.pattern.includes('/');
          if (argIsPosix || argIsSlashRegex) {
            if (!isWindowsExcludedNode(node, sourceCode)) {
              context.report({ node, messageId: 'pathLiteral' });
            }
          }
          return;
        }
      },
    };
  },
};

module.exports = rule;
