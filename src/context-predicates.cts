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
 *     1. Bare backtick-wrapped:  `ID=value`
 *     2. List-item backtick:    - `ID=value`
 *
 *   ID grammar: CLASS(.subkey)*  where CLASS = first dot-separated segment.
 *   ID chars: [A-Za-z0-9._-]  (CLASS always uppercase; subkeys may be mixed).
 *   Split on FIRST '=' only; everything before is the ID, everything after is
 *   the value (up to the closing backtick).
 *
 *   Skip:
 *     - Fenced code blocks (toggle on triple-backtick lines)
 *     - Prose lines (headings, blank lines, list items without a predicate)
 *     - Blockquote lines (session-log preamble, etc.)
 *
 * Dependency-free: Node built-ins only (none needed at all — pure string
 * parsing). ADR-457 build-at-publish: compiled by tsc to
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

// Regex matching the predicate ID grammar: one or more dot-separated segments.
// First segment must start with an uppercase letter (CLASS).
// Subsequent segments may start with letter/digit and include hyphens/underscores.
// We intentionally allow lowercase-starting sub-segments (e.g. PRED.k320.rule).
const ID_RE = /^([A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*)=(.+)$/;

// ID-only grammar (no trailing "=value" requirement) — used to detect the
// malformed empty-value case (`ID=` with nothing after the '=').
const ID_ONLY_RE = /^[A-Z][A-Z0-9_-]*(?:\.[A-Za-z0-9_.-]+)*$/;

/**
 * Strip a source line down to its backtick-wrapped "inner" content, if any.
 * Handles both line forms:
 *   1. Bare backtick line at column 0:  `ID=value`
 *   2. List-item backtick (optionally indented): - `ID=value`
 *
 * @param raw - the original source line (with newline stripped)
 * @returns the inner content between the backticks, or null if the line is
 *   not backtick-wrapped in either recognized form
 */
function extractInner(raw: string): string | null {
  const line = raw.trimEnd();

  if (line.startsWith('`') && line.endsWith('`') && line.length > 2) {
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

  let inFencedCode = false;
  let currentSection = '';
  const allSections: string[] = [];
  const seenSections = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1; // 1-based

    // Track fenced code blocks (triple-backtick toggle).
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
