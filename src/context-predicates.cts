/**
 * Context Predicates — CONTEXT.md predicate fact-store parser.
 *
 * Ported from the reference prototype
 * `examples/dynamic-context-management/context-predicates.cjs` (ADR-1671,
 * "Dynamic context management platform", Option-E predicate fact-store).
 * Behavior is preserved BYTE-FOR-BEHAVIOR from the prototype for the parts it
 * shares: `ID_RE`, the first-`=` split, the naive triple-backtick fence
 * toggle, and the `- ` list-item-only form. Known prototype defects are
 * DELIBERATELY carried forward here — a later commit fixes them behind a
 * failing-first test.
 *
 * Two intentional deviations from the prototype (ADR-1671 open question 4):
 *   - `Duplicate` carries `count`, not `lines: number[]`.
 *   - `ContextIndex.predicates` entries carry `{id, klass, value}` with NO
 *     `line` field — a committed artifact with no line numbers cannot drift
 *     on a line shift. The live parse result (`Predicate`) still carries
 *     `line` and `section`.
 *
 * One addition beyond the prototype: `ParseResult.malformed` collects
 * backtick lines that look like a predicate declaration attempt (contains a
 * backtick-wrapped `id=value`-shaped inner with an `=` at index >= 1) but are
 * rejected, with a distinct named `reason` per rejection class: `empty-value`
 * (e.g. `` `ID=` ``), `empty-segment` (a doubled dot in the id, e.g.
 * `` `A..b=1` ``), `invalid-id-chars` (disallowed characters in the id, e.g. a
 * space: `` `FOO BAR=1` ``), `lowercase-leading-class` (id's first segment
 * starts lowercase, e.g. `` `foo.bar=1` ``), and `value-contains-newline` (an
 * embedded CR/LF/U+2028/U+2029 in the value). A line with no `=` at all (e.g.
 * `` `ID` ``, ordinary inline code) is NOT a declaration attempt and never
 * produces a diagnostic. This does not change any accept/reject outcome —
 * only adds diagnostics.
 *
 * Grammar (from discovery facts):
 *   Two line forms, each on exactly one source line:
 *     1. Bare backtick-wrapped, optionally indented: `ID=value`, `  `ID=value``
 *     2. List-item backtick: `-`/`*`/`+`/`N.` marker followed by `ID=value`
 *
 *   ID grammar: CLASS(.subkey)*  where CLASS = first dot-separated segment.
 *   ID chars: [A-Za-z0-9._-]  (CLASS always uppercase; subkeys may be mixed).
 *   Split on FIRST '=' only; everything before is the ID, everything after is
 *   the value (up to the closing backtick).
 *
 *   Skip:
 *     - Fenced code blocks: ``` or ~~~, fence-length- and fence-char-aware
 *       (a longer fence containing a shorter same-char fence line stays a
 *       single skipped region; mismatched-char lines are fence content, not
 *       a toggle)
 *     - HTML comments (`<!-- ... -->`), including multi-line
 *     - Prose lines (headings, blank lines, list items without a predicate)
 *     - Blockquote lines (session-log preamble, etc.)
 *
 * Fence-length-awareness note: `src/markdown-sectionizer.cts`'s
 * `stripFencedCode` is the repo's canonical CommonMark fence-stripper, but its
 * `StripFencedResult.text` DROPS fence delimiter and content lines from the
 * output — it does not preserve original line numbers. This parser reports
 * `Predicate.line`/`Malformed.line` as 1-based SOURCE line numbers, which
 * callers assert on — so line-accurate skip detection is required, and
 * `stripFencedCode` cannot serve it directly.
 *
 * Comment/fence precedence (DEFECT.CONTEXT-PREDICATES-COMMENT-FENCE-BLIND,
 * #2928 review): `computeSkippedLineFlags` previously ran the HTML-comment
 * scan and a delegated call to `markdown-sectionizer.cts`'s exported
 * `scanFencedBlocks` seam as two INDEPENDENT passes over the raw lines. That
 * is unsound: `scanFencedBlocks` is comment-blind, so a fence delimiter
 * appearing INSIDE an HTML comment (with no later matching close in the
 * file) was treated as a real *unterminated* fence — silently skipping every
 * remaining line to EOF and permanently dropping later predicates. The
 * converse is also unsound the other way: a bare two-pass ordering that
 * resolves comments first and only then masks-and-rescans for fences
 * mis-handles a `<!--`/`-->` token that appears *inside a genuine fenced
 * block* (proven while fixing this: guarding the comment pass by a
 * comment-blind fence pass, or vice versa, always breaks one of the two
 * directions — the two constructs must suppress each other's
 * open/close detection while active, which only a single interleaved
 * left-to-right pass can guarantee).
 *
 * Chosen precedence (documented per the review's requirement): the two
 * constructs are scanned in ONE forward pass with two mutually-exclusive
 * states, `fence: {char,len} | null` and `inHtmlComment: boolean`.
 *   - While a fence is open, only a fence-close delimiter (same char, run
 *     length >= the opener's) can close it; any `<!--`/`-->` token on a
 *     fenced-content line is fence content, never a comment boundary.
 *   - While NEITHER is open and an HTML comment opens, only a `-->` token
 *     can close it; any fence delimiter seen while inside a comment is
 *     comment content, never a fence boundary.
 *   - When neither is open, a comment opener (`<!--`) is checked BEFORE a
 *     fence opener on the same line — HTML comments are lexically outermost
 *     in this document's grammar — so a fence-shaped info string that
 *     happens to also look like `<!--...-->` never spuriously opens/closes
 *     anything once the line has already been claimed as a fence opener (the
 *     inverse: a genuine one-line comment `<!-- ``` -->` is masked whole and
 *     never interpreted as a fence delimiter).
 * This single-pass design reuses `markdown-sectionizer.cts`'s exact
 * delimiter-matching rule (same regex, same `len >= open.len` /
 * mismatched-char-is-content / backtick-info-string-cannot-contain-backtick
 * semantics as `scanFencedBlocks`), so non-comment-interacting documents are
 * byte-for-byte identical to delegating to `scanFencedBlocks` (see
 * `tests/context-predicates.test.cjs`'s fence-skip parity suite) — the
 * interleaving is required ONLY to resolve the comment/fence interaction,
 * not to change fence semantics themselves. This is therefore a second,
 * necessarily local copy of the (tiny) delimiter-match condition — the
 * scanFencedBlocks seam cannot serve both scans at once, because the correct
 * boundary decision for either construct depends on the OTHER construct's
 * live state at that exact line, not just on a static, comment-blind
 * pre-scan of the raw lines.
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/context-predicates.cjs (gitignored).
 */

/** A single parsed predicate fact from CONTEXT.md. */
export interface Predicate {
  id: string;
  klass: string;
  value: string;
  line: number;
  section: string;
}

/** A predicate id that occurs more than once. */
export interface Duplicate {
  id: string;
  count: number;
}

/** A backtick-wrapped line that looked like a predicate declaration but was rejected. */
export interface Malformed {
  line: number;
  text: string;
  reason: string;
}

/** Result of parsing a CONTEXT.md markdown string for predicates. */
export interface ParseResult {
  predicates: Predicate[];
  duplicates: Duplicate[];
  malformed: Malformed[];
  skippedSections: string[];
}

/** Criteria for {@link selectPredicates}, ANDed together. */
export interface SelectOptions {
  klass?: string;
  prefix?: string;
  contains?: string;
}

/** A deterministic, committed index entry — no `line` (see module doc). */
export interface ContextIndexPredicate {
  id: string;
  klass: string;
  value: string;
}

/** Deterministic index built from a parsed predicates array. */
export interface ContextIndex {
  schemaVersion: 1;
  count: number;
  classes: Record<string, number>;
  predicates: ContextIndexPredicate[];
  duplicates: Duplicate[];
}

// ID grammar, validated STRUCTURALLY rather than by a single regex
// (DEFECT.CONTEXT-PREDICATES-ID-REDOS, #2928 review). The formerly-used regex
// `^([A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*)=(.+)$` is exponential: the
// group `(?:\.[A-Za-z0-9_.-]+)*` is ambiguous because its own character
// class contains `.`, so N consecutive dots have exponentially many
// backtick-partitionings for the regex engine to try on a failed match
// (measured: ~565ms for 40 consecutive dots, doubling roughly every 5).
// `.github/workflows/test.yml` runs `lint:ci` -> `lint:generated-sync` ->
// `gen-context-index.cjs --check` on `pull_request`, which parses the PR's
// own CONTEXT.md — so any external contributor could hang the shared CI
// runner with one crafted line, no write access required.
//
// Fix: split the candidate id on '.' and validate each segment with a
// simple, non-backtracking, per-segment pattern — linear in id length, no
// ambiguous quantifier. First segment (CLASS) must start with an uppercase
// letter; subsequent segments may start with letter/digit and include
// hyphens/underscores. We intentionally allow lowercase-starting
// sub-segments (e.g. PRED.k320.rule).
//
// Behavior change vs. the old regex: an EMPTY segment (a doubled dot, e.g.
// `A..b`) now REJECTS — the old regex accepted it because `.` was inside the
// subsequent-segment character class, so `.` itself could satisfy
// `[A-Za-z0-9_.-]+` with a single character. The real repo CONTEXT.md was
// checked (`grep -nE '\`[A-Z][A-Za-z0-9_.-]*\.\.[A-Za-z0-9_.-]*='
// CONTEXT.md`) and contains ZERO ids with a doubled dot, so rejecting the
// empty-segment case is the correct, stricter grammar with no behavior loss
// against real data (pinned by a dedicated test below).
const ID_FIRST_SEGMENT_RE = /^[A-Z][A-Z0-9_-]*$/;
const ID_SUBSEQUENT_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** Result of {@link validateIdDetailed}: valid, or invalid with a named reason. */
interface IdValidation {
  valid: boolean;
  reason?: 'empty-segment' | 'invalid-id-chars' | 'lowercase-leading-class';
}

/**
 * Structurally validate a candidate predicate id (linear time — no ambiguous
 * backtracking quantifier; see the ID grammar comment above), returning WHY it
 * is invalid so malformed diagnostics can name the exact rejection class.
 *
 * @param id - candidate id (everything before the first '=')
 */
function validateIdDetailed(id: string): IdValidation {
  const segments = id.split('.');

  // A doubled dot (or leading/trailing dot) produces an empty segment.
  if (segments.some((seg) => seg === '')) return { valid: false, reason: 'empty-segment' };

  const first = segments[0];
  if (!ID_FIRST_SEGMENT_RE.test(first)) {
    // Distinguish "starts lowercase" (a highly plausible typo, e.g.
    // `foo.bar=1`) from any other first-segment character-set violation
    // (e.g. a space, `FOO BAR=1`).
    if (/^[a-z]/.test(first)) return { valid: false, reason: 'lowercase-leading-class' };
    return { valid: false, reason: 'invalid-id-chars' };
  }
  for (let i = 1; i < segments.length; i++) {
    if (!ID_SUBSEQUENT_SEGMENT_RE.test(segments[i])) return { valid: false, reason: 'invalid-id-chars' };
  }
  return { valid: true };
}

/**
 * Structurally validate a candidate predicate id (linear time — no ambiguous
 * backtracking quantifier; see the ID grammar comment above).
 *
 * @param id - candidate id (everything before the first '=')
 */
function isValidId(id: string): boolean {
  return validateIdDetailed(id).valid;
}

// List markers recognized ahead of a backtick-wrapped declaration:
// `-`, `*`, `+`, or a numbered marker (`1.`, `42.`), each followed by
// whitespace. Mirrors the marker family `iterateBullets`/`updateBullet`
// (markdown-sectionizer.cts) recognize, widened here beyond the
// prototype-carried-forward dash-only form (ADR-1671 Phase 1 commit 3).
const LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+/;

/**
 * Strip a source line down to its backtick-wrapped "inner" content, if any.
 * Handles both line forms:
 *   1. Bare backtick line, optionally indented: `ID=value`, `  `ID=value``
 *   2. List-item backtick, any of `-`/`*`/`+`/`N.`, optionally indented:
 *      `- `ID=value``, `* `ID=value``, `+ `ID=value``, `1. `ID=value``
 *
 * @param raw - the original source line (with newline stripped)
 * @returns the inner content between the backticks, or null if the line is
 *   not backtick-wrapped in either recognized form
 */
function extractInner(raw: string): string | null {
  const line = raw.trimEnd();

  // Bare backtick-wrapped, tolerating leading indentation — shape decides
  // the bare form, not column 0 (Postel: CONTEXT.md authors indent freely).
  const bareTrimmed = line.replace(/^[ \t]+/, '');
  if (bareTrimmed.startsWith('`') && bareTrimmed.endsWith('`') && bareTrimmed.length > 2) {
    return bareTrimmed.slice(1, -1);
  }

  // List-item form: strip optional leading whitespace + list marker, then
  // check for backtick wrapping. `stripped !== line` guards against a line
  // with no marker at all (LIST_MARKER_RE.replace would otherwise no-op and
  // re-check the same failed bare-form test).
  const stripped = line.replace(LIST_MARKER_RE, '');
  if (stripped !== line && stripped.startsWith('`') && stripped.endsWith('`') && stripped.length > 2) {
    return stripped.slice(1, -1);
  }

  return null;
}

/**
 * Parse a single source line and return a raw {id, value} if it is a
 * predicate, or null otherwise.
 *
 * @param raw - the original source line (with newline stripped)
 */
function extractPredicate(raw: string): { id: string; value: string } | null {
  const inner = extractInner(raw);
  if (inner === null) return null;

  // Split on FIRST '=' only.
  const eqIdx = inner.indexOf('=');
  if (eqIdx < 1) return null;

  const id = inner.slice(0, eqIdx);
  const value = inner.slice(eqIdx + 1);

  // Value must be non-empty (the old ID_RE's trailing `(.+)$` requirement)
  // and must contain no embedded ECMAScript LineTerminator character (LF,
  // CR, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR) -- the old
  // regex's `.` metachar excludes exactly those four characters and carried
  // no `s`/`m` flag, so a value spanning an embedded \r (possible only via
  // the documented lone-CR limit: a "line" with no real \n at all still
  // carries a mid-string \r joining what the author intended as two
  // separate lines) could never satisfy `(.+)$`. Preserved byte-for-behavior
  // here so `yieldsNoPredicatesForLoneCrDocumentAsDocumentedLimit` stays
  // pinned. And the id must match the structural grammar (no spaces,
  // correct char set, no empty segment -- see isValidId's doc comment).
  if (value === '' || /[\n\r\u2028\u2029]/.test(value) || !isValidId(id)) return null;

  return { id, value };
}

/**
 * Detect the "looks like a predicate declaration attempt but is rejected"
 * malformed case for a line that {@link extractPredicate} already rejected —
 * naming WHY, so a maintainer's typo is diagnosable instead of silently
 * vanishing. Only fires when the line is backtick-wrapped (in either
 * recognized form) AND contains an `=` at index >= 1 — a plain inline-code
 * line with no `=` at all (e.g. `` `ID` ``) is not a declaration attempt and
 * never produces a diagnostic. Does not change any accept/reject decision —
 * diagnostic only.
 *
 * Reason precedence when a line fails more than one check at once: id
 * validity is checked first (an invalid id makes the value irrelevant), then
 * empty-value, then embedded-newline.
 *
 * @param raw - the original source line (with newline stripped)
 */
function detectMalformed(raw: string): { text: string; reason: string } | null {
  const inner = extractInner(raw);
  if (inner === null) return null;

  const eqIdx = inner.indexOf('=');
  if (eqIdx < 1) return null;

  const id = inner.slice(0, eqIdx);
  const value = inner.slice(eqIdx + 1);

  const idCheck = validateIdDetailed(id);
  if (!idCheck.valid) {
    return { text: raw.trimEnd(), reason: idCheck.reason as string };
  }
  if (value === '') {
    return { text: raw.trimEnd(), reason: 'empty-value' };
  }
  if (/[\n\r\u2028\u2029]/.test(value)) {
    return { text: raw.trimEnd(), reason: 'value-contains-newline' };
  }

  return null;
}

// Fence delimiter line matcher — mirrors `markdown-sectionizer.cts`'s
// `scanFencedBlocks` regex exactly (≥3 backticks/tildes, ≤3-space indent
// tolerance). Kept local so the single interleaved pass below can decide,
// line by line, whether a delimiter is a REAL fence boundary given the
// comment state AT THAT LINE — see the module doc comment's "Comment/fence
// precedence" section for why this can't be a call-then-mask over
// `scanFencedBlocks`'s output.
const FENCE_DELIM_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Compute, per source line, whether that line falls inside a fenced code
 * block or an HTML comment (`<!-- ... -->`, single- or multi-line).
 * LINE-PRESERVING: returns one boolean per input line (no lines dropped or
 * collapsed) — see the module doc comment for why that distinction is
 * load-bearing here.
 *
 * Single interleaved forward pass over two mutually-exclusive states —
 * `fence` (open fence delimiter char + run length, or null) and
 * `inHtmlComment` — so each construct suppresses the OTHER's open/close
 * detection while it is active (module doc comment's "Comment/fence
 * precedence"). This is the fix for DEFECT.CONTEXT-PREDICATES-COMMENT-FENCE-
 * BLIND: a fence delimiter inside a real HTML comment is comment content
 * (never opens a fence), and a `<!--`/`-->` token inside a real fenced block
 * is fence content (never opens/closes a comment).
 *
 * @param lines - source lines (as produced by `markdown.split('\n')`)
 */
function computeSkippedLineFlags(lines: string[]): boolean[] {
  const skip = new Array<boolean>(lines.length).fill(false);

  let fence: { char: '`' | '~'; len: number } | null = null;
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    // Strip trailing \r (CRLF safety), mirroring stripFencedCode's/
    // scanFencedBlocks's own `rawLine.replace(/\r$/, '')`.
    const line = lines[i].replace(/\r$/, '');

    if (fence !== null) {
      // Inside a real fence: only a matching closer can end it. Any
      // `<!--`/`-->` on this line is fence content, not a comment boundary
      // (converse precedence).
      skip[i] = true;
      const m = FENCE_DELIM_RE.exec(line);
      if (m) {
        const char = m[2][0] as '`' | '~';
        const len = m[2].length;
        const trailing = m[3];
        if (char === fence.char && len >= fence.len && /^\s*$/.test(trailing)) {
          fence = null;
        }
      }
      continue;
    }

    if (inHtmlComment) {
      // Inside a real comment: only '-->' can end it. Any fence delimiter on
      // this line is comment content, not a fence boundary (primary
      // precedence — the DEFECT.CONTEXT-PREDICATES-COMMENT-FENCE-BLIND
      // repro: a fence delimiter with no later real closer must not skip to
      // EOF just because it happened to appear inside a comment).
      skip[i] = true;
      if (line.includes('-->')) inHtmlComment = false;
      continue;
    }

    // Neither construct open: HTML comments are lexically outermost in this
    // document's grammar, so a comment opener is checked BEFORE a fence
    // opener on the same line.
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) {
      skip[i] = true;
      if (!trimmed.includes('-->')) {
        inHtmlComment = true; // multi-line: stays open until a later '-->'
      }
      continue;
    }

    const m = FENCE_DELIM_RE.exec(line);
    if (m) {
      const char = m[2][0] as '`' | '~';
      const trailing = m[3];
      // CommonMark §4.5: a backtick fence opener's info string must not
      // itself contain a backtick — such a line is ordinary content, not a
      // valid opener (mirrors scanFencedBlocks).
      if (!(char === '`' && trailing.includes('`'))) {
        skip[i] = true;
        fence = { char, len: m[2].length };
        continue;
      }
    }

    skip[i] = false;
  }

  return skip;
}

/**
 * Parse all predicates from a CONTEXT.md markdown string.
 *
 * @param markdown
 */
export function parsePredicates(markdown: string): ParseResult {
  const lines = markdown.split('\n');
  const predicates: Predicate[] = [];
  const malformed: Malformed[] = [];
  // Track id -> occurrence count for duplicate detection
  const idCounts = new Map<string, number>();

  const skippedLines = computeSkippedLineFlags(lines);
  let currentSection = '';
  const allSections: string[] = [];
  const seenSections = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1; // 1-based

    // Fenced code blocks and HTML comments (line-preserving; see
    // computeSkippedLineFlags's doc comment).
    if (skippedLines[i]) continue;

    // Track section headings for the section field.
    if (raw.startsWith('#')) {
      currentSection = raw.replace(/^#+\s*/, '').trim();
      if (currentSection && !seenSections.has(currentSection)) {
        seenSections.add(currentSection);
        allSections.push(currentSection);
      }
      continue;
    }

    // Blockquote lines (start with ">") are prose — skip.
    if (raw.trimStart().startsWith('>')) continue;

    // Attempt extraction.
    const pred = extractPredicate(raw);
    if (!pred) {
      const bad = detectMalformed(raw);
      if (bad) {
        malformed.push({ line: lineNo, text: bad.text, reason: bad.reason });
      }
      continue;
    }

    const klass = pred.id.split('.')[0];
    predicates.push({
      id: pred.id,
      klass,
      value: pred.value,
      line: lineNo,
      section: currentSection,
    });

    idCounts.set(pred.id, (idCounts.get(pred.id) || 0) + 1);
  }

  // Build duplicates list: ids with >1 occurrence.
  const duplicates: Duplicate[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) duplicates.push({ id, count });
  }
  // Sort duplicates by id for determinism.
  duplicates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Skipped sections: headings that yielded zero predicates (pure prose).
  const activeSections = new Set(predicates.map((p) => p.section));
  const skippedSections = allSections.filter((s) => !activeSections.has(s));

  return { predicates, duplicates, malformed, skippedSections };
}

/**
 * Select predicates by one or more optional criteria (ANDed together).
 *
 * @param predicates
 * @param opts
 */
export function selectPredicates(predicates: Predicate[], opts: SelectOptions = {}): Predicate[] {
  const { klass, prefix, contains } = opts;
  const containsLower = contains ? contains.toLowerCase() : null;

  return predicates.filter((p) => {
    if (klass !== undefined && p.klass !== klass) return false;
    if (prefix !== undefined && !p.id.startsWith(prefix)) return false;
    if (containsLower !== null) {
      const haystack = (p.id + ' ' + p.value).toLowerCase();
      if (!haystack.includes(containsLower)) return false;
    }
    return true;
  });
}

/**
 * Build a deterministic index object from a parsed predicates array.
 *
 * @param predicates
 */
export function buildIndex(predicates: Predicate[]): ContextIndex {
  // Count per class.
  const classCounts: Record<string, number> = {};
  for (const p of predicates) {
    classCounts[p.klass] = (classCounts[p.klass] || 0) + 1;
  }

  // Sort classes object by key for determinism.
  const classes: Record<string, number> = {};
  for (const k of Object.keys(classCounts).sort()) {
    classes[k] = classCounts[k];
  }

  // Sort predicates by id then by line number (line used for ordering only —
  // the committed index entry itself omits `line`; see module doc).
  const sortedPredicates = predicates
    .slice()
    .sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return a.line - b.line;
    })
    .map(({ id, klass, value }) => ({ id, klass, value }));

  // Rebuild duplicates from the (sorted-by-id) predicates for determinism.
  const idCounts = new Map<string, number>();
  for (const p of predicates) {
    idCounts.set(p.id, (idCounts.get(p.id) || 0) + 1);
  }
  const duplicates: Duplicate[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) duplicates.push({ id, count });
  }
  duplicates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: 1,
    count: predicates.length,
    classes,
    predicates: sortedPredicates,
    duplicates,
  };
}
