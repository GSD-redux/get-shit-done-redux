/**
 * token-scanner.cts — the tokenizer-first seam for stateful grammars (ADR-3212
 * §4, epic #3212 Phase 3, #3414).
 *
 * Source in src/token-scanner.cts, compiled to gsd-core/bin/lib/token-scanner.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Generalizes the proven `hooks/lib/git-cmd.js` token-walk (#3129 — "has not
 * re-opened") into a primitive other stateful-grammar consumers can share.
 * `git-cmd.js` migrates onto `tokenizeShellLike` with zero behavior change
 * (ADR §6); its own env-prefix/flag/subcommand walk logic stays put — only
 * the character-level tokenizer moves here.
 *
 * `indentWidth` is the primitive `src/decisions.cts`'s #3169 fix needs: a
 * decision-bullet list can NEST (a bullet elaborating on an already-open
 * decision, indented deeper than it), and a per-line regex cannot see that
 * nesting — only tracking indentation relative to the currently-open
 * decision can (ADR §4 criterion 1). See
 * .gsd/phase/chore-3414-tokenizer-first-seam/40-design.md §1.3 for the
 * disproven bold-run-content-classification alternative and why nesting
 * depth, not bullet content, is the actual distinguishing signal.
 */

/**
 * Tokenize a shell-like command string: whitespace-split, with single- and
 * double-quoted spans taken as one token each. No escape handling, no
 * brace/variable expansion — matches `hooks/lib/git-cmd.js`'s original
 * `tokenize()` exactly (parity-asserted in tests/token-scanner.test.cjs).
 */
export function tokenizeShellLike(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = cmd.length;

  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;

    let token = '';
    while (i < len && !/\s/.test(cmd[i])) {
      if (cmd[i] === "'") {
        i++;
        while (i < len && cmd[i] !== "'") token += cmd[i++];
        if (i < len) i++;
      } else if (cmd[i] === '"') {
        i++;
        while (i < len && cmd[i] !== '"') token += cmd[i++];
        if (i < len) i++;
      } else {
        token += cmd[i++];
      }
    }
    if (token) tokens.push(token);
  }

  return tokens;
}

/**
 * Count a line's leading whitespace width. Tabs count as one column each
 * (not expanded) — matches `src/decisions.cts`'s existing continuation-line
 * check (`/^[ \t]/`), which never expanded tabs either; this function does
 * not introduce a new tab-width policy.
 */
export function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}
