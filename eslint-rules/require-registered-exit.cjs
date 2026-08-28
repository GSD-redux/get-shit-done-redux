'use strict';

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
 *    declaration/expression named `terminateNow`), not by a path+line number,
 *    which rots the instant the function grows or moves.
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

        if (isInsideFunctionNamed(node, 'terminateNow')) return;

        context.report({ node, messageId: 'rawProcessExit' });
      },
    };
  },
};

module.exports = rule;
