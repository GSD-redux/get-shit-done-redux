'use strict';

/**
 * require-subprocess-timeout
 *
 * Flag: an `execSync` / `execFileSync` / `spawnSync` call (the synchronous
 * `node:child_process` primitives named in `DEFECT.UNBOUNDED-SUBPROCESS`)
 * whose options object does not carry a `timeout` key.
 *
 * The canonical defect: a sync subprocess with no `timeout` cannot be
 * interrupted and hangs indefinitely on a stuck remote, a large repo, or a
 * missing network — freezing the calling process (and, on a CI runner, the
 * whole chunk) with no diagnostic. CLAUDE.md's fix-forward is 5-30s for git,
 * 60s for npm, with a degraded-result + warning on timeout rather than a
 * throw.
 *
 * References:
 *   DEFECT.UNBOUNDED-SUBPROCESS (CONTEXT.md)
 *
 * Message:
 *   Cite DEFECT.UNBOUNDED-SUBPROCESS: a sync subprocess without `timeout`
 *   hangs indefinitely on a stuck remote/large repo/missing network. Add
 *   `timeout` (5-30s for git, 60s for npm).
 *
 * ── Known boundaries ─────────────────────────────────────────────────────────
 *
 * (a) Name-based matching only, mirroring require-fs-op-fallback.cjs's
 *     fs.rename precedent. Two callee shapes are recognized:
 *       - a bare Identifier call: `execSync(...)` / `execFileSync(...)` /
 *         `spawnSync(...)` (the destructured-import shape used by every
 *         production call site surveyed: `import { execFileSync } from
 *         'node:child_process'`).
 *       - a dotted MemberExpression call on ANY object identifier:
 *         `childProcess.spawnSync(...)`, `cp.execSync(...)` (the
 *         default-import shape). Unlike require-fs-op-fallback's `fs.rename`
 *         check, the object name is NOT constrained to a fixed spelling
 *         (e.g. `childProcess`) — `execSync`/`execFileSync`/`spawnSync` are
 *         distinctive enough names that constraining the receiver would only
 *         create false negatives for equally-valid aliases (`cp`,
 *         `child_process`), unlike the generic `rename` method name that
 *         motivated locking `fs.rename` to the `fs` spelling.
 *     There is deliberately no static verification that the callee actually
 *     resolves to `node:child_process` (no import-binding trace) — the
 *     production survey showed zero collisions with unrelated methods of
 *     these three names.
 *
 * (b) Options-argument POSITION is resolved by fixed Node.js call arity, not
 *     "the last argument" — `execSync(command, options?)` puts options at
 *     index 1; `execFileSync(file, args?, options?)` / `spawnSync(file,
 *     args?, options?)` put options at index 2. A fixed index (rather than
 *     "last argument") is required because a 2-argument execFileSync/
 *     spawnSync call's 2nd argument is the command's `args` ARRAY, not
 *     options — treating it as a candidate options value would silently
 *     swallow the "no options passed at all" case (categorically unbounded).
 *     The one Node.js shape this does NOT detect: `execFileSync(file,
 *     options)` with the middle `args` array omitted entirely — the
 *     production survey found zero call sites using it, so it is out of
 *     scope for v1.
 *
 * (c) Only an OBJECT LITERAL at that fixed index is inspected for a
 *     `timeout` property (a plain key, e.g. `timeout: 5000` or `timeout:
 *     opts.timeout ?? 10_000` — the key's PRESENCE is what matters, not its
 *     value). An Identifier or spread-only options argument
 *     (`execFileSync('git', args, opts)`) is NOT flagged — the options may
 *     have been pre-built with a timeout elsewhere and this rule chooses
 *     precision over recall rather than trace the identifier back to its
 *     declaration.
 *
 * (d) A call with NO options argument at that index at all
 *     (`execSync('git status')`, `execFileSync('git', ['status'])`) IS
 *     flagged. The production survey of `src/**\/*.cts` found every real
 *     call site already passes an options object literal — there is no
 *     existing "bare, no options" shape to accommodate — and a call with no
 *     options object has categorically no `timeout`, so it is the same
 *     defect as an options object missing the key.
 *
 * Suppression: `// allow-unbounded-subprocess: <reason>` as a trailing
 * comment on the call's line (mirrors the `// allow-adhoc-markdown: <reason>`
 * / `// allow-test-rule: <reason>` per-finding-exemption convention).
 */

const SYNC_SUBPROCESS_METHODS = new Set(['execSync', 'execFileSync', 'spawnSync']);

// Fixed options-argument index per method (see boundary (b) above):
//   execSync(command, options?)                -> options at index 1
//   execFileSync(file, args?, options?)        -> options at index 2
//   spawnSync(file, args?, options?)           -> options at index 2
const OPTIONS_ARG_INDEX = {
  execSync: 1,
  execFileSync: 2,
  spawnSync: 2,
};

/**
 * Returns the matched method name ('execSync'/'execFileSync'/'spawnSync') for
 * a bare Identifier call or a dotted MemberExpression call on any object
 * identifier (see boundary (a)), or null if `node` is not such a call.
 */
function matchSyncSubprocessMethodName(node) {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee.type === 'Identifier' && SYNC_SUBPROCESS_METHODS.has(callee.name)) {
    return callee.name;
  }
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    SYNC_SUBPROCESS_METHODS.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * Returns the AST node at the method's fixed options-argument index (see
 * OPTIONS_ARG_INDEX / boundary (b)), or undefined if the call was not given
 * that many arguments (no options passed at all).
 */
function getOptionsArgument(node, methodName) {
  const idx = OPTIONS_ARG_INDEX[methodName];
  return node.arguments[idx];
}

/**
 * True if `optionsArg` is an ObjectExpression that carries a `timeout` key
 * (any property kind: plain, computed-with-literal name). False for
 * `undefined` (no options argument at all — boundary (d)), a non-object
 * argument (Identifier/spread/etc — boundary (c)), or an object literal with
 * no `timeout` key.
 */
function hasTimeoutOptionsObject(optionsArg) {
  if (!optionsArg || optionsArg.type !== 'ObjectExpression') return false;
  return optionsArg.properties.some((prop) => {
    if (prop.type !== 'Property') return false; // skip SpreadElement
    if (prop.computed) {
      return prop.key.type === 'Literal' && prop.key.value === 'timeout';
    }
    if (prop.key.type === 'Identifier') return prop.key.name === 'timeout';
    if (prop.key.type === 'Literal') return prop.key.value === 'timeout';
    return false;
  });
}

/**
 * True if `optionsArg` IS present but is NOT an object literal (Identifier,
 * spread-built, CallExpression, etc) — i.e. a pre-built options value the
 * rule deliberately declines to trace (boundary (c): precision over recall).
 */
function isNonLiteralOptionsArg(optionsArg) {
  return optionsArg !== undefined && optionsArg.type !== 'ObjectExpression';
}

/**
 * True when a `// allow-unbounded-subprocess: <reason>` comment sits on the
 * node's start line or end line (covers both a trailing comment on a
 * single-line call and one on the closing-paren line of a multi-line call).
 */
function hasSuppressionComment(node, sourceCode) {
  const startLine = node.loc.start.line;
  const endLine = node.loc.end.line;
  const allComments = sourceCode.getAllComments();
  return allComments.some((c) => {
    if (!/allow-unbounded-subprocess:\s*\S/.test(c.value)) return false;
    return c.loc.start.line === startLine || c.loc.start.line === endLine;
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require execSync/execFileSync/spawnSync to carry a `timeout` option (DEFECT.UNBOUNDED-SUBPROCESS)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      requireSubprocessTimeout:
        'Unbounded sync subprocess: execSync/execFileSync/spawnSync without `timeout` hangs indefinitely ' +
        'on a stuck remote, a large repo, or missing network (DEFECT.UNBOUNDED-SUBPROCESS). Add `timeout` ' +
        '(5-30s for git, 60s for npm) and handle the timeout with a degraded result, not a throw. ' +
        'Suppress with: // allow-unbounded-subprocess: <reason>',
    },
  },

  create(context) {
    // Scope: src/**/*.cts only (never tests/**). eslint.config.mjs also scopes
    // the plugin registration to `files: ['src/**/*.cts']`, but RuleTester
    // runs the rule directly with no config-level file filtering, so the
    // filename check must live in the rule itself for the VALID
    // tests/**-filename test case to hold.
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (!/(?:^|\/)src\/.*\.cts$/.test(filename.replace(/\\/g, '/'))) {
      return {};
    }

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        const methodName = matchSyncSubprocessMethodName(node);
        if (!methodName) return;

        const optionsArg = getOptionsArgument(node, methodName);

        // Precision over recall: an Identifier/spread-built options arg is
        // not traced back to its declaration — not flagged.
        if (isNonLiteralOptionsArg(optionsArg)) return;

        // Object literal carrying a `timeout` key -> OK. (`optionsArg`
        // undefined — no options passed at all — falls through to report.)
        if (hasTimeoutOptionsObject(optionsArg)) return;

        if (hasSuppressionComment(node, sourceCode)) return;

        context.report({ node, messageId: 'requireSubprocessTimeout' });
      },
    };
  },
};

module.exports = rule;
