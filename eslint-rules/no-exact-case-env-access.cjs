'use strict';

const path = require('node:path');
const { isCaseVaryingEnvVarName } = require('./lib/portability-vocab.cjs');

/**
 * no-exact-case-env-access
 *
 * `process.env` is a case-insensitive Proxy on every platform, so
 * `process.env.PATH` (or `process.env['PATH']`) is always safe even though
 * Windows itself ships several of these variables under a different
 * conventional casing (`Path`, `ComSpec`, ...). The moment that value is
 * copied into, or read through, ANY other object — a spread of
 * `process.env`, a function parameter, a destructure with no traceable
 * source — the exact-case Windows spelling is what survives, and an
 * uppercase POSIX-style lookup against it silently resolves to `undefined`
 * on Windows.
 *
 * This rule flags two shapes reading any casing of any name in
 * WINDOWS_CASE_VARYING_ENV_VARS off a receiver that is not `process.env`
 * itself:
 *
 *   1. MemberExpression reads — `env.PATH`, `opts.env['ComSpec']` — but NOT
 *      `process.env.PATH` / `process.env['PATH']`.
 *   2. ObjectPattern destructuring — `const { PATH } = env` — but NOT
 *      `const { PATH } = process.env`.
 *
 * The `process.env` check (isProcessEnvExpression) is deliberately
 * syntactic-only, not flow-sensitive: it recognizes exactly `process.env`
 * and `process['env']` at the access site, one level deep, with no alias
 * tracking (`const env = process.env; env.PATH` is NOT recognized as safe
 * and WILL be flagged — route through envGet or destructure directly from
 * process.env instead).
 *
 * MemberExpression matching requires an "env-shaped" receiver (see
 * isEnvShapedExpression) for BOTH notations, dot and bracket alike, because
 * a first pass that flagged any `<object>.<name>` where `<name>` is
 * vocab-matching produced 113 false positives — ordinary lowercase property
 * access like `config.path` or `entry.path` collides with the
 * (case-insensitive) vocab list — and a later pass that special-cased
 * bracket form to report unconditionally reintroduced the same class of
 * false positive (`artifact['path']` on an unrelated `Record<string,
 * unknown>` is not an env read just because the key string matches):
 *
 *   - Dot form (`X.PATH`, non-computed) and bracket form (`X['PATH']`,
 *     computed + string Literal) are both reported ONLY when the receiver
 *     `X` is "env-shaped" — i.e. an identifier literally named `env` (any
 *     casing) or a MemberExpression whose property resolves to `env` (any
 *     casing), such as `opts.env.PATH` / `opts.env['ComSpec']`. Neither
 *     notation is precise enough on its own risk-wise; the receiver check
 *     is what keeps `config.path`, `entry.path`, `artifact['path']`, etc.
 *     unflagged while still catching the real risk shapes.
 *
 * ObjectPattern destructuring gets the same dot-notation-style restriction
 * for symmetry: `const { PATH } = env` / `const { PATH } = opts.env` are
 * flagged, but `const { path } = someConfigObject` is not, because the
 * traced source there is not env-shaped.
 *
 * The seam exemption is PATH-SUFFIX ANCHORED, not substring-matched — see
 * isSeamFile in no-private-binary-resolution.cjs for the identical logic and
 * rationale (case I9 pins the distinction there).
 */

const SEAM_RELATIVE_PATH = 'src/shell-command-projection.cts';

/**
 * True when `filename` IS the seam file, matched by path SUFFIX after
 * normalizing separators to `/` — never by substring containment anywhere
 * else in the path.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isSeamFile(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  const normalized = filename.split(path.sep).join('/');
  return normalized === SEAM_RELATIVE_PATH || normalized.endsWith(`/${SEAM_RELATIVE_PATH}`);
}

/**
 * True when `node` is the expression `process.env` (non-computed, property
 * is Identifier `env`) or `process['env']` (computed, property is a string
 * Literal `'env'`). Nothing else counts: no alias tracking, no deeper
 * unwrapping — this is a deliberate, documented limit of the rule.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isProcessEnvExpression(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.object.type !== 'Identifier' || node.object.name !== 'process') return false;
  if (!node.computed) {
    return node.property.type === 'Identifier' && node.property.name === 'env';
  }
  return node.property.type === 'Literal' && node.property.value === 'env';
}

/**
 * True when `node` is "env-shaped": a receiver whose own name/property is an
 * exact case-insensitive match to `env`, one level deep, no fuzzy/substring
 * matching. Matches:
 *
 *   - Identifier `env` / `Env` / `ENV` (a bare env parameter or variable).
 *   - MemberExpression `X.env` / `X.Env` / `X['env']` / `X['Env']` (property
 *     resolves, case-insensitively, to the literal name `env`).
 *
 * Anything else — including a MemberExpression whose OBJECT is further
 * env-shaped (`a.b.env.PATH`) — is not unwrapped further; this is a
 * deliberate one-level-deep limit, matching isProcessEnvExpression's own
 * documented limit.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isEnvShapedExpression(node) {
  if (!node) return false;
  if (node.type === 'Identifier') {
    return typeof node.name === 'string' && node.name.toLowerCase() === 'env';
  }
  if (node.type === 'MemberExpression') {
    if (!node.computed) {
      return node.property.type === 'Identifier' && node.property.name.toLowerCase() === 'env';
    }
    return (
      node.property.type === 'Literal' &&
      typeof node.property.value === 'string' &&
      node.property.value.toLowerCase() === 'env'
    );
  }
  return false;
}

/**
 * Extracts the statically-known accessed/destructured name from a
 * MemberExpression's property or an ObjectPattern Property's key.
 *
 *   - non-computed Identifier (`env.PATH`, `{ PATH: v }`): use `.name`.
 *   - Literal string key/property, computed OR non-computed
 *     (`env['PATH']`, `{ ['PATH']: v }`, and — non-computed only for
 *     ObjectPattern keys — `{ 'PATH': v }`): use `.value`.
 *   - a computed variable expression (`env[key]`) is NOT statically
 *     decidable and returns `null`.
 *
 * A MemberExpression's non-computed property is ALWAYS an Identifier by JS
 * grammar (`obj.'PATH'` is not valid syntax), so accepting a non-computed
 * Literal only changes behavior for ObjectPattern keys, where both
 * `{ PATH: v }` (Identifier) and `{ 'PATH': v }` (Literal) are valid
 * non-computed forms.
 *
 * @param {boolean} computed
 * @param {import('eslint').Rule.Node} node - the `property` node (MemberExpression) or `key` node (Property)
 * @returns {string | null}
 */
function extractStaticName(computed, node) {
  if (node.type === 'Identifier' && !computed) return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow exact-case environment variable access off a non-process.env receiver',
      category: 'Portability',
    },
    schema: [],
    messages: {
      exactCaseEnvRead:
        'Reading "{{name}}" is an exact-case environment lookup off a non-process.env object — ' +
        'Windows renames env vars (Path, ComSpec, ...) and only the process.env proxy is ' +
        'case-insensitive. Route through envGet(env, name) in src/shell-command-projection.cts, ' +
        'or destructure directly from process.env.',
    },
  },

  create(context) {
    const filename = typeof context.filename === 'string' ? context.filename : context.getFilename();
    if (isSeamFile(filename)) return {};

    return {
      MemberExpression(node) {
        if (isProcessEnvExpression(node.object)) return;
        const name = extractStaticName(node.computed, node.property);
        if (name === null || !isCaseVaryingEnvVarName(name)) return;

        if (isEnvShapedExpression(node.object)) {
          context.report({ node, messageId: 'exactCaseEnvRead', data: { name } });
        }
      },

      ObjectPattern(node) {
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const name = extractStaticName(property.computed, property.key);
          if (name === null || !isCaseVaryingEnvVarName(name)) continue;

          let source = null;
          const parent = node.parent;
          if (parent && parent.type === 'VariableDeclarator' && parent.id === node) {
            source = parent.init;
          } else if (parent && parent.type === 'AssignmentExpression' && parent.left === node) {
            source = parent.right;
          }

          if (source && isProcessEnvExpression(source)) continue;
          if (!source || !isEnvShapedExpression(source)) continue;
          context.report({ node: property, messageId: 'exactCaseEnvRead', data: { name } });
        }
      },
    };
  },
};

module.exports = rule;
