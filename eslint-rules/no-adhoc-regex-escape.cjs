'use strict';

/**
 * no-adhoc-regex-escape
 *
 * ADR-3212 (lexical-seam-consolidation) §7 / #3412 Phase 1:
 * `src/pattern.cts` is the single seam for regex-metacharacter escaping
 * (`escapeRegex` / `literalPattern`, delegating to the built-in
 * `RegExp.escape`). This rule flags the two ways a 13th hand-rolled copy of
 * that concern can be reintroduced:
 *
 *   1. ADHOC-REPLACE  — an inline `<expr>.replace(<escape-all-metachars
 *                        char-class regex>, '\$&')` call anywhere outside
 *                        `src/pattern.cts`. Matches on the character-class
 *                        MEMBER SET (the 14 regex metacharacters
 *                        `. * + ? ^ $ { } ( ) | [ ] \`), not on exact byte
 *                        order or escaping style — a reordered or
 *                        differently-escaped class with the same member set
 *                        is the same shape and still fires (design doc
 *                        row 25).
 *
 *   2. UNSAFE-NEW-REGEXP — `new RegExp(<identifier>)` where `<identifier>`
 *                        is a genuinely dynamic, unescaped runtime value
 *                        (a function parameter, or a `let`/`var` binding, or
 *                        a `const` whose initializer is not a static
 *                        string/template) with no seam routing.
 *
 * Negative space (design doc "Not-corruption"; test-matrix rows 26-28) —
 * deliberately NOT flagged:
 *
 *   - `src/pattern.cts` itself — the seam owns this shape.
 *   - A regex literal that merely CONTAINS the escape-class characters as
 *     DATA (e.g. `/^[.*+?]$/`) with no `.replace(..., '\$&')` shape present.
 *   - `new RegExp(<identifier>)` where `<identifier>` is a REVIEWED PATTERN
 *     FRAGMENT. Provenance is accepted under EITHER of two conditions
 *     (strongest first):
 *       (a) STRUCTURAL — the identifier resolves (via scope walk) to a
 *           `const` declaration whose initializer is a string Literal or a
 *           TemplateLiteral with zero `${...}` expressions. This cannot be
 *           evaded by renaming the identifier (#3410's guard-evasion class:
 *           a rule keyed only on an identifier's NAME is defeated by a
 *           rename; a rule keyed on the const/static-initializer SHAPE is
 *           not).
 *       (b) NAMING CONVENTION (fallback) — the identifier ends in `_SOURCE`
 *           AND resolves (via scope walk) to one of: an ES `import` binding,
 *           or a `require(...)`-derived module-scope `const` (either
 *           `const { X_SOURCE } = require('./mod.cjs')` or
 *           `const X_SOURCE = require('./mod.cjs').X_SOURCE`). Kept for the
 *           cross-module case where the initializer itself is not in scope
 *           to inspect (condition (a) cannot see into another file), e.g. an
 *           imported `PHASE_NUMBER_TOKEN_SOURCE`. (a) is the real check; (b)
 *           only covers what (a) structurally cannot see — and is bound to
 *           the identifier's ACTUAL BINDING KIND, not just its spelling: a
 *           function parameter, a `let`/`var`, a reassigned binding, or an
 *           unresolvable identifier is NEVER exempted by naming alone, no
 *           matter what it's called. A naming-only check (no scope/binding
 *           verification) is exactly #3410's guard-evasion class — a rule
 *           keyed on spelling is defeated by picking a matching name for a
 *           genuinely dynamic value (e.g. a function parameter named
 *           `userInput_SOURCE`). If scope analysis cannot resolve the
 *           identifier's binding at all, this fails CLOSED (flags it) —
 *           an unresolvable binding is not evidence of safety.
 *     A `new RegExp(<CallExpression>)` argument that already routes through
 *     the seam (`escapeRegex(...)` / `literalPattern(...)`, by name or as a
 *     `pattern.escapeRegex(...)` member call) is also treated as safe — that
 *     IS the fix, not a violation.
 *
 * Per-finding exemption: add  // allow-adhoc-regex-escape: <reason>  as a
 * trailing comment on the same source line, OR as a standalone comment on
 * the line immediately preceding the flagged node (mirrors
 * no-adhoc-markdown-parsing's `// allow-adhoc-markdown:` convention).
 */

// The 14 regex metacharacters the census copies' char class escapes.
const ESCAPE_ALL_METACHARS_SET = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

// The self-reference replacement string every copy uses: '\$&' (3 chars:
// backslash, dollar, ampersand).
const SELF_REFERENCE_REPLACEMENT = '\\$&';

const SOURCE_SUFFIX_RE = /_SOURCE$/;

/**
 * Parse the first top-level (unescaped) `[...]` character class out of a
 * regex source string and return its member-character set, or `null` if no
 * class is present / it is unterminated. Single-pass, escape-aware — mirrors
 * the style of no-adhoc-markdown-parsing's hasQualifyingNegatedPipeClass
 * (walk once, honor `\` escapes, never backtrack into the class body).
 */
function parseCharClassMembers(src) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') break;
    i += 1;
  }
  if (i >= src.length) return null;

  let j = i + 1;
  let negated = false;
  if (src[j] === '^') {
    negated = true;
    j += 1;
  }

  const members = new Set();
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const next = src[j + 1];
      if (next === undefined) return null; // unterminated escape
      members.add(next);
      j += 2;
      continue;
    }
    if (c === ']') {
      return { members, negated };
    }
    members.add(c);
    j += 1;
  }
  return null; // unterminated class
}

/**
 * Does `src` (a regex literal's `.pattern`) contain, as its first char
 * class, EXACTLY the escape-all-metachars member set — regardless of
 * ordering or which members are backslash-escaped (row 25: shape, not
 * bytes)?
 */
function isEscapeAllMetacharsClassSource(src) {
  const parsed = parseCharClassMembers(src || '');
  if (!parsed || parsed.negated) return false;
  if (parsed.members.size !== ESCAPE_ALL_METACHARS_SET.size) return false;
  for (const m of ESCAPE_ALL_METACHARS_SET) {
    if (!parsed.members.has(m)) return false;
  }
  return true;
}

/** Is `node` the regex literal `.replace()` first-argument shape? */
function isEscapeAllMetacharsRegexLiteral(node) {
  return node.type === 'Literal' && !!node.regex && isEscapeAllMetacharsClassSource(node.regex.pattern);
}

/** Is `node` the string literal `'\$&'` self-reference replacement? */
function isSelfReferenceReplacement(node) {
  return node.type === 'Literal' && typeof node.value === 'string' && node.value === SELF_REFERENCE_REPLACEMENT;
}

/**
 * Walk up the scope chain from `scope` looking for `identifierName`'s
 * declaration. Returns `{ def, kind }` where `kind` is 'param' for a
 * function-parameter binding, 'import' for an ES `import` binding, or the
 * VariableDeclaration `kind` ('const'/'let'/'var') for a variable binding —
 * or `null` if unresolved in any enclosing scope reachable from here (fails
 * closed: callers must treat `null` as "not provably safe").
 */
function resolveBinding(identifierName, scope) {
  let s = scope;
  while (s) {
    const variable = s.variables.find((v) => v.name === identifierName);
    if (variable) {
      const def = variable.defs && variable.defs[0];
      if (!def) return null;
      if (def.type === 'Parameter') return { def, kind: 'param' };
      if (def.type === 'ImportBinding') return { def, kind: 'import' };
      if (
        def.node
        && def.node.type === 'VariableDeclarator'
        && def.parent
        && def.parent.type === 'VariableDeclaration'
      ) {
        return { def, kind: def.parent.kind };
      }
      return null;
    }
    s = s.upper;
  }
  return null;
}

/** Is `node` a `require(...)` call expression? */
function isRequireCallExpression(node) {
  return !!node && node.type === 'CallExpression'
    && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require';
}

/**
 * Provenance condition (b), require branch — does `identifierName` resolve
 * to a module-scope `const` whose initializer is EITHER `require(...)`
 * itself (the `const { X_SOURCE } = require('./mod.cjs')` destructure shape)
 * OR a non-computed member access on a `require(...)` call (the
 * `const X_SOURCE = require('./mod.cjs').X_SOURCE` shape)?
 */
function resolvesToRequireDerivedConstBinding(identifierName, scope) {
  const binding = resolveBinding(identifierName, scope);
  if (!binding || binding.kind !== 'const') return false;
  const init = binding.def.node.init;
  if (!init) return false;
  if (isRequireCallExpression(init)) return true;
  if (init.type === 'MemberExpression' && !init.computed && isRequireCallExpression(init.object)) return true;
  return false;
}

/** Provenance condition (b), import branch — does `identifierName` resolve to an ES `import` binding? */
function resolvesToImportBinding(identifierName, scope) {
  const binding = resolveBinding(identifierName, scope);
  return !!binding && binding.kind === 'import';
}

/**
 * Provenance condition (a) — STRUCTURAL: does `identifierName` resolve to a
 * `const` whose initializer is a static string Literal or a TemplateLiteral
 * with no `${...}` expressions?
 */
function resolvesToStaticConstFragment(identifierName, scope) {
  const binding = resolveBinding(identifierName, scope);
  if (!binding || binding.kind !== 'const') return false;
  const init = binding.def.node.init;
  if (!init) return false;
  if (init.type === 'Literal' && typeof init.value === 'string') return true;
  if (init.type === 'TemplateLiteral' && (!init.expressions || init.expressions.length === 0)) return true;
  return false;
}

/**
 * UNSAFE-NEW-REGEXP is deliberately narrow. An earlier version of this rule
 * flagged ANY `new RegExp(<identifier>)` whose identifier resolved to a
 * function parameter, a `let`/`var`, or a `const` with a non-static
 * initializer — e.g. `const src = someHelper(x); new RegExp(src);`. A first
 * whole-repo run proved that heuristic unusable: it fired ~25 times across
 * `tests/**` on code with no relation to the escape-helper concern —
 * `for (const level of [...]) { ...new RegExp(level)... }` (a fixed literal
 * array), `patterns.filter(p => new RegExp(p).test(...))` (`p` is itself an
 * already-regex-shaped source string, not literal text needing escaping),
 * `const src = phaseId.phaseMarkdownRegexSource(x); new RegExp(src)` (a
 * value produced by a function that ALREADY routes through escapeRegex
 * internally, just not through a literal `new RegExp(escapeRegex(...))`
 * one-liner). A syntax-only rule cannot distinguish "raw literal text that
 * needed escaping and didn't get it" from "an already-valid regex-source
 * string produced elsewhere" for an arbitrary non-literal expression — so it
 * does not try to for the general case.
 *
 * What IS a reliable, false-positive-free signal is the row-29 shape
 * itself: a function whose ENTIRE body is `return new RegExp(<own
 * parameter>)` (or an arrow function's implicit-return equivalent) — i.e. a
 * hand-rolled re-implementation of `literalPattern()` that skips the
 * escaping step. That shape cannot arise from "value already computed
 * upstream and merely re-used" (there is no upstream — the parameter IS the
 * function's only input), so it is exactly ADR §7's "new RegExp() built
 * from a non-literal without routing through the seam" with no other
 * plausible reading.
 */
function isSoleReturnOfOwnParameter(newExprNode, argIdentifier) {
  let fn = null;

  const parent = newExprNode.parent;
  if (!parent) return false;

  if (parent.type === 'ReturnStatement' && parent.argument === newExprNode) {
    const block = parent.parent;
    if (
      block
      && block.type === 'BlockStatement'
      && block.body.length === 1
      && block.parent
      && (block.parent.type === 'FunctionDeclaration'
        || block.parent.type === 'FunctionExpression'
        || block.parent.type === 'ArrowFunctionExpression')
      && block.parent.body === block
    ) {
      fn = block.parent;
    }
  }
  else if (parent.type === 'ArrowFunctionExpression' && parent.body === newExprNode) {
    fn = parent;
  }

  if (!fn) return false;
  return (fn.params || []).some((p) => p.type === 'Identifier' && p.name === argIdentifier.name);
}

function isReviewedPatternFragmentIdentifier(identifierName, scope) {
  if (resolvesToStaticConstFragment(identifierName, scope)) return true; // (a) structural
  if (SOURCE_SUFFIX_RE.test(identifierName)) {
    // (b) naming fallback — only trusted when the identifier's ACTUAL
    // BINDING is an import or a require()-derived module-scope const.
    // A function parameter, a let/var, a reassigned binding, or an
    // unresolvable identifier is never exempted by spelling alone (#3410
    // guard-evasion class) — fails closed via resolveBinding returning null.
    if (resolvesToImportBinding(identifierName, scope)) return true;
    if (resolvesToRequireDerivedConstBinding(identifierName, scope)) return true;
    return false;
  }
  return false;
}

/**
 * Unwrap a chain of TypeScript `<expr> as T` casts (TSAsExpression) down to
 * the innermost expression, so a cast around a MemberExpression/Identifier
 * argument cannot hide its shape from the checks below. Zero sites exist in
 * this repo today (#3951 Rung A measurement) — kept so a future cast cannot
 * silently re-open the hole this widening closes.
 */
function unwrapTSAsExpression(node) {
  let n = node;
  while (n && n.type === 'TSAsExpression') {
    n = n.expression;
  }
  return n;
}

/** Does `node` route through the seam (`escapeRegex(...)` / `literalPattern(...)`)? */
function isSeamRoutedCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.type === 'Identifier') {
    return callee.name === 'escapeRegex' || callee.name === 'literalPattern';
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property) {
    return callee.property.name === 'escapeRegex' || callee.property.name === 'literalPattern';
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a hand-rolled regex-metacharacter-escape helper or an unrouted new RegExp() from a runtime value outside src/pattern.cts — import escapeRegex()/literalPattern() from the seam instead.',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      adhocRegexEscape:
        'Ad-hoc regex-metacharacter-escape detected (.replace() against the escape-all-metachars character class, with the \'\\$&\' self-reference replacement). Import escapeRegex() from ./pattern (src/pattern.cts) instead. Suppress with: // allow-adhoc-regex-escape: <reason>',
      unsafeNewRegExp:
        'new RegExp() built from a runtime value with no escaping and no seam routing. Route it through escapeRegex()/literalPattern() from ./pattern (src/pattern.cts) first. Suppress with: // allow-adhoc-regex-escape: <reason>',
    },
  },

  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const normalizedFilename = filename.replace(/\\/g, '/');
    // The seam owns this shape — it is not a violation of itself.
    if (/(?:^|\/)src\/pattern\.cts$/.test(normalizedFilename)) {
      return {};
    }

    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;

    function isAllowed(node) {
      const nodeStartLine = node.loc.start.line;
      const allComments = sourceCode.getAllComments();
      return allComments.some((c) => {
        if (!/allow-adhoc-regex-escape:\s*\S/.test(c.value)) return false;
        return c.loc.start.line === nodeStartLine || c.loc.start.line === nodeStartLine - 1;
      });
    }

    return {
      // ── ADHOC-REPLACE: <expr>.replace(<escape-class>, '\$&') ──────────────
      CallExpression(node) {
        const callee = node.callee;
        if (callee && callee.type === 'MemberExpression' && !callee.computed
          && callee.property && callee.property.name === 'replace') {
          const args = node.arguments || [];
          const patternArg = args[0];
          const replacementArg = args[1];
          if (
            patternArg
            && replacementArg
            && isEscapeAllMetacharsRegexLiteral(patternArg)
            && isSelfReferenceReplacement(replacementArg)
          ) {
            if (!isAllowed(node)) {
              context.report({ node, messageId: 'adhocRegexEscape' });
            }
          }
          return;
        }

        // ── UNSAFE-NEW-REGEXP is checked on NewExpression below; nothing
        //    else to do for other CallExpressions here.
      },

      // ── UNSAFE-NEW-REGEXP: new RegExp(<unrouted runtime identifier>) ──────
      NewExpression(node) {
        if (!node.callee || node.callee.type !== 'Identifier' || node.callee.name !== 'RegExp') return;
        const arg = node.arguments && node.arguments[0];
        if (!arg) return;
        // #3951 Rung A: a `<expr> as T` cast around the argument (TSAsExpression)
        // must not hide its shape from the checks below — unwrap to the
        // innermost expression. Zero sites exist today; kept so a future cast
        // cannot silently re-open the hole this widening closes.
        const effectiveArg = unwrapTSAsExpression(arg);

        // Static text (string literal / no-interpolation template literal) —
        // fully known at lint time, not a runtime value. Never flagged.
        if (effectiveArg.type === 'Literal' && typeof effectiveArg.value === 'string') return;
        if (effectiveArg.type === 'TemplateLiteral' && (!effectiveArg.expressions || effectiveArg.expressions.length === 0)) return;

        // Already routed through the seam — that IS the fix.
        if (isSeamRoutedCall(effectiveArg)) return;

        if (effectiveArg.type === 'Identifier') {
          const scope = context.getScope ? context.getScope() : sourceCode.getScope(node);
          if (isReviewedPatternFragmentIdentifier(effectiveArg.name, scope)) {
            return;
          }

          // The `_SOURCE` suffix exists ONLY to claim provenance exemption
          // (b). An identifier that carries the suffix but did NOT resolve
          // to a legitimate import/require-derived binding above (or is
          // unresolvable at all) IS the #3410-class evasion this check
          // exists to close — flag it unconditionally, independent of the
          // narrower sole-return-of-parameter shape below. This cannot
          // reproduce the ~25 unrelated false positives an earlier, broader
          // "any non-literal identifier" heuristic produced (see
          // isSoleReturnOfOwnParameter's doc comment): those identifiers
          // never carried the `_SOURCE` naming convention in the first
          // place, so this branch never reaches them.
          if (SOURCE_SUFFIX_RE.test(effectiveArg.name)) {
            if (!isAllowed(node)) {
              context.report({ node, messageId: 'unsafeNewRegExp' });
            }
            return;
          }

          // Narrow, false-positive-free shape only — see
          // isSoleReturnOfOwnParameter's doc comment for why the broader
          // "any non-literal identifier" heuristic was rejected.
          if (isSoleReturnOfOwnParameter(node, effectiveArg)) {
            if (!isAllowed(node)) {
              context.report({ node, messageId: 'unsafeNewRegExp' });
            }
          }
          return;
        }

        // #3951 Rung A: `new RegExp(obj['key'])` / `new RegExp(cfg.pattern)`
        // — the whole UNSAFE-NEW-REGEXP arm used to gate on
        // `arg.type === 'Identifier'` alone, so a MemberExpression argument
        // (computed or not) was never examined at all. That is why this rule
        // never fired on the #3477 ReDoS (src/verify.cts:1239).
        if (effectiveArg.type === 'MemberExpression') {
          // (a) `.source`-exemption — `new RegExp(X.source, flags)` is the
          // safe re-flag-composition idiom. Keyed ONLY on the PROPERTY being
          // literally `source` (non-computed): exempting on the OBJECT
          // instead would wave through `X.anything`, which buys nothing.
          if (!effectiveArg.computed && effectiveArg.property && effectiveArg.property.type === 'Identifier') {
            if (effectiveArg.property.name === 'source') return;

            // (b) provenance exemption, extended to MemberExpressions: the
            // same NAMING CONVENTION fallback isReviewedPatternFragmentIdentifier
            // already trusts for bare identifiers — a `_SOURCE`-suffixed
            // constant reached through a required module namespace, e.g.
            // `phaseId.BRACKET_PHASE_TOKEN_SOURCE` where
            // `const phaseId = require('./phase-id.cjs')`. Bound to the
            // OBJECT's actual binding kind (import / require()-derived
            // const), never to spelling alone — same #3410 guard-evasion
            // discipline as the bare-identifier case above.
            if (
              SOURCE_SUFFIX_RE.test(effectiveArg.property.name)
              && effectiveArg.object
              && effectiveArg.object.type === 'Identifier'
            ) {
              const scope = context.getScope ? context.getScope() : sourceCode.getScope(node);
              if (
                resolvesToImportBinding(effectiveArg.object.name, scope)
                || resolvesToRequireDerivedConstBinding(effectiveArg.object.name, scope)
              ) {
                return;
              }
            }
          }

          // Neither exemption applied — a MemberExpression argument (computed
          // like `obj['key']`, or non-computed like `cfg.pattern`) with no
          // proven-safe provenance is exactly ADR §7's "new RegExp() built
          // from a runtime value with no escaping and no seam routing."
          // Deliberately UNCONDITIONAL (unlike the bare-Identifier arm's
          // narrower isSoleReturnOfOwnParameter gate): a MemberExpression
          // argument categorically cannot be the "value already computed
          // upstream, safely, and merely re-used" case that heuristic exists
          // to avoid false-flagging — see isSoleReturnOfOwnParameter's doc
          // comment. Measured across the repo: this arm's population is
          // exactly the 27 `new RegExp(<MemberExpression>)` sites accounted
          // for above (18 `.source`, 3 provenance-exempt, 6 real findings) —
          // going wider than this shape is out of scope.
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'unsafeNewRegExp' });
          }
        }
      },
    };
  },
};

// Exposed for reuse by scripts/lint-no-adhoc-regex-escape.cjs (the whole-tree
// parity backstop for directories/extensions this rule's eslint.config.mjs
// wiring does not reach, e.g. tests/fixtures/**/*.cts). ESLint itself only
// reads `.create`/`.meta` off a required rule module, so these extra
// properties are inert to the linter and exist purely as a single source of
// truth for the shape-detection logic (avoids a second, drifting copy of the
// character-class parser — the exact class of bug this rule exists to end).
rule.isEscapeAllMetacharsClassSource = isEscapeAllMetacharsClassSource;
rule.SELF_REFERENCE_REPLACEMENT = SELF_REFERENCE_REPLACEMENT;

module.exports = rule;
