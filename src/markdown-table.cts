/**
 * Markdown Table Model — canonical GFM table parsing + schema registry seam
 * (ADR-2143, epic #2143). Pure functions, Node built-ins only, string-in/value-out,
 * no I/O. Compiled by tsc to gsd-core/bin/lib/markdown-table.cjs.
 *
 * NOTE: the `Result<T>` here is the ADR-2143 §5 parse-result shape {ok,value|reason},
 * now defined once in `./write-set.cjs` (the shared fail-loud + write-set seam) and
 * re-exported here so existing importers of `Result` from this module keep working
 * unchanged — deliberately distinct from command-routing-hub's dispatch `Result`
 * {ok,data|kind}; the two never mix (different modules).
 */

import { collectSection, collectSections, replaceSection } from './markdown-sectionizer.cjs';
import type { HeadingToken, Section } from './markdown-sectionizer.cjs';
import type { Result } from './write-set.cjs';
export type { Result } from './write-set.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A parsed GFM pipe table: header column names + rows addressed by column name. */
export interface MarkdownTable {
  columns: string[];
  rows: Record<string, string>[];
}

/** One recognised header-shape variant of a canonical table kind. */
export interface CanonicalTableVariant {
  label: string;
  columns: string[];
}

// ─── Schema registry ──────────────────────────────────────────────────────────

/**
 * Canonical column-header shapes for every GFM table GSD parses or generates.
 * Each entry in `TABLE_SCHEMAS[id]` is one accepted variant (exact column names,
 * in order); `matchTableSchema` resolves a parsed header back to `{id, label}`.
 *
 * This registry is the single source of truth — a parity test
 * (tests/markdown-table.test.cjs) asserts every variant's header appears
 * verbatim in the template/workflow file that generates it, so the registry
 * and the templates can never silently drift (ADR-2143 §3 Generative-Fix-
 * Divergence guard).
 */
export const TABLE_SCHEMAS: Record<string, CanonicalTableVariant[]> = {
  RoadmapProgress: [
    { label: 'flat', columns: ['Phase', 'Plans Complete', 'Status', 'Completed'] },
    {
      label: 'milestone-grouped',
      columns: ['Phase', 'Milestone', 'Plans Complete', 'Status', 'Completed'],
    },
  ],
  RequirementsTraceability: [
    { label: 'default', columns: ['Requirement', 'Phase', 'Status'] },
  ],
  QuickTasks: [
    { label: 'no-status', columns: ['#', 'Description', 'Date', 'Commit', 'Directory'] },
    {
      label: 'with-status',
      columns: ['#', 'Description', 'Date', 'Commit', 'Status', 'Directory'],
    },
  ],
  Security: [
    { label: 'trust-boundaries', columns: ['Boundary', 'Description', 'Data Crossing'] },
    {
      label: 'threat-register',
      columns: [
        'Threat ID',
        'Category',
        'Component',
        'Severity',
        'Disposition',
        'Mitigation',
        'Status',
      ],
    },
    {
      label: 'accepted-risks',
      columns: ['Risk ID', 'Threat Ref', 'Rationale', 'Accepted By', 'Date'],
    },
    {
      label: 'audit-trail',
      columns: ['Audit Date', 'Threats Total', 'Closed', 'Open', 'Run By'],
    },
  ],
};

/**
 * Resolve a parsed table's header columns to the canonical schema it matches
 * (exact column names, same length, same order), else `null`.
 */
export function matchTableSchema(columns: string[]): { id: string; label: string } | null {
  for (const [id, variants] of Object.entries(TABLE_SCHEMAS)) {
    for (const variant of variants) {
      if (
        variant.columns.length === columns.length
        && variant.columns.every((col, idx) => col === columns[idx])
      ) {
        return { id, label: variant.label };
      }
    }
  }
  return null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Split one GFM table row line into trimmed cell strings.
 * Strips one leading and one trailing `|`, splits on unescaped `|`, trims
 * each cell, and unescapes `\\` back to `\` and `\|` back to `|` (the exact
 * reverse of `escapeCell`'s `\`->`\\` then `|`->`\|` order below), so cell
 * values round-trip exactly — including literal backslashes.
 */
export function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);
  return stripped.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\([\\|])/g, '$1'));
}

/**
 * True when every delimiter cell matches GFM's `:?-{1,}:?` shape (spaces
 * removed). Exported (alongside `splitTableRow`) so callers that need their
 * own ragged-tolerant header/delimiter detection — e.g. state.cts's
 * `cmdStateRecordMetric` row-append, which must recognize an existing table
 * without requiring every DATA row to also parse cleanly (#2245 Blocker 2) —
 * reuse the exact same header/delimiter-shape check `parseMarkdownTable` uses,
 * instead of re-deriving it and risking divergence.
 */
export function isDelimiterRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, '')));
}

/**
 * Parse the FIRST GFM pipe table found in `sectionText`.
 *
 * Defensive by design: never throws — every malformed shape (no table,
 * missing/misaligned delimiter row, ragged data row) returns a typed
 * `{ok:false, reason}` instead of silently coercing or dropping data
 * (ADR-2143 §3 — ragged rows are errors, not silent).
 *
 * Scope note: GSD planning tables (STATE.md/ROADMAP.md/requirements.md/
 * SECURITY.md) are always fully-piped (leading + trailing `|` on every row)
 * and non-indented — this parser targets THAT shape, not arbitrary
 * CommonMark (which also allows non-piped rows and up to 3 leading spaces).
 */
export function parseMarkdownTable(sectionText: string): Result<MarkdownTable> {
  if (typeof sectionText !== 'string' || sectionText.trim() === '') {
    return { ok: false, reason: 'empty or non-string input' };
  }

  const lines = sectionText.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'no table found' };
  }

  const columns = splitTableRow(lines[headerIdx]);

  const delimiterLine = lines[headerIdx + 1];
  if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  const delimiterCells = splitTableRow(delimiterLine);
  if (!isDelimiterRow(delimiterCells)) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  if (delimiterCells.length !== columns.length) {
    return { ok: false, reason: 'delimiter/header column count mismatch' };
  }

  const rows: Record<string, string>[] = [];
  let rowNum = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) break;

    rowNum += 1;
    const cells = splitTableRow(lines[i]);
    if (cells.length !== columns.length) {
      return {
        ok: false,
        reason: `row ${rowNum} has ${cells.length} cells, expected ${columns.length}`,
      };
    }

    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = cells[idx];
    });
    rows.push(row);
  }

  return { ok: true, value: { columns, rows } };
}

// ─── updateTableCell (ADR-2143 §7 formatting-preserving cell write) ──────────

/** One line of `text`, with its absolute start offset and original EOL length. */
interface LineOffset {
  line: string;
  start: number;
}

/**
 * Split `text` into lines exactly like `.split(/\r?\n/)` (bare `\r` is NOT a
 * line break, matching `parseMarkdownTable`), tracking each line's absolute
 * start offset in `text` so cell ranges can be computed relative to the
 * ORIGINAL string, not the trimmed/relative line.
 */
function splitLinesWithOffsets(text: string): LineOffset[] {
  const result: LineOffset[] = [];
  let start = 0;
  const re = /\r\n|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    result.push({ line: text.slice(start, m.index), start });
    start = m.index + m[0].length;
  }
  result.push({ line: text.slice(start), start });
  return result;
}

/**
 * Cell range within one row: `text.slice(start, end)` is the RAW cell text
 * (untrimmed, still `\`-escaped) between its two delimiting `|` characters.
 */
interface CellRange {
  start: number;
  end: number;
}

/**
 * Split one GFM table row LINE into raw cell ranges, absolute to the original
 * `text` the line was sliced from (`lineStart` = that line's start offset).
 * Mirrors `splitTableRow`'s trim + strip-leading/trailing-pipe + unescaped-pipe
 * split EXACTLY, but returns character ranges instead of trimmed values, so a
 * caller can splice a replacement into the original string byte-for-byte.
 */
function splitTableRowRanges(line: string, lineStart: number): CellRange[] {
  const leftTrim = /^\s*/.exec(line)![0].length;
  const rightTrim = /\s*$/.exec(line)![0].length;
  let stripped = line.slice(leftTrim, line.length - rightTrim);
  let strippedStart = lineStart + leftTrim;

  if (stripped.startsWith('|')) {
    stripped = stripped.slice(1);
    strippedStart += 1;
  }
  if (stripped.endsWith('|')) {
    stripped = stripped.slice(0, -1);
  }

  const cells: CellRange[] = [];
  const re = /(?<!\\)\|/g;
  let cellStartRel = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    cells.push({ start: strippedStart + cellStartRel, end: strippedStart + m.index });
    cellStartRel = m.index + 1;
  }
  cells.push({ start: strippedStart + cellStartRel, end: strippedStart + stripped.length });
  return cells;
}

/** Unescape one raw (still-`\`-escaped) cell/column-name span exactly like
 * `splitTableRow`: trim, then reverse `\\` -> `\` and `\|` -> `|`. */
function unescapeCellText(raw: string): string {
  return raw.trim().replace(/\\([\\|])/g, '$1');
}

/**
 * Surgically edit ONE table cell while preserving the table's exact byte
 * formatting (ADR-2143 §7). Locates the first GFM table's header + delimiter
 * row in `tableText` (own header/delimiter detection — deliberately does NOT
 * gate on `parseMarkdownTable(tableText).ok`), finds the first DATA row where
 * `match(row, index)` is true, and replaces ONLY that row's `column` cell's
 * raw inner text (the span between its two delimiting `|` characters) — every
 * other byte of `tableText` (other cells, padding, alignment, EOL style) is
 * left BYTE-IDENTICAL. This is deliberately NOT a parse-then-render: a
 * render pass would reformat padding/alignment/dates that mutation sites
 * (e.g. `status.padEnd(11)`) depend on staying pinned.
 *
 * Ragged-tolerant by design (#2245 review Fix 2): each data row's
 * `{colName:cellText}` record is built ONLY from the columns physically
 * present in THAT row — a short row simply omits its trailing column names;
 * an over-long row's extra trailing cells are ignored — so `match` is called
 * with whatever partial record a ragged row yields. A single sibling row
 * whose cell count doesn't match the header must never silently no-op the
 * whole write (the prior `parseMarkdownTable(tableText).ok` gate failed the
 * ENTIRE table — including an otherwise-well-formed target row — the moment
 * ANY other row in the same table was ragged). A row that matches on content
 * but is too short to physically contain `column` has no cell to splice
 * into, so it cannot be selected; the scan continues past it.
 *
 * `newValue` is spliced in VERBATIM as the new raw cell span — it is the
 * caller's responsibility to supply the fully-formatted text (including any
 * leading/trailing padding needed to reproduce the table's existing column
 * alignment, and to escape a literal `|` or `\` the value might contain via
 * the same convention `splitTableRow`/`escapeCell` use elsewhere in this
 * module). When `newValue` is a function, it receives the CURRENT (trimmed,
 * unescaped) cell value — the same value that appears in `match`'s `row`
 * argument — and must return the full literal replacement text. Returning
 * the current value unchanged is a supported no-op-probe pattern for callers
 * that need to know whether (and to what current value) a row matched
 * without necessarily writing a new value.
 *
 * Returns `{ok:false, reason}` only for a genuinely absent/malformed table
 * (no header line, or no valid delimiter row immediately below it), an
 * unknown `column`, or zero rows satisfying `match` while physically
 * containing `column` — never for a ragged sibling row.
 */
export function updateTableCell(
  tableText: string,
  match: (row: Record<string, string>, index: number) => boolean,
  column: string,
  newValue: string | ((current: string) => string),
): Result<string> {
  const lines = splitLinesWithOffsets(tableText);

  // #3255: pick the first VALID table whose columns include `column`. The prior
  // code bound to the FIRST table of any shape and returned 'unknown column' if
  // that one lacked the column — so a section holding a summary table above the
  // target (e.g. ## Traceability: a phase-summary table, then the requirement
  // rows) never reached the target table. Scan for the first valid table that
  // carries the column; if none does but a valid table exists, still return
  // 'unknown column' (single-table behaviour unchanged). Track the first
  // malformation reason so a lone malformed table keeps its specific error.
  let headerIdx = -1;
  let columns: string[] = [];
  let firstValidIdx = -1;
  let firstMalformedReason: string | null = null;
  const recordMalformed = (reason: string): void => {
    if (firstMalformedReason === null && firstValidIdx === -1) firstMalformedReason = reason;
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (!trimmed.startsWith('|') || trimmed.indexOf('|', 1) === -1) continue;
    const delimiterLine = lines[i + 1]?.line;
    if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) {
      recordMalformed('missing delimiter row');
      continue;
    }
    const candidateRanges = splitTableRowRanges(lines[i].line, lines[i].start);
    const candidateColumns = candidateRanges.map((r) => unescapeCellText(tableText.slice(r.start, r.end)));
    const delimiterCells = splitTableRow(delimiterLine);
    if (!isDelimiterRow(delimiterCells)) {
      recordMalformed('missing delimiter row');
      continue;
    }
    if (delimiterCells.length !== candidateColumns.length) {
      recordMalformed('delimiter/header column count mismatch');
      continue;
    }
    if (firstValidIdx === -1) firstValidIdx = i;
    if (candidateColumns.includes(column)) {
      headerIdx = i;
      columns = candidateColumns;
      break;
    }
  }
  if (headerIdx === -1) {
    if (firstValidIdx !== -1) return { ok: false, reason: `unknown column: ${column}` };
    return { ok: false, reason: firstMalformedReason ?? 'no table found' };
  }
  const targetColIdx = columns.indexOf(column);

  let selectedRange: CellRange | undefined;
  let dataRowIndex = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (!trimmed.startsWith('|')) break;

    const cellRanges = splitTableRowRanges(lines[i].line, lines[i].start);
    const record: Record<string, string> = {};
    const presentCount = Math.min(cellRanges.length, columns.length);
    for (let c = 0; c < presentCount; c++) {
      record[columns[c]] = unescapeCellText(tableText.slice(cellRanges[c].start, cellRanges[c].end));
    }

    if (targetColIdx < cellRanges.length && match(record, dataRowIndex)) {
      selectedRange = cellRanges[targetColIdx];
      break;
    }
    dataRowIndex += 1;
  }

  if (!selectedRange) {
    return { ok: false, reason: 'no matching row' };
  }

  const currentValue = unescapeCellText(tableText.slice(selectedRange.start, selectedRange.end));
  const replacement = typeof newValue === 'function' ? newValue(currentValue) : newValue;

  // True no-op guard: a function `newValue` that returns `current` UNCHANGED
  // (the documented no-op-probe pattern) must leave `tableText` genuinely
  // byte-identical, padding included. `current` is already trimmed/unescaped,
  // so naively splicing it back in would strip the raw cell's original
  // leading/trailing padding — this returns the ORIGINAL text untouched
  // instead whenever the callback's answer is "no change".
  if (typeof newValue === 'function' && replacement === currentValue) {
    return { ok: true, value: tableText };
  }

  return {
    ok: true,
    value: tableText.slice(0, selectedRange.start) + replacement + tableText.slice(selectedRange.end),
  };
}

// ─── deleteTableRow (ADR-2143 §7 row-removal sibling of updateTableCell) ─────

/**
 * Surgically delete ONE whole table row while preserving every other byte of
 * `tableText` (ADR-2143 §7, row-removal sibling of `updateTableCell`). Locates
 * the first GFM table's header + delimiter row in `tableText` using the exact
 * same self-contained, ragged-tolerant scan `updateTableCell` uses (own
 * header/delimiter detection — does NOT gate on `parseMarkdownTable(tableText).ok`),
 * finds the FIRST data row where `match(row, index)` is true, and splices out
 * that row's entire LINE — including its trailing newline (`\r\n` or `\n`,
 * whichever terminates it) — from `tableText`. Every other byte (header,
 * delimiter, other rows, surrounding prose before/after the table, EOL style)
 * is left BYTE-IDENTICAL.
 *
 * Ragged-tolerant by design, mirroring `updateTableCell` (#2245 review Fix 2):
 * each data row's `{colName:cellText}` record is built ONLY from the columns
 * physically present in THAT row — a sibling row whose cell count doesn't
 * match the header must never abort the whole scan; `match` is simply called
 * with whatever partial record a ragged row yields.
 *
 * Returns `{ok:false, reason}` for a genuinely absent/malformed table (no
 * header line, or no valid delimiter row immediately below it) or zero rows
 * satisfying `match` — never for a ragged sibling row.
 */
export function deleteTableRow(
  tableText: string,
  match: (row: Record<string, string>, index: number) => boolean,
): Result<string> {
  const lines = splitLinesWithOffsets(tableText);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'no table found' };
  }

  const delimiterLine = lines[headerIdx + 1]?.line;
  if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) {
    return { ok: false, reason: 'missing delimiter row' };
  }

  const headerRanges = splitTableRowRanges(lines[headerIdx].line, lines[headerIdx].start);
  const columns = headerRanges.map((r) => unescapeCellText(tableText.slice(r.start, r.end)));

  const delimiterCells = splitTableRow(delimiterLine);
  if (!isDelimiterRow(delimiterCells)) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  if (delimiterCells.length !== columns.length) {
    return { ok: false, reason: 'delimiter/header column count mismatch' };
  }

  let selectedLineIdx = -1;
  let dataRowIndex = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (!trimmed.startsWith('|')) break;

    const cellRanges = splitTableRowRanges(lines[i].line, lines[i].start);
    const record: Record<string, string> = {};
    const presentCount = Math.min(cellRanges.length, columns.length);
    for (let c = 0; c < presentCount; c++) {
      record[columns[c]] = unescapeCellText(tableText.slice(cellRanges[c].start, cellRanges[c].end));
    }

    if (match(record, dataRowIndex)) {
      selectedLineIdx = i;
      break;
    }
    dataRowIndex += 1;
  }

  if (selectedLineIdx === -1) {
    return { ok: false, reason: 'no matching row' };
  }

  // Splice out the whole LINE including its trailing EOL: the next line's
  // recorded `start` offset is already positioned right after whatever EOL
  // (`\r\n` or `\n`) terminated the selected line (see `splitLinesWithOffsets`
  // above) — when the selected row is the LAST line in `tableText` (no
  // trailing EOL to preserve), fall back to the end of the string.
  let rowStart = lines[selectedLineIdx].start;
  let rowEnd: number;
  if (selectedLineIdx + 1 < lines.length) {
    rowEnd = lines[selectedLineIdx + 1].start;
  } else {
    // The selected row is the LAST line and has no trailing EOL: deleting from
    // its `start` to end-of-string would strand the EOL that terminated the
    // PREVIOUS line as a dangling newline. Back `rowStart` up over that
    // preceding `\n` (and its `\r`, if any) so the table ends cleanly after the
    // new last row.
    rowEnd = tableText.length;
    if (rowStart > 0 && tableText[rowStart - 1] === '\n') {
      rowStart -= 1;
      if (rowStart > 0 && tableText[rowStart - 1] === '\r') rowStart -= 1;
    }
  }

  return {
    ok: true,
    value: tableText.slice(0, rowStart) + tableText.slice(rowEnd),
  };
}

// ─── insertTableRow (ADR-2143 §7 row-insertion sibling of updateTableCell) ───

/**
 * Insert ONE new row into a GFM table while preserving every other byte of
 * `tableText` (ADR-2143 §7, row-insertion sibling of `updateTableCell` /
 * `deleteTableRow`). Locates the first table's header + delimiter row using
 * the exact same self-contained, ragged-tolerant scan the other two use (own
 * header/delimiter detection — does NOT gate on `parseMarkdownTable(tableText).ok`),
 * builds the new row's cells in the table's ACTUAL header order — each column
 * name is passed through `valueFor(column)`; a column for which `valueFor`
 * returns `undefined` gets `fallback` (default `'-'`) — and splices it in
 * immediately after the table's LAST existing data row (or immediately after
 * the delimiter row when the table has zero data rows).
 *
 * Name-addressed and header-order-agnostic by construction: unlike a
 * hardcoded positional literal (`| ${a} | ${b} | - | - |`), this never
 * silently no-ops or mis-maps a value onto the wrong column when the header
 * is reordered or a superset of the columns `valueFor` knows about (#2245
 * audit sibling finding — the bug this helper replaces).
 *
 * EOL-preserving: the new row reuses whatever exact EOL bytes (`\r\n` or
 * `\n`) already terminate the line it's inserted after, so a CRLF document
 * stays CRLF and an LF document stays LF — never guessed or hardcoded. When
 * the insertion point is at the very end of `tableText` with no following
 * line (the table's last row has no trailing EOL of its own), the existing
 * last row is terminated with the header/delimiter boundary's own EOL (so it
 * gains a terminator, since it is no longer the last line) and the new row
 * becomes the new EOL-less tail — mirroring `tableText`'s own convention of
 * not forcing a trailing newline that wasn't already there.
 *
 * Escaping (F4 #2245 review): unlike `updateTableCell`, whose `newValue` is
 * spliced in VERBATIM (caller-must-escape — see its doc comment above), every
 * value returned by `valueFor` (and `fallback`) IS escaped internally here via
 * `escapeCell` before being joined into the new row, exactly like
 * `appendQuickTaskRow` below — a caller-supplied name containing a literal
 * `|` or `\` cannot silently split the new row into extra columns. Callers do
 * NOT need to pre-escape their values.
 *
 * Returns `{ok:false, reason}` only for a genuinely absent/malformed table
 * (no header line, or no valid delimiter row immediately below it) — never
 * for a ragged data row (mirrors `updateTableCell`/`deleteTableRow`).
 */
export function insertTableRow(
  tableText: string,
  valueFor: (column: string) => string | undefined,
  fallback = '-',
): Result<string> {
  const lines = splitLinesWithOffsets(tableText);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'no table found' };
  }

  const delimiterLine = lines[headerIdx + 1]?.line;
  if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  const delimiterCells = splitTableRow(delimiterLine);
  if (!isDelimiterRow(delimiterCells)) {
    return { ok: false, reason: 'missing delimiter row' };
  }

  const headerRanges = splitTableRowRanges(lines[headerIdx].line, lines[headerIdx].start);
  const columns = headerRanges.map((r) => unescapeCellText(tableText.slice(r.start, r.end)));

  // Header -> delimiter EOL, reused as the fallback terminator for the "insert
  // point is at the absolute end of tableText" edge case below.
  const headerToDelimiterEol = tableText.slice(
    lines[headerIdx].start + lines[headerIdx].line.length,
    lines[headerIdx + 1].start,
  ) || '\n';

  let lastLineIdx = headerIdx + 1; // delimiter row, when the table has zero data rows
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].line.trim().startsWith('|')) break;
    lastLineIdx = i;
  }

  const newRow = `| ${columns.map((col) => escapeCell(valueFor(col) ?? fallback)).join(' | ')} |`;

  if (lastLineIdx + 1 < lines.length) {
    // A following line exists — insert the new row, reusing the EXACT EOL
    // that already terminates the current last table line, so every other
    // byte (including everything after the table) stays untouched.
    const insertAt = lines[lastLineIdx + 1].start;
    const eol = tableText.slice(lines[lastLineIdx].start + lines[lastLineIdx].line.length, insertAt);
    return { ok: true, value: tableText.slice(0, insertAt) + newRow + eol + tableText.slice(insertAt) };
  }

  // The table's last row is also the last line of `tableText` (no trailing
  // EOL). Terminate it now — it needs one, since it is no longer last — and
  // append the new row as the new EOL-less tail.
  return { ok: true, value: tableText + headerToDelimiterEol + newRow };
}

/**
 * Find the first table in `text` whose header matches `TABLE_SCHEMAS[schemaId]`,
 * scanning the WHOLE document (not just a named section). Returns `null` when
 * no table with that schema is found.
 *
 * Fixes the regression where callers first located a named heading (e.g.
 * `## Progress`) via `collectSection` and only then parsed a table inside it —
 * a schema-matching table that lives under a differently-named heading (or no
 * heading at all), or that isn't the first table in the document, was
 * invisible to that approach. Scanning the whole document by schema restores
 * the old "find the progress table anywhere" behaviour while staying
 * seam-based (ADR-2143).
 */
export function findTableBySchema(text: string, schemaId: string): MarkdownTable | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|') || t.indexOf('|', 1) === -1) continue;
    const cols = splitTableRow(lines[i]);
    const m = matchTableSchema(cols);
    if (m && m.id === schemaId) {
      const parsed = parseMarkdownTable(lines.slice(i).join('\n'));
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

/**
 * Find the first GFM table in `text` whose header contains ALL of `required`
 * column names (order-independent; extra/injected columns allowed). Returns
 * the parsed `MarkdownTable`, or `null` when no table's header is a superset
 * of `required`.
 *
 * Column-NAME/order/count-invariant counterpart to `findTableBySchema` (ADR-2143
 * §3 "addressed by NAME, never ordinal"): where `findTableBySchema` requires an
 * EXACT canonical column set+order registered in `TABLE_SCHEMAS`, this scans
 * for any header that names the required columns, in any order, tolerating
 * extra/unrelated injected columns. Cells remain addressable by column NAME
 * via the returned `MarkdownTable`.
 */
export function findTableWithColumns(text: string, required: string[]): MarkdownTable | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|') || t.indexOf('|', 1) === -1) continue;
    const cols = splitTableRow(lines[i]);
    if (required.every((rq) => cols.includes(rq))) {
      const parsed = parseMarkdownTable(lines.slice(i).join('\n'));
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

// ─── Quick Tasks row append (#2133) ────────────────────────────────────────────

/**
 * Escape one dynamic cell value for insertion into a GFM pipe-table row.
 *
 * Escapes `\` -> `\\` FIRST, then `|` -> `\|` (in that order, so a literal
 * backslash already in the value is never mistaken for part of an escape
 * sequence introduced by this function — CodeQL js/incomplete-sanitization).
 * `splitTableRow` reverses both in the opposite order (`\\` -> `\` then
 * `\|` -> `|`, see line ~114 above), so escaping/unescaping round-trips
 * exactly, including literal backslashes. Newlines are collapsed to a
 * single space — a raw `|` or embedded newline in a cell value (e.g. a task
 * `description`) would otherwise corrupt the table (extra column / a fake
 * extra row) and get rejected by the now-fail-loud `parseMarkdownTable` as a
 * ragged row.
 *
 * Exported (F3/#2245 review) so callers of `updateTableCell` that build a
 * replacement value by transforming the CURRENT (already-unescaped) cell
 * text — e.g. phase.cts's Progress-ordinal renumber, which decrements the
 * leading digit of a `Phase` cell like `3. Parser | Lexer` and splices the
 * rest of the cell text back verbatim — can re-escape that value before
 * returning it from the `newValue` callback, honoring `updateTableCell`'s
 * caller-must-re-escape contract (see its doc comment above) instead of
 * spliceing a raw, unescaped `|` back into the table and silently splitting
 * the cell.
 */
export function escapeCell(value: string): string {
  return String(value)
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\') // escape the escape char FIRST (CodeQL js/incomplete-sanitization)
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Shared sentinel `reason` returned by both `appendQuickTaskRow` and
 * `resetQuickTaskRows` when the "Quick Tasks Completed" heading is absent
 * from `stateContent` (#2142). The section is created lazily by
 * `gsd-core/workflows/quick.md` Step 7b and is absent from
 * `gsd-core/templates/state.md`, so an absent section is the common case,
 * not an anomaly — callers compare against this constant rather than
 * matching on the free-form reason string (CONTRIBUTING.md "Prohibited:
 * Raw Text Matching").
 */
export const QUICK_TASKS_SECTION_ABSENT = 'no Quick Tasks Completed section';

/**
 * #3860: heading predicate for STATE.md's Quick Tasks Completed section(s).
 * The heading is a section LABEL, not data — milestone-scoped files
 * legitimately carry suffixed headings (`### Quick Tasks Completed (v1.1+)`
 * beside an archived `(v1.0)`), so the match is prefix-anchored with a word
 * boundary, never exact: `Quick Tasks Completedness` must NOT match. Hoisted
 * beside QUICK_TASKS_SECTION_ABSENT so `appendQuickTaskRow` and
 * `resetQuickTaskRows` cannot drift apart again.
 */
const isQuickTasksHeading = (h: HeadingToken): boolean =>
  /^quick tasks completed\b/i.test(h.text.trim());

/**
 * #3860: among ALL heading-matching sections, pick the first whose body is a
 * table with a recognized Quick Tasks schema — a legacy/unparseable table
 * first in document order no longer shadows a usable one further down. When
 * NO section is usable, return the FIRST match so the caller's downstream
 * error describes the real problem (unparseable/legacy table) instead of a
 * false QUICK_TASKS_SECTION_ABSENT.
 *
 * Bounding: `collectSections` ends a candidate's body only at the NEXT
 * matching heading — far too wide for splicing (it would swallow an
 * intervening `## Deferred Items` table into the Quick Tasks body, and
 * `appendQuickTaskRow`'s last-table-line scan would then splice the new row
 * into that WRONG table). Each candidate is therefore re-collected through
 * `collectSection` with an offset-precise predicate, whose default
 * level-bounded stop (next heading of the same or higher level) is exactly
 * the semantics the pre-#3860 single-section lookup had.
 *
 * Convention: "first" is document order — the newest-on-top layout the issue
 * itself demonstrates (`(v1.1+)` above an archived `(v1.0)`). When several
 * suffixed sections all carry recognized schemas, this layer has no signal
 * for which milestone is active, so document order is the pinned tie-break.
 */
function selectQuickTasksSection(stateContent: string): Section | null {
  const candidates = collectSections(stateContent, isQuickTasksHeading);
  if (candidates.length === 0) return null;

  const boundedOf = (cand: Section): Section | null =>
    collectSection(stateContent, (h: HeadingToken) => h.offset === cand.heading.offset);

  const firstBounded = boundedOf(candidates[0]);
  for (const cand of candidates) {
    const bounded = boundedOf(cand);
    if (!bounded) continue;
    const parsed = parseMarkdownTable(bounded.body);
    if (parsed.ok && matchTableSchema(parsed.value.columns)?.id === 'QuickTasks') return bounded;
  }
  return firstBounded;
}

/** Fields needed to render one "Quick Tasks Completed" row (schema-driven). */
export interface QuickTaskFields {
  description: string;
  date: string;
  commit: string;
  status?: string;
  directory?: string;
  /**
   * The canonical `${quick_id}` cell (#3356 defect 1). When supplied, the `#`
   * cell renders this value verbatim instead of the positional ordinal
   * `rows.length + 1` — matching `workflows/quick.md`'s Step 7c row shape for
   * callers that actually have a quick id and task directory (e.g. a
   * `--quick-id`-bearing `gsd-tools quick-tasks-append` invocation). Omitted
   * (the `fast.md` caller, which has neither a quick id nor a task
   * directory — #2133) falls back to the ordinal exactly as before; this is
   * a pure widening, never a behavior change for existing callers.
   */
  quickId?: string;
}

/**
 * Append one row to STATE.md's "Quick Tasks Completed" table.
 *
 * Pure, schema-driven replacement for fast.md's inline `awk NF-2` column-count
 * guess (#2133, ADR-2143 §3 schema registry / §7 fail-loud unrecognized-schema
 * guard). Never touches disk, git, or the clock — callers (the `gsd-tools
 * quick-tasks-append` subcommand) compute `date`/`commit` and pass them in.
 *
 * Fails loud (`{ok:false, reason}`, never a silent skip) when:
 *   - no "Quick Tasks Completed" heading exists in `stateContent`
 *   - the section's body doesn't parse as a GFM table (parseMarkdownTable failure)
 *   - the table's header doesn't match a known `TABLE_SCHEMAS.QuickTasks` variant
 *     (the old awk arithmetic silently skipped here instead — that silent-skip
 *     branch is the bug this replaces).
 *
 * The new row is inserted immediately after the LAST existing table row line
 * (or immediately after the header/delimiter when the table has zero data
 * rows), preserving any surrounding blank lines/trailing content in the section.
 */
export function appendQuickTaskRow(
  stateContent: string,
  fields: QuickTaskFields,
): Result<{ content: string; row: string; variant: string }> {
  const section = selectQuickTasksSection(stateContent);
  if (!section) {
    return { ok: false, reason: QUICK_TASKS_SECTION_ABSENT };
  }

  const parsed = parseMarkdownTable(section.body);
  if (!parsed.ok) {
    return { ok: false, reason: `quick-tasks table: ${parsed.reason}` };
  }

  const match = matchTableSchema(parsed.value.columns);
  if (!match || match.id !== 'QuickTasks') {
    return {
      ok: false,
      reason: `unrecognized Quick Tasks schema (columns: ${parsed.value.columns.join(' | ')})`,
    };
  }

  const variant = TABLE_SCHEMAS.QuickTasks.find((v) => v.label === match.label);
  const columns = variant ? variant.columns : parsed.value.columns;

  const rowNumber = parsed.value.rows.length + 1;
  const cellFor = (col: string): string => {
    switch (col) {
      case '#': return escapeCell(fields.quickId ?? String(rowNumber));
      case 'Description': return escapeCell(fields.description);
      case 'Date': return escapeCell(fields.date);
      case 'Commit': return escapeCell(fields.commit);
      case 'Status': return escapeCell(fields.status ?? '—');
      case 'Directory': return escapeCell(fields.directory ?? '—');
      default: return '—';
    }
  };
  const row = `| ${columns.map(cellFor).join(' | ')} |`;

  // Detect the section's EOL BEFORE splitting on /\r?\n/ (which discards it) so
  // the rejoin below preserves CRLF instead of downgrading a CRLF section to
  // mixed EOL (the inserted `row` itself never contains a newline).
  const eol = /\r\n/.test(section.body) ? '\r\n' : '\n';
  const lines = section.body.split(/\r?\n/);
  let lastTableLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) lastTableLineIdx = i;
  }
  // lastTableLineIdx is always >= 0 here — parseMarkdownTable already
  // confirmed a header + delimiter row exist in this same `section.body`.
  const newLines = [
    ...lines.slice(0, lastTableLineIdx + 1),
    row,
    ...lines.slice(lastTableLineIdx + 1),
  ];
  const newBody = newLines.join(eol);

  const content = replaceSection(stateContent, section, newBody);

  return { ok: true, value: { content, row, variant: match.label } };
}


// ─── migrateQuickTasksTable (#3730 option b) ───────────────────────────────

/**
 * Column-name → canonical-cell mapping for migrating a legacy Quick Tasks table
 * (#3730). Name-based, case-insensitive; every column NOT in this map lands in
 * the Description bucket (joined with ' · ' in original column order, unknown
 * names kept as `name: value`) so no historical datum is dropped.
 */
const QUICK_TASKS_COLUMN_ALIASES: Record<string, string> = {
  '#': '#', id: '#',
  date: 'Date', when: 'Date',
  commit: 'Commit', sha: 'Commit',
  status: 'Status',
  directory: 'Directory', artifacts: 'Directory', path: 'Directory', dir: 'Directory',
  description: 'Description', task: 'Description', summary: 'Description',
  slug: 'Description', scope: 'Description', title: 'Description',
};

/**
 * Migrate STATE.md's "Quick Tasks Completed" table onto the canonical
 * `with-status` schema (#3730, maintainer decision 2026-09-02: option b).
 *
 * The pre-registry prose template licensed arbitrary column shapes GSD itself
 * emitted, and `appendQuickTaskRow` fails loud on every one of them — leaving a
 * project permanently unappendable. This is the supported repair path: the
 * `gsd-tools quick-tasks-migrate` subcommand, plus an automatic check on the
 * first `quick`/`fast` run (the workflow calls this before appending), which is
 * a silent no-op when the section is absent, the table is already canonical, or
 * the user never runs quick at all.
 *
 * Same section-selection, parse, and fail-loud posture as `appendQuickTaskRow`
 * (ADR-2143 §7 upheld — append still rejects; this REPAIRS). Returns
 * `{ok:true, value:{content, migrated:false}}` for the no-op cases so callers
 * can stay silent, and `{migrated:true, from, rows}` when a rewrite happened so
 * the CLI can report exactly what moved.
 */
export function migrateQuickTasksTable(
  stateContent: string,
): Result<{ content: string; migrated: boolean; from?: string[]; rows?: number }> {
  const section = selectQuickTasksSection(stateContent);
  if (!section) {
    return { ok: true, value: { content: stateContent, migrated: false } };
  }

  const parsed = parseMarkdownTable(section.body);
  if (!parsed.ok) {
    return { ok: false, reason: `quick-tasks table: ${parsed.reason}` };
  }

  const match = matchTableSchema(parsed.value.columns);
  if (match && match.id === 'QuickTasks') {
    return { ok: true, value: { content: stateContent, migrated: false } };
  }

  const canonical = TABLE_SCHEMAS.QuickTasks.find((v) => v.label === 'with-status')!.columns;
  // Map each legacy column to its canonical target; unmapped names keep their
  // identity so the Description bucket can render them losslessly.
  const targets = parsed.value.columns.map((c) => QUICK_TASKS_COLUMN_ALIASES[c.trim().toLowerCase()] ?? null);

  const rows = parsed.value.rows.map((row, rowIdx) => {
    const bucket: Record<string, string> = {
      '#': '', Description: '', Date: '', Commit: '', Status: '', Directory: '',
    };
    const descriptionParts: string[] = [];
    // parseMarkdownTable hands back name-keyed records (rows[i][columnName]).
    parsed.value.columns.forEach((col, i) => {
      const raw = (row[col] ?? '').trim();
      const target = targets[i];
      if (target === 'Description') {
        if (raw) descriptionParts.push(raw);
      } else if (target) {
        // Collision-safe (#3730 review): two legacy columns aliasing the same
        // canonical target must not silently overwrite — the displaced value
        // joins the Description bucket under its own name, same convention as
        // an unknown column, so no historical datum is dropped.
        if (raw && bucket[target]) {
          descriptionParts.push(`${col.trim()}: ${raw}`);
        } else if (raw) {
          bucket[target] = raw;
        }
      } else if (raw) {
        descriptionParts.push(`${col.trim()}: ${raw}`);
      }
    });
    bucket['#'] = bucket['#'] || String(rowIdx + 1);
    bucket.Description = descriptionParts.join(' · ');
    bucket.Date = bucket.Date || '—';
    bucket.Commit = bucket.Commit || '—';
    bucket.Status = bucket.Status || '—';
    bucket.Directory = bucket.Directory || '—';
    return `| ${canonical.map((c) => escapeCell(bucket[c])).join(' | ')} |`;
  });

  const eol = /\r\n/.test(section.body) ? '\r\n' : '\n';
  const lines = section.body.split(/\r?\n/);
  // CONTIGUOUS-run bound (#3730 review), mirroring resetQuickTaskRows: the
  // section body may carry a SECOND table (a `#### Notes` subsection or a
  // trailing table after a blank line) that parseMarkdownTable never read —
  // scanning for the last pipe line anywhere in the body would splice the
  // rewrite across it and silently destroy it. Only the first CONTIGUOUS run
  // of pipe lines — the table that was parsed — is replaced.
  const firstTableLineIdx = lines.findIndex((l) => l.trim().startsWith('|'));
  let lastTableLineIdx = firstTableLineIdx;
  while (lastTableLineIdx + 1 < lines.length && lines[lastTableLineIdx + 1].trim().startsWith('|')) {
    lastTableLineIdx++;
  }
  const header = `| ${canonical.join(' | ')} |`;
  // Widths match workflows/quick.md's canonical template byte-for-byte
  // (#3730 review): its delimiter is max(3, len+2) per column.
  const delimiter = `| ${canonical.map((c) => '-'.repeat(Math.max(3, c.length + 2))).join(' | ')} |`;
  const newBody = [
    ...lines.slice(0, firstTableLineIdx),
    header,
    delimiter,
    ...rows,
    ...lines.slice(lastTableLineIdx + 1),
  ].join(eol);

  return {
    ok: true,
    value: {
      content: replaceSection(stateContent, section, newBody),
      migrated: true,
      from: parsed.value.columns,
      rows: rows.length,
    },
  };
}

// ─── resetQuickTaskRows (#2142) ────────────────────────────────────────────

/**
 * Clear every DATA row from STATE.md's "Quick Tasks Completed" table, leaving
 * the header + delimiter lines byte-identical, for use at milestone close when
 * `--archive-quick` has actually moved the underlying `.planning/quick/*`
 * directories out from under the table (see `src/milestone.cts`'s
 * `archiveQuickTaskDirectories` / `cmdMilestoneComplete` wiring).
 *
 * Mirrors `appendQuickTaskRow`'s exact contract (same `selectQuickTasksSection` ->
 * `parseMarkdownTable` -> `matchTableSchema` pipeline, same fail-loud posture,
 * same EOL-detect-before-split handling) rather than inventing a second one:
 *   - no "Quick Tasks Completed" heading -> `{ok:false, reason:
 *     QUICK_TASKS_SECTION_ABSENT}` (no-op; a STATE.md without the section has
 *     nothing to reset — per #2142 design doc §40, behavior table row 5, the
 *     section is created lazily by quick.md Step 7b and is absent from
 *     templates/state.md, so absence is the common path, not an anomaly.
 *     Callers MUST treat this sentinel as silent — never surface it as a
 *     `preservation_warnings` entry).
 *   - the section body doesn't parse as a GFM table -> `{ok:false, reason}`.
 *   - the table's header doesn't match a known `TABLE_SCHEMAS.QuickTasks`
 *     variant -> `{ok:false, reason}` and — CRITICAL — no modification at
 *     all. A user-added column means the data can't be safely addressed by
 *     name, so clearing it would destroy rows under a schema we don't
 *     understand (Postel's Law: liberal in accepting known shapes,
 *     conservative about destroying what we don't).
 */
export function resetQuickTaskRows(
  stateContent: string,
): Result<{ content: string; cleared: number; variant: string }> {
  if (typeof stateContent !== 'string' || stateContent.trim() === '') {
    return { ok: false, reason: 'empty or non-string input' };
  }

  const section = selectQuickTasksSection(stateContent);
  if (!section) {
    return { ok: false, reason: QUICK_TASKS_SECTION_ABSENT };
  }

  const parsed = parseMarkdownTable(section.body);
  if (!parsed.ok) {
    return { ok: false, reason: `quick-tasks table: ${parsed.reason}` };
  }

  const match = matchTableSchema(parsed.value.columns);
  if (!match || match.id !== 'QuickTasks') {
    // Refuse the reset — keep every row, caller-owned content is untouched.
    return {
      ok: false,
      reason: `unrecognized Quick Tasks schema (columns: ${parsed.value.columns.join(' | ')})`,
    };
  }

  const cleared = parsed.value.rows.length;

  // Detect the section's EOL BEFORE splitting on /\r?\n/ (which discards it) —
  // exactly `appendQuickTaskRow`'s convention — so a CRLF document is not
  // downgraded to mixed EOL by the rejoin below.
  const eol = /\r\n/.test(section.body) ? '\r\n' : '\n';
  const lines = section.body.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) { headerIdx = i; break; }
  }
  // headerIdx is always found here — parseMarkdownTable already confirmed a
  // header + delimiter row exist in this same `section.body`.

  let lastTableLineIdx = headerIdx + 1; // delimiter row, when there are zero data rows
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    lastTableLineIdx = i;
  }

  // Keep the header + delimiter lines [0 .. headerIdx+1] plus everything
  // after the contiguous run of `|`-prefixed data rows — dropping only the
  // data rows themselves. Non-table content before/after the table inside
  // the section is preserved untouched.
  const newLines = [
    ...lines.slice(0, headerIdx + 2),
    ...lines.slice(lastTableLineIdx + 1),
  ];
  const newBody = newLines.join(eol);

  const content = replaceSection(stateContent, section, newBody);

  return { ok: true, value: { content, cleared, variant: match.label } };
}

// Consumers: require('../gsd-core/bin/lib/markdown-table.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).
