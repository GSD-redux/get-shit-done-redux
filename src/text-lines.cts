/**
 * text-lines.cts — the line-terminator seam (ADR-3212 §3, epic #3212 Phase 2,
 * #3413).
 *
 * Source in src/text-lines.cts, compiled to gsd-core/bin/lib/text-lines.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Sole owner of `\r?\n` splitting and CRLF normalization. Closes #3360: a
 * regex anchored on `^`/`$` under `/m` against a whole multi-line string is
 * exposed to `\r` being its own LineTerminator (ECMA-262), so a greedy `\s*`
 * can cross a CRLF boundary and inflate a captured indent by one character.
 * Split-then-match — call `splitLines` first, then match per already-split
 * line — is immune by construction, because a single split line can never
 * contain the delimiter that produced it. This module exists so that shape
 * is the easy, obvious way to write indentation-sensitive parsing, per the
 * design doc (.gsd/phase/chore-3413-text-lines-seam/40-design.md).
 *
 * A "genuine leaf" module (CONTEXT.md's term, shared with Phase 1's sibling
 * seam `src/pattern.cts`): zero I/O, zero imports from other `src/*.cts`
 * modules, pure string functions only.
 */

/**
 * Split document content into lines on `\r\n` or `\n`. A lone `\r` (bare CR,
 * no following `\n`) is NOT a delimiter — this matches every existing
 * `\r?\n` call site in the repo and is intentionally narrower than "treat
 * any LineTerminator as a break." Matches `String.prototype.split`'s own
 * contract for a trailing terminator (a trailing empty element) and for the
 * empty string (`[""]`).
 */
export function splitLines(content: string): string[] {
  if (typeof content !== 'string') {
    throw new TypeError(`splitLines: expected a string, got ${typeof content}`);
  }
  return content.split(/\r?\n/);
}

/**
 * Normalize all line endings to LF by stripping every `\r` character — not
 * only `\r\n` pairs. This is byte-for-byte the same operation as the 4
 * `scripts/gen-*.cjs` copies of `normalizeLineEndings` this module
 * consolidates (`content.replace(/\r/g, '')`), so a lone/unpaired `\r` (old
 * Mac-style content) is stripped too. Deliberately a different contract from
 * `splitLines`, which does NOT treat a bare `\r` as a delimiter (row 6) —
 * these are two different operations kept as two separate functions rather
 * than one "handle all CR-ish things" primitive.
 */
export function normalizeEol(content: string): string {
  return content.replace(/\r/g, '');
}

/**
 * Detect the dominant line-terminator in `content`: `'\r\n'` when CRLF pairs
 * outnumber bare LFs, `'\n'` when bare LFs outnumber CRLF pairs, and `'\r\n'`
 * as the default when there is no bare LF at all (all-CRLF content, or no
 * terminator present whatsoever — an empty or single-line input). See the
 * design doc's Rejected section for why the tie/empty default is `'\r\n'`
 * rather than `'\n'`: this function exists to PRESERVE whatever a file
 * already uses, not to bias toward LF the way a write-time normalizer would.
 */
export function detectEol(content: string): '\n' | '\r\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const totalLfCount = (content.match(/\n/g) || []).length;
  const bareLfCount = totalLfCount - crlfCount;
  if (bareLfCount === 0 || crlfCount >= bareLfCount) return '\r\n';
  return '\n';
}

/**
 * Join lines back into a single string with `eol` (default `'\n'`) between
 * each pair — the inverse of `splitLines`. `joinLines(splitLines(x),
 * detectEol(x))` reproduces `x` byte-for-byte for any `x` already in
 * canonical (single-terminator) form (ADR-3212 §3's round-trip property).
 */
export function joinLines(lines: string[], eol?: '\n' | '\r\n'): string {
  return lines.join(eol ?? '\n');
}
