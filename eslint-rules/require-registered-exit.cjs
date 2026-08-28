'use strict';

const path = require('node:path');

/**
 * require-registered-exit
 *
 * Issue #3910 (epic #3889 Phase 6): "the raw terminator is banned by
 * construction." A raw `process.exit(...)` call bypasses the registered
 * exit-contract machinery in src/cli-exit.cts (ExitError/runMain for a CLI
 * path, terminateNow for a hook) — the whole point of ADR-3889 is that
 * EVERY process termination is projected through one of those two seams, so
 * a bare `process.exit()` re-opens exactly the "nothing fails with success"
 * defect class the epic exists to close.
 *
 * Flags: any `CallExpression` whose callee is a `MemberExpression` with
 * `object.name === 'process'` and `property.name === 'exit'` — i.e.
 * `process.exit(...)`.
 *
 * Does NOT flag `process.exitCode = N` — that assignment is the CORRECT
 * drain-then-exit pattern `runMain` itself uses, and conflating the two is
 * what inflated this epic's original raw-`process.exit()` census 2x (a
 * `MemberExpression` assignment target is never a `CallExpression`, so this
 * rule's `CallExpression`-only selector already excludes it structurally;
 * see the negative-control tests in tests/eslint-rules.test.cjs).
 *
 * ── Allowlist (exactly two sites, repo-wide) ────────────────────────────────
 *
 * 1. The body of `terminateNow` in src/cli-exit.cts — the single sanctioned
 *    terminator (ADR-3889 §3: write-then-terminate, the only place exit code
 *    2 — the hook-protocol deny — may be produced). Detected STRUCTURALLY
 *    below (any process.exit() call lexically nested inside a function
 *    declaration/expression named `terminateNow`, AND the file's basename is
 *    `cli-exit.cts`), not by a path+line number, which rots the instant the
 *    function grows or moves. The basename constraint is required in
 *    addition to the name check: without it, any function named
 *    `terminateNow` anywhere in the repo would silently inherit the
 *    allowlist, widening the rule's trust boundary to a name that can be
 *    typo'd or copy-pasted into an unrelated module.
 *
 * 2. gsd-core/bin/gsd-tools.cjs's `ensureRuntimeBuild` bootstrap-failure path
 *    (see its own inline `// eslint-disable-next-line local/require-registered-exit`
 *    comment). That call runs BEFORE `./lib/cli-exit.cjs` is even required —
 *    the registered-exit seam does not exist yet at that point in the
 *    process's lifetime, so there is nothing to route through. An inline
 *    disable directive WITH a reason comment at that one call site was
 *    chosen over a hardcoded path in this rule for the same reason
 *    terminateNow's allowlisting is structural rather than path-based: a
 *    path-keyed allowlist here would silently stop protecting the file the
 *    moment its bootstrap code moved, while an inline directive travels with
 *    the call site and fails loudly (an unused-disable lint error) if the
 *    surrounding code changes such that it is no longer needed.
 *
 * ── Known limits (documented, deliberately out of scope) ────────────────────
 *
 * The rule matches a literal `CallExpression` shaped exactly like
 * `process.exit(...)` (a non-computed MemberExpression on an Identifier
 * named `process` with a property named `exit`). It does NOT do scope/flow
 * analysis, so it cannot catch:
 *
 *   - `process['exit'](0)` — computed member access (same identifier, but
 *     `callee.computed` is true so the property-name check never runs).
 *   - `const e = process.exit; e(1);` — aliasing the function reference to a
 *     local binding before calling it; by the time the alias is called, the
 *     callee is a plain Identifier, not a MemberExpression on `process`.
 *   - `process.exit.call(null, 1)` / `process.exit.apply(null, [1])` —
 *     invoking `process.exit` indirectly via Function.prototype.call/apply;
 *     the outer CallExpression's callee is `process.exit.call`, not
 *     `process.exit` itself.
 *
 * Catching these would require binding/scope-aware analysis (tracking that a
 * local variable or a `.call`/`.apply` receiver resolves back to
 * `process.exit`), which is a materially different and more expensive class
 * of rule. Out of scope for this issue. See the pinning tests in
 * tests/eslint-rules.test.cjs ("KNOWN LIMIT (pinned, not endorsed)") that
 * assert these are NOT flagged today — if a future change starts catching
 * one of them, those tests will fail loudly instead of the change silently
 * altering the rule's reach.
 */

/**
 * True if `node` (a CallExpression) is lexically nested inside a function
 * declaration or function expression named `name`, walking up the ESLint
 * `.parent` chain. Used to allowlist the terminateNow body structurally —
 * see the module doc comment above.
 */
function isInsideFunctionNamed(node, name) {
  let current = node.parent;
  while (current) {
    if (
      (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression') &&
      current.id &&
      current.id.type === 'Identifier' &&
      current.id.name === name
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw process.exit() outside terminateNow — route CLI paths through runMain/ExitError, hooks through terminateNow, and drain-only exits through process.exitCode',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      rawProcessExit:
        'Raw process.exit() is banned outside terminateNow (ADR-3889). Use runMain/ExitError '
        + '(src/cli-exit.cts) for a CLI entrypoint, terminateNow (src/cli-exit.cts) for a hook that '
        + 'must write-then-terminate immediately, or set process.exitCode and let the process drain '
        + 'naturally when nothing needs an immediate hard exit.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.object.type !== 'Identifier' || callee.object.name !== 'process') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'exit') return;

        const filename = context.filename ?? context.getFilename();
        if (path.basename(filename) === 'cli-exit.cts' && isInsideFunctionNamed(node, 'terminateNow')) return;

        context.report({ node, messageId: 'rawProcessExit' });
      },
    };
  },
};

module.exports = rule;
