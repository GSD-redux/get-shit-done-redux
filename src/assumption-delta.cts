/**
 * Assumption-Delta detector (#1561).
 *
 * A rarely-firing, advisory architecture checkpoint. When a phase makes
 * something PLURAL / OPTIONAL / CHOSEN that used to be SINGULAR / REQUIRED /
 * DERIVED, the primary key / identity model may silently stop matching the
 * generalized intent. This detector scans phase-scope prose for the linguistic
 * signals of that transition so the plan:pre capability hook (see
 * capabilities/assumption-delta/) can surface ONE identity-model question.
 *
 * Design notes (rubber-duck'd):
 *  - DETERMINISTIC + TYPED IR. The "does it fire?" decision is a pure function
 *    returning { detected, signals, terms }, not an LLM judgment — so the
 *    low-false-positive guarantee (acceptance criterion #2) is testable.
 *  - BARE "or" IS INTENTIONALLY EXCLUDED from the default pluralization cues.
 *    The issue lists "or" as a tell, but bare "or" is extremely common in
 *    English prose and would make the gate fire on nearly every phase
 *    description. Pluralization requires a stronger second-case cue
 *    (second / alternative / fallback / additional / ...). The vocabulary is
 *    tunable (config + the `terms` parameter) so teams can widen it.
 *  - FENCED CODE BLOCKS ARE STRIPPED first (via the markdown-sectionizer seam)
 *    so a trigger term that appears only inside a code snippet does not fire.
 *  - Mirrors ui-safety-gate.cts: a pure function + a STDIN-reading CLI whose
 *    exit codes mirror grep (0 = signal found, 1 = none, 2 = usage error).
 *
 * Public API:
 *   detectAssumptionDelta(text, terms?) -> { detected, signals, terms }
 *   DEFAULT_ASSUMPTION_DELTA_TERMS
 *
 * CLI:
 *   echo "$PHASE_SECTION" | node gsd-core/bin/lib/assumption-delta.cjs [--json]
 *     exit 0 = signal detected, 1 = none, 2 = startup error
 *     --json additionally prints the typed IR on stdout
 */

import { stripFencedCode } from './markdown-sectionizer.cjs';
import { escapeRegex } from './pattern.cjs';

export type AssumptionDeltaKind = 'pluralization' | 'optional' | 'chosen';

export interface AssumptionDeltaSignal {
  kind: AssumptionDeltaKind;
  term: string;
  snippet: string;
}

export interface AssumptionDeltaTermSet {
  pluralization: string[];
  optional: string[];
  chosen: string[];
}

export interface AssumptionDeltaResult {
  detected: boolean;
  signals: AssumptionDeltaSignal[];
  terms: AssumptionDeltaTermSet;
}

/**
 * Curated default trigger vocabulary. Each kind lists cue terms that signal a
 * core-assumption monopoly has been lost. ADDITIVE-ONLY (Hyrum's Law: once
 * shipped, this set is a depended-upon interface). Tunable via the `terms`
 * parameter or the capability's config slice.
 */
export const DEFAULT_ASSUMPTION_DELTA_TERMS: Readonly<AssumptionDeltaTermSet> = {
  // Primary trigger — a second X where there was one.
  // Bare "or" excluded (prose-frequency false positives).
  pluralization: [
    'second',
    'alternative',
    'alternate',
    'fallback',
    'also',
    'additional',
    'another',
    'supplementary',
    'alongside',
    'multiple',
    'plural',
    '2nd',
  ],
  // required / `only` -> optional
  optional: ['optional', 'optionally'],
  // derived -> chosen / constant -> parameter
  chosen: [
    'chosen',
    'choose',
    'selectable',
    'configurable',
    'parameterized',
    'parameterised',
    'parameterize',
    'parameterise',
    'custom',
  ],
};

/** Hardening caps for the tunable term vocabulary (Codex review finding). */
const MAX_TERMS_PER_KIND = 200;
const MAX_TERM_LEN = 32;

/**
 * Normalize a caller-provided term list: trim, lowercase, reject empties and
 * punctuation-only terms (e.g. "-"), dedupe (preserve order), and cap the
 * count/length so a huge or hostile `--terms` value cannot build a giant
 * alternation regex or echo a massive payload. Defaults are already clean, so
 * this is a no-op on them.
 */
function normalizeTerms(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase().slice(0, MAX_TERM_LEN);
    // Require at least one alphanumeric char so punctuation-only terms like
    // "-" cannot match prose punctuation as a "signal".
    if (!t || !/[a-z0-9]/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TERMS_PER_KIND) break;
  }
  return out;
}

/**
 * Resolve the effective term set: per-kind override. An explicitly-provided
 * non-empty array for a kind REPLACES that kind's defaults (then normalized);
 * an absent kind KEEPS its defaults. An explicitly-empty array disables that
 * kind (override present, normalized to []). This lets a caller narrow one axis
 * without re-declaring the others.
 */
function resolveTerms(terms?: Partial<AssumptionDeltaTermSet>): AssumptionDeltaTermSet {
  const merge = (key: AssumptionDeltaKind): string[] => {
    const t = terms && terms[key];
    return Array.isArray(t) ? normalizeTerms(t) : [...DEFAULT_ASSUMPTION_DELTA_TERMS[key]];
  };
  return {
    pluralization: merge('pluralization'),
    optional: merge('optional'),
    chosen: merge('chosen'),
  };
}

/** Trim + collapse + truncate a context window around a match for the snippet. */
function makeSnippet(line: string, term: string): string {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 120) return cleaned;
  // Centre the window on the matched term when the line is long.
  const idx = cleaned.toLowerCase().indexOf(term);
  if (idx < 0) return cleaned.slice(0, 120);
  const start = Math.max(0, idx - 50);
  const end = Math.min(cleaned.length, idx + term.length + 50);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < cleaned.length ? '…' : '';
  return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}

/**
 * Detect assumption-delta signals in phase-scope prose.
 *
 * @param text - Roadmap phase section / scope prose. Non-string inputs degrade
 *   to `{ detected: false }` without throwing.
 * @param terms - Optional per-kind override (see resolveTerms).
 * @returns typed IR: { detected, signals[], terms }. `terms` is the effective
 *   (merged) set actually used, so callers/tests can audit what fired.
 */
export function detectAssumptionDelta(
  text: unknown,
  terms?: Partial<AssumptionDeltaTermSet>,
): AssumptionDeltaResult {
  if (typeof text !== 'string') {
    return { detected: false, signals: [], terms: resolveTerms(terms) };
  }

  const effective = resolveTerms(terms);

  // Strip fenced code blocks so trigger terms inside code snippets do not fire.
  // stripFencedCode is CommonMark-correct and CRLF-safe.
  const stripped = stripFencedCode(text.replace(/\r\n/g, '\n')).text;
  if (stripped.trim().length === 0) {
    return { detected: false, signals: [], terms: effective };
  }

  const signals: AssumptionDeltaSignal[] = [];
  const kinds: AssumptionDeltaKind[] = ['pluralization', 'optional', 'chosen'];

  for (const kind of kinds) {
    const cueTerms = effective[kind];
    if (cueTerms.length === 0) continue;
    // Word-boundary anchored, case-insensitive — same shape as ui-safety-gate.
    // (^|[^a-zA-Z0-9])(TERM)([^a-zA-Z0-9]|$) prevents interior-substring matches.
    const escaped = cueTerms.map(escapeRegex).join('|');
    const pattern = new RegExp('(^|[^a-zA-Z0-9])(' + escaped + ')([^a-zA-Z0-9]|$)', 'gi');
    const seen = new Set<string>();
    for (const line of stripped.split('\n')) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        const raw = m[2];
        if (!raw) continue;
        const matched = raw.toLowerCase();
        const key = `${kind}:${matched}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({ kind, term: matched, snippet: makeSnippet(line, matched) });
      }
    }
  }

  return { detected: signals.length > 0, signals, terms: effective };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
// Reads phase-section text from STDIN (not argv) to avoid OS ARG_MAX limits.
// Invoked by workflow bash as: echo "$PHASE_SECTION" | node .../assumption-delta.cjs [--json]
// Exit 0 = signal detected, 1 = none, 2 = startup error. Mirrors ui-safety-gate.

if (require.main === module) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  // --terms <csv>: config-tunable vocabulary override. Replaces the
  // pluralization cues (the primary trigger); optional/chosen keep defaults.
  // An EMPTY value ("") or a flag-shaped value restores the curated defaults
  // (does NOT disable pluralization). Terms are normalized (deduped, etc.) by
  // detectAssumptionDelta's resolveTerms.
  let termsOverride: Partial<AssumptionDeltaTermSet> | undefined;
  const termsIdx = argv.indexOf('--terms');
  const termsVal = termsIdx !== -1 ? argv[termsIdx + 1] : undefined;
  if (typeof termsVal === 'string' && !termsVal.startsWith('-')) {
    const list = termsVal
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    termsOverride = list.length > 0 ? { pluralization: list } : undefined;
  }
  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (chunk: string) => chunks.push(chunk));

  process.stdin.on('end', () => {
    const input = chunks.join('');
    const result = detectAssumptionDelta(input, termsOverride);
    if (wantJson) {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    process.exit(result.detected ? 0 : 1);
  });

  process.stdin.on('error', (err: Error) => {
    process.stderr.write(`ERROR: assumption-delta.cjs stdin read failed: ${err.message}\n`);
    process.exit(2);
  });
}
