'use strict';

const path = require('path');

/**
 * no-adhoc-timeout-literal
 *
 * Flag a bare numeric literal used as a `timeout`/`timeoutMs` option value in
 * a test file. This is a **test-suite-only** convention rule — it does not
 * touch production `src/`/`bin/` code, where a literal like `execNpm(args, {
 * timeout: 15_000 })` bounds a real subprocess for real production
 * resilience. CONTRIBUTING.md/CLAUDE.md separately mandate that production
 * timeout bound on safety grounds (never hang); this rule is about naming a
 * shared, reviewed ceiling instead of scattering ad hoc guesses.
 *
 * ## What this enforces
 *
 * A bare `timeout`/`timeoutMs` literal scattered per call site drifts
 * silently from its siblings, or worse, collides exactly with one. That is
 * not hypothetical: on 2026-09-06, `gsd-core/bin/check-latest-version.cjs`
 * hardcoded `execNpm(args, { timeout: 15_000 })` and, independently,
 * `tests/gsd-check-update-worker-atomic-cache.test.cjs` hardcoded
 * `runHookSeam(WORKER_PATH, [], { timeoutMs: 15000 })` — two unrelated files,
 * same guessed number, no shared reference. When the inner one's timeout
 * fired, the outer one could SIGKILL the whole process tree at the exact
 * same instant before it could degrade gracefully: a zero-margin race that
 * failed specifically on Windows CI (fixed in PR #4428 by extracting a named
 * `NPM_VIEW_TIMEOUT_MS` constant and referencing it with an explicit
 * margin). This rule closes the gap CONTRIBUTING.md already documents:
 * "A non-literal value (`timeout: GIT_TIMEOUT_MS`) is trusted — that is the
 * shape you should be writing" — by actually enforcing that shape.
 *
 * ## Recognized shape
 *
 * Any non-computed `Property` node whose key is exactly `timeout` or
 * `timeoutMs` (string or Identifier key form) is flagged when its `value`
 * resolves, via `evalNumeric` (Literal number, unary +/-, or a `*`/`+`/`-`/`/`
 * BinaryExpression chain — same logic as `no-unbounded-spawn.cjs`), to a
 * concrete JS number. An `Identifier` value (including shorthand
 * `{ timeoutMs }`), a `MemberExpression` (`opts.timeout`,
 * `TIMEOUTS.PROBE`), or a `CallExpression` value all fail to resolve via
 * `evalNumeric` and are trusted as-is — this rule does not attempt general
 * expression evaluation, matching `no-unbounded-spawn`'s own philosophy of
 * trusting anything it can't literally evaluate to a number.
 *
 * ## No marker-comment escape
 *
 * Unlike `no-unbounded-spawn`'s `// allow-spawn-timeout-ceiling: <reason>`
 * (which has a genuine "sometimes a call really does need >600s" exception),
 * there is no legitimate reason a timeout value needs to stay an inline
 * literal forever — the fix is always "extract to a named constant," which
 * is trivial. The only escape here is the allowlist below, and it is a
 * temporary migration aid, not a permanent one.
 *
 * ## Allowlist
 *
 * `allowlist` (repo-relative POSIX paths) exempts pre-existing legacy
 * violations, with mechanics identical to `no-unbounded-spawn.cjs`: an
 * allowlisted file's violations are counted internally but not reported: a
 * listed file with zero violations reports `staleAllowlistEntry` so the dead
 * entry gets deleted. The allowlist only ever ratchets down.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a bare numeric literal as a timeout/timeoutMs option value in tests',
      category: 'Reliability',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      adhocTimeoutLiteral:
        'Bare numeric `{{key}}: {{value}}` literal: two independent hardcoded copies of the ' +
        'same guessed timeout can silently drift apart, or worse, collide exactly and produce ' +
        'a zero-margin race (this repo hit exactly that on 2026-09-06 — ' +
        '`bin/check-latest-version.cjs`\'s `timeout: 15_000` and this suite\'s independent ' +
        '`timeoutMs: 15000` could SIGKILL the whole tree at the same instant, PR #4428). ' +
        'Extract a named constant: import an existing one from `tests/helpers/timeouts.cjs` ' +
        '(`PROBE_TIMEOUT_MS`, `GIT_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`, `INSTALL_TIMEOUT_MS`) if this ' +
        'call is the same class of subprocess, or declare a local one with a comment justifying ' +
        'why it is a distinct class, per CONTRIBUTING.md\'s "Use Centralized Test Helpers" section.',
      staleAllowlistEntry:
        '{{file}} no longer contains an ad hoc timeout literal. Delete its line from ' +
        'eslint-rules/no-adhoc-timeout-literal.allowlist.json — the allowlist only ratchets down.',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];

    const TIMEOUT_KEYS = new Set(['timeout', 'timeoutMs']);

    const filename = context.filename || context.getFilename();
    const cwd = context.cwd || (context.getCwd ? context.getCwd() : process.cwd());
    const rel = path.relative(cwd, filename).split(path.sep).join('/');
    const allowlisted = allowlist.includes(rel);
    let violations = 0;

    /**
     * Returns the string value of a Literal node, or null.
     */
    function stringValue(node) {
      if (node && node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
      }
      return null;
    }

    /** Recursion depth cap for evalNumeric — guards against a pathological
     * nested-expression chain blowing the stack. */
    const MAX_EVAL_DEPTH = 20;

    /**
     * Recursively evaluates a numeric-ish AST node to a JS number, or
     * returns undefined if it's not one of the recognized numeric shapes.
     * Handles a numeric Literal, a unary +/- of a recursively-numeric
     * argument, and a BinaryExpression (*, +, -, /) where both sides are
     * recursively numeric — so a multi-term chain like `60 * 60 * 1000`
     * resolves instead of bailing out on the first nested BinaryExpression.
     * Identical logic to `no-unbounded-spawn.cjs`'s `evalNumeric`.
     */
    function evalNumeric(node, depth = 0) {
      if (depth > MAX_EVAL_DEPTH) return undefined;
      if (node.type === 'Literal' && typeof node.value === 'number') {
        return node.value;
      }
      if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
        const arg = evalNumeric(node.argument, depth + 1);
        if (arg === undefined) return undefined;
        return node.operator === '-' ? -arg : arg;
      }
      if (
        node.type === 'BinaryExpression' &&
        (node.operator === '*' || node.operator === '+' || node.operator === '-' || node.operator === '/')
      ) {
        const left = evalNumeric(node.left, depth + 1);
        const right = evalNumeric(node.right, depth + 1);
        if (left === undefined || right === undefined) return undefined;
        switch (node.operator) {
          case '*':
            return left * right;
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '/':
            return left / right;
          default:
            return undefined;
        }
      }
      return undefined;
    }

    return {
      Property(node) {
        if (node.computed) return;
        const keyName = node.key.type === 'Identifier' ? node.key.name : stringValue(node.key);
        if (!keyName || !TIMEOUT_KEYS.has(keyName)) return;

        const numeric = evalNumeric(node.value);
        if (numeric === undefined) return;

        violations += 1;
        if (allowlisted) return;

        context.report({
          node,
          messageId: 'adhocTimeoutLiteral',
          data: { key: keyName, value: String(numeric) },
        });
      },

      'Program:exit'(node) {
        if (allowlisted && violations === 0) {
          context.report({ node, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
