'use strict';

/**
 * no-adhoc-markdown-parsing
 *
 * Flags hand-rolled markdown-structure scanning in src/*.cts that duplicates
 * the canonical seam (src/markdown-sectionizer.cts, src/markdown-table.cts).
 * Applies to three patterns:
 *
 *   1. FENCE-BLOCK-STRIP — regex literals whose source contains a triple-backtick
 *                          or triple-tilde fence delimiter AND a multiline body
 *                          ([\s\S] or [\S\s]), indicating the regex strips/matches
 *                          a fenced CODE BLOCK spanning multiple lines.
 *
 *                          A bare single-line fence-opener test like /^```/ or
 *                          /^\s*(?:```|~~~)/ is NOT flagged — that is line
 *                          detection / normalisation, not block-stripping.
 *
 *   2. SECTION-COLLECT   — regex literals of the shape
 *                          /(#{...}\n)([\s\S]*?)(?=\n#{...}|$)/  (a heading
 *                          capture followed by a non-greedy body up to a heading
 *                          lookahead). These hand-roll what collectSection() owns.
 *                          Fingerprint: [\\s\\S] (multiline body) AND (?= lookahead
 *                          that references a heading anchor #.
 *
 *   3. TABLE-REGEX       — regex literals whose source contains an escaped pipe
 *                          (\|, the GFM table-cell delimiter) AND a negated-pipe
 *                          cell-capture character class ([^|] / [^\|]), e.g.
 *                          /\|[^|]*\|/. This is the fingerprint of a hand-rolled
 *                          markdown table-row/cell scan (ADR-2143 §7). Kept
 *                          deliberately conservative — a regex with an escaped
 *                          pipe but no negated-pipe cell class (e.g. a bare
 *                          `\|` delimiter probe) is NOT flagged, to keep the
 *                          false-positive rate low.
 *
 *                          ALSO inspects `new RegExp(<arg>)` where `<arg>` is a
 *                          string Literal or a TemplateLiteral (ADR-2143 §7
 *                          Phase 4) — a dynamically-built table-row pattern such
 *                          as `new RegExp(`^(\\|\\s*${phase}...[^|]*)$`)` is the
 *                          exact same hand-rolled table scan, just constructed
 *                          at runtime instead of written as a literal. Only the
 *                          STATIC text is inspected: for a TemplateLiteral, the
 *                          quasis (cooked, escapes resolved) are concatenated
 *                          and any `${...}` expression contributes nothing —
 *                          conservative by design, so a dynamic segment can
 *                          never manufacture or hide the fingerprint. A `new
 *                          RegExp(someIdentifier)` IS ALSO inspected (#2245
 *                          audit) when `someIdentifier` resolves to a same-
 *                          scope `const` declaration whose initializer is
 *                          itself a regex Literal, a string Literal, or a
 *                          TemplateLiteral — mirroring the ADHOC-REPLACE-
 *                          MUTATION resolver below. A `let`/`var` binding, a
 *                          function parameter, a call result, or string
 *                          concatenation is deliberately NOT resolved — a real,
 *                          documented boundary, not a recall hole.
 *
 *   4. ADHOC-REPLACE-MUTATION — a `.replace(` call whose receiver identifier
 *                          name matches /roadmap|state|reqContent|content/i AND
 *                          whose first argument is a regex Literal or a `new
 *                          RegExp(<Literal-or-TemplateLiteral>)` matching EITHER
 *                          the TABLE-REGEX or the SECTION-COLLECT fingerprint
 *                          (ADR-2143 §7 Phase 4). Targets the specific ad-hoc
 *                          write pattern `roadmapContent.replace(tableRowPattern,
 *                          ...)` / `stateContent.replace(sectionPattern, ...)` —
 *                          a mutation of a roadmap/state document via a hand-
 *                          rolled table or section regex. `withSection(...)` /
 *                          `withPhaseSection(...)` / `updateTableCell(...)`
 *                          calls (the canonical seam mutators) are never
 *                          `.replace(` calls on such a receiver and so never trip
 *                          this — nor does `.replace()` on a receiver whose name
 *                          doesn't match the roadmap/state fingerprint.
 *
 * Per-finding exemption: add  // allow-adhoc-markdown: <reason>  as a
 * trailing comment on the same source line, OR as a standalone comment on the
 * line immediately preceding the flagged node.  (Mirrors no-source-grep's
 * // allow-test-rule: mechanism but is scoped to individual findings.)
 *
 * Authors must import from src/markdown-sectionizer.cts (fences/sections) or
 * src/markdown-table.cts (parseMarkdownTable / findTableWithColumns /
 * updateTableCell / TABLE_SCHEMAS) instead.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hand-rolled markdown-structure scanning (fence-block-strip, section-collect, table-regex) in src/*.cts — import the markdown-sectionizer / markdown-table seam instead.',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      fenceRegex:
        'Ad-hoc fence-block-strip regex detected (triple-fence delimiter + multiline body). Import stripFencedCode() from ./markdown-sectionizer instead. Suppress with: // allow-adhoc-markdown: <reason>',
      sectionCollect:
        'Ad-hoc section-collect regex detected (heading + [\\s\\S]*? + lookahead). Import collectSection() from ./markdown-sectionizer instead. Suppress with: // allow-adhoc-markdown: <reason>',
      tableRegex:
        'Ad-hoc table-row/cell regex detected (escaped pipe + negated-pipe cell-capture class). Use parseMarkdownTable() / findTableWithColumns() / TABLE_SCHEMAS from ./markdown-table instead. Suppress with: // allow-adhoc-markdown: <reason>',
      adhocReplaceMutation:
        'Ad-hoc .replace() mutation of a roadmap/state document using a hand-rolled table or section regex. Use updateTableCell() (./markdown-table) or withSection()/withPhaseSection() (./markdown-sectionizer) instead. Suppress with: // allow-adhoc-markdown: <reason>',
    },
  },

  create(context) {
    // Only run on src/*.cts files
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (!/(?:^|\/)src\/[^/]+\.cts$/.test(filename.replace(/\\/g, '/'))) {
      return {};
    }

    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;

    /**
     * Check whether a node has a trailing  // allow-adhoc-markdown: <reason>
     * comment on the same source line, OR a standalone allow comment on the
     * line immediately before the node's start line.
     */
    function isAllowed(node) {
      const nodeStartLine = node.loc.start.line;

      const allComments = sourceCode.getAllComments();
      return allComments.some((c) => {
        if (!/allow-adhoc-markdown:\s*\S/.test(c.value)) return false;
        // Same line, or one line above
        return c.loc.start.line === nodeStartLine || c.loc.start.line === nodeStartLine - 1;
      });
    }

    // ── Fence-block-strip detection ──────────────────────────────────────────
    // A regex literal whose source contains ``` or ~~~ AND contains [\s\S] or
    // [\S\s] (a multiline body), indicating it strips/matches a fenced block.
    // A bare /^```/ or /^\s*(?:```|~~~)/ (line-detection, no multiline body)
    // is explicitly NOT flagged.
    const TRIPLE_BACKTICK = '```'; // ```
    const TRIPLE_TILDE = '~~~';

    function isFenceBlockStripRegex(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      const src = node.regex.pattern || '';
      // Must contain a triple fence delimiter
      if (!src.includes(TRIPLE_BACKTICK) && !src.includes(TRIPLE_TILDE)) return false;
      // Must ALSO contain a multiline body marker — i.e. it spans blocks, not just lines
      const hasMultilineBody = src.includes('[\\s\\S]') || src.includes('[\\S\\s]');
      return hasMultilineBody;
    }

    // ── Section-collect regex detection ─────────────────────────────────────
    // Matches patterns of the shape:
    //   /(#{1,6}...\n)([\s\S]*?)(?=\n#{...}|$)/
    // The key fingerprint is: [\\s\\S] (or [\s\S]) AND (?= (lookahead) AND # in
    // the same regex, forming the "body up to next heading" construct.
    function isSectionCollectRegexSource(src) {
      // Must contain [\s\S] (the non-greedy body)
      const hasMultilineBody = src.includes('[\\s\\S]') || src.includes('[\\S\\s]');
      if (!hasMultilineBody) return false;
      // Must contain a lookahead (?= that references a heading anchor #
      const hasHeadingLookahead = /\(\?=.*#/.test(src);
      return hasHeadingLookahead;
    }

    function isSectionCollectRegex(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      return isSectionCollectRegexSource(node.regex.pattern || '');
    }

    // ── Table-regex detection ───────────────────────────────────────────────
    // A regex source containing an escaped pipe (\| — the GFM table-cell
    // delimiter) AND a negated-pipe cell-capture character class ([^|] or
    // [^\|]), indicating a hand-rolled table-row/cell scan such as /\|[^|]*\|/.
    // Conservative by design: a bare escaped-pipe delimiter probe with no
    // negated-pipe cell class is NOT flagged.
    //
    // The negated class qualifies ONLY when its body is the pipe (escaped or
    // bare) plus zero or more of the two-character line-terminator/tab escapes
    // `\n`, `\r`, `\t` (#2880): the common, and strictly MORE correct, spelling
    // is `[^|\n]` (a GFM cell can span neither a pipe nor a line break) —
    // `src/state-document.cts` used exactly that and evaded the rule entirely,
    // which is the ADR-2143 §7 enforcement hole this widening closes. A
    // negated class that excludes the pipe alongside anything ELSE — e.g.
    // `[^\s|]`, `[^"|]`, `[^a-z|]` — is a different (non-table) idiom and is
    // NOT flagged, and a negated class that does not exclude a pipe at all
    // (`[^\n]`, `[^a-z]`) is still NOT a cell scan.
    //
    // Implemented as a single-pass scanner (not a regex) — see
    // hasQualifyingNegatedPipeClass below for why the regex encoding of this
    // fingerprint was rejected (quadratic-on-failure blowup).
    function isTableRegexSource(src) {
      // Must contain an escaped pipe
      if (!src.includes('\\|')) return false;
      return hasQualifyingNegatedPipeClass(src);
    }

    // ── Single-pass negated-character-class scanner (FIX 3 + FIX 4) ─────────
    // Walks `src` once, left to right. On encountering a negated class
    // `[^...]` it scans forward to the class's closing `]` (honoring `\`
    // escapes within the class) exactly once, then resumes scanning
    // immediately AFTER that `]` — never backtracking into the class body.
    // This keeps the whole walk O(n) regardless of how many negated classes
    // (or how large) the source contains — unlike the regex it replaces,
    // /\[\^[^\]]*\\?\|[^\]]*\]/, which is quadratic on failure (two unbounded
    // [^\]]* runs around an optional), measured at ~23s for a 256000-char
    // adversarial input.
    //
    // Returns true if ANY negated class in `src` QUALIFIES as a hand-rolled
    // GFM cell-capture class: it excludes a pipe (`\|` or bare `|`) and,
    // after removing that pipe, every remaining member is one of the
    // two-character line-terminator/tab escapes `\n`, `\r`, `\t` (zero extra
    // members is fine — `[^|]` alone qualifies). A class that excludes the
    // pipe alongside anything ELSE (`[^\s|]`, `[^"|]`, `[^a-z|]`) does NOT
    // qualify — that is a different, non-table idiom. A class that never
    // excludes a pipe at all (`[^\n]`, `[^a-z]`) does not qualify either.
    function hasQualifyingNegatedPipeClass(src) {
      let i = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[' && src[i + 1] === '^') {
          let j = i + 2;
          let classHasPipe = false;
          let classIsPure = true;
          let closed = false;
          while (j < src.length) {
            const cc = src[j];
            if (cc === '\\') {
              const next = src[j + 1];
              if (next === '|') {
                classHasPipe = true;
              }
              else if (next !== 'n' && next !== 'r' && next !== 't') {
                classIsPure = false;
              }
              j += 2;
              continue;
            }
            if (cc === ']') {
              closed = true;
              j += 1;
              break;
            }
            if (cc === '|') {
              classHasPipe = true;
            }
            else {
              classIsPure = false;
            }
            j += 1;
          }
          if (closed && classHasPipe && classIsPure) return true;
          i = closed ? j : src.length;
          continue;
        }
        i += 1;
      }
      return false;
    }

    function isTableRegex(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      return isTableRegexSource(node.regex.pattern || '');
    }

    // ── new RegExp(<Literal-string | TemplateLiteral>) source extraction ─────
    // Builds the EFFECTIVE regex source text for a `new RegExp(...)` call so
    // the same fingerprint checks above can run against it. Only a string
    // Literal or a TemplateLiteral first argument is inspected — anything else
    // (an Identifier, a call, string concatenation via `+`) is out of scope,
    // keeping this conservative (no false positives from an un-inspectable
    // dynamic pattern). For a TemplateLiteral, only the STATIC quasis (cooked —
    // escapes already resolved, matching what `node.regex.pattern` gives for a
    // literal) are concatenated; every `${...}` expression contributes nothing,
    // so a dynamic segment can neither manufacture nor hide the fingerprint.
    /**
     * Same scope walk as `resolveVariableInit` below (~line 224), but
     * additionally requires the binding be a `const` declaration (#2245
     * audit). Used ONLY by `getNewRegExpSource`'s Identifier-resolution
     * branch: a `let`/`var` regex identifier can be reassigned elsewhere in
     * its scope, so trusting its FIRST initializer would be unsound in a way
     * a `const` binding's initializer never is. A function parameter or a
     * call-result initializer already fails the VariableDeclarator/`init`
     * shape check and returns `null` regardless.
     */
    function resolveConstVariableInit(identifierName, scope) {
      let s = scope;
      while (s) {
        const variable = s.variables.find((v) => v.name === identifierName);
        if (variable) {
          const def = variable.defs && variable.defs[0];
          if (
            def
            && def.node
            && def.node.type === 'VariableDeclarator'
            && def.node.init
            && def.parent
            && def.parent.type === 'VariableDeclaration'
            && def.parent.kind === 'const'
          ) {
            return def.node.init;
          }
          return null;
        }
        s = s.upper;
      }
      return null;
    }

    function getNewRegExpSource(node, scope) {
      if (node.type !== 'NewExpression') return null;
      if (!node.callee || node.callee.type !== 'Identifier' || node.callee.name !== 'RegExp') return null;
      const arg = node.arguments && node.arguments[0];
      if (!arg) return null;
      if (arg.type === 'Literal' && typeof arg.value === 'string') {
        return arg.value;
      }
      if (arg.type === 'TemplateLiteral') {
        return arg.quasis.map((q) => (q.value && q.value.cooked) || '').join('');
      }
      // Identifier resolution (#2245 audit — recall-hole fix): `new
      // RegExp(tableRe)` where `const tableRe = /.../` (or a string/template
      // literal) escaped the fingerprint entirely before this. Conservative
      // by design: only a const-declared literal/template initializer is
      // followed; anything else (param, call, `let`/`var`, concatenation)
      // resolves to `null` and is silently out of scope, same as before.
      if (arg.type === 'Identifier' && scope) {
        const init = resolveConstVariableInit(arg.name, scope);
        if (init) {
          if (init.type === 'Literal' && init.regex) return init.regex.pattern || '';
          if (init.type === 'Literal' && typeof init.value === 'string') return init.value;
          if (init.type === 'TemplateLiteral') {
            return init.quasis.map((q) => (q.value && q.value.cooked) || '').join('');
          }
        }
      }
      return null;
    }

    function isNewRegExpTableRegex(node, scope) {
      const src = getNewRegExpSource(node, scope);
      return src !== null && isTableRegexSource(src);
    }

    // ── ADHOC-REPLACE-MUTATION detection (ADR-2143 §7 Phase 4) ──────────────
    // A `.replace(` call whose receiver is a roadmap/state-ish identifier AND
    // whose first argument resolves (directly, or via a same-scope `const`
    // declaration) to a regex Literal or `new RegExp(...)` matching either the
    // TABLE or SECTION-COLLECT fingerprint.
    const REPLACE_RECEIVER_RE = /roadmap|state|reqContent|content/i;

    /** Resolve a Literal-regex or new-RegExp(...) source directly from `node`. */
    function directRegexSource(node) {
      if (node.type === 'Literal' && node.regex) return node.regex.pattern || '';
      const newRegExpSrc = getNewRegExpSource(node);
      if (newRegExpSrc !== null) return newRegExpSrc;
      return null;
    }

    /** Walk up the scope chain from `scope` to find `identifierName`'s declared initializer. */
    function resolveVariableInit(identifierName, scope) {
      let s = scope;
      while (s) {
        const variable = s.variables.find((v) => v.name === identifierName);
        if (variable) {
          const def = variable.defs && variable.defs[0];
          if (def && def.node && def.node.type === 'VariableDeclarator' && def.node.init) {
            return def.node.init;
          }
          return null;
        }
        s = s.upper;
      }
      return null;
    }

    /** Resolve the effective regex source for a `.replace()` pattern argument. */
    function resolveReplacePatternSource(argNode, scope) {
      const direct = directRegexSource(argNode);
      if (direct !== null) return direct;
      if (argNode.type === 'Identifier') {
        const init = resolveVariableInit(argNode.name, scope);
        if (init) return directRegexSource(init);
      }
      return null;
    }

    function isAdhocReplaceMutation(node, scope) {
      if (node.type !== 'CallExpression') return false;
      const callee = node.callee;
      if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
      if (!callee.property || callee.property.name !== 'replace') return false;
      const receiver = callee.object;
      if (!receiver || receiver.type !== 'Identifier' || !REPLACE_RECEIVER_RE.test(receiver.name)) return false;
      const patternArg = node.arguments && node.arguments[0];
      if (!patternArg) return false;
      const src = resolveReplacePatternSource(patternArg, scope);
      if (src === null) return false;
      return isTableRegexSource(src) || isSectionCollectRegexSource(src);
    }

    return {
      Literal(node) {
        // 1. Fence-block-strip regex
        if (isFenceBlockStripRegex(node)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'fenceRegex' });
          }
          return;
        }

        // 2. Section-collect regex
        if (isSectionCollectRegex(node)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'sectionCollect' });
          }
          return;
        }

        // 3. Table-regex (hand-rolled table-row/cell scan)
        if (isTableRegex(node)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'tableRegex' });
          }
        }
      },

      // 3b. Table-regex built via new RegExp(<Literal-string | TemplateLiteral
      //     | const-declared identifier resolving to either>)
      NewExpression(node) {
        const scope = context.getScope ? context.getScope() : sourceCode.getScope(node);
        if (isNewRegExpTableRegex(node, scope)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'tableRegex' });
          }
        }
      },

      // 4. Ad-hoc .replace() mutation of a roadmap/state document
      CallExpression(node) {
        const scope = context.getScope ? context.getScope() : sourceCode.getScope(node);
        if (isAdhocReplaceMutation(node, scope)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'adhocReplaceMutation' });
          }
        }
      },
    };
  },
};

module.exports = rule;
