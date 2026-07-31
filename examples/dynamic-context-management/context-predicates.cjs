'use strict';

/**
 * context-predicates.cjs — CONTEXT.md predicate fact-store parser.
 *
 * Self-contained CommonJS module (no dependency on build:lib output).
 *
 * Exports:
 *   parsePredicates(markdown) -> { predicates, duplicates, skippedSections }
 *   selectPredicates(predicates, { klass, prefix, contains }) -> filtered array
 *   buildIndex(predicates) -> deterministic plain object
 *
 * Grammar (from discovery facts):
 *   Two line forms, each on exactly one source line:
 *     1. Bare backtick-wrapped:  `ID=value`
 *     2. List-item backtick:    - `ID=value`
 *
 *   ID grammar: CLASS(.subkey)*  where CLASS = first dot-separated segment.
 *   ID chars: [A-Za-z0-9._-]  (CLASS always uppercase; subkeys may be mixed).
 *   A doubled dot (empty segment, e.g. `A..b`) is REJECTED — see the
 *   ID-validation comment below for why.
 *   Split on FIRST '=' only; everything before is the ID, everything after is
 *   the value (up to the closing backtick).
 *
 *   Skip:
 *     - Fenced code blocks (toggle on triple-backtick lines)
 *     - Prose lines (headings, blank lines, list items without a predicate)
 *     - The "PR fix discipline" section (pure prose, no predicates)
 *     - Session-log blockquote preamble
 *
 * `ParseResult.malformed` collects backtick lines that look like a predicate
 * declaration attempt (contains a backtick-wrapped `id=value`-shaped inner
 * with an `=` at index >= 1) but are rejected, with a distinct named `reason`
 * per rejection class: `empty-value`, `empty-segment` (doubled dot),
 * `invalid-id-chars` (disallowed characters, e.g. a space),
 * `lowercase-leading-class` (id's first segment starts lowercase), and
 * `value-contains-newline` (embedded CR/LF/U+2028/U+2029 in the value). A
 * line with no `=` at all (ordinary inline code, e.g. `` `ID` ``) never
 * produces a diagnostic. Mirrors production's src/context-predicates.cts.
 */

// ID grammar, validated STRUCTURALLY rather than by a single regex
// (DEFECT.CONTEXT-PREDICATES-ID-REDOS, #2928 review). The formerly-used regex
// `^([A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*)=(.+)$` is exponential: the group
// `(?:\.[A-Za-z0-9_.-]+)*` is ambiguous because its own character class
// contains `.`, so N consecutive dots have exponentially many
// backtick-partitionings for the regex engine to try on a failed match
// (measured: ~565ms for 40 consecutive dots, doubling roughly every 5).
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
// `[A-Za-z0-9_.-]+` with a single character.
const ID_FIRST_SEGMENT_RE = /^[A-Z][A-Z0-9_-]*$/;
const ID_SUBSEQUENT_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Structurally validate a candidate predicate id (linear time — no ambiguous
 * backtracking quantifier; see the ID grammar comment above), returning WHY it
 * is invalid so malformed diagnostics can name the exact rejection class.
 *
 * @param {string} id - candidate id (everything before the first '=')
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateIdDetailed(id) {
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
 * @param {string} id - candidate id (everything before the first '=')
 * @returns {boolean}
 */
function isValidId(id) {
  return validateIdDetailed(id).valid;
}

/**
 * Strip a source line down to its backtick-wrapped "inner" content, if any.
 * Handles both line forms:
 *   1. Bare backtick line: `ID=value`  (starts with backtick at column 0)
 *   2. List-item backtick: - `ID=value`  (list-item with leading "- ")
 * Also tolerates "  - `ID=value`" (indented list item — observed in CONTEXT.md).
 *
 * @param {string} raw - the original source line (with newline stripped)
 * @returns {string | null}
 */
function extractInner(raw) {
  const line = raw.trimEnd();

  if (line.startsWith('`') && line.endsWith('`') && line.length > 2) {
    // bare backtick line
    return line.slice(1, -1);
  }

  // strip optional leading whitespace + "- " then check for backtick wrapping
  const stripped = line.replace(/^\s*-\s+/, '');
  if (stripped.startsWith('`') && stripped.endsWith('`') && stripped.length > 2) {
    return stripped.slice(1, -1);
  }

  return null;
}

/**
 * Parse a single source line and return a raw {id, value} if it is a predicate,
 * or null otherwise. Handles both line forms after stripping list markers.
 *
 * @param {string} raw  - the original source line (with newline stripped)
 * @returns {{ id: string, value: string } | null}
 */
function extractPredicate(raw) {
  const inner = extractInner(raw);
  if (inner === null) return null;

  // Now match the ID grammar. Split on FIRST '=' only.
  const eqIdx = inner.indexOf('=');
  if (eqIdx < 1) return null;

  const id = inner.slice(0, eqIdx);
  const value = inner.slice(eqIdx + 1);

  // Value must be non-empty and must contain no embedded ECMAScript
  // LineTerminator character (LF, CR, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
  // SEPARATOR) — mirrors production's src/context-predicates.cts. And the id
  // must match the structural grammar (no spaces, correct char set, no empty
  // segment — see isValidId's doc comment).
  if (value === '' || /[\n\r\u2028\u2029]/.test(value) || !isValidId(id)) return null;

  return { id, value };
}

/**
 * Detect the "looks like a predicate declaration attempt but is rejected"
 * malformed case for a line that {@link extractPredicate} already rejected —
 * naming WHY. Only fires when the line is backtick-wrapped AND contains an
 * `=` at index >= 1 — a plain inline-code line with no `=` at all (e.g.
 * `` `ID` ``) is not a declaration attempt and never produces a diagnostic.
 * Does not change any accept/reject decision — diagnostic only. Mirrors
 * production's src/context-predicates.cts detectMalformed.
 *
 * @param {string} raw - the original source line (with newline stripped)
 * @returns {{ text: string, reason: string } | null}
 */
function detectMalformed(raw) {
  const inner = extractInner(raw);
  if (inner === null) return null;

  const eqIdx = inner.indexOf('=');
  if (eqIdx < 1) return null;

  const id = inner.slice(0, eqIdx);
  const value = inner.slice(eqIdx + 1);

  const idCheck = validateIdDetailed(id);
  if (!idCheck.valid) {
    return { text: raw.trimEnd(), reason: idCheck.reason };
  }
  if (value === '') {
    return { text: raw.trimEnd(), reason: 'empty-value' };
  }
  if (/[\n\r\u2028\u2029]/.test(value)) {
    return { text: raw.trimEnd(), reason: 'value-contains-newline' };
  }

  return null;
}

/**
 * Parse all predicates from a CONTEXT.md markdown string.
 *
 * @param {string} markdown
 * @returns {{
 *   predicates: Array<{ id: string, klass: string, value: string, line: number, section: string }>,
 *   duplicates: Array<{ id: string, lines: number[] }>,
 *   malformed: Array<{ line: number, text: string, reason: string }>,
 *   skippedSections: string[]
 * }}
 */
function parsePredicates(markdown) {
  const lines = markdown.split('\n');
  const predicates = [];
  const malformed = [];
  // Track id -> list of line numbers for duplicate detection
  const idLines = new Map(); // id -> number[]

  let inFencedCode = false;
  let currentSection = '';
  const allSections = [];
  const seenSections = new Set();

  // Section names that are known pure-prose (0 predicates) — we still scan them
  // but track them as skipped if nothing is found. The parser is tolerant; it
  // simply won't find predicates in prose sections.
  // We do NOT hard-skip any section except fenced code — the grammar says "scan
  // for backtick predicates everywhere but skip fenced code".

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1; // 1-based

    // Track fenced code blocks (triple-backtick toggle).
    // A fenced-code fence starts with ``` possibly followed by a language token.
    // We use a simple heuristic: a line trimmed to /^```/ triggers the toggle.
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('```')) {
      inFencedCode = !inFencedCode;
      continue;
    }

    if (inFencedCode) continue;

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
    if (trimmed.startsWith('>')) continue;

    // Attempt extraction.
    const pred = extractPredicate(raw);
    if (!pred) {
      const bad = detectMalformed(raw);
      if (bad) malformed.push({ line: lineNo, text: bad.text, reason: bad.reason });
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

    const existing = idLines.get(pred.id);
    if (existing) {
      existing.push(lineNo);
    } else {
      idLines.set(pred.id, [lineNo]);
    }
  }

  // Build duplicates list: ids with >1 occurrence.
  const duplicates = [];
  for (const [id, lns] of idLines) {
    if (lns.length > 1) {
      duplicates.push({ id, lines: lns });
    }
  }
  // Sort duplicates by id for determinism.
  duplicates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Skipped sections: headings that yielded zero predicates (pure prose).
  const activeSections = new Set(predicates.map((p) => p.section));
  const skippedSections = allSections.filter((s) => !activeSections.has(s));

  return { predicates, duplicates, malformed, skippedSections };
}

/**
 * Select predicates by one or more optional criteria (ANDed together).
 *
 * @param {Array<{ id: string, klass: string, value: string, line: number, section: string }>} predicates
 * @param {{ klass?: string, prefix?: string, contains?: string }} opts
 * @returns {Array<{ id: string, klass: string, value: string, line: number, section: string }>}
 */
function selectPredicates(predicates, opts = {}) {
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
 * @param {Array<{ id: string, klass: string, value: string, line: number }>} predicates
 * @returns {{
 *   schemaVersion: 1,
 *   count: number,
 *   classes: Record<string, number>,
 *   predicates: Array<{ id: string, klass: string, value: string, line: number }>,
 *   duplicates: Array<{ id: string, lines: number[] }>
 * }}
 */
function buildIndex(predicates) {
  // Count per class.
  const classCounts = {};
  for (const p of predicates) {
    classCounts[p.klass] = (classCounts[p.klass] || 0) + 1;
  }

  // Sort classes object by key for determinism.
  const classes = {};
  for (const k of Object.keys(classCounts).sort()) {
    classes[k] = classCounts[k];
  }

  // Sort predicates by id then by line number.
  const sortedPredicates = predicates
    .map(({ id, klass, value, line }) => ({ id, klass, value, line }))
    .sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return a.line - b.line;
    });

  // Rebuild duplicates from sorted predicates for determinism.
  const idToLines = new Map();
  for (const p of sortedPredicates) {
    const arr = idToLines.get(p.id);
    if (arr) arr.push(p.line);
    else idToLines.set(p.id, [p.line]);
  }
  const duplicates = [];
  for (const [id, lines] of idToLines) {
    if (lines.length > 1) duplicates.push({ id, lines });
  }
  duplicates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    schemaVersion: 1,
    count: predicates.length,
    classes,
    predicates: sortedPredicates,
    duplicates,
  };
}

module.exports = { parsePredicates, selectPredicates, buildIndex };
