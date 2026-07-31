/**
 * STATE.md Document Module — pure transforms for STATE.md text.
 * This module does not read the filesystem and does not own persistence or locking.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state-document.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { splitTableRow } from './markdown-table.cjs';

// Internal helpers
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

interface ProgressRecord {
  total_phases?: unknown;
  completed_phases?: unknown;
  total_plans?: unknown;
  completed_plans?: unknown;
  percent?: unknown;
  [key: string]: unknown;
}

function existingProgressExceedsDerived(existingProgress: ProgressRecord, derivedProgress: ProgressRecord, key: string): boolean {
  const existing = toFiniteNumber(existingProgress[key]);
  const derived = toFiniteNumber(derivedProgress[key]);
  return existing !== null && derived !== null && existing > derived;
}

/**
 * Return true if a pipe-table row's first cell is a separator cell (`---`
 * variants) rather than a field name.  Prevents the separator row
 * `| --- | --- |` from being treated as a field named "---".
 */
function isTableSeparatorRow(firstCell: string): boolean {
  // A separator cell contains only dashes, colons (alignment hints), and whitespace.
  return /^[\s\-:]+$/.test(firstCell.trim());
}

function countLeading(str: string): number {
  const match = /^[ \t]*/.exec(str);
  return match ? match[0].length : 0;
}

/**
 * Canonicalize one UTF-16 code unit per the ECMAScript non-unicode
 * `Canonicalize` abstract operation, which governs how a case-insensitive
 * (`/i`, no `u` flag) RegExp compares characters: take `ch.toUpperCase()`.
 * The uppercasing is REJECTED (the original character is kept as-is) in
 * either of two cases: (1) `ch.toUpperCase()` does not produce exactly one
 * character (e.g. "ß" -> "SS" — a multi-character case-fold can never be a
 * per-character regex match, so Canonicalize leaves it alone), or (2) it
 * produces exactly one character but the original character's code point is
 * >= 128 while the uppercased character's code point is < 128 (this is what
 * stops a non-ASCII character from folding onto an ASCII one under `/i` —
 * e.g. KELVIN SIGN U+212A uppercases to ASCII "K" (U+004B), so this rule
 * rejects the fold and keeps U+212A, meaning `/k/i`/`/K/i` do NOT match
 * U+212A). Otherwise, the uppercased character is used. Plain
 * `.toLowerCase()`/`.toUpperCase()` folds both of these cases, which is
 * exactly why they diverge from real regex `/i` semantics.
 */
function canonicalizeCharForCaselessCompare(ch: string): string {
  const upper = ch.toUpperCase();
  if (upper.length !== 1) {
    return ch;
  }
  if (ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) {
    return ch;
  }
  return upper;
}

/**
 * Canonicalize a whole string, one UTF-16 code unit at a time, per the
 * ECMAScript non-unicode `Canonicalize` rule (see
 * canonicalizeCharForCaselessCompare) so that two strings compare equal
 * under this function iff a non-`u`-flag `/i` RegExp would treat them as
 * the same literal text. This is the correct replacement for
 * `.toLowerCase()` when replicating a non-`u` `/i` regex: `.toLowerCase()`
 * folds some non-ASCII characters (e.g. KELVIN SIGN U+212A) onto their
 * ASCII counterparts, which real `/i` regex semantics do not. Iteration is
 * by UTF-16 code unit (not code point) to match how a non-`u` regex engine
 * itself operates on surrogate halves individually.
 */
function canonicalizeForCaselessCompare(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += canonicalizeCharForCaselessCompare(str[i]);
  }
  return result;
}

/**
 * Return true when the caller's raw (untrimmed) `fieldName` may be considered
 * to match a row's raw (untrimmed) field cell text. Faithfully replicates the
 * backtracking of the regex this function replaced: `^(\|[ \t]*)(FieldName)
 * ([ \t]*\|...)`. Group 1 (`\|[ \t]*`, greedy but backtrackable) can hand any
 * PREFIX of the cell's leading `[ \t]` run over to group 2 (the literal,
 * case-insensitive `fieldName` text) — so `fieldName` is tried at every offset
 * `j` from 0 up to the length of that leading run. For a given `j` to be a
 * genuine match, two things must hold: `rawCell.slice(j, j + fieldName.length)`
 * must equal `fieldName` case-insensitively (group 2), AND everything left
 * over after it — `rawCell.slice(j + fieldName.length)` — must be entirely
 * `[ \t]` characters, because group 3 (`[ \t]*\|`) must consume that leftover
 * as whitespace before it can reach the delimiter pipe.
 *
 * A simple count-of-leading/trailing-whitespace comparison is NOT equivalent:
 * it ignores that group 2 is a literal-character match, not a whitespace-
 * class match, so it can produce false positives whenever `fieldName`'s own
 * padding is a different run of `[ \t]` characters than the cell's (e.g.
 * `fieldName` padded with spaces against a cell padded with tabs) — caught by
 * differential fuzzing against the regex this replaces.
 *
 * The case-insensitive comparison itself is done via
 * canonicalizeForCaselessCompare, NOT `.toLowerCase()`: the replaced regex
 * used `/i` WITHOUT the `u` flag, whose case-folding is the ECMAScript
 * non-unicode `Canonicalize` operation. `.toLowerCase()` folds some non-ASCII
 * characters onto ASCII ones (e.g. KELVIN SIGN U+212A -> "k") that `/i`
 * (no `u`) does NOT fold, so `.toLowerCase()` alone would NOT faithfully
 * replicate the old regex's semantics; canonicalizeForCaselessCompare does.
 */
function fieldNameMatchesRawCell(fieldName: string, rawCell: string): boolean {
  const n = fieldName.length;
  const cellLength = rawCell.length;
  if (n > cellLength)
    return false;
  const leadingRun = countLeading(rawCell);
  const maxOffset = Math.min(leadingRun, cellLength - n);
  const canonicalFieldName = canonicalizeForCaselessCompare(fieldName);
  for (let j = 0; j <= maxOffset; j++) {
    if (canonicalizeForCaselessCompare(rawCell.slice(j, j + n)) !== canonicalFieldName)
      continue;
    if (/^[ \t]*$/.test(rawCell.slice(j + n)))
      return true;
  }
  return false;
}

/**
 * Locate the value cell of a pipe-table row `| FieldName | value |` for the
 * given field name, by scanning `content` line by line (no whole-document
 * regex). Only a strict two-column row (exactly 3 `|` chars, starting the
 * line, ending the line after trailing space/tab is stripped) is considered;
 * this is what makes a 3-column row or an unescaped-pipe-bearing value cell
 * fail to match, mirroring the previous regex's behaviour. Separator rows
 * (`| --- | --- |`) are skipped, not matched. The match is case-insensitive.
 * A line terminator is `\r\n`, a lone `\r`, or a lone `\n` — matching the `m`
 * flag semantics of the regex this function replaced. Returns the byte range
 * of the value cell (after trimming surrounding space/tab) so the caller can
 * splice it directly.
 */
function locateFieldRow(content: string, fieldName: string): { valueStart: number; valueEnd: number; rawValue: string } | null {
  let lineStart = 0;
  while (lineStart <= content.length) {
    // A line terminator is `\r\n`, a lone `\r`, or a lone `\n` (JS treats a
    // bare `\r` as a line terminator too — the regex this replaced used the
    // `m` flag, which honors all three). Scan for whichever of `\r`/`\n`
    // occurs first; if it's `\r` immediately followed by `\n`, the terminator
    // is 2 chars wide, otherwise 1.
    let terminatorIndex = -1;
    let terminatorLength = 0;
    for (let i = lineStart; i < content.length; i++) {
      const ch = content[i];
      if (ch === '\n') {
        terminatorIndex = i;
        terminatorLength = 1;
        break;
      }
      if (ch === '\r') {
        terminatorIndex = i;
        terminatorLength = content[i + 1] === '\n' ? 2 : 1;
        break;
      }
    }
    const lineEnd = terminatorIndex === -1 ? content.length : terminatorIndex;
    const line = content.slice(lineStart, lineEnd);
    if (line.startsWith('|')) {
      const pipeCount = (line.match(/\|/g) || []).length;
      const trimmedEnd = line.replace(/[ \t]+$/, '');
      if (pipeCount === 3 && trimmedEnd.endsWith('|')) {
        const cells = splitTableRow(line);
        if (cells.length === 2 && !isTableSeparatorRow(cells[0])) {
          // Line has exactly 3 pipes (enforced above): opening pipe, the
          // field/value separator pipe, and the row-closing pipe.
          const fieldValueSeparatorPipe = line.indexOf('|', line.indexOf('|') + 1);
          const rawCell = line.slice(1, fieldValueSeparatorPipe);
          if (fieldNameMatchesRawCell(fieldName, rawCell)) {
            const rowClosingPipe = line.indexOf('|', fieldValueSeparatorPipe + 1);
            let valueStart = lineStart + fieldValueSeparatorPipe + 1;
            while (content[valueStart] === ' ' || content[valueStart] === '\t')
              valueStart++;
            let valueEnd = lineStart + rowClosingPipe;
            while (valueEnd - 1 >= valueStart && (content[valueEnd - 1] === ' ' || content[valueEnd - 1] === '\t'))
              valueEnd--;
            return { valueStart, valueEnd, rawValue: content.slice(valueStart, valueEnd) };
          }
        }
      }
    }
    if (terminatorIndex === -1)
      break;
    lineStart = terminatorIndex + terminatorLength;
  }
  return null;
}

export function stateExtractField(content: string, fieldName: string): string | null {
  const escaped = escapeRegex(fieldName);
  // Bold inline format: **FieldName:** value
  const boldPattern = new RegExp(`\\*\\*${escaped}:\\*\\*[ \\t]*(.+)`, 'i');
  const boldMatch = content.match(boldPattern);
  if (boldMatch)
    return boldMatch[1].trim();
  // Plain line-start format: FieldName: value
  const plainPattern = new RegExp(`^${escaped}:[ \\t]*(.+)`, 'im');
  const plainMatch = content.match(plainPattern);
  if (plainMatch)
    return plainMatch[1].trim();
  // Pipe-table format: | FieldName | value |
  // (Separator rows such as `| --- | --- |` are excluded.)
  const hit = locateFieldRow(content, fieldName);
  if (hit)
    return hit.rawValue.trim();
  return null;
}

export function stateReplaceField(content: string, fieldName: string, newValue: string): string | null {
  const escaped = escapeRegex(fieldName);
  // Bold inline format: **FieldName:** value
  const boldPattern = new RegExp(`(\\*\\*${escaped}:\\*\\*\\s*)(.*)`, 'i');
  if (boldPattern.test(content)) {
    return content.replace(boldPattern, (_match, prefix: string) => `${prefix}${newValue}`);
  }
  // Plain line-start format: FieldName: value
  const plainPattern = new RegExp(`(^${escaped}:\\s*)(.*)`, 'im');
  if (plainPattern.test(content)) {
    return content.replace(plainPattern, (_match, prefix: string) => `${prefix}${newValue}`);
  }
  // Pipe-table format: | FieldName | value |
  // Preserve the surrounding pipe/whitespace structure; only swap the value cell.
  const hit = locateFieldRow(content, fieldName);
  if (hit) {
    return content.slice(0, hit.valueStart) + newValue + content.slice(hit.valueEnd);
  }
  return null;
}

export function stateReplaceFieldWithFallback(content: string, primary: string, fallback: string | null | undefined, value: string): string {
  let result = stateReplaceField(content, primary, value);
  if (result)
    return result;
  if (fallback) {
    result = stateReplaceField(content, fallback, value);
    if (result)
      return result;
  }
  return content;
}

export function normalizeStateStatus(status: string | null | undefined, pausedAt: unknown): string {
  let normalizedStatus = status || 'unknown';
  const statusLower = (status || '').toLowerCase();
  if (statusLower.includes('paused') || statusLower.includes('stopped') || pausedAt) {
    normalizedStatus = 'paused';
  }
  else if (statusLower.includes('executing') || statusLower.includes('in progress')) {
    normalizedStatus = 'executing';
  }
  else if (statusLower.includes('planning') || statusLower.includes('ready to plan')) {
    normalizedStatus = 'planning';
  }
  else if (statusLower.includes('discussing')) {
    normalizedStatus = 'discussing';
  }
  else if (statusLower.includes('verif')) {
    normalizedStatus = 'verifying';
  }
  else if (statusLower.includes('complete') || statusLower.includes('done')) {
    normalizedStatus = 'completed';
  }
  else if (statusLower.includes('ready to execute')) {
    normalizedStatus = 'executing';
  }
  return normalizedStatus;
}

export function computeProgressPercent(
  completedPlans: number | null,
  totalPlans: number | null,
  completedPhases: number | null,
  totalPhases: number | null
): number | null {
  const hasPlanData = totalPlans !== null && totalPlans > 0 && completedPlans !== null;
  const hasPhaseData = totalPhases !== null && totalPhases > 0 && completedPhases !== null;
  if (!hasPlanData && !hasPhaseData)
    return null;
  // Use nullish coalescing to avoid non-null assertion operators (flow narrowing
  // cannot track through intermediate boolean variables).
  const planFraction = hasPlanData ? (completedPlans ?? 0) / (totalPlans ?? 1) : 1;
  const phaseFraction = hasPhaseData ? (completedPhases ?? 0) / (totalPhases ?? 1) : 1;
  return Math.min(100, Math.round(Math.min(planFraction, phaseFraction) * 100));
}

export function shouldPreserveExistingProgress(existingProgress: unknown, derivedProgress: unknown): boolean {
  if (!existingProgress || typeof existingProgress !== 'object')
    return false;
  if (!derivedProgress || typeof derivedProgress !== 'object')
    return false;
  const existing = existingProgress as ProgressRecord;
  const derived = derivedProgress as ProgressRecord;
  // total_phases (#1446) and total_plans (#2440) are intentionally excluded
  // from the ratchet: both must always take the freshly derived value so they
  // can correct in BOTH directions. total_plans legitimately moves up (a new
  // phase adds plans) and down (milestone reorganization removes phases).
  // Ratcheting it freezes stale values. Only completed_phases and
  // completed_plans keep ratchet behaviour — they are monotonic (once a
  // phase/plan is complete, it stays complete).
  return (
    existingProgressExceedsDerived(existing, derived, 'completed_phases') ||
    existingProgressExceedsDerived(existing, derived, 'completed_plans')
  );
}

export function normalizeProgressNumbers(progress: unknown): unknown {
  if (!progress || typeof progress !== 'object')
    return progress;
  const normalized: ProgressRecord = { ...(progress as ProgressRecord) };
  for (const key of ['total_phases', 'completed_phases', 'total_plans', 'completed_plans', 'percent']) {
    const number = toFiniteNumber(normalized[key]);
    if (number !== null)
      normalized[key] = number;
  }
  return normalized;
}

/**
 * KNOWN_TEMPLATE_DEFAULTS — per-field table of string values that were written
 * by a GSD handler (not by an executor / human).  A value that appears in this
 * list is safe to overwrite on the next handler call.  Any other value was
 * authored by the executor and must be preserved (Knuth invariant:
 * handler-owns-transition-between-known-template-defaults).
 *
 * Keys must match the canonical field name as it appears in STATE.md.
 * Comparison is case-insensitive so "None" and "none" both match.
 *
 * For Status, exact strings are supplemented by a pattern list
 * (KNOWN_STATUS_PATTERNS) that matches handler-generated values whose exact
 * text is variable (e.g. "Executing Phase 5").
 */
export const KNOWN_TEMPLATE_DEFAULTS: Record<string, string[]> = {
  'Resume File': ['None'],
  'Status': [
    'Ready to execute',
    'Phase complete — ready for verification',
    'Ready to plan',
    'Defining requirements',
    'Planning complete',
    // Legacy / abbreviated handler values present in older STATE.md files
    'Executing',
    'In progress',
    'Planning',
    'Verifying',
    'Completed',
    'Done',
    'Active',
    'Paused',
    'unknown',
  ],
  // Last Activity is a date field; ISO date-only strings (YYYY-MM-DD) are the
  // handler-generated form.  We detect them by shape rather than an exhaustive
  // list because the date changes every day.
  // NOTE: entries here are matched by isStateTemplateDefault using the date regex
  // in addition to exact string equality.
  'Last Activity': [],
  'Last activity': [],
};

/**
 * Regex patterns that match handler-generated Status values whose text includes
 * a variable component (e.g. phase number).  Checked after the KNOWN_TEMPLATE_DEFAULTS
 * exact-match list in isStateTemplateDefault.
 */
export const KNOWN_STATUS_PATTERNS: RegExp[] = [
  /^Executing Phase\s+\d+/i,
  /^Planning Phase\s+\d+/i,
  /^Phase\s+\d+\s+complete/i,
  /^Verifying Phase\s+\d+/i,
  /^Phase complete/i,
  // #1070: LLM executors (e.g. OpenCode) may write "Complete ✓" or bare "Complete"
  // when finishing a phase.  Only bare terminal markers yield to the next phase's
  // "Ready to execute" during planned-phase.  The pattern is anchored at both ends
  // so that statuses with trailing prose (e.g. "Complete but needs manual QA",
  // "Complete — ready for verification") are NOT matched and are preserved as
  // executor-authored values.  Only exact forms like "Complete", "Complete ✓",
  // "Complete✓", or "Complete ☑ " (trailing whitespace) match.
  /^Complete\s*[✓✔✅☑]?\s*$/i,
];

/**
 * Returns true when the given value is a known template default for the field,
 * meaning a GSD handler wrote it and a subsequent handler may replace it.
 *
 * A value is considered a template default when:
 *   (a) it appears in KNOWN_TEMPLATE_DEFAULTS[field] (exact, case-insensitive), OR
 *   (b) it matches the ISO date-only shape (YYYY-MM-DD) for Last Activity fields
 *       (handlers always write bare dates; executors write narrative prose).
 *
 * @param field  - Canonical field name (case-sensitive key lookup attempted
 *                  first, then case-insensitive fallback).
 * @param value  - The current value extracted from STATE.md.
 * @returns boolean
 */
export function isStateTemplateDefault(field: string, value: unknown): boolean {
  if (value === null || value === undefined) return true; // absent → initial write
  // Narrow to string: callers pass string values extracted from STATE.md.
  const v = (typeof value === 'string' ? value : `${value as boolean | number}`).trim();
  if (v === '') return true; // blank → treat as absent

  // Look up the defaults list, trying exact key first then case-insensitive.
  let defaults: string[] | null | undefined = KNOWN_TEMPLATE_DEFAULTS[field];
  if (!defaults) {
    const fieldLower = field.toLowerCase();
    const matchKey = Object.keys(KNOWN_TEMPLATE_DEFAULTS).find(k => k.toLowerCase() === fieldLower);
    defaults = matchKey ? KNOWN_TEMPLATE_DEFAULTS[matchKey] : null;
  }

  if (defaults && defaults.some(d => d.toLowerCase() === v.toLowerCase())) {
    return true;
  }

  const fieldLower = field.toLowerCase();

  // Status: also check pattern list for variable handler-generated values
  // (e.g. "Executing Phase 5", "Planning Phase 3").
  if (fieldLower === 'status') {
    if (KNOWN_STATUS_PATTERNS.some(p => p.test(v))) return true;
  }

  // Last Activity / Last activity: bare ISO date (YYYY-MM-DD) is handler-generated.
  if (fieldLower === 'last activity') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
  }

  return false;
}

/**
 * Replaces a field in STATE.md content only when the existing value is a known
 * template default (or the field is absent).  If the existing value is
 * executor-authored, the content is returned unchanged.
 *
 * When `newValue` is null or undefined the function is a no-op (returns content).
 *
 * @param content       - Full STATE.md text.
 * @param field         - Field name as it appears in STATE.md.
 * @param knownDefaults - The defaults list to check against (typically
 *                         KNOWN_TEMPLATE_DEFAULTS[field]).
 * @param newValue      - Value to write when replacement is permitted.
 * @returns Updated content (or original if skipped).
 */
export function stateReplaceFieldIfTemplate(content: string, field: string, knownDefaults: string[] | null | undefined, newValue: string | null | undefined): string {
  if (newValue === null || newValue === undefined) return content;
  const existing = stateExtractField(content, field);
  // Inline check: absent/blank → always write; in list → write; else → skip.
  if (existing === null || existing === undefined || existing.trim() === '') {
    return stateReplaceField(content, field, newValue) || content;
  }
  const v = existing.trim();
  const inList = (knownDefaults || []).some(d => d.toLowerCase() === v.toLowerCase());
  const fieldLower = field.toLowerCase();
  // Special-case: Status pattern list for variable handler-generated values.
  const matchesStatusPattern = (fieldLower === 'status') && KNOWN_STATUS_PATTERNS.some(p => p.test(v));
  // Special-case: Last Activity bare ISO date (YYYY-MM-DD) is handler-generated.
  const isDateShape = (fieldLower === 'last activity') && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (inList || matchesStatusPattern || isDateShape) {
    return stateReplaceField(content, field, newValue) || content;
  }
  // Executor-authored — preserve.
  return content;
}
