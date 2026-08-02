/**
 * Markdown Sectionizer — canonical markdown-structure parsing seam
 *
 * Pure functions, Node built-ins only (no external deps). String-in → value-out, no I/O.
 * Promoted from `uat-predicate.cts` `_stripFencedBlocks` (CommonMark-correct state machine)
 * and extended with heading tokenisation, section collection, and bullet iteration.
 *
 * ADR-1372 — T0 foundational seam. Migration tiers T1–T7 progressively adopt this seam.
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/markdown-sectionizer.cjs.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of stripping fenced code blocks from markdown content. */
export interface StripFencedResult {
  /** Content with all fenced code blocks removed (delimiters and body lines). */
  text: string;
  /**
   * True when the input contained an unterminated fence (EOF inside a fence).
   * Callers that wish to signal malformed input to the user should inspect this.
   */
  unterminatedFence: boolean;
}

/** An ATX heading extracted by `tokenizeHeadings`. */
export interface HeadingToken {
  /** Heading depth: 1 = `#`, 2 = `##`, 3 = `###`, etc. */
  level: number;
  /** Heading text with surrounding whitespace trimmed. */
  text: string;
  /** 1-based line number of the heading in the original content. */
  line: number;
  /** Character (string-index) offset of the `#` character in the original content string. */
  offset: number;
}

/** A collected markdown section (heading + body). */
export interface Section {
  /** The heading that opened this section. */
  heading: HeadingToken;
  /** All lines between this heading and the next stop, joined by `\n`. */
  body: string;
  /**
   * Character (string-index) offset in the ORIGINAL content string where the
   * section body begins (first character after the heading line's trailing newline).
   * Populated by `collectSections` and `collectSection`.
   * Used by `replaceSection` for a clean pure splice.
   *
   * INVARIANT: `content.slice(bodyStart, bodyEnd) === body` for every Section
   * returned by `collectSection` and `collectSections`.
   */
  bodyStart: number;
  /**
   * Character (string-index) offset in the ORIGINAL content string where the
   * section body ends (exclusive). Because `body` is `trimEnd()`-ed, this equals
   * `bodyStart + body.length` — NOT the start of the next heading line.
   *
   * INVARIANT: `content.slice(bodyStart, bodyEnd) === body`.
   * This guarantees `replaceSection(content, section, section.body) === content`.
   */
  bodyEnd: number;
}

/** Options shared by `collectSection` and `withSection` (see `collectSection`'s doc comment). */
export interface CollectSectionOptions {
  levelBounded?: boolean;
  stopAtLevel?: number;
  stripFences?: boolean;
}

/** Recognised bullet markers. */
export type BulletMarker = 'dash' | 'checkbox-unchecked' | 'checkbox-checked' | 'numbered';

/** A single bullet item from `iterateBullets`. */
export interface BulletItem {
  /** Which marker shape was recognised. */
  marker: BulletMarker;
  /** Full bullet text including all indented continuation lines, whitespace-trimmed. */
  text: string;
  /** Raw indentation prefix of the opening bullet line. */
  indent: string;
  /** Checkbox state — `true` for `[x]`, `false` for `[ ]`, `null` for non-checkbox. */
  checked: boolean | null;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface FenceState {
  char: '`' | '~';
  len: number;
}

// ─── stripFencedCode ──────────────────────────────────────────────────────────

/**
 * CommonMark-correct fenced-code-block stripper.
 *
 * Ported from `uat-predicate.cts` `_stripFencedBlocks` — the reference
 * implementation for the repo. DO NOT modify `uat-predicate.cts` (its
 * migration is T5); this is a tracked duplication until T5 lands.
 *
 * Rules:
 * - Opening delimiter: a line whose non-indent portion begins with ≥3 backticks
 *   or tildes (≤3 leading spaces tolerated per CommonMark §4.5).
 * - Closing delimiter: same character, run length ≥ opening, no trailing
 *   non-whitespace text.
 * - A tilde fence inside a backtick fence (or vice versa) is fence *content*,
 *   not a closing delimiter — delimiter char must match.
 * - Both delimiter lines and all content lines are dropped from the output.
 * - CRLF-safe: trailing `\r` is stripped before delimiter matching; the kept
 *   non-fence lines are returned as-is (including any `\r`).
 * - `unterminatedFence` signals EOF inside an open fence.
 */
export function stripFencedCode(content: string): StripFencedResult {
  if (typeof content !== 'string') {
    return { text: '', unterminatedFence: false };
  }
  const lines = content.split('\n');
  const kept: string[] = [];
  let openFence: FenceState | null = null;

  // Matches: optional indent (≤3 spaces per CommonMark), fence run, optional info string
  const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;

  for (const rawLine of lines) {
    // Strip trailing \r for delimiter matching (CRLF safety)
    const line = rawLine.replace(/\r$/, '');
    const m = delimRe.exec(line);
    if (m) {
      const char = m[2][0] as '`' | '~';
      const len = m[2].length;
      const trailing = m[3];
      if (openFence === null) {
        // CommonMark §4.5: backtick fence info string must not contain a backtick.
        // If it does, this line is NOT a valid fence opener (treat as ordinary content).
        if (char === '`' && trailing.includes('`')) {
          kept.push(rawLine);
          continue;
        }
        // Opening delimiter — record fence state, drop this line
        openFence = { char, len };
      } else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
        // Closing delimiter (same char, sufficient length, no trailing content) — close and drop
        openFence = null;
      }
      // else: mismatched delimiter inside fence — treat as content, still drop (it's a fence line)
      continue; // all delimiter lines are dropped
    }

    if (openFence === null) {
      kept.push(rawLine); // non-fence content: keep as-is (preserve original \r if any)
    }
    // Lines inside a fence are silently dropped
  }

  return { text: kept.join('\n'), unterminatedFence: openFence !== null };
}

// ─── stripInlineCode ──────────────────────────────────────────────────────────

/**
 * Remove CommonMark inline code spans (§6.1) from prose, line by line.
 *
 * A span opens with a run of N backticks and closes at the next run of EXACTLY
 * N backticks on the same line (a longer or shorter run is span content, per
 * CommonMark). The whole span — delimiters and content — is replaced by a
 * single space so the surrounding words do not join. A run with no matching
 * closer is literal text and is kept. Spans never cross line boundaries here:
 * multi-line code in planning prose is fenced-block territory
 * (`stripFencedCode`).
 *
 * Companion to `stripFencedCode` for term-matching callers (#2365): strip
 * fenced blocks first, then inline spans, so a trigger term inside backticks
 * is code, not prose evidence.
 */
export function stripInlineCode(content: string): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  return content.split('\n').map(stripInlineCodeLine).join('\n');
}

/** An inline code span located by `scanInlineCodeSpans`: [start, end) covers
 *  the WHOLE span including both backtick delimiters; `content` is the inner
 *  text between them. */
export interface InlineCodeSpan {
  start: number;
  end: number;
  content: string;
}

/**
 * Locate every inline code span in `content`, per line (offsets are into the
 * full string; spans never cross a `\n`). Callers that need the span CONTENT
 * (e.g. api-coverage's dependency-evidence scan, #2365) use this; callers that
 * just want spans gone use `stripInlineCode`.
 */
export function scanInlineCodeSpans(content: string): InlineCodeSpan[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  const out: InlineCodeSpan[] = [];
  let lineStart = 0;
  for (const line of content.split('\n')) {
    for (const s of scanSpansInLine(line)) {
      out.push({ start: lineStart + s.start, end: lineStart + s.end, content: s.content });
    }
    lineStart += line.length + 1;
  }
  return out;
}

function scanSpansInLine(line: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  if (line.indexOf('`') === -1) return spans;
  // Collect the maximal backtick RUNS once, then match openers to closers using
  // a per-length forward cursor. A naive "search the rest of the line for the
  // closer" loop is O(n²) on a line of many unmatched increasing-length runs
  // (#2365 review 9); precomputing runs makes the whole scan linear while
  // preserving CommonMark semantics (closer = next run of EXACTLY the same len).
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === '`') {
      let n = 1;
      while (i + n < line.length && line[i + n] === '`') n++;
      runs.push([i, n]);
      i += n;
    } else {
      i++;
    }
  }
  const runsByLen = new Map<number, number[]>();
  for (let k = 0; k < runs.length; k++) {
    const len = runs[k][1];
    const arr = runsByLen.get(len);
    if (arr) arr.push(k);
    else runsByLen.set(len, [k]);
  }
  const cursorByLen = new Map<number, number>();
  let k = 0;
  while (k < runs.length) {
    const [openPos, n] = runs[k];
    const candidates = runsByLen.get(n)!; // n came from this map, always present
    let ci = cursorByLen.get(n) ?? 0;
    while (ci < candidates.length && candidates[ci] <= k) ci++;
    if (ci < candidates.length) {
      const closeK = candidates[ci];
      const closePos = runs[closeK][0];
      spans.push({ start: openPos, end: closePos + n, content: line.slice(openPos + n, closePos) });
      cursorByLen.set(n, ci + 1);
      k = closeK + 1; // resume after the closer — runs inside the span are code
    } else {
      cursorByLen.set(n, ci);
      k++; // unmatched run → literal text, next run is a fresh opener
    }
  }
  return spans;
}

function stripInlineCodeLine(line: string): string {
  const spans = scanSpansInLine(line);
  if (spans.length === 0) return line;
  let out = '';
  let prev = 0;
  for (const s of spans) {
    out += line.slice(prev, s.start) + ' ';
    prev = s.end;
  }
  return out + line.slice(prev);
}

// ─── extractFencedBlock ───────────────────────────────────────────────────────

/** A fenced code block located by `scanFencedBlocks`: line-index span + info string. */
export interface FencedBlockRecord {
  /** Fence delimiter character (`` ` `` or `~`). */
  char: '`' | '~';
  /** Fence delimiter run length (≥3). */
  len: number;
  /** Opening line's trailing text (untrimmed) — the CommonMark "info string". */
  infoString: string;
  /** 0-based index (into the `lines` array) of the OPENING delimiter line. */
  openLineIdx: number;
  /**
   * 0-based index of the CLOSING delimiter line, or `-1` when the fence is
   * unterminated (EOF reached while still open — mirrors `stripFencedCode`'s
   * `unterminatedFence` signal).
   */
  closeLineIdx: number;
}

/**
 * Shared low-level fence-scanning engine. Walks `lines` and returns every
 * fenced block found, applying the EXACT SAME CommonMark delimiter rules as
 * `stripFencedCode` (≥3 backticks/tildes, ≤3-space indent tolerance, a closer
 * must be the same delimiter char with run length ≥ the opener and no
 * trailing non-whitespace text; a mismatched delimiter char — or a same-char
 * run that is too short or carries trailing text — encountered while a fence
 * is already open is fence CONTENT, not a new open/close event). This is the
 * "engine" `extractFencedBlock` reuses instead of an ad-hoc regex, so a
 * different-info-string fence, a fence nested/indented inside another fence,
 * and a `~~~` fence are all classified exactly as `stripFencedCode` would.
 *
 * Tracked duplication (same status as `tokenizeHeadings`'s copy, see its
 * comment above): this is a second independent copy of the fence state
 * machine, pending a T-tier consolidation.
 *
 * Exported so `context-predicates.cts` can consume this seam directly for its
 * line-preserving fenced-line skip detection, instead of carrying a third
 * independent copy of the fence state machine (see that module's doc
 * comment).
 */
export function scanFencedBlocks(lines: string[]): FencedBlockRecord[] {
  const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  const blocks: FencedBlockRecord[] = [];
  let open: { char: '`' | '~'; len: number; infoString: string; openLineIdx: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const m = delimRe.exec(line);
    if (!m) continue;

    const char = m[2][0] as '`' | '~';
    const len = m[2].length;
    const trailing = m[3];

    if (open === null) {
      // CommonMark §4.5: backtick fence info string must not contain a backtick.
      if (char === '`' && trailing.includes('`')) continue; // not a valid opener — ordinary content
      open = { char, len, infoString: trailing.trim(), openLineIdx: i };
    } else if (char === open.char && len >= open.len && /^\s*$/.test(trailing)) {
      blocks.push({
        char: open.char,
        len: open.len,
        infoString: open.infoString,
        openLineIdx: open.openLineIdx,
        closeLineIdx: i,
      });
      open = null;
    }
    // else: mismatched/insufficient delimiter while a fence is open — content, not a boundary.
  }

  if (open !== null) {
    blocks.push({
      char: open.char,
      len: open.len,
      infoString: open.infoString,
      openLineIdx: open.openLineIdx,
      closeLineIdx: -1,
    });
  }

  return blocks;
}

/**
 * Return the INNER text (the lines between the delimiters, joined by `\n`) of
 * the FIRST fenced code block whose opening info string — trimmed,
 * case-insensitive — equals `infoString`. Returns `null` when no such block
 * exists, including when the only matching-name fence is left unterminated
 * (EOF inside the fence — there is no well-defined inner span to return,
 * matching a non-greedy `\n```-anchored` regex's behaviour of also failing to
 * match an unclosed fence).
 *
 * Built on `scanFencedBlocks`, the same CommonMark fence-tracking engine
 * `stripFencedCode` uses — so a fence of a DIFFERENT info string, a fence
 * nested/indented inside another fence, and a `~~~` fence are all handled
 * exactly as `stripFencedCode` would classify them; this is not a fresh
 * ad-hoc regex.
 *
 * Migrated from `api-coverage.cts`'s bespoke
 * `` /```coverage\s*\n([\s\S]*?)\n```/i `` (ADR-1372 tier migration, #2143 audit).
 */
export function extractFencedBlock(content: string, infoString: string): string | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  if (typeof infoString !== 'string') return null;

  const target = infoString.trim().toLowerCase();
  const lines = content.split('\n');
  const blocks = scanFencedBlocks(lines);

  for (const block of blocks) {
    if (block.closeLineIdx === -1) continue; // unterminated — no well-defined inner span
    if (block.infoString.trim().toLowerCase() !== target) continue;
    return lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
  }

  return null;
}

// ─── tokenizeHeadings ─────────────────────────────────────────────────────────

/**
 * Extract all ATX headings from `content` in document order.
 *
 * Only headings OUTSIDE fenced code blocks are returned — `stripFencedCode` is
 * applied first so that a `## heading` inside a ``` fence is not tokenised.
 *
 * Each token records `{ level, text, line, offset }` where `offset` is relative
 * to the ORIGINAL `content` (before fence-stripping), enabling callers to use
 * `collectSection` on the original string.
 */
export function tokenizeHeadings(content: string): HeadingToken[] {
  if (typeof content !== 'string' || content.length === 0) return [];

  // Strip fences first so headings inside code blocks are ignored.
  // We need the original line positions, so we map stripped-text line numbers
  // back to original by tracking which original lines survived stripping.
  const originalLines = content.split('\n');
  const tokens: HeadingToken[] = [];

  // We re-run the fence state machine to know which lines are "kept", so we
  // can map line index in original to whether it survived.
  const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  let openFence: FenceState | null = null;

  // Accumulate character offset as we iterate lines
  let charOffset = 0;

  for (let i = 0; i < originalLines.length; i++) {
    const rawLine = originalLines[i];
    const line = rawLine.replace(/\r$/, '');

    const dm = delimRe.exec(line);
    if (dm) {
      const char = dm[2][0] as '`' | '~';
      const len = dm[2].length;
      const trailing = dm[3];
      if (openFence === null) {
        // CommonMark §4.5: backtick fence info string must not contain a backtick.
        if (char === '`' && trailing.includes('`')) {
          // Not a valid fence opener — check for heading on this line (will fall through)
        } else {
          openFence = { char, len };
          charOffset += rawLine.length + 1;
          continue;
        }
      } else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
        openFence = null;
        charOffset += rawLine.length + 1;
        continue;
      } else {
        // Mismatched/invalid delimiter inside fence — treat as content (still inside fence), skip heading check
        charOffset += rawLine.length + 1;
        continue;
      }
    }

    if (openFence === null) {
      // This line is outside any fence — check for ATX heading.
      // CommonMark: ≤3 leading spaces, then 1–6 `#`, then either EOF (empty heading)
      // or at least one space/tab followed by optional text, with optional closing `#` sequence.
      const headingMatch = /^( {0,3})(#{1,6})([ \t]+.*|[ \t]*)?$/.exec(line);
      if (headingMatch) {
        const hashes = headingMatch[2];
        const rest = headingMatch[3] ?? '';
        // Strip optional closing `#` sequence: trailing whitespace + one or more `#` + optional whitespace
        const rawText = rest.replace(/^[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '');
        tokens.push({
          level: hashes.length,
          text: rawText.trim(),
          line: i + 1, // 1-based
          offset: charOffset,
        });
      }
    }

    charOffset += rawLine.length + 1;
  }

  return tokens;
}

// ─── collectSections ─────────────────────────────────────────────────────────

/**
 * Collect sections from `content`, calling `stopPredicate` on each heading to
 * decide where sections end.
 *
 * Returns an array of `Section` objects, one per matched heading. The `body`
 * of each section runs from the line after the heading up to (but not
 * including) the next heading that satisfies `stopPredicate`, or EOF.
 *
 * Unlike a greedy-regex approach, this is a line-by-line walk — compatible
 * with the repo's "line-by-line section collection" pattern.
 */
export function collectSections(
  content: string,
  stopPredicate: (heading: HeadingToken) => boolean,
): Section[] {
  if (typeof content !== 'string' || content.length === 0) return [];

  const headings = tokenizeHeadings(content);
  if (headings.length === 0) return [];

  const lines = content.split('\n');
  const sections: Section[] = [];

  // Build a set of line numbers (1-based) that are heading lines
  const headingsByLine = new Map<number, HeadingToken>();
  for (const h of headings) {
    headingsByLine.set(h.line, h);
  }

  // Build a byte-offset table: lineOffsets[i] = byte offset of the start of line i+1 (1-based: i=0 → line 1)
  // The body of a section starts at the byte after the heading line's trailing '\n'.
  const lineOffsets: number[] = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = acc;
    acc += lines[i].length + 1; // +1 for the '\n' we split on
  }
  // lineOffsets[i] is the byte offset of line (i+1) (1-based). EOF sentinel:
  const eofOffset = acc; // === content.length + (content.endsWith('\n') ? 0 : 0) ≈ content.length

  let currentHeading: HeadingToken | null = null;
  let currentBodyStart = 0;
  let bodyLines: string[] = [];

  const flush = (_bodyEndOffset: number): void => {
    if (currentHeading !== null) {
      const rawBody = bodyLines.join('\n');
      const body = rawBody.trimEnd();
      // INVARIANT: content.slice(bodyStart, bodyEnd) === body
      // bodyEnd is derived from body.length, NOT from the raw separator offset,
      // so round-trips via replaceSection(content, section, section.body) are exact.
      sections.push({
        heading: currentHeading,
        body,
        bodyStart: currentBodyStart,
        bodyEnd: currentBodyStart + body.length,
      });
      currentHeading = null;
      bodyLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1; // 1-based
    const h = headingsByLine.get(lineNo);
    if (h !== undefined && stopPredicate(h)) {
      // This heading is a stop boundary — flush current section, start new one.
      // The body ends at the start of this heading line.
      flush(lineOffsets[i]);
      currentHeading = h;
      // Body starts at the beginning of the line AFTER the heading line
      const headingLineIdx = h.line - 1; // 0-based
      currentBodyStart = lineOffsets[headingLineIdx] + lines[headingLineIdx].length + 1;
    } else if (currentHeading !== null) {
      bodyLines.push(lines[i]);
    }
  }
  flush(eofOffset);

  return sections;
}

// ─── collectSection ───────────────────────────────────────────────────────────

/**
 * Collect a single section whose heading satisfies `headingPredicate`.
 *
 * Options:
 * - `levelBounded` (default: `true`): the section ends at the next heading of
 *   the same or higher level (lower level number = higher in the hierarchy).
 *   When `false`, the section body runs until any heading or EOF.
 *   Ignored when `stopAtLevel` is provided.
 * - `stopAtLevel` (optional): when provided, the section ends at the next heading
 *   whose `level <= stopAtLevel`, regardless of the opener's level. This enables
 *   modeling sections like a `##`-opened section that also stops at `###`
 *   (pass `stopAtLevel: 3`). Takes precedence over `levelBounded` when set.
 * - `stripFences` (default: `false`): apply `stripFencedCode` to the body
 *   before returning. The `heading` in the result always refers to the original
 *   heading (pre-strip).
 *
 * Returns `null` when no matching heading is found.
 */
export function collectSection(
  content: string,
  headingPredicate: (heading: HeadingToken) => boolean,
  opts: CollectSectionOptions = {},
): Section | null {
  if (typeof content !== 'string' || content.length === 0) return null;

  const { levelBounded = true, stopAtLevel, stripFences = false } = opts;

  const headings = tokenizeHeadings(content);
  const targetIdx = headings.findIndex(headingPredicate);
  if (targetIdx === -1) return null;

  const target = headings[targetIdx];
  const lines = content.split('\n');

  // Determine which headings act as stops after the target
  const bodyStartLine = target.line + 1; // 1-based, first line of body
  let bodyEndLine = lines.length + 1; // 1-based, exclusive (default: EOF+1)

  for (let j = targetIdx + 1; j < headings.length; j++) {
    const next = headings[j];
    let isStop: boolean;
    if (stopAtLevel !== undefined) {
      // stopAtLevel: stop at the next heading whose level <= stopAtLevel
      isStop = next.level <= stopAtLevel;
    } else {
      isStop = levelBounded ? next.level <= target.level : true;
    }
    if (isStop) {
      bodyEndLine = next.line; // stop before this line (1-based)
      break;
    }
  }

  // Compute character offsets for bodyStart.
  // lineOffsets[i] = character offset of line (i+1) in content (1-based).
  const lineOffsets: number[] = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = acc;
    acc += lines[i].length + 1; // +1 for the '\n' separator
  }
  const eofOffset = acc; // byte offset past the last line

  // bodyStart: character offset of first line of body (bodyStartLine is 1-based)
  const bodyStartOffset = bodyStartLine <= lines.length ? lineOffsets[bodyStartLine - 1] : eofOffset;

  // Slice body lines (0-based array: bodyStartLine-1 to bodyEndLine-2 inclusive)
  const bodyRaw = lines.slice(bodyStartLine - 1, bodyEndLine - 1).join('\n').trimEnd();
  const body = stripFences ? stripFencedCode(bodyRaw).text : bodyRaw;

  // INVARIANT: content.slice(bodyStart, bodyEnd) === body
  // bodyEnd is derived from body.length so that replaceSection(content, section, section.body) === content.
  return { heading: target, body, bodyStart: bodyStartOffset, bodyEnd: bodyStartOffset + body.length };
}

// ─── iterateBullets ───────────────────────────────────────────────────────────

/**
 * Extract bullet items from `sectionText`.
 *
 * Recognises three marker families:
 * - **Checkbox**: `- [ ] text` (unchecked) and `- [x] text` / `- [X] text` (checked)
 * - **Dash**: `- text`, `* text`, `+ text` (plain unordered list item)
 * - **Numbered**: `1. text`, `42. text` (ordered list item)
 *
 * Indented continuation lines (lines that are not themselves bullet openers and
 * have at least one leading space or tab) are accumulated into the current
 * bullet's `text`.
 *
 * Blank lines terminate the current bullet (consistent with CommonMark block
 * handling and the repo's existing bullet parsers).
 */
export function iterateBullets(sectionText: string): BulletItem[] {
  if (typeof sectionText !== 'string' || sectionText.length === 0) return [];

  const lines = sectionText.split('\n');
  const items: BulletItem[] = [];

  // Checkbox bullet: `<indent>- [ ] text` or `<indent>- [x] text`
  const checkboxRe = /^(\s*)- \[([xX ])\] (.*)$/;
  // Plain dash/asterisk/plus bullet: `<indent>- text`, `<indent>* text`, `<indent>+ text`
  const dashRe = /^(\s*)[-*+] (.*)$/;
  // Numbered bullet: `<indent>1. text`
  const numberedRe = /^(\s*)\d+\. (.*)$/;
  // Continuation: non-empty, indented, NOT a bullet opener
  const continuationRe = /^[ \t]/;

  let current: BulletItem | null = null;

  const flush = (): void => {
    if (current !== null) {
      current.text = current.text.trim();
      items.push(current);
      current = null;
    }
  };

  for (const rawLine of lines) {
    // Strip trailing \r (CRLF safety)
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    // Blank line terminates current bullet
    if (trimmed === '') {
      flush();
      continue;
    }

    // Checkbox bullet (checked or unchecked) — must test before dashRe
    const cbm = checkboxRe.exec(line);
    if (cbm) {
      flush();
      const stateChar = cbm[2];
      const checked = stateChar === 'x' || stateChar === 'X';
      current = {
        marker: checked ? 'checkbox-checked' : 'checkbox-unchecked',
        text: cbm[3],
        indent: cbm[1],
        checked,
      };
      continue;
    }

    // Numbered bullet
    const nm = numberedRe.exec(line);
    if (nm) {
      flush();
      current = {
        marker: 'numbered',
        text: nm[2],
        indent: nm[1],
        checked: null,
      };
      continue;
    }

    // Plain dash / asterisk / plus bullet
    const dm = dashRe.exec(line);
    if (dm) {
      flush();
      current = {
        marker: 'dash',
        text: dm[2],
        indent: dm[1],
        checked: null,
      };
      continue;
    }

    // Continuation line (indented, non-bullet) — append to current bullet
    if (current !== null && continuationRe.test(line)) {
      current.text += ' ' + trimmed;
      continue;
    }

    // Non-bullet, non-continuation line (e.g. a paragraph, heading) — flush
    flush();
  }
  flush();

  return items;
}

// ─── updateBullet ─────────────────────────────────────────────────────────────

/**
 * Locate the FIRST top-level bullet-opening line — checkbox (`- [ ]`/`- [x]`),
 * dash/asterisk/plus (`- `/`* `/`+ `), or numbered (`1. `) — whose bullet text
 * satisfies `match(bulletText, rawLine)`, replace that ONE physical line with
 * `transform(rawLine)`, and return the resulting full content string. Every
 * other byte in `content` — surrounding bullets, indentation, EOL style — is
 * left untouched: this is a pure single-line splice, not a document-wide
 * regex `.replace()`.
 *
 * Unlike `iterateBullets` (read-only, no offsets, and not itself fence-aware
 * — callers pre-strip fences when that matters), `updateBullet` tracks
 * character offsets itself so it can splice the transformed line back into
 * the ORIGINAL `content`, and is fence-aware on its own: a bullet-shaped line
 * inside a fenced code block (``` / ~~~, same CommonMark delimiter rules as
 * `stripFencedCode`) is never offered to `match`/`transform`. (Tracked
 * duplication of the fence state machine — same status as `tokenizeHeadings`'s
 * copy, see its doc comment — pending a T-tier consolidation.)
 *
 * `rawLine` (second argument to both `match` and `transform`) is the
 * UNMODIFIED physical line exactly as it appears between `\n` separators — so
 * on a CRLF document its trailing `\r` is included, matching what a
 * hand-rolled `^...[^\n]*`-shaped, `m`-flagged regex applied to the whole
 * document would have seen. `bulletText` (first argument to `match`) is the
 * bullet's own text with marker/checkbox stripped and any trailing `\r`
 * removed — the same extraction `iterateBullets` uses for `BulletItem.text`.
 *
 * Only the OPENING line of a (possibly multi-line) bullet is ever matched or
 * replaced — indented continuation lines are never presented to `match` or
 * `transform`.
 *
 * The gap between the marker and its content tolerates 1 or more spaces — not
 * only exactly one — mirroring CommonMark/GFM's 1–4-space allowance for
 * list-marker spacing (`checkboxRe`/`numberedRe`/`dashRe`'s own dedicated
 * quantifier caps at 4 per GFM; a wider run still recognises the line as a
 * bullet opener via the uncapped `dashRe` fallback catching the excess as
 * ordinary bullet text). So `-  [ ] text` (two spaces), `1.   text` (three
 * spaces), and even a pathologically wide run are all recognised bullet
 * openers, just as the canonical single-space `- [ ] text` / `1. text` are.
 *
 * Bounded no-op: if no bullet-opening line satisfies `match`, or `transform`
 * returns a non-string, `content` is returned completely unchanged.
 */
export function updateBullet(
  content: string,
  match: (bulletText: string, rawLine: string) => boolean,
  transform: (rawLine: string) => string,
): string {
  if (typeof content !== 'string' || content.length === 0) return content;

  const lines = content.split('\n');

  // Marker-to-content gap: CommonMark/GFM tolerates 1–4 spaces between a list
  // marker and its content (5+ pushes the content into indented-code-block
  // territory) — so `-  [ ] Phase 1: Foo` (two spaces) is still a valid
  // bullet opener, not just the single-space `- [ ] …` shape. A hand-rolled
  // single-space-only regex (e.g. the OLD `mutateMilestonePhase` checkbox
  // regex before its `updateBullet` migration, which used `-\s*\[` — no cap,
  // but at least 0+) would flip such a line; matching that requires this
  // primitive's own bullet-opening recognition to tolerate the same gap,
  // otherwise a wider-spaced bullet is silently never offered to `match`.
  // F5 (#2245 review, nit): the gap also tolerates a literal TAB (`\t`), not
  // only spaces — the OLD `-\s*\[` regex's `\s` class matched a tab too, so a
  // `-\t[ ] text` bullet (tab-separated marker) must still be recognised here.
  // Checkbox bullet: `<indent>- [ ] text` or `<indent>- [x] text`
  const checkboxRe = /^(\s*)-[ \t]{1,4}\[([xX ])\] (.*)$/;
  // Plain dash/asterisk/plus bullet: `<indent>- text`, `<indent>* text`, `<indent>+ text`
  const dashRe = /^(\s*)[-*+][ \t]{1,4}(.*)$/;
  // Numbered bullet: `<indent>1. text`
  const numberedRe = /^(\s*)\d+\.[ \t]{1,4}(.*)$/;

  // Fence tracking — same CommonMark delimiter rules as stripFencedCode
  // (tracked duplication, see doc comment above).
  const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  let openFence: FenceState | null = null;

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.replace(/\r$/, '');

    const dm = delimRe.exec(line);
    if (dm) {
      const char = dm[2][0] as '`' | '~';
      const len = dm[2].length;
      const trailing = dm[3];
      if (openFence === null) {
        // CommonMark §4.5: backtick fence info string must not contain a backtick.
        if (!(char === '`' && trailing.includes('`'))) {
          // Valid opener — record fence state; this delimiter line is not a bullet.
          openFence = { char, len };
          offset += rawLine.length + 1;
          continue;
        }
        // else: not a valid opener — falls through to the bullet check below.
      } else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
        // Closing delimiter — close the fence; this line is not a bullet.
        openFence = null;
        offset += rawLine.length + 1;
        continue;
      } else {
        // Mismatched/insufficient delimiter while a fence is open — fence content.
        offset += rawLine.length + 1;
        continue;
      }
    }

    if (openFence !== null) {
      // Inside a fence — never a bullet candidate.
      offset += rawLine.length + 1;
      continue;
    }

    let bulletText: string | null = null;
    const cbm = checkboxRe.exec(line);
    if (cbm) {
      bulletText = cbm[3];
    } else {
      const dm2 = dashRe.exec(line);
      if (dm2) {
        bulletText = dm2[2];
      } else {
        const nm = numberedRe.exec(line);
        if (nm) bulletText = nm[2];
      }
    }

    if (bulletText !== null && match(bulletText, rawLine)) {
      const newLine = transform(rawLine);
      if (typeof newLine !== 'string') return content;
      return content.slice(0, offset) + newLine + content.slice(offset + rawLine.length);
    }

    offset += rawLine.length + 1;
  }

  return content;
}

// ─── extractTaggedBlocks ──────────────────────────────────────────────────────

/**
 * Return the inner text of every `<tagName>…</tagName>` block in `content`,
 * in document order.
 *
 * Designed for extracting structured XML-like annotation blocks that live in
 * markdown prose (e.g. `<decisions>…</decisions>`, `<requirements>…</requirements>`).
 * Returns `[]` when no matching blocks are found.
 *
 * The `tagName` argument is regex-escaped, so names that contain regex
 * metacharacters (e.g. `foo.bar`, `my+tag`) are matched literally.
 *
 * **Input contract:** the caller decides whether to pass raw or fence-stripped
 * content. `extractTaggedBlocks` is a pure block extractor — it does NOT strip
 * fenced code blocks itself. If a `<tagName>` block appears inside a fenced code
 * block and should be excluded, the caller should apply `stripFencedCode` first.
 *
 * **Nested tags are NOT supported.** The body scan terminates at the NEXT
 * opening of the same tag (the ReDoS-safe boundary, #2128). Given
 * `<x><x>inner</x></x>`, `extractTaggedBlocks(content, 'x')` returns `['inner']`
 * — the well-formed inner block; the unterminated outer `<x>` is skipped.
 * Callers that need true nesting must use a proper XML/HTML parser.
 *
 * `allowAttributes` (default `false`): when `true`, the opening tag may carry
 * bounded attributes (`<tag foo="x">`) — needed for `<task type="…">` blocks.
 * Leave `false` for tags that must match exactly (e.g. `<decisions>`), and never
 * enable it for a tag where an attributed form is semantically distinct.
 *
 * Generalises `decisions.cts`'s bespoke `matchAll(/<decisions>([\s\S]*?)<\/decisions>/g)`
 * so tier T1 can drop its own copy (tracked duplication until T1 lands).
 */
export function extractTaggedBlocks(content: string, tagName: string, allowAttributes = false): string[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  if (typeof tagName !== 'string' || tagName.length === 0) return [];

  const pattern = taggedBlockPattern(tagName, 'g', allowAttributes);
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/**
 * Build the single, ReDoS-safe `<tag>…</tag>` block regex shared by
 * `extractTaggedBlocks` (extract bodies) and `stripTaggedBlocks` (remove blocks).
 *
 * Safety: the body terminates at the NEXT opening of this tag (stop-at-next-open)
 * instead of lazily rescanning the whole remaining document for a `</tag>` that
 * may never appear — so a document full of unclosed `<tag>` openings scans
 * LINEARLY, not quadratically (#2128). Group 1 is the block body.
 *
 * `allowAttributes`: when `true`, the opener accepts bounded attributes
 * (`<tag foo="x">`) and the body boundary is `<tag` followed by a space or `>`.
 * When `false`, the opener is the EXACT `<tag>` and the boundary is exact `<tag>`,
 * so an attributed `<tag foo>` is neither an opener nor a boundary — it is body
 * content. That exact form is load-bearing for `<details>` stripping: `<details
 * open>` marks the ACTIVE milestone and must be preserved, not stripped (#557).
 */
function taggedBlockPattern(tagName: string, flags: string, allowAttributes: boolean): RegExp {
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = allowAttributes ? `<${esc}(?:\\s[^>]{0,1000})?>` : `<${esc}>`;
  const boundary = allowAttributes ? `<${esc}[\\s>]` : `<${esc}>`;
  return new RegExp(`${open}((?:(?!${boundary})[\\s\\S])*?)</${esc}>`, flags);
}

/**
 * Remove every `<tagName>…</tagName>` block (opening tag, body, and closing tag)
 * from `content`. The ReDoS-safe counterpart to `extractTaggedBlocks` — same
 * hardened pattern, `.replace(…, '')` instead of body extraction. `allowAttributes`
 * defaults to `false` so `<details open>` (active milestone) is preserved (#557);
 * case-insensitive by default (matching the `<details>` strip call sites), pass
 * `caseSensitive` to force exact-case matching.
 */
export function stripTaggedBlocks(content: string, tagName: string, allowAttributes = false, caseSensitive = false): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  if (typeof tagName !== 'string' || tagName.length === 0) return content;
  return content.replace(taggedBlockPattern(tagName, caseSensitive ? 'g' : 'gi', allowAttributes), '');
}

// ─── replaceSection ───────────────────────────────────────────────────────────

/**
 * Splice `newBody` in place of a section's body and return the resulting
 * full content string.
 *
 * Uses the `bodyStart`/`bodyEnd` character offsets carried by the `Section`
 * type to perform a pure string splice — no regex, no line-counting. The
 * heading is preserved verbatim; only the bytes between `bodyStart` and
 * `bodyEnd` are replaced.
 *
 * The `newBody` is inserted as-is between `content.slice(0, bodyStart)` and
 * `content.slice(bodyEnd)`. If `newBody` should end with a trailing newline
 * before the next section's heading, the caller is responsible for including
 * it (consistent with how `trimEnd()` is applied to collected bodies — see
 * `collectSections`/`collectSection`).
 *
 * Typical read-modify-write pattern (T6 state.cts use case):
 * ```
 * const section = collectSection(content, h => h.text === 'Name');
 * if (section) {
 *   content = replaceSection(content, section, newBody);
 * }
 * ```
 *
 * CRLF-safe: the splice is purely character-offset-based, so CRLF sequences
 * are preserved in the surrounding content unchanged.
 */
export function replaceSection(content: string, section: Section, newBody: string): string {
  if (typeof content !== 'string') return content;
  if (typeof newBody !== 'string') return content;
  return content.slice(0, section.bodyStart) + newBody + content.slice(section.bodyEnd);
}

// ─── withSection ──────────────────────────────────────────────────────────────

/**
 * Locate the section whose heading matches `target`, run `edit` against ONLY
 * that section's body, and splice the result back into `content`.
 *
 * `target` is either an exact (trimmed) heading-text match or a predicate
 * function over `HeadingToken`. `edit` receives ONLY the section body — so any
 * regex it runs is physically confined to that section — an edit cannot cross
 * a section boundary (ADR-2143 §4, structurally retires the #2130/#2067/#2080
 * boundary-crossing class, where a hand-rolled regex escaped its intended
 * section and mutated a sibling/shipped/backticked-literal occurrence instead).
 *
 * Bounded no-op behaviour (Phase 3 of ADR-2143 adds fail-loud diagnostics on
 * top of this):
 * - No heading matches `target` → `content` is returned unchanged.
 * - `edit` returns a non-string, or returns the same string it was given →
 *   `content` is returned unchanged (no-op splice avoided).
 *
 * `opts` is forwarded verbatim to `collectSection` (see its doc comment for
 * `levelBounded` / `stopAtLevel` / `stripFences` semantics) — it lets a caller
 * whose heading levels are non-uniform (e.g. a mix of `###`/`####` phase
 * headings) choose the correct section-end rule instead of relying on the
 * `levelBounded: true` default.
 */
export function withSection(
  content: string,
  target: string | ((h: HeadingToken) => boolean),
  edit: (body: string) => string,
  opts: CollectSectionOptions = {},
): string {
  if (typeof content !== 'string') return content;
  const predicate = typeof target === 'function'
    ? target
    : (h: HeadingToken) => h.text.trim() === target.trim();
  const section = collectSection(content, predicate, opts);
  if (!section) return content;              // bounded no-op on miss (Phase 3 adds fail-loud)
  const newBody = edit(section.body);
  if (typeof newBody !== 'string' || newBody === section.body) return content;
  return replaceSection(content, section, newBody);
}

// ─── deleteSection ────────────────────────────────────────────────────────────

/**
 * Delete an entire section — the matching heading line ITSELF plus its body —
 * and return the resulting full content string.
 *
 * Locates the target heading via the SAME machinery `collectSection` uses
 * (`tokenizeHeadings` + `headingPredicate`), then determines the stop boundary
 * with the SAME level-bounding rule (`levelBounded` / `stopAtLevel`, see
 * `CollectSectionOptions`): the deleted range runs from the target heading's
 * OWN start offset up to (but not including) the next heading whose level is
 * the same-or-higher (lower level number) than the target's — so a level-3
 * `### Phase N` section deletes through any nested `####` content but STOPS at
 * the next `##`/`###` sibling, whatever that heading's text is (unlike a
 * hand-rolled regex anchored to a specific heading TEXT pattern, which keeps
 * scanning past an unrelated heading and can run away to EOF when no further
 * heading of that specific text shape follows — the whole-section-deletion
 * data-loss class this primitive retires).
 *
 * Unlike `collectSection`/`withSection` (which operate on a section's BODY
 * only, leaving the heading line untouched), `deleteSection` removes the
 * heading line too — the counterpart for "delete section" call sites that
 * `withSection` structurally cannot serve.
 *
 * Collapses at most one resulting blank-line seam: if removing the section
 * leaves 2+ blank lines immediately at the splice point (e.g. the original
 * document already had a double-blank separator immediately before the
 * deleted heading), the seam is normalized down to a single blank line so no
 * double-blank gap accumulates where the section used to sit. Content
 * elsewhere in the document is never touched.
 *
 * Returns `content` unchanged when no heading matches `headingPredicate`
 * (bounded no-op, mirroring `withSection`'s miss behaviour).
 */
export function deleteSection(
  content: string,
  headingPredicate: (heading: HeadingToken) => boolean,
  opts: CollectSectionOptions = {},
): string {
  if (typeof content !== 'string') return content;

  const { levelBounded = true, stopAtLevel } = opts;

  const headings = tokenizeHeadings(content);
  const targetIdx = headings.findIndex(headingPredicate);
  if (targetIdx === -1) return content;

  const target = headings[targetIdx];
  const lines = content.split('\n');

  // Determine the stop line using the SAME level-bounding rule collectSection uses.
  let stopLine = lines.length + 1; // 1-based, exclusive (default: EOF+1)
  for (let j = targetIdx + 1; j < headings.length; j++) {
    const next = headings[j];
    let isStop: boolean;
    if (stopAtLevel !== undefined) {
      isStop = next.level <= stopAtLevel;
    } else {
      isStop = levelBounded ? next.level <= target.level : true;
    }
    if (isStop) {
      stopLine = next.line;
      break;
    }
  }

  // Character offsets — same line-offset table collectSection builds.
  const lineOffsets: number[] = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = acc;
    acc += lines[i].length + 1; // +1 for the '\n' separator
  }
  const eofOffset = acc;

  const sectionStart = lineOffsets[target.line - 1]; // start of the target heading LINE itself
  const sectionEnd = stopLine <= lines.length ? lineOffsets[stopLine - 1] : eofOffset;

  const before = content.slice(0, sectionStart);
  const after = content.slice(sectionEnd);

  // Collapse a resulting blank-line seam to at most one blank line (2 newlines).
  // Only the tail of `before` (immediately at the splice point) is touched —
  // this never reaches into unrelated content elsewhere in the document.
  const collapsedBefore = before.replace(/(?:\r\n|\n){3,}$/, (m) => (m.includes('\r\n') ? '\r\n\r\n' : '\n\n'));

  return collapsedBefore + after;
}

// Consumers: require('../gsd-core/bin/lib/markdown-sectionizer.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).
