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
 * backtick lines that look like a predicate declaration but are rejected for
 * having an empty value (e.g. `` `ID=` ``), so the empty-value case is
 * surfaced as a diagnostic instead of being silently dropped. This does not
 * change any accept/reject outcome — only adds a diagnostic.
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
 * `stripFencedCode` cannot serve it directly. Instead, `computeSkippedLineFlags`
 * below consumes `markdown-sectionizer.cts`'s exported `scanFencedBlocks` seam
 * — which IS line-index based (`openLineIdx`/`closeLineIdx` into the same
 * `lines` array this module already splits on) — and derives a per-line
 * skipped-boolean array from its `FencedBlockRecord[]` output. This avoids a
 * third independent copy of the CommonMark fence state machine (ADR-1671
 * Prototype scope: production consumes the compiled seam); only the
 * HTML-comment scan below remains genuinely local, since
 * `markdown-sectionizer.cts` has no comment scanner.
 *
 * Depends on `markdown-sectionizer.cjs`'s `scanFencedBlocks` seam for fence
 * detection (otherwise pure string parsing; no other dependency). ADR-457
 * build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/context-predicates.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- markdown-sectionizer.cjs is an export= CommonJS module
import markdownSectionizer = require('./markdown-sectionizer.cjs');

const { scanFencedBlocks } = markdownSectionizer;

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

// Regex matching the predicate ID grammar: one or more dot-separated segments.
// First segment must start with an uppercase letter (CLASS).
// Subsequent segments may start with letter/digit and include hyphens/underscores.
// We intentionally allow lowercase-starting sub-segments (e.g. PRED.k320.rule).
const ID_RE = /^([A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*)=(.+)$/;

// ID-only grammar (no trailing "=value" requirement) — used to detect the
// malformed empty-value case (`ID=` with nothing after the '=').
const ID_ONLY_RE = /^[A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*$/;

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

  // Validate ID — must match the grammar (no spaces, correct char set).
  if (!ID_RE.test(inner)) return null;

  return { id, value };
}

/**
 * Detect the "looks like a declaration but has an empty value" malformed
 * case for a line that {@link extractPredicate} already rejected. Only
 * fires when the ID portion is grammatically valid on its own and the value
 * after the first '=' is empty (e.g. `` `ID=` ``). Does not change any
 * accept/reject decision — diagnostic only.
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

  if (value === '' && ID_ONLY_RE.test(id)) {
    return { text: raw.trimEnd(), reason: 'empty-value' };
  }

  return null;
}

/**
 * Compute, per source line, whether that line falls inside a fenced code
 * block or an HTML comment (`<!-- ... -->`, single- or multi-line).
 * LINE-PRESERVING: returns one boolean per input line (no lines dropped or
 * collapsed) — see the module doc comment for why that distinction is
 * load-bearing here.
 *
 * Fence detection is delegated entirely to `markdown-sectionizer.cts`'s
 * `scanFencedBlocks` seam — this module carries NO local copy of the fence
 * state machine. `scanFencedBlocks` is line-index based
 * (`openLineIdx`/`closeLineIdx`), so its output maps 1:1 onto this function's
 * `lines` array; an unterminated fence (`closeLineIdx === -1`) skips every
 * remaining line to end of file, matching `stripFencedCode`'s
 * `unterminatedFence` semantics.
 *
 * HTML-comment detection remains local — `markdown-sectionizer.cts` has no
 * comment scanner. A line already marked fenced by `scanFencedBlocks` is
 * never treated as an HTML-comment opener/closer, preserving the
 * mutual-exclusion priority the previous single-pass implementation
 * enforced (a `<!--` inside fence content is fence content, not a comment
 * boundary).
 *
 * @param lines - source lines (as produced by `markdown.split('\n')`)
 */
function computeSkippedLineFlags(lines: string[]): boolean[] {
  const skip = new Array<boolean>(lines.length).fill(false);

  for (const block of scanFencedBlocks(lines)) {
    const end = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
    for (let i = block.openLineIdx; i <= end; i++) skip[i] = true;
  }

  let inHtmlComment = false;
  for (let i = 0; i < lines.length; i++) {
    // Strip trailing \r for comment matching (CRLF safety), mirroring
    // stripFencedCode's own `rawLine.replace(/\r$/, '')`.
    const line = lines[i].replace(/\r$/, '');

    if (inHtmlComment) {
      skip[i] = true;
      if (line.includes('-->')) inHtmlComment = false;
      continue;
    }

    if (skip[i]) continue; // already inside a fenced block — cannot also open a comment here

    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) {
      skip[i] = true;
      if (!trimmed.includes('-->')) {
        inHtmlComment = true; // multi-line: stays open until a later '-->'
      }
    }
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
