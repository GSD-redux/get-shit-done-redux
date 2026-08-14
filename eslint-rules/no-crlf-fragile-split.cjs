'use strict';

/**
 * no-crlf-fragile-split
 *
 * Flag CRLF-fragile file-content splitting and regex patterns in test files.
 * Windows git-autocrlf causes readFileSync to return \r\n line endings; code
 * that splits on bare `\n` or uses regexes with bare `\n` will silently
 * mismatch on Windows.
 *
 * ## What this enforces
 *
 * G1 — a `.split('\n')` / `.split("\n")` CallExpression whose receiver is
 *      (transitively) a `readFileSync`/`fs.readFileSync` result — directly,
 *      via a chain, or via an Identifier that scope-resolves to a variable
 *      initialized from readFileSync.
 *      Message: use `splitLines()` from `src/text-lines.cts`.
 *
 * G2/G3 — a RegExpLiteral whose pattern contains a bare `\n` (a `\n` not
 *      part of `\r?\n` / `\r\n` / `[\r\n]` etc.) used as the pattern of a
 *      `.match`/`.test`/`.exec`/`.replace`/`.replaceAll`/`.split`/`.matchAll`
 *      call on a readFileSync-derived receiver. ALSO flags a RegExpLiteral
 *      with a bare `\n` whose source contains a markdown fence (```) or a
 *      frontmatter anchor (`^---`), since those shapes target file content.
 *      Message: use `splitLines()` from `src/text-lines.cts` (or the raw
 *      `\r?\n` regex, for a file that cannot import the compiled seam).
 *
 * ## Known boundaries
 *
 * The data-flow is scope-based: a readFileSync result is tracked via the
 * immediate call-chain or a single variable binding initialized from
 * readFileSync in the same file scope. A regex stored far from its use, or
 * content obtained via a non-readFileSync read (e.g. fs.readFile callback,
 * streams), may not be caught. G2/G3 additionally fires on fence/frontmatter
 * regex shapes even when data-flow is indirect, to catch the most common
 * markdown parsing patterns.
 *
 * DEFECT category: DEFECT.WINDOWS-CRLF-TEST-PORTABILITY
 */

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');
const { isReadFileSyncDerived, isPatternUsedOnFileContent } = require('./lib/readfilesync-trace.cjs');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow CRLF-fragile file-content split and regex patterns in tests (fails on Windows with git-autocrlf)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      crlfFragileSplit:
        'Splitting on literal "\\n" on readFileSync content is CRLF-fragile ' +
        '(DEFECT.WINDOWS-CRLF-TEST-PORTABILITY): Windows git-autocrlf yields "\\r\\n" ' +
        'line endings. Use splitLines() from src/text-lines.cts instead.',
      crlfFragileRegex:
        'RegExp with a bare "\\n" on readFileSync content is CRLF-fragile ' +
        '(DEFECT.WINDOWS-CRLF-TEST-PORTABILITY): Windows git-autocrlf yields "\\r\\n" ' +
        'line endings. Use splitLines() from src/text-lines.cts instead.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Returns the string value of a Literal node, or null.
     * @param {import('eslint').Rule.Node} node
     * @returns {string|null}
     */
    function stringValue(node) {
      if (node && node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
      }
      return null;
    }

    /**
     * Returns true if a RegExpLiteral has at least one FRAGILE bare \n — a \n
     * that is not adequately protected against CRLF.
     *
     * Per-occurrence classification: every \n in the pattern is inspected
     * individually. A \n is SAFE when ANY of these hold:
     *   1. Immediately preceded by \r? (part of \r?\n)
     *   2. Immediately preceded by \r  (part of \r\n)
     *   3. Inside a character class [...] that also contains \r
     *      (e.g. [\r\n], [^\r\n], [\n\r])
     *
     * Everything else is FRAGILE: [^\n], [\n], or a bare \n in the main pattern.
     *
     * @param {import('eslint').Rule.Node} node — Literal with regex
     * @returns {boolean}
     */
    function hasBareLiteralNewline(node) {
      if (!node || node.type !== 'Literal' || !node.regex) return false;
      const pattern = node.regex.pattern;
      if (!pattern.includes('\\n')) return false;

      // Walk the pattern, find every \n occurrence and classify it.
      let i = 0;
      // Track whether we are inside a [...] character class and whether
      // the current class contains \r.
      let inClass = false;
      let classHasCarriageReturn = false;
      let foundFragile = false;

      while (i < pattern.length) {
        // Entering a character class
        if (pattern[i] === '[' && !inClass) {
          inClass = true;
          classHasCarriageReturn = false;
          i++;
          // Skip optional ^ negation
          if (i < pattern.length && pattern[i] === '^') i++;
          // Skip ] if it appears immediately after [ or [^, where it is literal
          if (i < pattern.length && pattern[i] === ']') i++;
          continue;
        }

        // Exiting a character class
        if (pattern[i] === ']' && inClass) {
          inClass = false;
          i++;
          continue;
        }

        // Escape sequences inside the pattern
        if (pattern[i] === '\\' && i + 1 < pattern.length) {
          const next = pattern[i + 1];
          if (next === 'r') {
            // \r — if inside a class, note it contains \r
            if (inClass) classHasCarriageReturn = true;
            i += 2;
            continue;
          }
          if (next === 'n') {
            // \n found — classify it
            // Check if preceded by \r? or \r (look back in the raw pattern string)
            // "preceded by" means the two chars before the current \\ are \r or \r?
            const before2 = pattern.slice(Math.max(0, i - 2), i); // up to 2 chars before \\

            // Re-check with a wider window for \r?\n (pattern chars: \r?\n = 5 chars)
            const before3 = pattern.slice(Math.max(0, i - 3), i);
            const safeByPrefixFull =
              before3 === '\\r?' ||  // \r?\n
              before2 === '\\r';     // \r\n

            if (inClass) {
              // Inside a class: safe only if the class itself contains \r
              if (!classHasCarriageReturn) {
                foundFragile = true;
              }
            } else if (!safeByPrefixFull) {
              foundFragile = true;
            }
            i += 2;
            continue;
          }
          // Any other escape: skip both chars
          i += 2;
          continue;
        }

        i++;
      }

      return foundFragile;
    }

    /**
     * Returns true if a RegExpLiteral with a bare \n is used on a readFileSync-
     * derived receiver via .match/.test/.exec/.replace/.replaceAll/.split/.matchAll.
     *
     * Two AST shapes:
     *   Shape A: str.match(/regex/)  — regex is an ARG to the call.
     *     regex.parent = CallExpression (arg), callee.object = str
     *   Shape B: /regex/.test(str)   — regex is the callee object.
     *     regex.parent = MemberExpression (the .test callee)
     *     regex.parent.parent = CallExpression, first arg = str
     *
     * @param {import('eslint').Rule.Node} regexNode — the RegExpLiteral
     * @returns {boolean}
     */
    function isRegexUsedOnFileContent(regexNode) {
      return isPatternUsedOnFileContent(regexNode, sourceCode);
    }

    /**
     * Returns true if a RegExpLiteral pattern:
     *  - has a bare \n, AND
     *  - contains a markdown fence (```) or frontmatter anchor (^---)
     *
     * These shapes target file content by convention even without direct
     * data-flow tracking.
     *
     * @param {import('eslint').Rule.Node} node — Literal with regex
     * @returns {boolean}
     */
    function isMarkdownOrFrontmatterRegex(node) {
      if (!node || node.type !== 'Literal' || !node.regex) return false;
      if (!hasBareLiteralNewline(node)) return false;
      const pattern = node.regex.pattern;
      // Markdown fence: ```
      if (pattern.includes('```')) return true;
      // Frontmatter anchor: ^---
      if (/\^---/.test(pattern)) return true;
      return false;
    }

    // ── Per-file state ──────────────────────────────────────────────────────

    /** Collected G1 violations: {node} */
    const g1Violations = [];
    /** Collected G2/G3 violations: {node} */
    const g2g3Violations = [];

    return {
      // G1: .split('\n') on readFileSync-derived content
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee &&
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'split'
        ) {
          const args = node.arguments;
          if (args && args.length >= 1) {
            const argVal = stringValue(args[0]);
            if (argVal === '\n') {
              // Is the receiver derived from readFileSync?
              if (isReadFileSyncDerived(callee.object, sourceCode)) {
                g1Violations.push(node);
              }
            }
          }
        }
      },

      // G2/G3: RegExpLiteral with bare \n
      Literal(node) {
        if (!node.regex) return;
        if (!hasBareLiteralNewline(node)) return;

        // Check G2/G3 via data-flow (receiver is readFileSync-derived)
        if (isRegexUsedOnFileContent(node)) {
          g2g3Violations.push(node);
          return;
        }

        // Also check G2/G3 via content shape (markdown fence or frontmatter)
        if (isMarkdownOrFrontmatterRegex(node)) {
          g2g3Violations.push(node);
        }
      },

      'Program:exit'() {
        for (const node of g1Violations) {
          if (!isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'crlfFragileSplit' });
          }
        }
        for (const node of g2g3Violations) {
          if (!isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'crlfFragileRegex' });
          }
        }
      },
    };
  },
};

module.exports = rule;
