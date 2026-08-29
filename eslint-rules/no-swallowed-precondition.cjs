'use strict';

/**
 * no-swallowed-precondition
 *
 * Flag: a try/catch whose CATCH HANDLER swallows the error (no rethrow) where
 * the TRY BLOCK calls a filesystem CREATION verb (mkdirSync / openSync /
 * platformEnsureDir), AND the enclosing function separately references a
 * `*_ERRNO` / `*_ERRNOS`-named set (the established retry/tolerate-errno
 * convention across src/, e.g. PLANNING_LOCK_RETRY_ERRNOS).
 *
 * The defect (#1884, verbatim pre-fix at src/planning-workspace.cts:209-210):
 *
 *   // Ensure .planning/ exists
 *   try { platformEnsureDir(planningDir(cwd)); } catch { /* ok *\/ }
 *
 * A genuine EACCES/ENOSPC/EROFS creating the directory was swallowed. The
 * subsequent lock write then failed with ENOENT (parent missing) — and ENOENT
 * was in the function's own PLANNING_LOCK_RETRY_ERRNOS retry set — so the
 * fatal precondition failure was laundered into a 10-second phantom "lock
 * held by a live process" contention error instead of surfacing.
 *
 * Predicate, measured against this tree (911 → 24 → 0 across the three
 * stages; the CLEANUP-verb carve-out at stage 2 is the entire false-positive
 * mass: rmSync 54, unlinkSync 43, closeSync 17, chmodSync 12, rmdirSync 7,
 * kill 6 — all legitimate best-effort and deliberately NOT flagged):
 *
 *   1. a catch clause whose handler does not rethrow (no ThrowStatement
 *      anywhere in its subtree) — i.e. a true swallow, AND
 *   2. whose try-block calls a CREATION verb: mkdirSync, openSync, or
 *      platformEnsureDir (name-based; dotted `fs.mkdirSync`/`fs.openSync` or
 *      a bare call for platformEnsureDir), AND
 *   3. whose enclosing function references an identifier named `*_ERRNO` or
 *      `*_ERRNOS` anywhere in its body — the naming convention every one of
 *      the 10 retry/tolerate errno sets in src/ follows.
 *
 * Only requiring all three eliminates the CLEANUP-verb false positives
 * (rmSync/unlinkSync/closeSync/chmodSync/rmdirSync/kill are legitimate
 * best-effort swallows with no laundering risk) without narrowing so far
 * that the actual defect shape is missed.
 *
 * Known gap (deliberately NOT closed here — see #3987 review): a function
 * whose errno classification is an INLINE STRING LITERAL rather than a named
 * `*_ERRNOS` set (e.g. `if (code !== 'EEXIST') return null;` in
 * capability-lock.cts's acquireLock) is NOT caught by this rule. Broadening
 * stage 3 to inline literals produced 2 false positives in this tree
 * (capability-lock.cts:408's deliberate EEXIST steal-protocol check, and
 * commonjs-marker.cts:131's distinct documented outcome) — that shape is
 * fixed directly at its call site instead of being folded into this rule.
 *
 * References:
 *   issue #1884 (defect), #3987 (this rule)
 *   fix commit 0c43d853e (`fix(#1884): surface planning-lock mkdir failures,
 *   not a phantom timeout`) — the canonical fix-forward this rule enforces:
 *   let the creation failure propagate, or classify it distinctly so a fatal
 *   errno cannot be laundered into a retryable one.
 *
 * Message:
 *   Cite the seam: a swallowed CREATION-verb failure inside a function that
 *   also tolerates/retries specific errnos via a named `*_ERRNOS` set risks
 *   laundering a fatal filesystem error (EACCES/ENOSPC/EROFS) into a
 *   retryable one downstream. Let the creation failure propagate, or catch
 *   and classify it explicitly (rethrow anything not genuinely tolerable)
 *   so it can never be mistaken for a retryable condition.
 */

// Filesystem CREATION verbs — measured false-positive-free set. Cleanup verbs
// (rmSync, unlinkSync, closeSync, chmodSync, rmdirSync, kill) are deliberately
// excluded; they are legitimate best-effort operations with no laundering risk.
const CREATION_VERBS = new Set(['mkdirSync', 'openSync', 'platformEnsureDir']);

// The naming convention every retry/tolerate-errno set in src/ follows.
const ERRNO_SET_NAME_RE = /_ERRNOS?$/;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/**
 * Generic subtree walker, skipping `parent`/`tokens`/`comments` to avoid
 * cycles. `visit` returns truthy to short-circuit with that value.
 */
function walkSubtree(root, visit) {
  const seen = new WeakSet();
  function walk(n) {
    if (!n || typeof n !== 'object') return undefined;
    if (seen.has(n)) return undefined;
    seen.add(n);
    const result = visit(n);
    if (result) return result;
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            const r = walk(item);
            if (r) return r;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        const r = walk(child);
        if (r) return r;
      }
    }
    return undefined;
  }
  return walk(root);
}

/** True if `node` is a call to one of CREATION_VERBS (bare or `fs.`-dotted). */
function isCreationCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier' && CREATION_VERBS.has(callee.name)) {
    return true;
  }
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    CREATION_VERBS.has(callee.property.name)
  ) {
    return true;
  }
  return false;
}

/** True if any CREATION_VERBS call appears anywhere in `tryBlock`'s subtree. */
function tryBlockCallsCreationVerb(tryBlock) {
  return !!walkSubtree(tryBlock, (n) => isCreationCall(n));
}

/** True if `catchClause` has NO ThrowStatement anywhere in its subtree (a true swallow). */
function catchIsSwallowing(catchClause) {
  if (!catchClause) return false;
  return !walkSubtree(catchClause.body, (n) => n.type === 'ThrowStatement');
}

/** True if an identifier named `*_ERRNO`/`*_ERRNOS` appears anywhere in `node`'s subtree. */
function referencesErrnoSet(node) {
  return !!walkSubtree(node, (n) => n.type === 'Identifier' && ERRNO_SET_NAME_RE.test(n.name));
}

/** Nearest enclosing function (or Program, for top-level code) ancestor of `node`. */
function findEnclosingScope(node, sourceCode) {
  const ancestors =
    typeof sourceCode.getAncestors === 'function' ? sourceCode.getAncestors(node) : [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (FUNCTION_TYPES.has(ancestors[i].type)) return ancestors[i];
  }
  return sourceCode.ast;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag a swallowed filesystem-creation failure (mkdirSync/openSync/platformEnsureDir) ' +
        'inside a function that separately tolerates/retries specific errnos via a *_ERRNOS set — ' +
        'a fatal precondition error can be laundered into a retryable one (#1884)',
      category: 'Correctness',
    },
    schema: [],
    messages: {
      noSwallowedPrecondition:
        "Swallowed '{{verb}}' failure: this function also references an errno-tolerance set " +
        "('{{errnoRef}}'-style), so a genuine EACCES/ENOSPC/EROFS creating the precondition here " +
        'can be laundered into a retryable errno downstream (the #1884 class). ' +
        'Let the creation failure propagate, or catch and classify it explicitly ' +
        '(rethrow anything that is not genuinely tolerable) — never swallow it silently.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      TryStatement(node) {
        if (!node.handler) return;
        if (!tryBlockCallsCreationVerb(node.block)) return;
        if (!catchIsSwallowing(node.handler)) return;

        const scope = findEnclosingScope(node, sourceCode);
        if (!referencesErrnoSet(scope)) return;

        // Identify which creation verb triggered, for the message.
        let verb = 'mkdirSync/openSync/platformEnsureDir';
        walkSubtree(node.block, (n) => {
          if (isCreationCall(n)) {
            verb =
              n.callee.type === 'Identifier' ? n.callee.name : n.callee.property.name;
            return true;
          }
          return false;
        });

        context.report({
          node,
          messageId: 'noSwallowedPrecondition',
          data: { verb, errnoRef: '*_ERRNOS' },
        });
      },
    };
  },
};

module.exports = rule;
