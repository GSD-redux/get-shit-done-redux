'use strict';

const path = require('path');

/**
 * no-unbounded-spawn
 *
 * Flag a synchronous child_process spawn (`spawnSync`, `execFileSync`,
 * `execSync`) in tests that is not timeout-bounded.
 *
 * ## What this enforces (DEFECT.UNBOUNDED-SUBPROCESS)
 *
 * An unbounded synchronous subprocess spawn can hang indefinitely. On
 * macOS CI this is how a stuck test silently stops reporting instead of
 * failing loudly — the runner just goes quiet. Every sync spawn in a test
 * must either:
 *   - pass an explicit `timeout` (ms) in its options object, sized to a
 *     sane ceiling, or
 *   - be routed through `tests/helpers/process-seam.cjs` (`runNode`,
 *     `runGit`, `runHook`), which is bounded by construction.
 *
 * ## Recognized call shapes
 *
 * - Bare identifier calls: `spawnSync(...)`, `execFileSync(...)`,
 *   `execSync(...)` — whether from a plain destructure
 *   (`const { execFileSync } = require('child_process')`) or an aliased
 *   one (`const { execSync: exec } = require('child_process')`), or an
 *   ES import (`import { execSync } from 'node:child_process'`, with or
 *   without a local alias).
 * - Chained member calls: `require('node:child_process').execFileSync(...)`
 *   — matched object-blind on the callee's `.property` name, the same
 *   shape `no-bare-npm-exec.cjs` matches.
 *
 * ## Timeout resolution
 *
 * The options argument (last call argument, if any) is inspected for a
 * `timeout` property. An ObjectExpression is inspected directly; an
 * Identifier is resolved to its single-write, object-literal-initialized
 * variable in an enclosing scope. Anything else (spread-only, array,
 * literal, or an unresolvable identifier) is treated as unbounded — the
 * rule never assumes a call is safe just because it can't prove otherwise.
 *
 * A resolved timeout value is only "bounded" when it's a positive finite
 * number at or under `maxTimeoutMs` (default 600000ms / 10 minutes). A
 * non-literal timeout expression (variable, member access, call) is
 * trusted as bounded — this rule does not attempt general expression
 * evaluation.
 *
 * ## Allowlist
 *
 * `allowlist` (repo-relative POSIX paths) grandfathers pre-existing
 * violations. The allowlist only ratchets down: a listed file with zero
 * violations reports `staleAllowlistEntry` so the dead entry gets deleted.
 *
 * ## The ceiling escape — `allow-spawn-timeout-ceiling`
 *
 * A literal timeout over `maxTimeoutMs` is permitted, without triggering
 * `timeoutTooLarge`, only when the call carries an inline
 * `// allow-spawn-timeout-ceiling: <reason>` marker comment with a
 * non-empty reason — the same idiom as `// allow-test-rule: <reason>`
 * documented in CONTRIBUTING.md. The marker may sit on the line
 * immediately above the call, or anywhere inside the call's own source
 * range (e.g. next to the `timeout:` property itself). It binds only to
 * the call it decorates, never file-wide, and a bare/whitespace-only
 * reason does not count. Critically, the escape only ever raises the
 * ceiling for a call that already has a resolvable numeric timeout — it
 * never waives the requirement for a bound: a marked call with no
 * timeout at all still reports `unboundedSpawn`.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow an unbounded synchronous child_process spawn (spawnSync/execFileSync/execSync) in tests',
      category: 'Reliability',
    },
    schema: [
      {
        type: 'object',
        properties: {
          maxTimeoutMs: { type: 'number' },
          allowlist: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unboundedSpawn:
        'Unbounded synchronous subprocess spawn (DEFECT.UNBOUNDED-SUBPROCESS): an ' +
        'unbounded subprocess is an indefinite hang, and on macOS CI that is how a ' +
        'stuck run silently stops reporting instead of failing loudly. Pass an ' +
        'explicit `timeout` (ms), or route this call through ' +
        'tests/helpers/process-seam.cjs (`runNode`/`runGit`/`runHook`), which is ' +
        'bounded by construction.',
      timeoutTooLarge:
        '`timeout: {{value}}` exceeds the {{max}}ms ceiling — a timeout that large ' +
        'is effectively unbounded. Size it to what the command actually runs.',
      staleAllowlistEntry:
        '{{file}} no longer contains an unbounded spawn. Delete its line from ' +
        'eslint-rules/no-unbounded-spawn.allowlist.json — the allowlist only ratchets down.',
    },
  },

  create(context) {
    const DEFAULT_MAX_TIMEOUT_MS = 600000; // 10 minutes
    const options = context.options[0] || {};
    const maxTimeoutMs =
      typeof options.maxTimeoutMs === 'number' ? options.maxTimeoutMs : DEFAULT_MAX_TIMEOUT_MS;
    const allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];

    const TARGET_FNS = new Set(['spawnSync', 'execFileSync', 'execSync']);
    const CP_SOURCES = new Set(['child_process', 'node:child_process']);

    /** Map from local (in-scope) name -> canonical target function name. */
    const aliases = new Map();

    /** Requires a non-empty, non-whitespace-only reason after the colon. */
    const CEILING_MARKER_RE = /allow-spawn-timeout-ceiling:\s*\S/;

    /**
     * Returns true if `node` (a CallExpression) carries a valid
     * `// allow-spawn-timeout-ceiling: <reason>` marker comment — either on
     * the line immediately above the call, or anywhere inside the call's
     * own source range. Binds to this call only: a marker decorating a
     * different call elsewhere in the file is never considered.
     */
    function hasCeilingMarkerComment(node) {
      const sourceCode = context.sourceCode || context.getSourceCode();
      const allComments = sourceCode.getAllComments();
      for (const comment of allComments) {
        const isInline = comment.range[0] >= node.range[0] && comment.range[1] <= node.range[1];
        const isImmediatelyAbove = comment.loc.end.line === node.loc.start.line - 1;
        if ((isInline || isImmediatelyAbove) && CEILING_MARKER_RE.test(comment.value)) {
          return true;
        }
      }
      return false;
    }

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

    /**
     * Returns the function name for a CallExpression callee (Identifier or
     * non-computed MemberExpression), or null. Object-blind on purpose for
     * MemberExpression — matches `require('node:child_process').execFileSync(...)`
     * regardless of the object expression.
     */
    function getFnName(callee) {
      if (callee.type === 'Identifier') return callee.name;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        return callee.property.name;
      }
      return null;
    }

    /**
     * Returns true if `node` is a CallExpression matching
     * `require('child_process')` / `require('node:child_process')`.
     */
    function isChildProcessRequire(node) {
      return (
        node &&
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length === 1 &&
        CP_SOURCES.has(stringValue(node.arguments[0]))
      );
    }

    /**
     * Registers aliases from an ObjectPattern destructuring a
     * child_process require: `const { execFileSync } = require(...)` or
     * `const { execSync: exec } = require(...)`.
     */
    function registerDestructureAliases(pattern) {
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const keyName = prop.key.type === 'Identifier' ? prop.key.name : stringValue(prop.key);
        if (!keyName || !TARGET_FNS.has(keyName)) continue;
        if (prop.value.type !== 'Identifier') continue;
        aliases.set(prop.value.name, keyName);
      }
    }

    /**
     * Resolves the options argument for a target call: the last call
     * argument, if any. Returns the ObjectExpression to inspect, or null
     * if it cannot be resolved to one.
     */
    function resolveOptionsNode(node) {
      const args = node.arguments;
      if (!args || args.length === 0) return null;
      const last = args[args.length - 1];
      if (last.type === 'ObjectExpression') return last;
      if (last.type === 'Identifier') {
        const scope =
          context.sourceCode && typeof context.sourceCode.getScope === 'function'
            ? context.sourceCode.getScope(node)
            : context.getScope();
        let cur = scope;
        while (cur) {
          const variable = cur.variables.find((v) => v.name === last.name);
          if (variable) {
            if (variable.defs.length !== 1) return null;
            const def = variable.defs[0];
            if (def.type !== 'Variable' || !def.node.init || def.node.init.type !== 'ObjectExpression') {
              return null;
            }
            const writeRefs = variable.references.filter((r) => r.isWrite());
            if (writeRefs.length > 1) return null;
            return def.node.init;
          }
          cur = cur.upper;
        }
        return null;
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

    /**
     * Determines the timeout verdict for an options ObjectExpression:
     * 'bounded' | 'unbounded' | { tooLarge: number }.
     */
    function timeoutVerdict(objExpr) {
      let timeoutProp = null;
      for (const prop of objExpr.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const keyName = prop.key.type === 'Identifier' ? prop.key.name : stringValue(prop.key);
        if (keyName === 'timeout') timeoutProp = prop;
      }
      if (!timeoutProp) return 'unbounded';

      const value = timeoutProp.value;
      let v;
      const numeric = evalNumeric(value);
      if (numeric !== undefined) {
        v = numeric;
      } else if (value.type === 'Literal' && value.value === null) {
        return 'unbounded';
      } else if (
        value.type === 'Identifier' &&
        (value.name === 'undefined' || value.name === 'NaN')
      ) {
        return 'unbounded';
      } else {
        // A variable/member/call bound is trusted; this rule does not
        // attempt general expression evaluation.
        return 'bounded';
      }

      if (!Number.isFinite(v) || v <= 0) return 'unbounded';
      if (v > maxTimeoutMs) return { tooLarge: v };
      return 'bounded';
    }

    /**
     * Registers alias imports from an ImportDeclaration: `import
     * { execSync } from 'node:child_process'` or an aliased
     * `import { execSync as exec } from ...`.
     */
    function registerImportAliases(node) {
      if (typeof node.source.value !== 'string' || !CP_SOURCES.has(node.source.value)) return;
      for (const spec of node.specifiers) {
        if (spec.type !== 'ImportSpecifier') continue;
        const importedName =
          spec.imported.type === 'Identifier' ? spec.imported.name : stringValue(spec.imported);
        if (!importedName || !TARGET_FNS.has(importedName)) continue;
        aliases.set(spec.local.name, importedName);
      }
    }

    /**
     * Recursively walks the whole AST from `root`, over own enumerable
     * object/array properties (skipping `parent` to avoid walking back up
     * and re-visiting already-visited nodes), invoking `visit` on every
     * node encountered. Used to build the alias map in a pre-pass so that
     * `CallExpression` — visited during the normal single top-down walk —
     * can resolve an alias regardless of where in the file it was declared
     * relative to the call site.
     */
    function walk(node, visit) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, visit);
        return;
      }
      if (typeof node.type !== 'string') return;
      visit(node);
      for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const value = node[key];
        if (value && typeof value === 'object') {
          walk(value, visit);
        }
      }
    }

    return {
      Program(node) {
        walk(node, (n) => {
          if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && isChildProcessRequire(n.init)) {
            registerDestructureAliases(n.id);
          } else if (n.type === 'ImportDeclaration') {
            registerImportAliases(n);
          }
        });
      },

      CallExpression(node) {
        let name = getFnName(node.callee);
        if (node.callee.type === 'Identifier' && aliases.has(name)) {
          name = aliases.get(name);
        }
        if (!name || !TARGET_FNS.has(name)) return;

        const optionsNode = resolveOptionsNode(node);
        const verdict = optionsNode ? timeoutVerdict(optionsNode) : 'unbounded';

        if (verdict === 'bounded') return;

        // The ceiling escape only ever raises the ceiling for a call that
        // already resolved to a numeric-but-too-large timeout. It never
        // applies to an 'unbounded' verdict — a marker cannot waive the
        // requirement for a bound.
        if (
          typeof verdict === 'object' &&
          verdict.tooLarge !== undefined &&
          hasCeilingMarkerComment(node)
        ) {
          return;
        }

        violations += 1;
        if (allowlisted) return;

        if (typeof verdict === 'object' && verdict.tooLarge !== undefined) {
          context.report({
            node,
            messageId: 'timeoutTooLarge',
            data: { value: String(verdict.tooLarge), max: String(maxTimeoutMs) },
          });
        } else {
          context.report({ node, messageId: 'unboundedSpawn' });
        }
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
