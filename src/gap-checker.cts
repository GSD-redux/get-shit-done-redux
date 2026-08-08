/**
 * Post-planning gap analysis (#2493).
 *
 * Reads REQUIREMENTS.md (planning-root) and CONTEXT.md (per-phase) and compares
 * each REQ-ID and D-ID against the concatenated text of all PLAN.md files in
 * the phase directory. Emits a unified `Source | Item | Status` report.
 *
 * Gated on workflow.post_planning_gaps (default true). When false, returns
 * { enabled: false } and does not scan.
 *
 * Coverage detection uses word-boundary regex matching to avoid false positives
 * (REQ-1 must not match REQ-10).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/gap-checker.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseId = require('./phase-id.cjs');
const { escapeRegex } = phaseId;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningDir, findContextMdIn } = planningWorkspace;
import { parseDecisions, extractDecisions } from './decisions.cjs';
import { iterateBullets } from './markdown-sectionizer.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReqItem {
  id: string;
  text: string;
}

interface RequirementItem extends ReqItem {
  source: string;
}

type DecisionItem = ReturnType<typeof parseDecisions>[number] & { source: string };

type Item = RequirementItem | DecisionItem;

interface CoverageRow {
  source: string;
  item: string;
  status: string;
}

interface GapCounts {
  total: number;
  covered: number;
  uncovered: number;
}

interface GapResult {
  enabled: boolean;
  rows: CoverageRow[];
  table: string;
  summary: string;
  counts: GapCounts;
}

interface RunGapAnalysisOptions {
  phaseReqIds?: string | null | undefined;
}

/**
 * Parse REQ-IDs from REQUIREMENTS.md content.
 *
 * Supports both checkbox (`- [ ] **REQ-NN** ...`) and traceability table
 * (`| REQ-NN | ... |`) formats.
 */
function parseRequirements(reqMd: unknown): ReqItem[] {
  if (!reqMd || typeof reqMd !== 'string') return [];
  const out: ReqItem[] = [];
  const seen = new Set<string>();

  // Prefix-agnostic ID format: REQ-01, TST-01, BACK-07, INSP-04, etc.
  const ID_PATTERN = '[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+';
  const idRe = new RegExp(`^(${ID_PATTERN})$`);

  // Checkbox-bullet path: migrate to seam's iterateBullets (checkbox markers).
  // The **ID** is extracted from the bullet text caller-side — the seam provides
  // the raw text; we parse the bold-ID prefix from it here.
  const boldIdRe = new RegExp(`^\\*\\*(${ID_PATTERN})\\*\\*\\s*(.*)$`);
  for (const bullet of iterateBullets(reqMd)) {
    if (bullet.marker !== 'checkbox-unchecked' && bullet.marker !== 'checkbox-checked') continue;
    const m = boldIdRe.exec(bullet.text);
    if (!m) continue;
    const id = m[1];
    if (!idRe.test(id)) continue;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, text: (m[2] || '').trim() });
    }
  }

  // Pipe-table-row path and separator-row skip stay caller-side
  // (table parsing is out of seam scope per ADR-1372 T3 spec).
  const tableFirstCellRe = new RegExp(`^\\s*\\|\\s*(${ID_PATTERN})\\s*\\|`);
  const separatorRowRe = /^\s*\|[\s:|-]+\|\s*$/;
  const lines = reqMd.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('|')) continue;

    // Skip markdown table separator rows and header rows immediately preceding them.
    if (separatorRowRe.test(line)) continue;
    if (i + 1 < lines.length && separatorRowRe.test(lines[i + 1])) continue;

    const tm = tableFirstCellRe.exec(line);
    if (!tm) continue;
    const id = tm[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, text: '' });
    }
  }

  return out;
}

function detectCoverage(items: Item[], planText: string): CoverageRow[] {
  return items.map(it => {
    const re = new RegExp('\\b' + escapeRegex(it.id) + '\\b');
    return {
      source: it.source,
      item: it.id,
      status: re.test(planText) ? 'Covered' : 'Not covered',
    };
  });
}

function naturalKey(s: unknown): string {
  return String(s).replace(/(\d+)/g, (_, n: string) => n.padStart(8, '0'));
}

function sortRows(rows: CoverageRow[]): CoverageRow[] {
  const sourceOrder: Record<string, number> = { 'REQUIREMENTS.md': 0, 'CONTEXT.md': 1 };
  return rows.slice().sort((a, b) => {
    const so = (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
    if (so !== 0) return so;
    return naturalKey(a.item).localeCompare(naturalKey(b.item));
  });
}

function formatGapTable(rows: CoverageRow[]): string {
  if (rows.length === 0) {
    return '## Post-Planning Gap Analysis\n\nNo requirements or decisions to check.\n';
  }
  const header = '| Source | Item | Status |\n|--------|------|--------|';
  const body = rows.map(r => {
    const tick = r.status === 'Covered' ? '✓ Covered'
      : r.status === 'Missing from REQUIREMENTS.md' ? '⚠ Missing from REQUIREMENTS.md'
      : '✗ Not covered';
    return `| ${r.source} | ${r.item} | ${tick} |`;
  }).join('\n');
  return `## Post-Planning Gap Analysis\n\n${header}\n${body}\n`;
}

function readGate(cwd: string): boolean {
  const cfgPath = path.join(planningDir(cwd), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && 'workflow' in raw) {
      const wf = (raw as Record<string, unknown>)['workflow'];
      if (wf && typeof wf === 'object' && 'post_planning_gaps' in wf) {
        const val = (wf as Record<string, unknown>)['post_planning_gaps'];
        if (typeof val === 'boolean') return val;
      }
    }
  } catch { /* fall through */ }
  return true;
}

/**
 * Same-prefix ascending numeric range, e.g. `SEL-01..SEL-03`. Both sides must
 * share an identical prefix and a numeric suffix. Captures are:
 *   1 low prefix, 2 low digits, 3 high prefix (compared to group 1 for equality), 4 high digits.
 */
const PHASE_REQ_RANGE_RE = /^(.+-)(\d+)\.\.(.+-)(\d+)$/;

/**
 * Maximum number of IDs a single range token may expand to. A range whose span
 * exceeds this cap stays literal (fail-closed) rather than expanding, guarding
 * against pathological input like `X-1..X-100000` ballooning the comparison set.
 */
const MAX_PHASE_REQ_RANGE = 1000;

/**
 * Expand a single `--phase-req-ids` token in place. If it is a valid ascending
 * same-prefix numeric range (`<PREFIX>-NN..<PREFIX>-MM`, identical prefix both
 * sides, numeric NN ≤ MM), return the individual IDs `<PREFIX>-NN … <PREFIX>-MM`
 * preserving the bounds' zero-pad width. Anything that does NOT cleanly match a
 * valid range stays literal (fail-closed) — returned as a single-element array.
 *
 * The two numeric bounds must share the same digit width; a range with
 * differing widths (e.g. `SEL-9..SEL-11`) is ambiguous (padding to the wider
 * width could invent IDs like `SEL-09` that never appear unpadded in
 * REQUIREMENTS) and is left literal. A range spanning more than
 * MAX_PHASE_REQ_RANGE IDs also stays literal.
 */
function expandPhaseReqIdToken(token: string): string[] {
  const m = PHASE_REQ_RANGE_RE.exec(token);
  if (!m) return [token];
  const [, prefixLow, lowDigits, prefixHigh, highDigits] = m;
  // Fail closed unless the prefixes are identical.
  if (prefixLow !== prefixHigh) return [token];
  // Fail closed unless the bounds share an identical digit width. Differing
  // widths are ambiguous: padding to the wider width could invent IDs that
  // never appear unpadded in REQUIREMENTS.
  if (lowDigits.length !== highDigits.length) return [token];
  const low = Number(lowDigits);
  const high = Number(highDigits);
  // Fail closed on descending ranges (NN > MM). NN == MM is a valid single-element range.
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return [token];
  // Fail closed (DoS guard) on ranges spanning more than the cap.
  if (high - low + 1 > MAX_PHASE_REQ_RANGE) return [token];
  // Preserve the bounds' (shared) zero-pad width.
  const width = lowDigits.length;
  const out: string[] = [];
  for (let n = low; n <= high; n++) {
    out.push(`${prefixLow}${String(n).padStart(width, '0')}`);
  }
  return out;
}

/**
 * Normalize a raw `--phase-req-ids` argument into the scoping signal used by
 * runGapAnalysis (#447). Mirrors §13's null/TBD skip semantics.
 *
 *   undefined                  → flag absent: compare the whole REQUIREMENTS.md (back-compat)
 *   null | '' | TBD            → no requirements mapped to this phase: skip the comparison
 *   "REQ-01,REQ-02"            → restrict the comparison to these IDs
 *   "SEL-01..SEL-03"           → range form: expands in place to SEL-01, SEL-02, SEL-03 (#1269)
 *
 * Range form (#1269): a list element of the shape `<PREFIX>-NN..<PREFIX>-MM`
 * (identical prefix both sides, identical bound digit width, ascending numeric
 * NN ≤ MM) is expanded in place to the individual IDs, preserving the bounds'
 * zero-pad width; mixed lists expand in input order. Any element that does not
 * cleanly match a valid ascending same-prefix numeric range (mismatched
 * prefix, differing bound width, descending, non-numeric, missing bound, or
 * spanning more than MAX_PHASE_REQ_RANGE IDs) stays literal — no partial
 * expansion, no guessing.
 *
 * Tolerates JSON-array-ish input (`["REQ-01","REQ-02"]`) since callers may pass
 * the roadmap value through verbatim.
 */
function normalizePhaseReqIds(rawVal: unknown): string[] | null | undefined {
  if (rawVal === undefined) return undefined;
  if (rawVal === null) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const v = String(rawVal).replace(/["'[\]()]/g, '').trim();
  if (v === '' || /^(null|tbd|none)$/i.test(v)) return null;
  // Tolerate comma-, space-, or newline-separated lists (callers may pass the
  // roadmap value verbatim, whose serialization is not guaranteed).
  const ids = v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  // Expand range tokens (#1269) per-token AFTER the split, preserving input order.
  const expanded = ids.flatMap(expandPhaseReqIdToken);
  return expanded.length === 0 ? null : expanded;
}

function runGapAnalysis(cwd: string, phaseDir: string, options: RunGapAnalysisOptions = {}): GapResult {
  const phaseReqIds = normalizePhaseReqIds(options.phaseReqIds);
  if (!readGate(cwd)) {
    return {
      enabled: false,
      rows: [],
      table: '',
      summary: 'workflow.post_planning_gaps disabled — skipping post-planning gap analysis',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }

  const absPhaseDir = path.isAbsolute(phaseDir) ? phaseDir : path.join(cwd, phaseDir);

  const reqPath = planningPaths(cwd).requirements;
  const reqMd = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : '';
  let reqItems: RequirementItem[] = parseRequirements(reqMd).map(r => ({ ...r, source: 'REQUIREMENTS.md' }));

  // Scope the requirements comparison to the phase's mapped REQ-IDs (#447).
  // A phase that maps no requirements (phase_req_ids null/TBD) must not report
  // every unrelated project REQ-ID as a gap — mirror §13's skip behavior.
  // CONTEXT.md decisions (below) are always in scope regardless.
  let ghostReqIds: string[] = [];
  if (phaseReqIds === null) {
    reqItems = [];
  } else if (Array.isArray(phaseReqIds)) {
    const wanted = new Set(phaseReqIds);
    const foundIds = new Set(reqItems.map(r => r.id));
    reqItems = reqItems.filter(r => wanted.has(r.id));
    ghostReqIds = phaseReqIds.filter(id => !foundIds.has(id));
  }

  // Read the phase directory once; reuse the listing for both context detection
  // and plan-file enumeration (avoids redundant readdirSync calls).
  let phaseDirFiles: string[] = [];
  try {
    if (fs.existsSync(absPhaseDir)) phaseDirFiles = fs.readdirSync(absPhaseDir);
  } catch { /* unreadable */ }

  const ctxFile = findContextMdIn(phaseDirFiles);
  const ctxPath = ctxFile ? path.join(absPhaseDir, ctxFile) : null;
  const ctxMd = ctxPath ? fs.readFileSync(ctxPath, 'utf-8') : '';

  // Use extractDecisions so gap-checker can distinguish could-not-parse from none-present.
  const ctxExtraction = extractDecisions(ctxMd);
  const dItems: DecisionItem[] = ctxExtraction.decisions.map(d => ({ ...d, source: 'CONTEXT.md' }));

  const items: Item[] = [...reqItems, ...dItems];

  let planText = '';
  try {
    if (phaseDirFiles.length > 0) {
      // #3183 (lint-plan-count-drift): source the live plan-file list from
      // the single owner (scanPhasePlans) instead of a local `-PLAN\.md$`
      // filter on the already-read listing — picks up bare PLAN.md, nested
      // plans/, and excludes superseded plans, none of which the prior
      // root-only exact-suffix filter did.
      const files = scanPhasePlans(absPhaseDir).planFiles;
      planText = files.map(f => {
        try { return fs.readFileSync(path.join(absPhaseDir, f), 'utf-8'); }
        catch { return ''; }
      }).join('\n');
    }
  } catch { /* unreadable */ }

  // FIX D (#1365): surface decision could-not-parse independently of whether
  // requirements items exist. Without this, a could-not-parse on decisions is
  // silently masked whenever REQUIREMENTS.md has ≥1 item — the mismatch must
  // appear in the report regardless of the requirements row count.
  if (ctxExtraction.outcome === 'could-not-parse') {
    const mismatchMsg = '## Post-Planning Gap Analysis\n\nextracted 0 of N — possible format mismatch in CONTEXT.md decisions block.\n';
    // If there are also requirement items, include them in the return with the
    // mismatch summary appended, so the caller still sees requirement coverage.
    // #2334 HIGH 1: gate on `ghostReqIds.length > 0` too — identical defect to
    // the one fixed at #2316-6b (~34 lines below, at the `items.length === 0`
    // early return): a phase whose EVERY cited REQ-ID is unregistered has
    // `items.length === 0` (all its requirement items were filtered out at
    // ~line 297) but still has real ghost rows to report. Without this guard,
    // a single malformed `<decisions>` line in CONTEXT.md made an all-ghost
    // phase's ghost rows silently vanish (this could-not-parse branch fell
    // through to the bare `mismatchMsg`-only return below, dropping ghost
    // rows that the general path further down correctly surfaces).
    if (items.length > 0 || ghostReqIds.length > 0) {
      const rows = sortRows([
        ...detectCoverage(items, planText),
        ...ghostReqIds.map(id => ({ source: 'REQUIREMENTS.md', item: id, status: 'Missing from REQUIREMENTS.md' })),
      ]);
      const covered = rows.filter(r => r.status === 'Covered').length;
      const uncovered = rows.length - covered;
      const coverageSummary = uncovered === 0
        ? `✓ All ${rows.length} items covered by plans`
        : `⚠ ${uncovered} of ${rows.length} items not covered by any plan`;
      return {
        enabled: true,
        rows,
        table: formatGapTable(rows) + '\n' + coverageSummary + '\n\n' + mismatchMsg,
        summary: coverageSummary + '; extracted 0 of N — possible format mismatch',
        counts: { total: rows.length, covered, uncovered },
      };
    }
    return {
      enabled: true,
      rows: [],
      table: mismatchMsg,
      summary: 'extracted 0 of N — possible format mismatch',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }

  // #1365: if no items at all, surface a clean no-check message.
  // #2316-6b: this must NOT fire when `ghostReqIds` is non-empty — a phase
  // whose EVERY cited REQ-ID is unregistered has `items.length === 0` (all
  // its requirement items were filtered out at ~line 297) but still has real
  // ghost rows to report below. Without this guard, an all-orphan phase
  // reported LESS than a partially-orphan one (which falls through to the
  // general path further down and correctly surfaces its ghost rows).
  if (items.length === 0 && ghostReqIds.length === 0) {
    return {
      enabled: true,
      rows: [],
      table: '## Post-Planning Gap Analysis\n\nNo requirements or decisions to check.\n',
      summary: 'no requirements or decisions to check',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }

  const rows = sortRows([
    ...detectCoverage(items, planText),
    ...ghostReqIds.map(id => ({ source: 'REQUIREMENTS.md', item: id, status: 'Missing from REQUIREMENTS.md' })),
  ]);
  const covered = rows.filter(r => r.status === 'Covered').length;
  const uncovered = rows.length - covered;

  const summary = uncovered === 0
    ? `✓ All ${rows.length} items covered by plans`
    : `⚠ ${uncovered} of ${rows.length} items not covered by any plan`;

  return {
    enabled: true,
    rows,
    table: formatGapTable(rows) + '\n' + summary + '\n',
    summary,
    counts: { total: rows.length, covered, uncovered },
  };
}

function cmdGapAnalysis(cwd: string, args: string[], raw: boolean): void {
  const idx = args.indexOf('--phase-dir');
  if (idx === -1 || !args[idx + 1]) {
    error('Usage: gap-analysis --phase-dir <path-to-phase-directory>');
  }
  const phaseDir = args[idx + 1];

  // Optional --phase-req-ids scopes the requirements comparison (#447).
  // Absent → compare the whole REQUIREMENTS.md (back-compat).
  const reqIdx = args.indexOf('--phase-req-ids');
  const phaseReqIds = reqIdx === -1 ? undefined : (args[reqIdx + 1] ?? '');

  const result = runGapAnalysis(cwd, phaseDir, { phaseReqIds });
  output(result, raw, result.table || result.summary);
}

export = {
  parseRequirements,
  detectCoverage,
  formatGapTable,
  sortRows,
  normalizePhaseReqIds,
  runGapAnalysis,
  cmdGapAnalysis,
};
