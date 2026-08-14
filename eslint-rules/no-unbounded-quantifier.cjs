'use strict';

/**
 * no-unbounded-quantifier
 *
 * Flags a lazy any-scan or an unbounded quantifier over a broad character
 * class in a regex applied to caller-supplied document content — the ReDoS/
 * catastrophic-backtracking shape #2128 fixed (eight commits total; CodeQL
 * has flagged the class, #663). ADR-3212 §5/§7 (epic #3212 Phase 4, #3415).
 *
 * This rule is NOT part of the ADR-1703 portability-rule family (see
 * `docs/contributing/cross-platform-portability-rules.md`) and is not listed
 * in `tests/portability-rule-disable-ban.test.cjs`'s `PROTECTED_RULES` — its
 * `eslint-disable-next-line` suppressions, added after empirical
 * benign-verification of a specific site, are an intentional and permitted
 * part of this rule's design, unlike the ADR-1703 rules' zero-escape-hatch ban.
 *
 * ## What this enforces
 *
 * A RegExpLiteral (or `new RegExp('literal string')`, no interpolation —
 * interpolated-value construction is `no-adhoc-regex-escape`'s territory)
 * whose pattern contains an UNBOUNDED quantifier (`*`, `+`, `*?`, `+?`, or an
 * open-ended `{n,}`) applied to:
 *   - `[\s\S]` / `[\S\s]` (the standard any-char-including-newline idiom)
 *   - `.` when the pattern carries the `s` (dotAll) flag
 *   - a broad negated class `[^...]` whose excluded set is short (1-2 units,
 *     an escape sequence counting as one unit) — e.g. `[^)]`, `[^\n]`,
 *     `[^)\n]` — matches nearly the same "everything" shape as `[\s\S]`,
 *     and is the exact shape #2128 fixed (`[^)\n]*` → `[^)\n]{0,200}`)
 *
 * AND whose match target is data-flow-traced to a `readFileSync` result
 * (direct, chained, or via a same-scope variable binding — see
 * `lib/readfilesync-trace.cjs`, shared with `no-crlf-fragile-split`).
 *
 * A quantifier that already carries an explicit closed bound (`{0,200}`,
 * `{1,50}`) is NOT flagged — that is the #2128 fix shape this rule exists to
 * make the default.
 *
 * ## Known boundaries
 *
 * Scoped to file/document content by data-flow, identically to
 * `no-crlf-fragile-split`'s G2/G3 — a regex over a short in-memory constant,
 * a flag string, or a non-readFileSync-derived value is out of scope by
 * design (ADR-3212 §5: "most [of the census] are benign"). A regex stored far
 * from its use, or content obtained via a non-readFileSync read (fs.readFile
 * callback, streams), may not be caught.
 *
 * DEFECT category: CWE-1333 (Inefficient Regular Expression Complexity).
 */

const { isPatternUsedOnFileContent } = require('./lib/readfilesync-trace.cjs');

/**
 * Walks a regex pattern SOURCE STRING (not the compiled RegExp) looking for
 * an unbounded quantifier applied to a broad-match atom. Returns true on the
 * first fragile occurrence found.
 *
 * A "broad-match atom" immediately preceding the quantifier is one of:
 *   - the literal 6-char sequence `[\s\S]` or `[\S\s]`
 *   - `.` (only counted as broad when `hasDotAll` is true)
 *   - a character class `[^X]` where X (with escapes counted as one unit) is
 *     1-2 units long
 *
 * An "unbounded quantifier" is `*`, `+`, `*?`, `+?`, or `{n,}` (no upper
 * bound). `{n,m}` (closed) is never flagged.
 *
 * @param {string} pattern
 * @param {boolean} hasDotAll
 * @returns {boolean}
 */
function hasUnboundedBroadQuantifier(pattern, hasDotAll) {
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    let atomEnd = -1;

    if (pattern.startsWith('[\\s\\S]', i) || pattern.startsWith('[\\S\\s]', i)) {
      atomEnd = i + 6;
    } else if (hasDotAll && pattern[i] === '.') {
      atomEnd = i + 1;
    } else if (pattern[i] === '[' && pattern[i + 1] === '^') {
      let j = i + 2;
      let units = 0;
      let closed = false;
      while (j < len) {
        if (pattern[j] === ']') { closed = true; break; }
        if (pattern[j] === '\\' && j + 1 < len) { j += 2; units++; continue; }
        j++; units++;
      }
      if (closed && units >= 1 && units <= 2) {
        atomEnd = j + 1;
      }
    }

    if (atomEnd !== -1) {
      const quant = pattern.slice(atomEnd, atomEnd + 8);
      if (/^(\*\??|\+\??)/.test(quant)) return true;
      const openEnded = quant.match(/^\{(\d+),\}/);
      if (openEnded) return true;
    }

    i++;
  }

  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow an unbounded quantifier over a broad character class in a regex applied to file content (ReDoS risk, CWE-1333)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      unboundedQuantifier:
        'Unbounded quantifier over a broad character class ([\\s\\S]/./[^X]) applied to ' +
        'readFileSync content is a catastrophic-backtracking risk (CWE-1333, #2128 class). ' +
        'Bound it explicitly (e.g. {0,200}) or replace with a scanner from src/token-scanner.cts.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function checkPattern(node, pattern, flags) {
      if (!hasUnboundedBroadQuantifier(pattern, flags.includes('s'))) return;
      if (!isPatternUsedOnFileContent(node, sourceCode)) return;
      context.report({ node, messageId: 'unboundedQuantifier' });
    }

    return {
      Literal(node) {
        if (!node.regex) return;
        checkPattern(node, node.regex.pattern, node.regex.flags || '');
      },
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'RegExp') return;
        const [patternArg, flagsArg] = node.arguments;
        if (!patternArg || patternArg.type !== 'Literal' || typeof patternArg.value !== 'string') return;
        const flags = flagsArg && flagsArg.type === 'Literal' && typeof flagsArg.value === 'string' ? flagsArg.value : '';
        checkPattern(node, patternArg.value, flags);
      },
    };
  },
};

module.exports = rule;
