/**
 * Broken-windows ledger — enforced cross-phase defect register (issue #1950).
 *
 * Manages `.planning/WINDOWS.md`: a cross-phase ledger of small defects (stubs,
 * TODOs, skipped tests, lint warnings, unrun verifies, unmet truths, deviations).
 * `/gsd-ship` blocks while any entry is `open`; an entry can be `waived` only
 * with a recorded reason or `fixed`.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path. No other src/ imports.
 *
 * Storage format (`.planning/WINDOWS.md`):
 *   ---
 *   schema_version: 1
 *   open_count: N
 *   waived_count: N
 *   fixed_count: N
 *   total_count: N
 *   last_updated: <ISO-8601>
 *   ---
 *   # Broken Windows Ledger
 *   <human-readable prose>
 *   ```json
 *   [ <entries array, canonical JSON> ]
 *   ```
 *
 * Frontmatter holds scalar counts (the FAST path the ship gate reads via jq
 * without parsing JSON). The JSON code block is the AUTHORITATIVE entries
 * source. The two must agree; read paths cross-check and fail closed on drift.
 *
 * Exports:
 *   Constants: REASON, LEDGER_FILE_NAME, SCHEMA_VERSION, KINDS
 *   Pure:      emptyLedger, parseLedger, renderLedger, appendWindow,
 *              markWaived, markFixed, openCount, findByStatus
 *   I/O:       cmdWindowsStatus, cmdWindowsAppend, cmdWindowsWaive,
 *              cmdWindowsMarkFixed
 *
 * Reasoning shape — every cmd* function returns JSON suitable for `--raw`:
 *   success: { ok: true,  ledger: <Ledger>, ... }
 *   failure: { ok: false, reason: <REASON.*>, message: <string> }
 * Failure throws an ExitError-shaped error carrying REASON so the gsd-tools
 * dispatcher's `--json-errors` mode emits it as a structured code (CONTRIBUTING.md
 * "Prohibited: Raw Text Matching"). The frozen REASON enum is the typed surface
 * tests assert against.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Constants ─────────────────────────────────────────────────────────────

export const LEDGER_FILE_NAME = 'WINDOWS.md';
export const SCHEMA_VERSION = 1;

/**
 * Frozen reason enum. Tests assert against these — they are the typed surface
 * per CONTRIBUTING.md. Adding a new code requires updating this enum, the I/O
 * entry point that emits it, AND the test that locks Object.keys(REASON).sort()
 * — three coordinated changes that keep code and tests from drifting.
 */
export const REASON = Object.freeze({
  WINDOWS_OK: 'windows_ok',
  WINDOWS_LEDGER_MISSING: 'windows_ledger_missing',
  WINDOWS_LEDGER_MALFORMED: 'windows_ledger_malformed',
  WINDOWS_ID_NOT_FOUND: 'windows_id_not_found',
  WINDOWS_ALREADY_RESOLVED: 'windows_already_resolved',
  WINDOWS_WAIVE_REASON_EMPTY: 'windows_waive_reason_empty',
  WINDOWS_INVALID_KIND: 'windows_invalid_kind',
  WINDOWS_INVALID_FILE: 'windows_invalid_file',
  WINDOWS_INVALID_TEXT: 'windows_invalid_text',
  WINDOWS_INVALID_ID: 'windows_invalid_id',
  WINDOWS_APPEND_MISSING_FIELD: 'windows_append_missing_field',
  WINDOWS_USAGE: 'windows_usage',
});

/** Allowed window kinds. Aligned with the issue's enumerated sources. */
export const KINDS = Object.freeze([
  'stub',
  'todo',
  'fixme',
  'skipped-test',
  'lint-warning',
  'unmet-truth',
  'unrun-verify',
  'deviation',
]);

const KIND_SET = new Set(KINDS);

// ─── Types ─────────────────────────────────────────────────────────────────

export type WindowKind =
  | 'stub'
  | 'todo'
  | 'fixme'
  | 'skipped-test'
  | 'lint-warning'
  | 'unmet-truth'
  | 'unrun-verify'
  | 'deviation';

export type WindowStatus = 'open' | 'waived' | 'fixed';

export interface WindowEntry {
  id: number;
  kind: WindowKind;
  phase: string;
  file: string;        // '' when not applicable
  line: number | null; // null when not applicable
  description: string;
  status: WindowStatus;
  reason: string;      // '' unless status === 'waived'
  recorded_at: string; // ISO-8601
  resolved_at: string | null;
}

/** Input shape for appendWindow — id/status/timestamps are assigned by the fn. */
export type WindowInput = Pick<WindowEntry, 'kind' | 'phase' | 'description'> &
  Partial<Pick<WindowEntry, 'file' | 'line'>>;

export interface Ledger {
  schema_version: number;
  open_count: number;
  waived_count: number;
  fixed_count: number;
  total_count: number;
  last_updated: string;
  entries: WindowEntry[];
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Error carrying a REASON code. gsd-tools.cjs's `--json-errors` mode catches
 * this and emits `{ ok: false, reason: err.reason, message: err.message }` to
 * stderr; otherwise the message goes to stderr as plain text and the exit
 * code is non-zero.
 */
export class WindowsError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'WindowsError';
    this.reason = reason;
  }
}

// ─── Pure: constructors + counts ───────────────────────────────────────────

export function emptyLedger(now: string): Ledger {
  return {
    schema_version: SCHEMA_VERSION,
    open_count: 0,
    waived_count: 0,
    fixed_count: 0,
    total_count: 0,
    last_updated: now,
    entries: [],
  };
}

export function openCount(ledger: Ledger): number {
  return ledger.open_count;
}

export function findByStatus(ledger: Ledger, status: WindowStatus): WindowEntry[] {
  return ledger.entries.filter((e) => e.status === status);
}

function recomputeCounts(ledger: Ledger): Ledger {
  let open = 0, waived = 0, fixed = 0;
  for (const e of ledger.entries) {
    if (e.status === 'open') open++;
    else if (e.status === 'waived') waived++;
    else if (e.status === 'fixed') fixed++;
  }
  return {
    ...ledger,
    open_count: open,
    waived_count: waived,
    fixed_count: fixed,
    total_count: ledger.entries.length,
  };
}

function validateKind(kind: unknown): asserts kind is WindowKind {
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_KIND,
      `Invalid window kind: ${JSON.stringify(kind)}. Allowed: ${KINDS.join(', ')}.`,
    );
  }
}

function validateDescription(description: unknown): string {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new WindowsError(
      REASON.WINDOWS_APPEND_MISSING_FIELD,
      'Window description must be a non-empty string.',
    );
  }
  rejectBacktickRun(description, 'description');
  return description;
}

/**
 * Reject any string field that contains a 4-backtick run. The ledger's JSON
 * code block uses a 4-backtick fence; a 4-backtick run inside stringified
 * entry text would terminate the fence early and brick the next parse
 * (issue #1950 review H1). JSON.stringify does not escape backticks, so we
 * must catch them at validate time.
 */
function rejectBacktickRun(value: string, field: string): void {
  if (value.includes(FORBIDDEN_BACKTICK_RUN)) {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_TEXT,
      `Window ${field} contains a 4-backtick run, which would corrupt the ledger's JSON code fence.`,
    );
  }
}

function validateFile(file: unknown): string {
  if (file == null || file === '') return '';
  if (typeof file !== 'string') {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_FILE,
      'Window file must be a string when provided.',
    );
  }
  // Reject path traversal — the ledger is a project-local artifact; absolute or
  // parent-escaping paths serve no legitimate purpose and could mislead a human
  // reviewer into investigating the wrong location. Reject NUL bytes too.
  if (file.includes('\0')) {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_FILE,
      'Window file contains a NUL byte.',
    );
  }
  if (path.isAbsolute(file) || /(^|[/\\])\.\.([/\\]|$)/.test(file)) {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_FILE,
      `Window file rejects path traversal/absolute paths: ${file}`,
    );
  }
  return file;
}

function validateLine(line: unknown): number | null {
  if (line == null || line === '') return null;
  // Strict: number or numeric string only; reject garbage like "abc" (which
  // Number() would silently coerce to NaN → null, hiding type drift). Issue
  // #1950 review M2.
  const n = typeof line === 'number' ? line : Number(line);
  if (!Number.isInteger(n) || n < 1) {
    throw new WindowsError(
      REASON.WINDOWS_APPEND_MISSING_FIELD,
      `Window line must be a positive integer when provided (got: ${JSON.stringify(line)}).`,
    );
  }
  return n;
}

function nextId(entries: WindowEntry[]): number {
  let max = 0;
  for (const e of entries) if (e.id > max) max = e.id;
  return max + 1;
}

/**
 * Append a window to the ledger. Assigns the next dense id (max+1), sets
 * status=open, timestamps via opts.now.
 *
 * Concurrency (issue #1950 review L2): NOT safe for concurrent writers. Two
 * parallel `gsd_run windows append` invocations both read the same snapshot,
 * both compute the same nextId, both write — the second atomic rename wins
 * and the first append (and the entry it added) is silently lost. This is
 * acceptable in the current single-executor-per-phase model; document if the
 * executor ever gains parallel wave-level append.
 */
export function appendWindow(
  ledger: Ledger,
  input: WindowInput,
  opts: { now: string } = { now: new Date().toISOString() },
): { ledger: Ledger; entry: WindowEntry } {
  validateKind(input.kind);
  const description = validateDescription(input.description);
  const file = validateFile(input.file);
  const line = validateLine(input.line);

  const id = nextId(ledger.entries);
  const entry: WindowEntry = {
    id,
    kind: input.kind,
    phase: String(input.phase ?? ''),
    file,
    line,
    description,
    status: 'open',
    reason: '',
    recorded_at: opts.now,
    resolved_at: null,
  };

  const entries = [...ledger.entries, entry];
  const result = recomputeCounts({ ...ledger, entries, last_updated: opts.now });
  return { ledger: result, entry };
}

function findEntryOrFail(ledger: Ledger, id: number): WindowEntry {
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) {
    throw new WindowsError(
      REASON.WINDOWS_ID_NOT_FOUND,
      `No window with id ${id}.`,
    );
  }
  return entry;
}

function assertOpen(entry: WindowEntry): void {
  if (entry.status !== 'open') {
    throw new WindowsError(
      REASON.WINDOWS_ALREADY_RESOLVED,
      `Window ${entry.id} is already ${entry.status} (resolved_at=${entry.resolved_at}).`,
    );
  }
}

export function markWaived(
  ledger: Ledger,
  id: number,
  reason: string,
  opts: { now: string } = { now: new Date().toISOString() },
): Ledger {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new WindowsError(
      REASON.WINDOWS_WAIVE_REASON_EMPTY,
      'Waive requires a non-empty recorded reason.',
    );
  }
  const entry = findEntryOrFail(ledger, id);
  assertOpen(entry);

  const newStatus: WindowStatus = 'waived';
  const entries = ledger.entries.map((e) =>
    e.id === id
      ? { ...e, status: newStatus, reason, resolved_at: opts.now }
      : e,
  );
  return recomputeCounts({ ...ledger, entries, last_updated: opts.now });
}

export function markFixed(
  ledger: Ledger,
  id: number,
  opts: { now: string } = { now: new Date().toISOString() },
): Ledger {
  const entry = findEntryOrFail(ledger, id);
  assertOpen(entry);

  const newStatus: WindowStatus = 'fixed';
  const entries = ledger.entries.map((e) =>
    e.id === id
      ? { ...e, status: newStatus, resolved_at: opts.now }
      : e,
  );
  return recomputeCounts({ ...ledger, entries, last_updated: opts.now });
}

// ─── Pure: parse / render ──────────────────────────────────────────────────

// JSON-FENCE strategy (issue #1950 review H1): a description containing the
// 3-backtick markdown fence sequence would terminate the code block early
// inside JSON.stringify output (which does not escape backticks), corrupting
// the file and bricking the next parse. We use a 4-backtick fence which
// cannot collide with anything JSON.stringify can emit on its own (JSON has
// no 4-backtick operator), AND validate that no entry's text fields contain
// a 4-backtick run, so the rendered file is provably reparseable.
const JSON_FENCE_OPEN = '````json';
const JSON_FENCE_CLOSE = '````';
const FORBIDDEN_BACKTICK_RUN = '````';

/**
 * Minimal strict frontmatter parser for flat scalar keys. Only supports the
 * shape this module emits: `key: <number|string>` per line. Throws on any
 * structural deviation — fail-closed on drift.
 */
function parseFrontmatterStrict(raw: string): Record<string, number | string> {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      'Ledger missing frontmatter opening ---',
    );
  }
  const headerEnd = raw.startsWith('---\r\n') ? 5 : 4;
  const closeIdx = raw.indexOf('\n---', headerEnd);
  if (closeIdx === -1) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      'Ledger missing frontmatter closing ---',
    );
  }
  const yamlBody = raw.slice(headerEnd, closeIdx);
  const out: Record<string, number | string> = {};
  for (const line of yamlBody.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) {
      throw new WindowsError(
        REASON.WINDOWS_LEDGER_MALFORMED,
        `Ledger frontmatter line is not key: value: ${JSON.stringify(line)}`,
      );
    }
    const [, key, valueStr] = m;
    const trimmed = valueStr.trim();
    if (/^-?\d+$/.test(trimmed)) {
      out[key] = Number(trimmed);
    } else if (/^-?\d+\.\d+$/.test(trimmed)) {
      out[key] = Number(trimmed);
    } else {
      // String — strip surrounding quotes if present.
      out[key] =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
          ? trimmed.slice(1, -1)
          : trimmed;
    }
  }
  return out;
}

function parseJsonBlock(raw: string): WindowEntry[] {
  const start = raw.indexOf(JSON_FENCE_OPEN);
  if (start === -1) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      'Ledger missing JSON code block for entries.',
    );
  }
  const end = raw.indexOf(JSON_FENCE_CLOSE, start + JSON_FENCE_OPEN.length);
  if (end === -1) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      'Ledger JSON code block not terminated.',
    );
  }
  const jsonText = raw.slice(start + JSON_FENCE_OPEN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger JSON block failed to parse: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      'Ledger JSON block must be an array.',
    );
  }
  return parsed.map(validateEntryShape);
}

function validateEntryShape(e: unknown, i: number): WindowEntry {
  if (typeof e !== 'object' || e === null) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger entry ${i} is not an object.`,
    );
  }
  const o = e as Record<string, unknown>;
  const required = ['id', 'kind', 'phase', 'file', 'description', 'status', 'reason', 'recorded_at'];
  for (const k of required) {
    if (!(k in o)) {
      throw new WindowsError(
        REASON.WINDOWS_LEDGER_MALFORMED,
        `Ledger entry ${i} missing required field: ${k}`,
      );
    }
  }
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 1) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger entry ${i} has invalid id.`,
    );
  }
  if (typeof o.kind !== 'string' || !KIND_SET.has(o.kind)) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger entry ${i} has invalid kind: ${JSON.stringify(o.kind)}`,
    );
  }
  if (typeof o.status !== 'string' || !['open', 'waived', 'fixed'].includes(o.status)) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger entry ${i} has invalid status: ${JSON.stringify(o.status)}`,
    );
  }
  if (typeof o.description !== 'string' || typeof o.reason !== 'string') {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger entry ${i} has non-string description/reason.`,
    );
  }
  const phaseStr = typeof o.phase === 'string'
    ? o.phase
    : (o.phase == null ? '' : typeof o.phase === 'number' || typeof o.phase === 'boolean' ? String(o.phase) : '');
  const recordedStr = typeof o.recorded_at === 'string'
    ? o.recorded_at
    : (o.recorded_at == null ? '' : typeof o.recorded_at === 'number' || typeof o.recorded_at === 'boolean' ? String(o.recorded_at) : '');
  const resolvedStr = typeof o.resolved_at === 'string'
    ? o.resolved_at
    : (o.resolved_at == null ? null : typeof o.resolved_at === 'number' || typeof o.resolved_at === 'boolean' ? String(o.resolved_at) : null);
  return {
    id: o.id,
    kind: o.kind as WindowKind,
    phase: phaseStr,
    file: typeof o.file === 'string' ? o.file : '',
    line: o.line == null ? null : (Number(o.line) || null),
    description: o.description,
    status: o.status as WindowStatus,
    reason: o.reason,
    recorded_at: recordedStr,
    resolved_at: resolvedStr,
  };
}

export function parseLedger(raw: string): Ledger {
  const fm = parseFrontmatterStrict(raw);
  if (fm.schema_version !== SCHEMA_VERSION) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger schema_version must be ${SCHEMA_VERSION}; got ${JSON.stringify(fm.schema_version)}.`,
    );
  }
  const requiredCounts = ['open_count', 'waived_count', 'fixed_count', 'total_count'];
  for (const k of requiredCounts) {
    const v = fm[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new WindowsError(
        REASON.WINDOWS_LEDGER_MALFORMED,
        `Ledger ${k} must be an integer; got ${JSON.stringify(v)}.`,
      );
    }
  }
  if (typeof fm.last_updated !== 'string') {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger last_updated must be a string; got ${JSON.stringify(fm.last_updated)}.`,
    );
  }

  const entries = parseJsonBlock(raw);
  const ledger: Ledger = {
    schema_version: SCHEMA_VERSION,
    open_count: typeof fm.open_count === 'number' ? fm.open_count : 0,
    waived_count: typeof fm.waived_count === 'number' ? fm.waived_count : 0,
    fixed_count: typeof fm.fixed_count === 'number' ? fm.fixed_count : 0,
    total_count: typeof fm.total_count === 'number' ? fm.total_count : 0,
    last_updated: typeof fm.last_updated === 'string' ? fm.last_updated : '',
    entries,
  };

  // Cross-check: frontmatter counts must agree with entries-derived counts.
  const recomputed = recomputeCounts(ledger);
  if (
    recomputed.open_count !== ledger.open_count ||
    recomputed.waived_count !== ledger.waived_count ||
    recomputed.fixed_count !== ledger.fixed_count ||
    recomputed.total_count !== ledger.total_count
  ) {
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Ledger counts disagree with entries: frontmatter open/waived/fixed/total=` +
        `${ledger.open_count}/${ledger.waived_count}/${ledger.fixed_count}/${ledger.total_count}` +
        ` but entries yield ${recomputed.open_count}/${recomputed.waived_count}/${recomputed.fixed_count}/${recomputed.total_count}.`,
    );
  }
  return ledger;
}

export function renderLedger(ledger: Ledger): string {
  const fm = [
    '---',
    `schema_version: ${ledger.schema_version}`,
    `open_count: ${ledger.open_count}`,
    `waived_count: ${ledger.waived_count}`,
    `fixed_count: ${ledger.fixed_count}`,
    `total_count: ${ledger.total_count}`,
    `last_updated: ${ledger.last_updated}`,
    '---',
    '',
  ].join('\n');

  const header = [
    '# Broken Windows Ledger',
    '',
    '> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.',
    '> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).',
    '> Mark fixed with `gsd-tools windows fixed <id>`.',
    '',
  ].join('\n');

  const table = renderTable(ledger.entries);
  const jsonBlock = [JSON_FENCE_OPEN, JSON.stringify(ledger.entries, null, 2), JSON_FENCE_CLOSE, ''].join('\n');

  return [fm, header, table, '', jsonBlock].join('\n');
}

function renderTable(entries: WindowEntry[]): string {
  if (entries.length === 0) {
    return [
      '| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |',
      '|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|',
      '| _(none)_ |  |  |  |  | _No windows recorded._ |  |  |  |  |',
    ].join('\n');
  }
  const rows = [
    '| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |',
    '|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|',
  ];
  for (const e of entries) {
    // Escape backslash FIRST, then pipe — markdown table cells treat `\` as
    // the escape introducer, so a description containing `\|` would render
    // as an escaped pipe (i.e. a literal `|` inside the cell) and split the
    // column. Escaping `\` → `\\` first makes the subsequent `\|` replacement
    // unambiguous. (CodeQL: js/incomplete-sanitization — issue #1950 PR #2441.)
    const cell = (s: string | number | null) =>
      String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|');
    rows.push(
      [
        '|', cell(e.id), '|', cell(e.phase), '|', cell(e.kind), '|',
        cell(e.file), '|', cell(e.line ?? ''), '|',
        cell(e.description), '|', cell(e.status), '|',
        cell(e.reason), '|', cell(e.recorded_at), '|', cell(e.resolved_at), '|',
      ].join(' '),
    );
  }
  return rows.join('\n');
}

// ─── I/O entry points ──────────────────────────────────────────────────────

function ledgerPath(cwd: string): string {
  return path.join(cwd, '.planning', LEDGER_FILE_NAME);
}

function readLedgerOrNull(cwd: string): Ledger | null {
  const p = ledgerPath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e: unknown) {
    // ENOENT is the only "no ledger yet" case. Every other fs error (EACCES,
    // EPERM, EIO, ENOTDIR, EBADF, ...) must NOT be silently coerced to "empty
    // ledger" — that would fail the ship gate OPEN on an unreadable ledger,
    // contradicting the workflow's documented "fail closed on unreadable"
    // invariant (issue #1950 review H2). Propagate as malformed so the gate
    // blocks and the operator sees a real diagnostic.
    const code = (e && typeof e === 'object' && 'code' in e)
      ? String((e as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') return null;
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Could not read ledger at ${p} (${code || 'unknown fs error'}): ${(e as Error).message}.`,
    );
  }
  // parseLedger throws WindowsError on malformed content — caller surfaces it.
  return parseLedger(raw);
}

function ensurePlanningDir(cwd: string): void {
  const dir = path.join(cwd, '.planning');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Errnos that Windows throws transiently on rename when a reader or antivirus
 * scanner holds the target. We retry through these; anything else propagates.
 *
 * NOTE (issue #1950 review L3): the retry uses a short busy-wait rather than
 * setTimeout — this is a synchronous CLI path with no event loop to yield on,
 * and the cumulative wait is bounded at 25+50+100+200 = 375ms across 5 attempts.
 * If a future caller moves this onto an async path, swap to awaitable sleeps.
 */
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 25;

function renameWithRetry(tmp: string, target: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err && typeof err === 'object' && 'code' in err) ? String((err as { code?: unknown }).code) : '';
      if (code && RENAME_RETRY_ERRNOS.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
        // Exponential-ish backoff: 25ms, 50ms, 100ms, 200ms.
        const delay = RENAME_BACKOFF_MS * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // Busy-wait a very short time — Windows transient locks usually clear in <100ms.
        }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function writeLedgerAtomic(cwd: string, ledger: Ledger): void {
  ensurePlanningDir(cwd);
  const p = ledgerPath(cwd);
  const tmp = `${p}.${process.pid}.tmp`;

  // #2893: preserve any prose below the JSON ledger block. renderLedger
  // reconstructs frontmatter + header + table + JSON — it does not include
  // trailing prose that users may have written below the closing fence.
  // Without this, every append/waive/fixed silently destroys that prose.
  let trailingProse = '';
  try {
    const existing = fs.readFileSync(p, 'utf8');
    // #2893: search for the CLOSING fence starting AFTER the opening fence,
    // mirroring parseJsonBlock — indexOf(JSON_FENCE_CLOSE) alone would match
    // the opening fence ('````json' starts with '````').
    const openIdx = existing.indexOf(JSON_FENCE_OPEN);
    if (openIdx !== -1) {
      const fenceEnd = existing.indexOf(JSON_FENCE_CLOSE, openIdx + JSON_FENCE_OPEN.length);
      if (fenceEnd !== -1) {
        const afterFence = existing.slice(fenceEnd + JSON_FENCE_CLOSE.length);
        // Drop leading newlines; keep the rest as prose.
        trailingProse = afterFence.replace(/^\n+/, '');
      }
    }
  } catch {
    // File doesn't exist yet (first write) — no prose to preserve.
  }

  const rendered = renderLedger(ledger);
  const content = trailingProse ? `${rendered}${trailingProse}` : rendered;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    renameWithRetry(tmp, p);
  } catch (err) {
    // Clean up the orphaned tmp file so repeated failures don't accumulate
    // `.planning/WINDOWS.md.<pid>.tmp` files (issue #1950 review M1). Best-effort:
    // unlink failures (e.g., already gone) are swallowed.
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Emit a JSON result to stdout in the canonical shape. */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2));
}

/** `gsd-tools windows status [--raw]`. */
export function cmdWindowsStatus(cwd: string, opts: { raw?: boolean } = {}): void {
  let ledger: Ledger;
  try {
    ledger = readLedgerOrNull(cwd) ?? emptyLedger(nowIso());
  } catch (e) {
    if (e instanceof WindowsError) throw e;
    throw new WindowsError(
      REASON.WINDOWS_LEDGER_MALFORMED,
      `Unexpected error reading ledger: ${(e as Error).message}`,
    );
  }
  void opts; // status output is JSON in both human and raw modes (single shape)
  emit({ ok: true, ledger });
}

/** `gsd-tools windows append --kind K --phase N [--file F] [--line L] --description D`. */
export function cmdWindowsAppend(
  cwd: string,
  args: string[],
  opts: { raw?: boolean } = {},
): void {
  void opts;
  const parsed = parseArgs(args, {
    flags: ['--kind', '--phase', '--file', '--line', '--description'],
    required: ['--kind', '--phase', '--description'],
  });

  let ledger: Ledger;
  try {
    ledger = readLedgerOrNull(cwd) ?? emptyLedger(nowIso());
  } catch (e) {
    if (e instanceof WindowsError) throw e;
    throw new WindowsError(REASON.WINDOWS_LEDGER_MALFORMED, (e as Error).message);
  }

  const result = appendWindow(
    ledger,
    {
      kind: parsed.values['--kind'] as WindowKind,
      phase: parsed.values['--phase'] ?? '',
      file: parsed.values['--file'] ?? '',
      line: parsed.values['--line'] == null ? null : Number(parsed.values['--line']),
      description: parsed.values['--description'] ?? '',
    },
    { now: nowIso() },
  );
  writeLedgerAtomic(cwd, result.ledger);
  emit({ ok: true, ledger: result.ledger, entry: result.entry });
}

/** `gsd-tools windows waive <id> "<reason>"`. */
export function cmdWindowsWaive(
  cwd: string,
  args: string[],
  opts: { raw?: boolean } = {},
): void {
  void opts;
  const { positionals } = parseArgs(args, { flags: [], required: [], positionals: 2 });
  const idStr = positionals[0];
  const reason = positionals[1];

  const id = parseIdOrThrow(idStr);

  let ledger: Ledger;
  try {
    ledger = readLedgerOrNull(cwd) ?? emptyLedger(nowIso());
  } catch (e) {
    if (e instanceof WindowsError) throw e;
    throw new WindowsError(REASON.WINDOWS_LEDGER_MALFORMED, (e as Error).message);
  }

  const updated = markWaived(ledger, id, reason ?? '', { now: nowIso() });
  writeLedgerAtomic(cwd, updated);
  emit({ ok: true, ledger: updated });
}

/** `gsd-tools windows fixed <id>`. */
export function cmdWindowsMarkFixed(
  cwd: string,
  args: string[],
  opts: { raw?: boolean } = {},
): void {
  void opts;
  const { positionals } = parseArgs(args, { flags: [], required: [], positionals: 1 });
  const id = parseIdOrThrow(positionals[0]);

  let ledger: Ledger;
  try {
    ledger = readLedgerOrNull(cwd) ?? emptyLedger(nowIso());
  } catch (e) {
    if (e instanceof WindowsError) throw e;
    throw new WindowsError(REASON.WINDOWS_LEDGER_MALFORMED, (e as Error).message);
  }

  const updated = markFixed(ledger, id, { now: nowIso() });
  writeLedgerAtomic(cwd, updated);
  emit({ ok: true, ledger: updated });
}

function parseIdOrThrow(raw: string | undefined): number {
  if (raw == null || raw === '') {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_ID,
      'Window id is required.',
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new WindowsError(
      REASON.WINDOWS_INVALID_ID,
      `Window id must be a positive integer (got: ${JSON.stringify(raw)}).`,
    );
  }
  return n;
}

/** Minimal argv parser — flag values via `--flag value` or `--flag=value`. */
function parseArgs(
  args: string[],
  spec: { flags: string[]; required: string[]; positionals?: number },
): { values: Record<string, string | undefined>; positionals: string[] } {
  const values: Record<string, string | undefined> = {};
  const positionals: string[] = [];
  const flagSet = new Set(spec.flags);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a == null) continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flagName = eq === -1 ? a : a.slice(0, eq);
      if (!flagSet.has(flagName)) {
        throw new WindowsError(
          REASON.WINDOWS_USAGE,
          `Unknown flag: ${flagName}`,
        );
      }
      if (eq !== -1) {
        values[flagName] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next == null || next.startsWith('--')) {
          if (!(flagName in values)) values[flagName] = undefined;
        } else {
          values[flagName] = next;
          i++;
        }
      }
    } else {
      positionals.push(a);
    }
  }

  for (const r of spec.required) {
    if (values[r] == null || values[r] === '') {
      throw new WindowsError(
        REASON.WINDOWS_USAGE,
        `Missing required flag: ${r}`,
      );
    }
  }

  const want = spec.positionals ?? 0;
  if (positionals.length < want) {
    throw new WindowsError(
      REASON.WINDOWS_USAGE,
      `Expected ${want} positional argument(s); got ${positionals.length}.`,
    );
  }

  return { values, positionals };
}
