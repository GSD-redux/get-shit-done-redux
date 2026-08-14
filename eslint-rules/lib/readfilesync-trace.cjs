'use strict';

/**
 * readfilesync-trace.cjs
 *
 * Shared data-flow tracing for "is this AST node derived from a readFileSync
 * call" and "is this RegExpLiteral applied to a readFileSync-derived
 * receiver" — extracted from `no-crlf-fragile-split.cjs` (ADR-1703 Phase 4)
 * so `no-unbounded-quantifier.cjs` (ADR-3212 §5/§7, epic #3212 Phase 4,
 * #3415) does not carry a second, divergence-prone copy of the same ~80-line
 * scope walk. Both rules import this module; a parity test
 * (tests/readfilesync-trace-parity.test.cjs) asserts they classify a shared
 * fixture set identically.
 *
 * Byte-identical logic to the pre-extraction copy in `no-crlf-fragile-split.cjs`
 * — this is a pure relocation, not a rewrite (ADR-3212 §6, extend-never-mutate).
 */

/**
 * Returns true if the node is a call to `readFileSync` or `fs.readFileSync`.
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isReadFileSyncCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier' && callee.name === 'readFileSync') return true;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'readFileSync'
  ) {
    return true;
  }
  return false;
}

/**
 * Given an Identifier node, walk the scope chain to find its binding, then
 * check if the initializer is derived from readFileSync.
 * @param {import('eslint').Rule.Node} identNode
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function resolveIdentifierToReadFileSync(identNode, sourceCode) {
  if (typeof sourceCode.getScope !== 'function') return false;

  let scope;
  try {
    scope = sourceCode.getScope(identNode);
  } catch (_) {
    // If scope resolution fails (e.g. due to unsupported node type or parser
    // version mismatch), conservatively return false (not flagged) — an
    // unresolvable scope produces a false negative rather than a spurious error.
    return false;
  }
  if (!scope) return false;

  let s = scope;
  while (s) {
    const variable = s.variables.find((v) => v.name === identNode.name);
    if (variable) {
      const defs = variable.defs;
      if (!defs || defs.length === 0) return false;
      const decl = defs[0].node; // VariableDeclarator
      if (!decl || !decl.init) return false;
      return isReadFileSyncDerived(decl.init, sourceCode);
    }
    s = s.upper;
  }
  return false;
}

/**
 * Returns true if `node` is (transitively) derived from a readFileSync call.
 *
 * Handles:
 *  - Direct: readFileSync(...) -- the node itself IS the readFileSync call
 *  - Chain: readFileSync(...).toString() etc.
 *  - Identifier resolved via scope to a variable initialized from readFileSync
 *
 * @param {import('eslint').Rule.Node} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isReadFileSyncDerived(node, sourceCode) {
  if (!node) return false;

  if (isReadFileSyncCall(node)) return true;

  if (node.type === 'MemberExpression') {
    return isReadFileSyncDerived(node.object, sourceCode);
  }

  if (node.type === 'CallExpression') {
    if (isReadFileSyncCall(node)) return true;
    if (node.callee.type === 'MemberExpression') {
      return isReadFileSyncDerived(node.callee.object, sourceCode);
    }
  }

  if (node.type === 'Identifier') {
    return resolveIdentifierToReadFileSync(node, sourceCode);
  }

  return false;
}

/**
 * Returns true if a pattern-bearing node (RegExpLiteral, or the callee-object
 * position for `/regex/.test(str)`) is used on a readFileSync-derived
 * receiver via .match/.test/.exec/.replace/.replaceAll/.split/.matchAll.
 *
 * Two AST shapes:
 *   Shape A: str.match(/regex/)  — regex is an ARG to the call.
 *     regex.parent = CallExpression (arg), callee.object = str
 *   Shape B: /regex/.test(str)   — regex is the callee object.
 *     regex.parent = MemberExpression (the .test callee)
 *     regex.parent.parent = CallExpression, first arg = str
 *
 * @param {import('eslint').Rule.Node} regexNode — the RegExpLiteral (or `new RegExp(...)` CallExpression)
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isPatternUsedOnFileContent(regexNode, sourceCode) {
  const FILE_METHODS = new Set(['match', 'test', 'exec', 'replace', 'replaceAll', 'split', 'matchAll']);
  const parent = regexNode.parent;
  if (!parent) return false;

  // Shape A: str.match(regex) — regex is an argument; parent is CallExpression
  if (parent.type === 'CallExpression') {
    const callee = parent.callee;
    if (
      callee &&
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.property.type === 'Identifier' &&
      FILE_METHODS.has(callee.property.name)
    ) {
      if (parent.arguments.includes(regexNode)) {
        return isReadFileSyncDerived(callee.object, sourceCode);
      }
    }
    return false;
  }

  // Shape B: /regex/.test(str) — regex is the callee object.
  if (parent.type === 'MemberExpression' && !parent.computed) {
    if (
      parent.object === regexNode &&
      parent.property.type === 'Identifier' &&
      FILE_METHODS.has(parent.property.name)
    ) {
      const callExpr = parent.parent;
      if (callExpr && callExpr.type === 'CallExpression' && callExpr.callee === parent) {
        const args = callExpr.arguments;
        if (args && args.length > 0) {
          return isReadFileSyncDerived(args[0], sourceCode);
        }
      }
    }
  }

  return false;
}

module.exports = {
  isReadFileSyncCall,
  isReadFileSyncDerived,
  isPatternUsedOnFileContent,
};
