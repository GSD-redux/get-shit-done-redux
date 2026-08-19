'use strict';

const path = require('node:path');
const { PATHEXT_VAR_NAME, countWindowsExecutableExtensions } = require('./lib/portability-vocab.cjs');

/**
 * no-private-binary-resolution
 *
 * Epic #3411's actual thesis: four private Windows-binary-resolution
 * implementations existed (execNpm's shell:true, execTool's absence of any
 * handling, gsd-tools.cjs's private scan, and fallow-runner.cts's own
 * candidate array). All four are gone; this rule stops a fifth from
 * accreting by flagging the two unambiguous "I am re-implementing Windows
 * binary resolution" shapes outside the platform seam
 * (src/shell-command-projection.cts):
 *
 *   1. Reading PATHEXT from any object, any casing — Windows environment
 *      variable names are case-insensitive, and nothing reads PATHEXT for a
 *      reason other than locating an executable. This covers both member
 *      access (`env.PATHEXT`, `env['Pathext']`) and destructuring
 *      (`const { PATHEXT } = env`, `const { PATHEXT: exts } = env`), from
 *      any source object.
 *   2. A hardcoded Windows executable-extension list (an ArrayExpression or
 *      a single string literal) carrying two or more of .exe/.cmd/.bat/.com
 *      — the exact shape both deleted implementations had. A SINGLE
 *      extension is deliberately not flagged: that is a classification
 *      (`p.endsWith('.cmd')`) or a shim-path derivation
 *      (`scriptPath.replace(/\.js$/, '.cmd')`), not a candidate list, and
 *      the tree has legitimate instances of both.
 *
 * The seam exemption is PATH-SUFFIX ANCHORED, not substring-matched: a file
 * is exempt only when its repo-relative path IS `src/shell-command-projection.cts`
 * or ENDS WITH `/src/shell-command-projection.cts` — so a file nested under
 * any parent directory at that suffix (e.g. `foo/src/shell-command-projection.cts`)
 * is exempt too, but a file that merely contains that string as a substring
 * elsewhere in its own path, or as a `.bak` / `.test.cts` variant of the
 * filename itself, is NOT exempt (case I9 pins this distinction) — a
 * substring exemption would be the obvious wrong implementation here.
 *
 * See .gsd/phase/chore-3619-no-bare-binary-spawn/40-design.md for the full
 * behavior table and rejected alternatives.
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

/** True when `node` is a string Literal whose value case-insensitively equals PATHEXT_VAR_NAME. */
function isPathextStringLiteral(node) {
  return !!node && node.type === 'Literal' && typeof node.value === 'string'
    && node.value.toLowerCase() === PATHEXT_VAR_NAME.toLowerCase();
}

/** True when `node` is an Identifier whose name case-insensitively equals PATHEXT_VAR_NAME. */
function isPathextIdentifier(node) {
  return !!node && node.type === 'Identifier'
    && node.name.toLowerCase() === PATHEXT_VAR_NAME.toLowerCase();
}

/**
 * True when a MemberExpression's property resolves to PATHEXT, any casing:
 *   - non-computed (dot access): property is always an Identifier — `env.PATHEXT`, `env.pathext`
 *   - computed (bracket access): property may be a string Literal — `env['PATHEXT']` —
 *     or an Identifier referencing a same-named local variable — `env[PATHEXT]`
 *     (row 10 in the design doc: a variable *named* PATHEXT, accepted false-positive risk)
 */
function memberExpressionReadsPathext(node) {
  const property = node.property;
  if (!node.computed) return isPathextIdentifier(property);
  return isPathextStringLiteral(property) || isPathextIdentifier(property);
}

/**
 * True when an ObjectPattern `Property`'s key resolves to PATHEXT, any casing —
 * regardless of what is being destructured (`process.env`, `env`, `opts.env`,
 * anything) and regardless of renaming (`const { PATHEXT: exts } = ...`):
 *   - non-computed key: an Identifier (`{ PATHEXT }`, `{ Pathext: v }`) or a
 *     string Literal (`{ 'PATHEXT': v }`)
 *   - computed key (`{ [expr]: v }`): only a string Literal is statically
 *     decidable (`{ ['PATHEXT']: v }`); a variable expression like `{ [key]: v }`
 *     is NOT decidable and must not be reported (an Identifier that happens to
 *     be *named* PATHEXT is still accepted, mirroring the MemberExpression
 *     computed case above and its accepted false-positive risk).
 */
function objectPatternPropertyReadsPathext(property) {
  if (!property || property.type !== 'Property') return false;
  const key = property.key;
  return isPathextIdentifier(key) || isPathextStringLiteral(key);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow re-implementing Windows binary resolution outside the platform seam',
      category: 'Portability',
    },
    schema: [],
    messages: {
      pathextRead:
        'Reading PATHEXT is Windows binary resolution — route through resolveExecutableBinary ' +
        'in src/shell-command-projection.cts instead. Four private resolvers is what epic #3411 removed.',
      extensionList:
        'A hardcoded Windows executable-extension list is a private resolver candidate set — ' +
        'use the seam\'s PATHEXT handling in src/shell-command-projection.cts instead.',
    },
  },

  create(context) {
    const filename = typeof context.filename === 'string' ? context.filename : context.getFilename();
    if (isSeamFile(filename)) return {};

    return {
      MemberExpression(node) {
        if (memberExpressionReadsPathext(node)) {
          context.report({ node, messageId: 'pathextRead' });
        }
      },

      ObjectPattern(node) {
        for (const property of node.properties) {
          if (objectPatternPropertyReadsPathext(property)) {
            context.report({ node: property, messageId: 'pathextRead' });
          }
        }
      },

      ArrayExpression(node) {
        const stringValues = node.elements
          .filter((el) => el && el.type === 'Literal' && typeof el.value === 'string')
          .map((el) => el.value);
        if (stringValues.length === 0) return;
        if (countWindowsExecutableExtensions(stringValues.join(' ')) >= 2) {
          context.report({ node, messageId: 'extensionList' });
        }
      },

      Literal(node) {
        if (typeof node.value !== 'string') return;
        // Elements of an ArrayExpression are handled by the ArrayExpression
        // visitor above (which combines the whole array's contents) — do not
        // double-report the same evidence from this node's own value alone.
        const parent = node.parent;
        if (parent && parent.type === 'ArrayExpression' && parent.elements.includes(node)) return;
        if (countWindowsExecutableExtensions(node.value) >= 2) {
          context.report({ node, messageId: 'extensionList' });
        }
      },
    };
  },
};

module.exports = rule;
