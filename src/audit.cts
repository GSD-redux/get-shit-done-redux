/**
 * Open Artifact Audit — Cross-type unresolved state scanner
 *
 * Scans all .planning/ artifact categories for items with open/unresolved state.
 * Returns structured JSON for workflow consumption.
 * Called by: gsd-tools.cjs audit-open
 * Used by: /gsd:complete-milestone pre-close gate
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/audit.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { platformReadSync } from './shell-command-projection.cjs';
import { collectSection } from './markdown-sectionizer.cjs';
import { splitLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { normalizeLineEndings } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, quickDirFrom, todosDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, spliceFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE, scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocator = require('./phase-locator.cjs');
const { getAllArchivedPhaseDirs } = phaseLocator;
import { requireSafePath, sanitizeForDisplay, sanitizeLabel } from './security.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error: ioError } = io;
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DebugSessionItem {
  slug: string;
  status: string;
  updated: string;
  hypothesis: string;
  scan_error?: boolean;
}

interface QuickTaskItem {
  slug: string;
  date: string;
  status: string;
  description: string;
  scan_error?: boolean;
}

interface ThreadItem {
  slug: string;
  status: string;
  updated: string;
  title: string;
  scan_error?: boolean;
}

interface TodoItem {
  filename: string;
  priority: string;
  area: string;
  summary: string;
  scan_error?: boolean;
  _remainder_count?: number;
}

interface SeedItem {
  seed_id: string;
  slug: string;
  status: string;
  title: string;
  scan_error?: boolean;
}

interface UatGapItem {
  phase: string;
  file: string;
  status: string;
  open_scenario_count: number;
  scan_error?: boolean;
  archived_milestone?: string;
}

interface VerificationGapItem {
  phase: string;
  file: string;
  status: string;
  scan_error?: boolean;
  archived_milestone?: string;
}

interface ContextQuestionItem {
  phase: string;
  file: string;
  question_count: number;
  questions: string[];
  scan_error?: boolean;
  archived_milestone?: string;
}

interface DeferredItem {
  phase: string;
  file: string;
  text: string;
  scan_error?: boolean;
  archived_milestone?: string;
}

/**
 * Minimal structural view of `uat.cjs` — only the export `scanDeferredItems`
 * lazily requires. Mirrors the local-interface convention in
 * `audit-command-router.cts`, which types its lazy requires the same way.
 */
interface UatDeferredModule {
  parseDeferredItems(content: string): Array<{ name: string }>;
  /**
   * #3458 follow-up: like `parseDeferredItems`, but returns EVERY entry
   * (including `status: resolved` ones) together with its raw, unlowercased
   * `status:` field value (`''` when absent) so a caller can distinguish
   * "resolved" (fixed for real — never counted) from the new "acknowledged"
   * (suppressed-but-tallied) from anything else (open). `parseDeferredItems`
   * itself is defined in terms of this — see uat.cts — so the two can never
   * drift on what an entry's text/boundaries are.
   */
  parseDeferredItemsWithStatus(content: string): Array<{ name: string; status: string }>;
  /**
   * Writer half of the #3458 follow-up seam (A4): sets a matched deferred
   * entry's `status:` field to `acknowledged` in place, verdict-preserving
   * (never touches an entry already `status: resolved`) and scoped to the
   * BULLET-only (headless) `## Deferred Items` shape — see the doc comment on
   * the implementation in uat.cts for why the heading-delimited (#3457) shape
   * is refused rather than attempted.
   */
  acknowledgeDeferredItem(content: string, targetText: string): AcknowledgeDeferredItemResult;
}

/** Result of `UatDeferredModule.acknowledgeDeferredItem`. */
interface AcknowledgeDeferredItemResult {
  content: string;
  status: 'ok' | 'not_found' | 'ambiguous' | 'unsupported_heading_shape' | 'already_resolved' | 'match_verification_failed';
}

/**
 * A scanner's items PLUS how many otherwise-open items it suppressed via a
 * current `audit_acknowledged` marker (#3458 follow-up, A5). Every
 * phase-scoped and flat scanner returns this shape now instead of a bare
 * array, so `auditOpenArtifacts` can report both halves without a second
 * scan pass.
 */
interface ScanOutcome<T> {
  items: T[];
  acknowledged: number;
}

interface AuditCounts {
  debug_sessions: number;
  quick_tasks: number;
  threads: number;
  todos: number;
  seeds: number;
  uat_gaps: number;
  verification_gaps: number;
  context_questions: number;
  deferred_items: number;
  total: number;
}

interface AuditResult {
  scanned_at: string;
  has_open_items: boolean;
  counts: AuditCounts;
  /**
   * Per-category count of items SUPPRESSED by a current (non-stale)
   * `audit_acknowledged` marker (#3458 follow-up, design point A5) — mirrors
   * `counts`'s shape exactly. A suppressed item never appears in `counts` or
   * `items`; this is the only place it is still observable, so a reviewer can
   * tell "clean because fixed" apart from "clean because silenced".
   */
  acknowledged: AuditCounts;
  items: {
    debug_sessions: DebugSessionItem[];
    quick_tasks: QuickTaskItem[];
    threads: ThreadItem[];
    todos: TodoItem[];
    seeds: SeedItem[];
    uat_gaps: UatGapItem[];
    verification_gaps: VerificationGapItem[];
    context_questions: ContextQuestionItem[];
    deferred_items: DeferredItem[];
  };
}

// The SCOPE BOUNDARY convention's filename (`agents/gsd-executor.md`), shared
// verbatim with the #2287 phase-boundary reader in `uat.cts`.
const DEFERRED_ITEMS_FILENAME = 'deferred-items.md';

// Terminal UAT states: `complete` (legacy) and `resolved` (post-gap-closure
// per workflows/execute-phase.md). Hoisted outside scanUatGaps so the Set is
// not recreated on each loop iteration.
const TERMINAL_UAT_STATUSES = new Set(['complete', 'resolved']);

// ─── Acknowledgment marker (suppression) ──────────────────────────────────────
//
// #3458 follow-up: `query audit-open` now scans archived milestone phase dirs,
// so an item still unresolved when a milestone closed resurfaces at EVERY
// later close, forever — `[A] Acknowledge all` documented that decision to
// STATE.md but never suppressed it. This section is the suppression seam.
//
// The marker lives INSIDE the artifact it suppresses, as an
// `audit_acknowledged` frontmatter map (no ledger, no id minting — see
// `uat.cts:891-897`'s `deferred-items.md` in-place `status: resolved`
// convention, which this generalizes):
//
//   audit_acknowledged:
//     milestone: v1.0        # which milestone close acknowledged it
//     at: 2026-08-15          # ISO date
//     status: gaps_found      # snapshot of the artifact's state AT acknowledgment
//                              # (named `gap_snapshot` — status + open-scenario
//                              # count — for `uat_gaps`, and `questions_digest`
//                              # — a content hash of the question set, not just
//                              # its count — for `context_questions`; see
//                              # `isAuditItemAcknowledged`'s `snapshotKey` param
//                              # and each category's `deriveXxx` snapshot
//                              # helper for why a bare status/count was not
//                              # enough for those two — #3458 follow-up review)
//
// It is VERDICT-PRESERVING (this section never writes `status:` itself — see
// `cmdAuditAcknowledge` below) and SELF-INVALIDATING: it suppresses ONLY while
// `snapshotKey`'s recorded value still equals the artifact's CURRENT
// effective value. Edit the artifact after acknowledging it and the item
// resurfaces automatically — no separate revive/carry-forward state, and a
// stale acknowledgment can never hide a NEW problem, PROVIDED the category's
// snapshot actually captures the dimension that changed — `uat_gaps` and
// `context_questions` snapshot more than their status/count for exactly this
// reason (see above); every other category's only tracked dimension IS its
// `status:` (or, for `todos`, presence), so a bare status/presence snapshot
// is already complete for those.
//
// `isAuditItemAcknowledged` is the ONE shared predicate every scanner below
// routes through — this file has already been through the "hand-rolled the
// same check nine times" defect family twice this PR; a tenth hand-roll here
// is exactly that class. `deferred_items` is the deliberate exception: its
// suppression key lives PER-ENTRY inside `deferred-items.md`'s own
// `status:` field (see `uat.cts`'s `parseDeferredItemsWithStatus`), not in a
// file-level `audit_acknowledged` map, because a single deferred-items.md can
// carry many independently-acknowledgeable entries.

/**
 * Parse and validate an artifact's `audit_acknowledged` frontmatter marker,
 * then decide whether it suppresses the item given the artifact's CURRENT
 * effective state.
 *
 * `snapshotKey` names which sub-field of the marker map carries the snapshot
 * comparison value (`'status'` for every category except CONTEXT files, which
 * use `'question_count'`). `presenceOnly: true` (used only for `todos`, which
 * has no natural status field to snapshot) skips the snapshot comparison
 * entirely — marker PRESENCE alone suppresses.
 *
 * A marker that is not a plain object/map, or is missing a non-empty string
 * `milestone`/`at`, or — when a snapshot comparison applies — missing a
 * string at `snapshotKey`, is MALFORMED and treated as ABSENT: this function
 * returns `false` and the item surfaces. A bad marker must never suppress.
 */
function isAuditItemAcknowledged(
  fm: Record<string, unknown>,
  opts: { snapshotKey: string; currentValue: string; presenceOnly?: boolean },
): boolean {
  const raw = fm.audit_acknowledged;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const marker = raw as Record<string, unknown>;
  if (typeof marker.milestone !== 'string' || !marker.milestone) return false;
  if (typeof marker.at !== 'string' || !marker.at) return false;
  if (opts.presenceOnly) return true;
  const snapshot = marker[opts.snapshotKey];
  if (typeof snapshot !== 'string') return false;
  return snapshot === opts.currentValue;
}

/**
 * Derive a THREAD file's effective status: frontmatter `status:` when
 * present, else the `## Status: OPEN|IN PROGRESS` body fallback — the same
 * two-step derivation `scanThreads` already performed inline. Extracted so
 * `cmdAuditAcknowledge` computes the CURRENT snapshot value with the exact
 * same logic the scanner used to produce the marker's recorded value,
 * instead of a second hand-derivation that could silently drift from it.
 */
function deriveThreadStatus(fm: Record<string, unknown>, content: string): string {
  let status = ((fm.status as string) || '').toLowerCase().trim();
  if (!status) {
    const bodyStatusMatch = content.match(/##\s*Status:\s*(OPEN|IN PROGRESS|IN_PROGRESS)/i);
    if (bodyStatusMatch) {
      status = bodyStatusMatch[1].toLowerCase().replace(/ /g, '_');
    }
  }
  return status;
}

/**
 * Count a UAT file's still-open (`result: pending`/`[pending]`) scenarios.
 * Extracted from `scanUatGaps`'s inline logic for the same reason as
 * `deriveThreadStatus` — one derivation, shared by the scanner and
 * `cmdAuditAcknowledge`'s `deriveUatGapSnapshotValue` below.
 */
function deriveUatGapOpenScenarioCount(content: string): number {
  return (content.match(/result:\s*(?:pending|\[pending\])/gi) || []).length;
}

/**
 * Stable snapshot value for a `uat_gaps` item (WARNING 2, #3458 follow-up
 * review). `status` alone is COUNT-blind the other direction: a UAT file can
 * stay in the SAME open status (`gaps_found`) while gaining MORE pending
 * scenarios (measured: 1→6 pending, status unchanged, item stayed
 * suppressed under the old status-only scheme). Composing `status` with the
 * open-scenario count means either dimension changing invalidates the
 * snapshot.
 */
function deriveUatGapSnapshotValue(status: string, content: string): string {
  return `${status}::scenarios=${deriveUatGapOpenScenarioCount(content)}`;
}

/**
 * Derive a CONTEXT file's FULL, UNTRUNCATED open-questions list: the
 * structured `open_questions` frontmatter array when present and
 * non-empty, else EVERY qualifying line of the `## Open Questions` body
 * section. Extracted from `scanContextQuestions`'s inline logic for the same
 * reason as `deriveThreadStatus` — one derivation, shared by the scanner and
 * `cmdAuditAcknowledge`, so the acknowledged `question_count`/digest snapshot
 * can never diverge from what the scanner counts.
 *
 * F2 (#3458 follow-up review, sibling of the deferred_items span-carrying
 * fix): this used to `slice(0, 3)` the body-section list AND clamp each
 * question to 200 chars BEFORE returning — a value meant for DISPLAY reused
 * for the IDENTITY snapshot `deriveOpenQuestionsDigest` hashes. A 4th+
 * question, or anything past char 200 of an earlier one, was invisible to
 * the digest: an attacker could ship 3 innocuous questions first, then add
 * real blockers afterward with zero effect on the recorded snapshot. Every
 * caller that wants a bounded list for DISPLAY (`scanContextQuestions`'s
 * `questions` field) truncates its OWN copy at the call site; this function
 * always returns the complete, unclamped set.
 */
function deriveOpenQuestions(content: string, fm: Record<string, unknown>): string[] {
  let questions: string[] = [];
  if (fm.open_questions) {
    if (Array.isArray(fm.open_questions) && fm.open_questions.length > 0) {
      questions = (fm.open_questions as unknown[]).map(q => sanitizeForDisplay(String(q)));
    }
  }

  if (questions.length === 0) {
    const oqSection = collectSection(content, (h) => h.level === 2 && h.text.trim().toLowerCase().startsWith('open questions'), { levelBounded: true });
    if (oqSection) {
      const oqBody = oqSection.body.trim();
      if (oqBody && oqBody.length > 0 && !/^\s*none\s*$/i.test(oqBody)) {
        const items = oqBody.split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => l && l !== '-' && l !== '*')
          .filter((l: string) => /^[-*\d]/.test(l) || l.includes('?'));
        questions = items.map((q: string) => sanitizeForDisplay(q));
      }
    }
  }

  return questions;
}

/** Bound a question's DISPLAY text (never fed into the identity digest — see `deriveOpenQuestions`'s doc comment). */
function truncateQuestionForDisplay(question: string): string {
  return question.slice(0, 200);
}

/**
 * Stable normalized digest of a CONTEXT file's open-questions set (WARNING 2,
 * #3458 follow-up review). `question_count` alone is COUNT-only: replacing
 * every question's TEXT with brand-new ones while holding the count steady
 * left an acknowledged item permanently suppressed (measured: 2 questions
 * acknowledged, then both replaced with unrelated new blockers — still
 * `counts:0`). Hashing the full, ordered question text means ANY edit —
 * add, remove, reword, or reorder — changes the digest and the item
 * resurfaces. sha256 (not the raw joined string) keeps the marker's stored
 * value bounded regardless of question length/count.
 *
 * `questions` MUST be the untruncated, unclamped set `deriveOpenQuestions`
 * returns — never a display-sliced/-clamped copy (F2, #3458 follow-up
 * review); a truncated input reintroduces exactly the blind spot this digest
 * exists to close.
 *
 * Length-prefixed, separator-free encoding (SWEEP finding, #3458 follow-up
 * review) — NOT a plain join (the prior revision joined on a literal
 * embedded NUL byte, `questions.join('\\0')` written as a raw control
 * character in the SOURCE FILE itself — invisible in a normal diff/editor
 * and still forgeable: attacker-controlled markdown CAN contain a literal
 * NUL codepoint, since the file is read as UTF-8 text, so that scheme never
 * actually closed the boundary-collision gap it was reaching for). A bare
 * separator-joined string has no reliably unambiguous element boundary: two
 * DIFFERENT question arrays can render the identical joined string and
 * collide on the same digest — e.g. `['- Is X ready?', '- Y done?']` and
 * `['- Is X ready? - Y', 'done?']` both join to
 * `'- Is X ready? - Y done?'` under a space-join, and both could be forced to
 * collide under a NUL-join too by an attacker who embeds the separator
 * itself. Prefixing each element with its own CHARACTER LENGTH
 * (`<len>:<text>`, concatenated with no separator at all) makes the encoding
 * self-delimiting instead: decoding always consumes exactly `<len>`
 * characters after each `:` before reading the next length prefix, so no two
 * distinct arrays can ever encode to the same string — regardless of what
 * characters the questions themselves contain.
 */
function deriveOpenQuestionsDigest(questions: string[]): string {
  const encoded = questions.map((q) => `${q.length}:${q}`).join('');
  return crypto.createHash('sha256').update(encoded).digest('hex');
}

// ─── scanDebugSessions ────────────────────────────────────────────────────────

/**
 * Scan .planning/debug/ for open sessions.
 * Open = status NOT in ['resolved', 'complete'].
 * Ignores the resolved/ subdirectory.
 */
function scanDebugSessions(planDir: string): ScanOutcome<DebugSessionItem> {
  const debugDir = path.join(planDir, 'debug');
  if (!fs.existsSync(debugDir)) return { items: [], acknowledged: 0 };

  const results: DebugSessionItem[] = [];
  let acknowledged = 0;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(debugDir, { withFileTypes: true });
  } catch {
    return { items: [{ scan_error: true, slug: '', status: '', updated: '', hypothesis: '' }], acknowledged: 0 };
  }

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;

    const filePath = path.join(debugDir, entry.name);

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(filePath, planDir, 'debug session file', { allowAbsolute: true });
    } catch {
      continue;
    }

    // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
    // document at this read boundary, same seam as `src/uat.cts`'s
    // `readNormalizedDocument` — `platformReadSync` performs no line-ending
    // normalization itself, and extractFrontmatter/status-derivation below
    // degrade a lone-CR file's frontmatter to `unknown`, which every scan
    // in this module treats as "not open" (fail-open, the permissive
    // direction) rather than a real parse gap.
    const rawContent = platformReadSync(safeFilePath);
    if (rawContent === null) continue;
    const content = normalizeLineEndings(rawContent);

    const fm = extractFrontmatter(content, safeFilePath);
    const status = ((fm.status as string) || 'unknown').toLowerCase();
    if (status === 'resolved' || status === 'complete') continue;

    if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
      acknowledged++;
      continue;
    }

    // Extract hypothesis from "Current Focus" block if parseable
    let hypothesis = '';
    const focusSection = collectSection(content, (h) => h.level === 2 && h.text.trim().toLowerCase().startsWith('current focus'), { levelBounded: true });
    if (focusSection) {
      const focusText = focusSection.body.trim().split('\n')[0].trim();
      hypothesis = sanitizeForDisplay(focusText.slice(0, 100));
    }

    const slug = path.basename(entry.name, '.md');
    results.push({
      slug: sanitizeLabel(slug),
      status: sanitizeForDisplay(status),
      updated: sanitizeForDisplay(fm.updated || fm.date || ''),
      hypothesis,
    });
  }

  return { items: results, acknowledged };
}

// ─── resolveQuickTaskSummaryFile ───────────────────────────────────────────────

/**
 * Resolve a quick task's SUMMARY file, if any exists, under its own
 * directory (`taskDir`). workflows/quick.md mandates `${quick_id}-SUMMARY.md`;
 * older flows used bare `SUMMARY.md` — accept either to avoid a
 * false-positive "missing", preferring the per-task `${dirName}-SUMMARY.md`
 * form when more than one candidate exists.
 *
 * #3183 (ADR-3180 Decision 4(a) — bucket B, out of scope for the
 * scanPhasePlans migration): this scans a quick task's OWN directory
 * (`.planning/quick/<task>/`) for THAT task's single completion record —
 * "does this one quick task have a SUMMARY.md" — not a phase directory's
 * live-plan/summary counting question. scanPhasePlans is the wrong tool
 * here; there is no plan/summary PAIRING to derive, only a single filename
 * presence check local to a non-phase directory.
 *
 * Extracted (#3458 follow-up) so `scanQuickTasks` (read) and
 * `cmdAuditAcknowledge`'s quick_tasks writer share the ONE discovery rule —
 * previously the writer would have had to hand-roll this exact filter a
 * second time, which is exactly the re-derivation-drift class
 * `scripts/lint-plan-count-drift.cjs` exists to catch (see its
 * `FUNCTION_SCOPED_EXEMPTIONS` entry for this function).
 *
 * Returns `null` (never throws) on an unreadable `taskDir` or when no
 * SUMMARY-shaped file exists.
 */
function resolveQuickTaskSummaryFile(taskDir: string, dirName: string): string | null {
  let summaryFiles: fs.Dirent[];
  try {
    summaryFiles = fs.readdirSync(taskDir, { withFileTypes: true })
      .filter(e => e.isFile() && (e.name === 'SUMMARY.md' || e.name.endsWith('-SUMMARY.md')));
  } catch {
    return null;
  }
  if (summaryFiles.length === 0) return null;
  const preferred = summaryFiles.find(e => e.name === `${dirName}-SUMMARY.md`)
    || summaryFiles.find(e => e.name.endsWith('-SUMMARY.md'))
    || summaryFiles[0];
  return path.join(taskDir, preferred.name);
}

// ─── scanQuickTasks ───────────────────────────────────────────────────────────

/**
 * Scan .planning/quick/ for incomplete tasks.
 * Incomplete if SUMMARY.md missing or status !== 'complete'.
 */
function scanQuickTasks(planDir: string): ScanOutcome<QuickTaskItem> {
  // #2142: routed through the shared quickDirFrom composer (planning-workspace.cts)
  // so `.planning/quick` has exactly ONE owner instead of two ad-hoc path.joins.
  const quickDir = quickDirFrom(planDir);
  if (!fs.existsSync(quickDir)) return { items: [], acknowledged: 0 };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(quickDir, { withFileTypes: true });
  } catch {
    return { items: [{ scan_error: true, slug: '', date: '', status: '', description: '' }], acknowledged: 0 };
  }

  const results: QuickTaskItem[] = [];
  let acknowledged = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirName = entry.name;
    const taskDir = path.join(quickDir, dirName);

    let safeTaskDir: string;
    try {
      safeTaskDir = requireSafePath(taskDir, planDir, 'quick task dir', { allowAbsolute: true });
    } catch {
      continue;
    }

    const summaryPath = resolveQuickTaskSummaryFile(safeTaskDir, dirName);

    let status = 'missing';
    const description = '';
    let fm: Record<string, unknown> | null = null;

    if (summaryPath && fs.existsSync(summaryPath)) {
      let safeSum: string;
      try {
        safeSum = requireSafePath(summaryPath, planDir, 'quick task summary', { allowAbsolute: true });
      } catch {
        continue;
      }
      // #3078-CR MEDIUM 2: same normalize-at-read-boundary fix as the other
      // scans in this module — see the comment above `scanDebugSessions`'s
      // read.
      const rawContent = platformReadSync(safeSum);
      if (rawContent === null) {
        status = 'unreadable';
      } else {
        const content = normalizeLineEndings(rawContent);
        fm = extractFrontmatter(content, safeSum);
        status = ((fm.status as string) || 'unknown').toLowerCase();
      }
    }

    if (status === 'complete') continue;

    // Acknowledgment marker only ever lives in the SUMMARY file's own
    // frontmatter — a task with no summary (status: 'missing') has nowhere to
    // carry one, so `fm` is null and this is skipped (never suppressed).
    if (fm && isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
      acknowledged++;
      continue;
    }

    // Parse date and slug from directory name: YYYYMMDD-slug or YYYY-MM-DD-slug
    let date = '';
    let slug = sanitizeLabel(dirName);
    const dateMatch = dirName.match(/^(\d{4}-?\d{2}-?\d{2})-(.+)$/);
    if (dateMatch) {
      // dateMatch[1] is regex-constrained to `\d{4}-?\d{2}-?\d{2}` (digits and
      // literal hyphens only — the same "constrained at the source" shape as
      // `archived_milestone`), so it cannot itself carry a control byte.
      // Still routed through sanitizeLabel as defense-in-depth for
      // consistency with every other directory-name-derived field here.
      date = sanitizeLabel(dateMatch[1]);
      slug = sanitizeLabel(dateMatch[2]);
    }

    results.push({
      slug,
      date,
      status: sanitizeForDisplay(status),
      description,
    });
  }

  return { items: results, acknowledged };
}

// ─── scanThreads ──────────────────────────────────────────────────────────────

/**
 * Scan .planning/threads/ for open threads.
 * Open if status in ['open', 'in_progress', 'in progress'] (case-insensitive).
 */
function scanThreads(planDir: string): ScanOutcome<ThreadItem> {
  const threadsDir = path.join(planDir, 'threads');
  if (!fs.existsSync(threadsDir)) return { items: [], acknowledged: 0 };

  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(threadsDir, { withFileTypes: true });
  } catch {
    return { items: [{ scan_error: true, slug: '', status: '', updated: '', title: '' }], acknowledged: 0 };
  }

  const openStatuses = new Set(['open', 'in_progress', 'in progress']);
  const results: ThreadItem[] = [];
  let acknowledged = 0;

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;

    const filePath = path.join(threadsDir, entry.name);

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(filePath, planDir, 'thread file', { allowAbsolute: true });
    } catch {
      continue;
    }

    // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
    // document at this read boundary, same seam as `src/uat.cts`'s
    // `readNormalizedDocument` — `platformReadSync` performs no line-ending
    // normalization itself, and extractFrontmatter/status-derivation below
    // degrade a lone-CR file's frontmatter to `unknown`, which every scan
    // in this module treats as "not open" (fail-open, the permissive
    // direction) rather than a real parse gap.
    const rawContent = platformReadSync(safeFilePath);
    if (rawContent === null) continue;
    const content = normalizeLineEndings(rawContent);

    const fm = extractFrontmatter(content, safeFilePath);
    const status = deriveThreadStatus(fm, content);

    if (!openStatuses.has(status)) continue;

    if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
      acknowledged++;
      continue;
    }

    // Extract title from # Thread: heading or frontmatter title
    let title = sanitizeForDisplay(fm.title || '');
    if (!title) {
      const headingMatch = content.match(/^#\s*Thread:\s*(.+)$/m);
      if (headingMatch) {
        title = sanitizeForDisplay(headingMatch[1].trim().slice(0, 100));
      }
    }

    const slug = path.basename(entry.name, '.md');
    results.push({
      slug: sanitizeLabel(slug),
      status: sanitizeForDisplay(status),
      updated: sanitizeForDisplay(fm.updated || fm.date || ''),
      title,
    });
  }

  return { items: results, acknowledged };
}

// ─── scanTodos ────────────────────────────────────────────────────────────────

/**
 * Scan .planning/todos/pending/ for pending todos.
 * Returns array of { filename, priority, area, summary }.
 * Display limited to first 5 + count of remainder.
 *
 * #4256: takes the ROOT-scoped todos base (`todosDir(cwd)`), NOT the
 * workstream-scoped planning dir the other scans use — todos are shared
 * project state (the migrateToWorkstreams contract keeps them at
 * .planning/todos/), so the close gate must read the root or it clears
 * vacuously under a workstream. The requireSafePath boundary below moves
 * with the base.
 */
function scanTodos(todosBase: string): ScanOutcome<TodoItem> {
  const pendingDir = path.join(todosBase, 'pending');
  if (!fs.existsSync(pendingDir)) return { items: [], acknowledged: 0 };

  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(pendingDir, { withFileTypes: true });
  } catch {
    return { items: [{ scan_error: true, filename: '', priority: '', area: '', summary: '' }], acknowledged: 0 };
  }

  const mdFiles = files.filter(e => e.isFile() && e.name.endsWith('.md'));
  const results: TodoItem[] = [];
  let acknowledged = 0;

  // BLOCKER 2 (#3458 follow-up review): filter acknowledged items BEFORE
  // the display cap. Capping the RAW file list to 5 first meant an
  // acknowledge of one of those 5 files simply revealed the 6th on the next
  // scan — files 6/7/... (never shown, never acknowledgeable via the CLI's
  // own remedy) permanently vanished from every later scan once 5+ items
  // existed, because `mdFiles.length` (not the post-filter open count) drove
  // both the cap and the remainder count. Read every file's acknowledgment
  // state first, THEN cap the OPEN (unacknowledged) set for display.
  const openFiles: { entry: fs.Dirent; content: string; fm: Record<string, unknown> }[] = [];
  for (const entry of mdFiles) {
    const filePath = path.join(pendingDir, entry.name);

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(filePath, todosBase, 'todo file', { allowAbsolute: true });
    } catch {
      continue;
    }

    // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
    // document at this read boundary, same seam as `src/uat.cts`'s
    // `readNormalizedDocument` — `platformReadSync` performs no line-ending
    // normalization itself, and extractFrontmatter/status-derivation below
    // degrade a lone-CR file's frontmatter to `unknown`, which every scan
    // in this module treats as "not open" (fail-open, the permissive
    // direction) rather than a real parse gap.
    const rawContent = platformReadSync(safeFilePath);
    if (rawContent === null) continue;
    const content = normalizeLineEndings(rawContent);

    const fm = extractFrontmatter(content, safeFilePath);

    // Todos carry no natural status field — presence in pending/ IS "open" by
    // definition (a resolved todo is moved out, not status-flagged). So the
    // acknowledgment check here is PRESENCE-ONLY: no snapshot to go stale, no
    // self-invalidation on edit — see `isAuditItemAcknowledged`'s doc comment.
    if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: '', presenceOnly: true })) {
      acknowledged++;
      continue;
    }

    openFiles.push({ entry, content, fm });
  }

  const displayFiles = openFiles.slice(0, 5);
  for (const { entry, content, fm } of displayFiles) {
    // Extract first line of body after frontmatter
    const bodyMatch = content.replace(/^---[\s\S]*?---\r?\n?/, '');
    const firstLine = splitLines(bodyMatch.trim())[0] || '';
    const summary = sanitizeForDisplay(firstLine.slice(0, 100));

    results.push({
      filename: sanitizeLabel(entry.name),
      priority: sanitizeForDisplay(fm.priority || ''),
      area: sanitizeForDisplay(fm.area || ''),
      summary,
    });
  }

  if (openFiles.length > 5) {
    results.push({ _remainder_count: openFiles.length - 5, filename: '', priority: '', area: '', summary: '' });
  }

  return { items: results, acknowledged };
}

// ─── scanSeeds ────────────────────────────────────────────────────────────────

/**
 * Scan .planning/seeds/SEED-*.md for unimplemented seeds.
 * Unimplemented if status in ['dormant', 'active', 'triggered'].
 */
function scanSeeds(planDir: string): ScanOutcome<SeedItem> {
  const seedsDir = path.join(planDir, 'seeds');
  if (!fs.existsSync(seedsDir)) return { items: [], acknowledged: 0 };

  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(seedsDir, { withFileTypes: true });
  } catch {
    return { items: [{ scan_error: true, seed_id: '', slug: '', status: '', title: '' }], acknowledged: 0 };
  }

  const unimplementedStatuses = new Set(['dormant', 'active', 'triggered']);
  const results: SeedItem[] = [];
  let acknowledged = 0;

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('SEED-') || !entry.name.endsWith('.md')) continue;

    const filePath = path.join(seedsDir, entry.name);

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(filePath, planDir, 'seed file', { allowAbsolute: true });
    } catch {
      continue;
    }

    // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
    // document at this read boundary, same seam as `src/uat.cts`'s
    // `readNormalizedDocument` — `platformReadSync` performs no line-ending
    // normalization itself, and extractFrontmatter/status-derivation below
    // degrade a lone-CR file's frontmatter to `unknown`, which every scan
    // in this module treats as "not open" (fail-open, the permissive
    // direction) rather than a real parse gap.
    const rawContent = platformReadSync(safeFilePath);
    if (rawContent === null) continue;
    const content = normalizeLineEndings(rawContent);

    const fm = extractFrontmatter(content, safeFilePath);
    const status = ((fm.status as string) || 'dormant').toLowerCase();

    if (!unimplementedStatuses.has(status)) continue;

    if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
      acknowledged++;
      continue;
    }

    // Extract seed_id from filename or frontmatter. The regex match is
    // `\w`/hyphen-constrained (safe by construction, like `archived_milestone`)
    // but the fallback taken when a filename doesn't fully match — e.g. a
    // `SEED-`-prefixed, `.md`-suffixed name with a control byte SOMEWHERE in
    // the middle, which still passes the `startsWith`/`endsWith` filter above
    // — is the raw, unconstrained basename. Both branches are routed through
    // sanitizeLabel below.
    const seedIdMatch = entry.name.match(/^(SEED-[\w-]+)\.md$/);
    const seed_id = seedIdMatch ? seedIdMatch[1] : path.basename(entry.name, '.md');
    const slug = sanitizeLabel(seed_id.replace(/^SEED-/, ''));

    let title = sanitizeForDisplay(fm.title || '');
    if (!title) {
      const headingMatch = content.match(/^#\s*(.+)$/m);
      if (headingMatch) title = sanitizeForDisplay(headingMatch[1].trim().slice(0, 100));
    }

    results.push({
      seed_id: sanitizeLabel(seed_id),
      slug,
      status: sanitizeForDisplay(status),
      title,
    });
  }

  return { items: results, acknowledged };
}

// ─── listAuditPhaseTargets ────────────────────────────────────────────────────

interface AuditPhaseTarget {
  dir: string;
  fullPath: string;
  milestone?: string;
}

/**
 * Enumerate phase directories across BOTH the active `.planning/phases/` root
 * and every archived `.planning/milestones/vX.Y-phases/` root. Shared by the
 * four phase-scoped scanners below (#3458 — epic #3473 B2/F2). Previously each
 * scanner hand-rolled its own active-only `readdirSync(phasesDir)` walk and
 * bailed out entirely when the active root was missing, so items still
 * unresolved when a milestone closed and its phase dirs archived became
 * permanently invisible to every later audit.
 *
 * ACTIVE dirs: raw readdirSync + isDirectory filter + sort. The enumeration
 * walk itself (readdirSync + isDirectory filter + sort) is UNCHANGED from the
 * scanners' prior inline behavior; what IS new is that a failed read here no
 * longer aborts the whole scan the way each scanner's own inline
 * `if (!fs.existsSync) return []` / try-readdirSync-catch-return-sentinel
 * pair used to — see `activeUnreadable` below, which is how that signal is
 * now surfaced to callers instead. Deliberately NOT routed through
 * listMilestonePhaseDirs: these scanners are deliberately not
 * milestone-filtered today, and switching would silently add window/sentinel
 * filtering — a behavior change belonging to #3372, not here.
 *
 * A missing/unreadable active root does NOT short-circuit the archive walk —
 * the old `if (!fs.existsSync(phasesDir)) return []` was the whole bug in a
 * fully-archived project; it degrades to "skip the active half" only. An
 * UNREADABLE (as opposed to merely absent) active root is reported back via
 * `activeUnreadable: true` so each of the four callers can still emit the
 * `scan_error` sentinel they emitted pre-#3458 for this exact case (a real
 * I/O failure, not "verified clean") — see each scanner's own use of it.
 *
 * ARCHIVED dirs: sourced from `getArchivedPhaseDirs` (phase-locator.cjs), the
 * canonical archive-enumeration seam `uat.cts`'s `cmdAuditUat` already uses.
 * Archived dirs are deliberately NOT milestone-filtered either — see the
 * comment at src/uat.cts:107-111: listMilestonePhaseDirs derives the CURRENT
 * milestone's phase dirs (window + sentinel filtered) from ROADMAP.md, and
 * archived phases belong to past milestones by definition, so filtering them
 * discards every one and silently reinstates the bug this function fixes.
 *
 * An unreadable/unresolvable ARCHIVE root does NOT get its own sentinel.
 * Pre-#3458 there was no archived read at all, so — unlike the active root —
 * there is no prior `scan_error` contract to preserve here, and no existing
 * consumer can regress. It also degrades the same way `listArchiveVersionDirs`
 * (phase-locator.cts) already treats an absent `milestones/` dir: a real
 * empty, not a failure, matching this function's existing "skip that root"
 * idiom for the missing-active-dir case above. Adding a second sentinel path
 * would let a machine consumer conflate "no milestones archived yet" (the
 * overwhelmingly common case for an active project) with an actual read
 * failure, which is a worse signal-to-noise trade than the one this
 * function's own fix removes for the active root.
 *
 * Same-named dirs in both roots (e.g. "01-alpha" active AND archived) are
 * DISTINCT targets — no dedupe.
 */
function listAuditPhaseTargets(planDir: string, cwd: string): { targets: AuditPhaseTarget[]; activeUnreadable: boolean } {
  const targets: AuditPhaseTarget[] = [];
  let activeUnreadable = false;

  const phasesDir = path.join(planDir, 'phases');
  if (fs.existsSync(phasesDir)) {
    try {
      const dirs = fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      for (const dir of dirs) {
        targets.push({ dir, fullPath: path.join(phasesDir, dir) });
      }
    } catch {
      // Unreadable active root: skip it, do not abort the archive walk, but
      // report it so callers can emit their pre-#3458 scan_error sentinel.
      activeUnreadable = true;
    }
  }

  // #3804: the audit is cross-workstream by design — the shared
  // getAllArchivedPhaseDirs helper (root + every workstream, distinct
  // '<ws>/<version>' labels) owns that walk.
  try {
    for (const archived of getAllArchivedPhaseDirs(cwd)) {
      targets.push({ dir: archived.name, fullPath: archived.fullPath, milestone: archived.milestone });
    }
  } catch {
    // Unreadable/unresolvable archive root: skip it, keep whatever active
    // targets were already collected. No sentinel — see docstring above.
  }

  return { targets, activeUnreadable };
}

// ─── scanUatGaps ──────────────────────────────────────────────────────────────

/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for UAT gaps (UAT files with status != 'complete'/'resolved').
 */
function scanUatGaps(planDir: string, cwd: string): ScanOutcome<UatGapItem> {
  const results: UatGapItem[] = [];
  let acknowledged = 0;
  const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
  if (activeUnreadable) {
    results.push({ scan_error: true, phase: '', file: '', status: '', open_scenario_count: 0 });
  }

  for (const target of targets) {
    const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;

    let files: string[];
    try {
      files = fs.readdirSync(target.fullPath);
    } catch {
      continue;
    }

    // Scoped to THIS phase's own token (#3511) so a stray, cross-phase, or
    // ad-hoc UAT file cannot surface as this phase's gap — same fix as
    // scanVerificationGaps below.
    for (const file of scopeToPhase(
      files.filter(f => f.includes('-UAT') && f.endsWith('.md')),
      target.dir,
    )) {
      const filePath = path.join(target.fullPath, file);

      let safeFilePath: string;
      try {
        safeFilePath = requireSafePath(filePath, planDir, 'UAT file', { allowAbsolute: true });
      } catch {
        continue;
      }

      // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
      // document at this read boundary, same seam as `src/uat.cts`'s
      // `readNormalizedDocument` — `platformReadSync` performs no line-ending
      // normalization itself, and extractFrontmatter/status-derivation below
      // degrade a lone-CR file's frontmatter to `unknown`, which every scan
      // in this module treats as "not open" (fail-open, the permissive
      // direction) rather than a real parse gap.
      const rawContent = platformReadSync(safeFilePath);
      if (rawContent === null) continue;
      const content = normalizeLineEndings(rawContent);

      const fm = extractFrontmatter(content, safeFilePath);
      const status = ((fm.status as string) || 'unknown').toLowerCase();
      const result = ((fm.result as string) || '').toLowerCase();

      // Also accept `result: all_pass` as a fallback when status is absent
      // — covers UATs that omit `status:`.
      if (TERMINAL_UAT_STATUSES.has(status)) continue;
      if (status === 'unknown' && result === 'all_pass') continue;

      // Count open scenarios — computed BEFORE the acknowledged check
      // (WARNING 2) so the snapshot comparison sees it too, not just status.
      const pendingMatches = deriveUatGapOpenScenarioCount(content);

      if (isAuditItemAcknowledged(fm, { snapshotKey: 'gap_snapshot', currentValue: deriveUatGapSnapshotValue(status, content) })) {
        acknowledged++;
        continue;
      }

      const item: UatGapItem = {
        phase: sanitizeLabel(phaseNum),
        file: sanitizeLabel(file),
        status: sanitizeForDisplay(status),
        open_scenario_count: pendingMatches,
      };
      if (target.milestone !== undefined) item.archived_milestone = sanitizeLabel(target.milestone);
      results.push(item);
    }
  }

  return { items: results, acknowledged };
}

// ─── scanVerificationGaps ─────────────────────────────────────────────────────

/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for VERIFICATION gaps.
 */
function scanVerificationGaps(planDir: string, cwd: string): ScanOutcome<VerificationGapItem> {
  const results: VerificationGapItem[] = [];
  let acknowledged = 0;
  const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
  if (activeUnreadable) {
    results.push({ scan_error: true, phase: '', file: '', status: '' });
  }

  for (const target of targets) {
    const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;

    let files: string[];
    try {
      files = fs.readdirSync(target.fullPath);
    } catch {
      continue;
    }

    // Scoped to THIS phase's own token (#3511) so a stray, cross-phase, or
    // ad-hoc VERIFICATION file cannot surface as this phase's gap.
    for (const file of scopeToPhase(
      files.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md')),
      target.dir,
    )) {
      const filePath = path.join(target.fullPath, file);

      let safeFilePath: string;
      try {
        safeFilePath = requireSafePath(filePath, planDir, 'VERIFICATION file', { allowAbsolute: true });
      } catch {
        continue;
      }

      // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
      // document at this read boundary, same seam as `src/uat.cts`'s
      // `readNormalizedDocument` — `platformReadSync` performs no line-ending
      // normalization itself, and extractFrontmatter/status-derivation below
      // degrade a lone-CR file's frontmatter to `unknown`, which every scan
      // in this module treats as "not open" (fail-open, the permissive
      // direction) rather than a real parse gap.
      const rawContent = platformReadSync(safeFilePath);
      if (rawContent === null) continue;
      const content = normalizeLineEndings(rawContent);

      const fm = extractFrontmatter(content, safeFilePath);
      const status = ((fm.status as string) || 'unknown').toLowerCase();

      if (status !== 'gaps_found' && status !== 'human_needed') continue;

      if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
        acknowledged++;
        continue;
      }

      const item: VerificationGapItem = {
        phase: sanitizeLabel(phaseNum),
        file: sanitizeLabel(file),
        status: sanitizeForDisplay(status),
      };
      if (target.milestone !== undefined) item.archived_milestone = sanitizeLabel(target.milestone);
      results.push(item);
    }
  }

  return { items: results, acknowledged };
}

// ─── scanContextQuestions ─────────────────────────────────────────────────────

/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for CONTEXT files with open_questions.
 */
function scanContextQuestions(planDir: string, cwd: string): ScanOutcome<ContextQuestionItem> {
  const results: ContextQuestionItem[] = [];
  let acknowledged = 0;
  const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
  if (activeUnreadable) {
    results.push({ scan_error: true, phase: '', file: '', question_count: 0, questions: [] });
  }

  for (const target of targets) {
    const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;

    let files: string[];
    try {
      files = fs.readdirSync(target.fullPath);
    } catch {
      continue;
    }

    for (const file of files.filter(f => f.includes('-CONTEXT') && f.endsWith('.md'))) {
      const filePath = path.join(target.fullPath, file);

      let safeFilePath: string;
      try {
        safeFilePath = requireSafePath(filePath, planDir, 'CONTEXT file', { allowAbsolute: true });
      } catch {
        continue;
      }

      // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
      // document at this read boundary, same seam as `src/uat.cts`'s
      // `readNormalizedDocument` — `platformReadSync` performs no line-ending
      // normalization itself, and extractFrontmatter/status-derivation below
      // degrade a lone-CR file's frontmatter to `unknown`, which every scan
      // in this module treats as "not open" (fail-open, the permissive
      // direction) rather than a real parse gap.
      const rawContent = platformReadSync(safeFilePath);
      if (rawContent === null) continue;
      const content = normalizeLineEndings(rawContent);

      const fm = extractFrontmatter(content, safeFilePath);
      const questions = deriveOpenQuestions(content, fm);

      if (questions.length === 0) continue;

      // WARNING 2 (#3458 follow-up review): snapshot the QUESTIONS
      // THEMSELVES (a content digest), not just their count — a count-only
      // snapshot cannot see the same-count REPLACEMENT of every question
      // with brand-new ones (measured: 2 acknowledged, then both swapped for
      // unrelated new blockers, still suppressed under the old scheme).
      if (isAuditItemAcknowledged(fm, { snapshotKey: 'questions_digest', currentValue: deriveOpenQuestionsDigest(questions) })) {
        acknowledged++;
        continue;
      }

      const item: ContextQuestionItem = {
        phase: sanitizeLabel(phaseNum),
        file: sanitizeLabel(file),
        question_count: questions.length,
        questions: questions.slice(0, 3).map(truncateQuestionForDisplay),
      };
      if (target.milestone !== undefined) item.archived_milestone = sanitizeLabel(target.milestone);
      results.push(item);
    }
  }

  return { items: results, acknowledged };
}

// ─── scanDeferredItems ────────────────────────────────────────────────────────

/**
 * Scan phase directories for UNRESOLVED entries in `deferred-items.md` (#2646),
 * across both .planning/phases (active) and .planning/milestones/vX.Y-phases
 * (archived).
 *
 * The SCOPE BOUNDARY convention (`agents/gsd-executor.md`) has a phase agent
 * log an out-of-scope discovery here rather than fix it. #2287 made that file
 * readable at the PHASE boundary (`/gsd-progress` check 7, `audit-uat`); this
 * scanner closes the remaining reader gap one boundary up, so an entry still
 * unresolved at MILESTONE close surfaces in the pre-close audit alongside the
 * other eight categories and the existing `[R]/[A]/[C]` prompt applies to it.
 * Without this, phase directories archive to `milestones/vX.Y-phases/` (#1871)
 * and the entry leaves the live tree having never been triaged.
 *
 * The resolved/unresolved predicate is NOT reimplemented here: `uat.cjs`
 * already exports `parseDeferredItemsWithStatus`, which owns the parsing rule
 * (entries under a `## Deferred Items` level-2 heading, else the whole file
 * fail-safe) and — unlike `parseDeferredItems` — surfaces each entry's raw
 * `status:` field instead of filtering `resolved` internally, so THIS scanner
 * can apply the three-way split (#3458 follow-up): `resolved` (fixed for
 * real — dropped, never counted, matching pre-existing behavior exactly),
 * `acknowledged` (suppressed AND tallied — the new deferred_items marker;
 * see the module doc comment above `isAuditItemAcknowledged`), else open.
 * Duplicating either inequality is how two readers of the same file drift
 * into disagreeing about what "open" means. The require is deliberately
 * LAZY, inside the scan, to preserve `audit-command-router.cts`'s property
 * that a route never loads the module it does not need.
 */
function scanDeferredItems(planDir: string, cwd: string): ScanOutcome<DeferredItem> {
  const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const uat: UatDeferredModule = require('./uat.cjs');

  const results: DeferredItem[] = [];
  let acknowledged = 0;
  if (activeUnreadable) {
    results.push({ scan_error: true, phase: '', file: '', text: '' });
  }

  for (const target of targets) {
    const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;

    const filePath = path.join(target.fullPath, DEFERRED_ITEMS_FILENAME);
    if (!fs.existsSync(filePath)) continue;

    let safeFilePath: string;
    try {
      safeFilePath = requireSafePath(filePath, planDir, 'deferred items file', { allowAbsolute: true });
    } catch {
      continue;
    }

    // #3078-CR MEDIUM 2: normalize at this read boundary too —
    // `parseDeferredItemsWithStatus` performs no normalization of its own
    // (unlike `src/uat.cts`'s callers, which route through
    // `readNormalizedDocument`), so a lone-CR `deferred-items.md` was read as
    // one unbroken line and every entry in it silently vanished.
    const rawContent = platformReadSync(safeFilePath);
    if (rawContent === null) continue;
    const content = normalizeLineEndings(rawContent);

    for (const item of uat.parseDeferredItemsWithStatus(content)) {
      const rawStatus = (item.status || '').toLowerCase();
      if (rawStatus === 'resolved') continue; // fixed for real — never counted
      if (rawStatus === 'acknowledged') {
        acknowledged++;
        continue;
      }

      const resultItem: DeferredItem = {
        phase: sanitizeLabel(phaseNum),
        file: sanitizeLabel(DEFERRED_ITEMS_FILENAME),
        text: sanitizeForDisplay(item.name),
      };
      if (target.milestone !== undefined) resultItem.archived_milestone = sanitizeLabel(target.milestone);
      results.push(resultItem);
    }
  }

  return { items: results, acknowledged };
}

// ─── auditOpenArtifacts ───────────────────────────────────────────────────────

/**
 * Main audit function. Scans all .planning/ artifact categories.
 *
 * @param cwd - Project root directory
 * @returns Structured audit result
 */
function auditOpenArtifacts(cwd: string): AuditResult {
  const planDir = planningDir(cwd);

  const debugSessions = (() => {
    try { return scanDebugSessions(planDir); } catch { return { items: [{ scan_error: true, slug: '', status: '', updated: '', hypothesis: '' }], acknowledged: 0 }; }
  })();

  const quickTasks = (() => {
    try { return scanQuickTasks(planDir); } catch { return { items: [{ scan_error: true, slug: '', date: '', status: '', description: '' }], acknowledged: 0 }; }
  })();

  const threads = (() => {
    try { return scanThreads(planDir); } catch { return { items: [{ scan_error: true, slug: '', status: '', updated: '', title: '' }], acknowledged: 0 }; }
  })();

  const todos = (() => {
    // #4256: the ONE root-scoped category — todos are shared project state,
    // so the close gate reads todosDir(cwd) (the root), not the workstream-
    // scoped planDir every other scan below receives. Reading planDir here
    // made audit-open print "All artifact types clear. Safe to proceed."
    // with pending todos on disk under a workstream.
    try { return scanTodos(todosDir(cwd)); } catch { return { items: [{ scan_error: true, filename: '', priority: '', area: '', summary: '' }], acknowledged: 0 }; }
  })();

  const seeds = (() => {
    try { return scanSeeds(planDir); } catch { return { items: [{ scan_error: true, seed_id: '', slug: '', status: '', title: '' }], acknowledged: 0 }; }
  })();

  const uatGaps = (() => {
    try { return scanUatGaps(planDir, cwd); } catch { return { items: [{ scan_error: true, phase: '', file: '', status: '', open_scenario_count: 0 }], acknowledged: 0 }; }
  })();

  const verificationGaps = (() => {
    try { return scanVerificationGaps(planDir, cwd); } catch { return { items: [{ scan_error: true, phase: '', file: '', status: '' }], acknowledged: 0 }; }
  })();

  const contextQuestions = (() => {
    try { return scanContextQuestions(planDir, cwd); } catch { return { items: [{ scan_error: true, phase: '', file: '', question_count: 0, questions: [] }], acknowledged: 0 }; }
  })();

  const deferredItems = (() => {
    try { return scanDeferredItems(planDir, cwd); } catch { return { items: [{ scan_error: true, phase: '', file: '', text: '' }], acknowledged: 0 }; }
  })();

  // Count real items (not scan_error sentinels). #3817: a `_remainder_count`
  // marker is not a phantom — it RECORDS real items the detail list truncated
  // away for display, so its value counts toward the total. Truncation limits
  // display, never counting; only scan_error (a read failure, not an item)
  // contributes zero.
  const countReal = (arr: Array<{ scan_error?: boolean; _remainder_count?: number }>) =>
    arr.reduce((sum, i) => {
      if (i.scan_error) return sum;
      if (typeof i._remainder_count === 'number') return sum + i._remainder_count;
      return sum + 1;
    }, 0);

  const counts: AuditCounts = {
    debug_sessions: countReal(debugSessions.items),
    quick_tasks: countReal(quickTasks.items),
    threads: countReal(threads.items),
    todos: countReal(todos.items),
    seeds: countReal(seeds.items),
    uat_gaps: countReal(uatGaps.items),
    verification_gaps: countReal(verificationGaps.items),
    context_questions: countReal(contextQuestions.items),
    deferred_items: countReal(deferredItems.items),
    total: 0,
  };
  counts.total = counts.debug_sessions + counts.quick_tasks + counts.threads + counts.todos + counts.seeds + counts.uat_gaps + counts.verification_gaps + counts.context_questions + counts.deferred_items;

  // #3458 follow-up (A5): mirrors `counts`'s shape exactly, so a reviewer can
  // tell "clean because fixed" apart from "clean because silenced" without a
  // second output contract to learn.
  const acknowledged: AuditCounts = {
    debug_sessions: debugSessions.acknowledged,
    quick_tasks: quickTasks.acknowledged,
    threads: threads.acknowledged,
    todos: todos.acknowledged,
    seeds: seeds.acknowledged,
    uat_gaps: uatGaps.acknowledged,
    verification_gaps: verificationGaps.acknowledged,
    context_questions: contextQuestions.acknowledged,
    deferred_items: deferredItems.acknowledged,
    total: 0,
  };
  acknowledged.total = acknowledged.debug_sessions + acknowledged.quick_tasks + acknowledged.threads + acknowledged.todos + acknowledged.seeds + acknowledged.uat_gaps + acknowledged.verification_gaps + acknowledged.context_questions + acknowledged.deferred_items;

  return {
    scanned_at: new Date().toISOString(),
    has_open_items: counts.total > 0,
    counts,
    acknowledged,
    items: {
      debug_sessions: debugSessions.items,
      quick_tasks: quickTasks.items,
      threads: threads.items,
      todos: todos.items,
      seeds: seeds.items,
      uat_gaps: uatGaps.items,
      verification_gaps: verificationGaps.items,
      context_questions: contextQuestions.items,
      deferred_items: deferredItems.items,
    },
  };
}

// ─── formatAuditReport ────────────────────────────────────────────────────────

/**
 * Format the audit result as a human-readable report.
 *
 * @param auditResult - Result from auditOpenArtifacts()
 * @returns Formatted report
 */
function formatAuditReport(auditResult: AuditResult): string {
  const { counts, items, has_open_items, acknowledged } = auditResult;
  const lines: string[] = [];

  lines.push('### Milestone Close: Open Artifact Audit');

  // WARNING 3 (#3458 follow-up review): the acknowledged tally previously
  // existed only in `--json` output — the human report could not tell
  // "clean because fixed" apart from "clean because silenced", which is the
  // exact distinction the acknowledged/counts split exists to preserve.
  if (!has_open_items) {
    lines.push('');
    if (acknowledged.total > 0) {
      lines.push(`All artifact types clear (${acknowledged.total} previously acknowledged item${acknowledged.total !== 1 ? 's' : ''} still suppressed).`);
    } else {
      lines.push('All artifact types clear. Safe to proceed.');
    }
    lines.push('');
    lines.push('---');
    return lines.join('\n');
  }

  // WARNING 3: per-category "N previously acknowledged" suffix, so the
  // human report carries the same "clean vs silenced" signal `--json`
  // already did via `acknowledged`.
  const ackSuffix = (n: number): string => (n > 0 ? `, ${n} previously acknowledged` : '');

  // Debug sessions (blocking quality — red)
  if (counts.debug_sessions > 0) {
    lines.push('');
    lines.push(`🔴 Debug Sessions (${counts.debug_sessions} open${ackSuffix(acknowledged.debug_sessions)})`);
    for (const item of items.debug_sessions.filter(i => !i.scan_error)) {
      const hyp = item.hypothesis ? ` — ${item.hypothesis}` : '';
      lines.push(`   • ${item.slug} [${item.status}]${hyp}`);
    }
  }

  // UAT gaps (blocking quality — red)
  if (counts.uat_gaps > 0) {
    lines.push('');
    lines.push(`🔴 UAT Gaps (${counts.uat_gaps} phases with incomplete UAT${ackSuffix(acknowledged.uat_gaps)})`);
    for (const item of items.uat_gaps.filter(i => !i.scan_error)) {
      const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
      lines.push(`   • Phase ${item.phase}${archived}: ${item.file} [${item.status}] — ${item.open_scenario_count} pending scenarios`);
    }
  }

  // Verification gaps (blocking quality — red)
  if (counts.verification_gaps > 0) {
    lines.push('');
    lines.push(`🔴 Verification Gaps (${counts.verification_gaps} unresolved${ackSuffix(acknowledged.verification_gaps)})`);
    for (const item of items.verification_gaps.filter(i => !i.scan_error)) {
      const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
      lines.push(`   • Phase ${item.phase}${archived}: ${item.file} [${item.status}]`);
    }
  }

  // Quick tasks (incomplete work — yellow)
  if (counts.quick_tasks > 0) {
    lines.push('');
    lines.push(`🟡 Quick Tasks (${counts.quick_tasks} incomplete${ackSuffix(acknowledged.quick_tasks)})`);
    for (const item of items.quick_tasks.filter(i => !i.scan_error)) {
      const d = item.date ? ` (${item.date})` : '';
      lines.push(`   • ${item.slug}${d} [${item.status}]`);
    }
  }

  // Todos (incomplete work — yellow)
  if (counts.todos > 0) {
    const realTodos = items.todos.filter(i => !i.scan_error && !i._remainder_count);
    const remainder = items.todos.find(i => i._remainder_count);
    lines.push('');
    lines.push(`🟡 Pending Todos (${counts.todos} pending${ackSuffix(acknowledged.todos)})`);
    for (const item of realTodos) {
      const area = item.area ? ` [${item.area}]` : '';
      const pri = item.priority ? ` (${item.priority})` : '';
      lines.push(`   • ${item.filename}${area}${pri}`);
      if (item.summary) lines.push(`     ${item.summary}`);
    }
    if (remainder) {
      lines.push(`   ... and ${remainder._remainder_count} more`);
    }
  }

  // Threads (deferred decisions — blue)
  if (counts.threads > 0) {
    lines.push('');
    lines.push(`🔵 Open Threads (${counts.threads} active${ackSuffix(acknowledged.threads)})`);
    for (const item of items.threads.filter(i => !i.scan_error)) {
      const title = item.title ? ` — ${item.title}` : '';
      lines.push(`   • ${item.slug} [${item.status}]${title}`);
    }
  }

  // Seeds (deferred decisions — blue)
  if (counts.seeds > 0) {
    lines.push('');
    lines.push(`🔵 Unimplemented Seeds (${counts.seeds} pending${ackSuffix(acknowledged.seeds)})`);
    for (const item of items.seeds.filter(i => !i.scan_error)) {
      const title = item.title ? ` — ${item.title}` : '';
      lines.push(`   • ${item.seed_id} [${item.status}]${title}`);
    }
  }

  // Context questions (deferred decisions — blue)
  if (counts.context_questions > 0) {
    lines.push('');
    lines.push(`🔵 CONTEXT Open Questions (${counts.context_questions} phases with open questions${ackSuffix(acknowledged.context_questions)})`);
    for (const item of items.context_questions.filter(i => !i.scan_error)) {
      const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
      lines.push(`   • Phase ${item.phase}${archived}: ${item.file} (${item.question_count} question${item.question_count !== 1 ? 's' : ''})`);
      for (const q of item.questions) {
        lines.push(`     - ${q}`);
      }
    }
  }

  // Deferred items (deferred decisions — blue). Out-of-scope discoveries a
  // phase agent recorded rather than fixed, still unresolved at close (#2646).
  if (counts.deferred_items > 0) {
    lines.push('');
    lines.push(`🔵 Deferred Items (${counts.deferred_items} unresolved${ackSuffix(acknowledged.deferred_items)})`);
    for (const item of items.deferred_items.filter(i => !i.scan_error)) {
      const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
      lines.push(`   • Phase ${item.phase}${archived}: ${item.text}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**${counts.total} item${counts.total !== 1 ? 's' : ''} require decisions before close.**`);
  if (acknowledged.total > 0) {
    lines.push(`${acknowledged.total} previously acknowledged item${acknowledged.total !== 1 ? 's' : ''} also suppressed above the ${counts.total} open item${counts.total !== 1 ? 's' : ''}.`);
  }

  return lines.join('\n');
}

// ─── resolvePhaseTargetDir ─────────────────────────────────────────────────────

/**
 * Resolve ONE phase directory (active or archived) by its phase token, for
 * `cmdAuditAcknowledge`'s `--phase [--archived-milestone]` identification of
 * a uat_gaps/verification_gaps/context_questions/deferred_items item. Built
 * on `listAuditPhaseTargets` — the same enumeration the four phase-scoped
 * scanners use — so the writer can never resolve a DIFFERENT directory than
 * the one the audit actually scanned.
 *
 * `archivedMilestone` absent → matches the ACTIVE `.planning/phases/<dir>`
 * (a target with no `milestone`). Present → matches the archived target
 * whose `milestone` equals it exactly — the same disambiguator the audit
 * output's `archived_milestone` field carries.
 */
function resolvePhaseTargetDir(planDir: string, cwd: string, phase: string, archivedMilestone: string | null): string | null {
  const { targets } = listAuditPhaseTargets(planDir, cwd);
  const phaseTokenRe = new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i');
  for (const target of targets) {
    const phaseMatch = target.dir.match(phaseTokenRe);
    const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
    if (phaseNum !== phase) continue;
    if (archivedMilestone) {
      if (target.milestone === archivedMilestone) return target.fullPath;
    } else if (target.milestone === undefined) {
      return target.fullPath;
    }
  }
  return null;
}

// ─── cmdAuditAcknowledge ────────────────────────────────────────────────────────

/**
 * CLI writer for the #3458 follow-up suppression seam (design point A4). Sets
 * (or refreshes) the `audit_acknowledged` marker on ONE identified artifact,
 * snapshotting its CURRENT effective state itself so the marker is never
 * hand-authored and can never drift from what the scanners actually compute.
 *
 * `--category` selects which of the nine audit categories is being
 * acknowledged, and which OTHER flags are required to identify the artifact —
 * mirroring the fields the audit's OWN JSON output already carries per
 * category (phase/file/archived_milestone for the four phase-scoped
 * categories; slug/seed-id/dir/filename for the five flat ones), the same
 * convention `frontmatter get/set/merge/validate` uses for `--file`/`--field`.
 *
 * VERDICT-PRESERVING: this function never writes to the artifact's own
 * `status:` field (the audit's real verdict) for the 8 frontmatter-marker
 * categories — only the sibling `audit_acknowledged` map. `deferred_items` is
 * the sole, deliberate exception (see `uat.cts`'s `acknowledgeDeferredItem`):
 * there, the marker IS the entry's own `status:` field, because a
 * deferred-items.md entry carries no OTHER meaning for that field.
 *
 * Every path this function writes is routed through `requireSafePath`, so an
 * artifact identifier that resolves outside the project is refused before
 * any read or write is attempted.
 */
function cmdAuditAcknowledge(cwd: string, args: string[], raw: boolean): void {
  // args already has the family + subcommand tokens stripped by the caller
  // (audit-command-router.cts:147 passes `hubArgs.slice(2)`), so validation
  // begins at index 0 — there is no positional this handler owns itself.
  const {
    category, milestone, at: atFlag,
    phase, file, 'archived-milestone': archivedMilestone,
    slug, 'seed-id': seedId, dir: quickDir, filename, text,
  } = parseNamedArgsOrExit(args, {
    valueFlags: [
      'category', 'milestone', 'at',
      'phase', 'file', 'archived-milestone',
      'slug', 'seed-id', 'dir', 'filename', 'text',
    ],
    positionals: 0,
  }, ioError);

  if (!category) ioError('--category is required');
  if (!milestone) ioError('--milestone is required');
  // All declared flags above are value flags, so each resolves to `string |
  // null` at runtime; the cast narrows away the `boolean` arm of
  // ParsedNamedArgs's value type that this call site never produces.
  const at = (atFlag as string | null) || new Date().toISOString().slice(0, 10);

  const planDir = planningDir(cwd);
  const markerBase = { milestone: milestone as string, at };

  // #3078-CR MEDIUM 2: every `fs.readFileSync` in this function (below, and
  // in the flat-category branch further down) is DELIBERATELY left raw,
  // unlike `auditOpenArtifacts`'s scan reads (which now route through
  // `normalizeLineEndings`). This function splices frontmatter into the
  // EXISTING content and writes the result back via `platformWriteSync` /
  // `uat.acknowledgeDeferredItem` — both `spliceFrontmatter` and
  // `acknowledgeDeferredItem` locate and rewrite a specific byte span
  // (frontmatter block / matched deferred-item text) in the file exactly as
  // it exists on disk. Normalizing first would rewrite the file's line
  // endings as a side effect of an unrelated acknowledge operation, and a
  // splice computed against normalized text can land at the wrong offset
  // when written back over the RAW (un-normalized) original. The snapshot
  // VALUE computed below IS normalized (on a separate in-memory copy, never
  // the spliced one) so it agrees with the scanner's frame — see the comment
  // at `normalizedContent` further down.
  // ── The four phase-scoped categories: --phase --file [--archived-milestone] ──
  const PHASE_SCOPED = new Set(['uat_gaps', 'verification_gaps', 'context_questions', 'deferred_items']);
  if (PHASE_SCOPED.has(category as string)) {
    if (!phase) ioError('--phase is required for this --category');
    if (!file) ioError('--file is required for this --category');
    const targetDir = resolvePhaseTargetDir(planDir, cwd, phase as string, archivedMilestone as string | null);
    if (!targetDir) {
      ioError(`no phase directory found for phase "${phase as string}"${archivedMilestone ? ` (archived-milestone "${archivedMilestone}")` : ''}`);
    }
    const filePath = path.join(targetDir as string, file as string);
    const safeFilePath = requireSafePath(filePath, planDir, 'audit acknowledge target', { allowAbsolute: true });
    if (!fs.existsSync(safeFilePath)) ioError(`file not found: ${file as string}`);

    if (category === 'deferred_items') {
      if (!text) ioError('--text is required for --category deferred_items');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const uat: UatDeferredModule = require('./uat.cjs');
      const content = fs.readFileSync(safeFilePath, 'utf-8');
      const result = uat.acknowledgeDeferredItem(content, text as string);
      if (result.status === 'not_found') ioError(`no deferred item matched --text "${text as string}"`);
      if (result.status === 'ambiguous') ioError(`--text "${text as string}" matches more than one deferred item — text must be unique`);
      if (result.status === 'already_resolved') ioError(`deferred item is already "status: resolved" — acknowledging a resolved item is a no-op`);
      if (result.status === 'unsupported_heading_shape') {
        // #3781: heading-shaped entries are supported; the remaining refusal
        // cause is a GFM table row embedded in the entry's span (non-contiguous
        // — a write cannot be anchored safely).
        ioError('this deferred item\'s span embeds a GFM table row, so the CLI writer cannot anchor a safe write to it — edit the file directly');
      }
      if (result.status === 'match_verification_failed') {
        ioError(`internal error: matched span for --text "${text as string}" did not re-verify before write — refused rather than risk writing the wrong entry`);
      }
      platformWriteSync(safeFilePath, result.content);
      output({ acknowledged: true, category, phase, file, text }, raw, 'true');
      return;
    }

    const content = fs.readFileSync(safeFilePath, 'utf-8');
    const fm = extractFrontmatter(content, safeFilePath);
    // Mixed-frame fix (security review, 4th instance on this branch): the
    // splice above and below stays keyed to RAW `content` (raw byte offsets
    // must not shift), but `scanUatGaps`/`scanContextQuestions` now derive
    // their comparison values from `normalizeLineEndings`d content. Deriving
    // the snapshot here from raw `content` would make a lone-CR file's
    // stored value permanently disagree with what the scanner recomputes —
    // `audit acknowledge` would be a silent no-op for lone-CR artifacts. Feed
    // the derive functions a normalized COPY; never splice from it.
    const normalizedContent = normalizeLineEndings(content);
    let snapshotKey: string;
    let currentValue: string;
    if (category === 'uat_gaps') {
      // WARNING 2 (#3458 follow-up review): status alone can't see MORE
      // pending scenarios added under the same status — snapshot the
      // composite `deriveUatGapSnapshotValue` instead (see its doc comment).
      snapshotKey = 'gap_snapshot';
      currentValue = deriveUatGapSnapshotValue(((fm.status as string) || 'unknown').toLowerCase(), normalizedContent);
    } else if (category === 'verification_gaps') {
      snapshotKey = 'status';
      currentValue = ((fm.status as string) || 'unknown').toLowerCase();
    } else {
      // context_questions — WARNING 2: snapshot a content digest of the
      // question set, not just its count (see `deriveOpenQuestionsDigest`'s
      // doc comment).
      snapshotKey = 'questions_digest';
      currentValue = deriveOpenQuestionsDigest(deriveOpenQuestions(normalizedContent, fm));
    }
    fm.audit_acknowledged = { ...markerBase, [snapshotKey]: currentValue };
    const newContent = spliceFrontmatter(content, fm);
    platformWriteSync(safeFilePath, newContent);
    output({ acknowledged: true, category, phase, file, [snapshotKey]: currentValue }, raw, 'true');
    return;
  }

  // ── The five flat categories: category-specific identifier flag ──
  // `status` for all five per the architecture's per-category table (`todos`
  // is presence-only and never reads `snapshotKey`, so it stays a constant).
  const snapshotKey = 'status';
  let safeFilePath: string;
  let currentValue: string;
  let createIfMissing = false;
  // Same value shape `Frontmatter`/`extractFrontmatter` use (frontmatter.cts
  // does not export the `Frontmatter` type name itself, so it is spelled out
  // structurally here) — keeps this and `extractFrontmatter`'s return type
  // unifying to the SAME type below instead of a lossy `Record<string,
  // unknown>` that `spliceFrontmatter`'s `Frontmatter` parameter would reject.
  let fmForCreate: Record<string, string | string[] | Record<string, unknown>> = {};

  if (category === 'debug_sessions') {
    if (!slug) ioError('--slug is required for --category debug_sessions');
    safeFilePath = requireSafePath(path.join(planDir, 'debug', `${slug as string}.md`), planDir, 'audit acknowledge target', { allowAbsolute: true });
    if (!fs.existsSync(safeFilePath)) ioError(`file not found: debug/${slug as string}.md`);
    const content = fs.readFileSync(safeFilePath, 'utf-8');
    currentValue = ((extractFrontmatter(content, safeFilePath).status as string) || 'unknown').toLowerCase();
  } else if (category === 'threads') {
    if (!slug) ioError('--slug is required for --category threads');
    safeFilePath = requireSafePath(path.join(planDir, 'threads', `${slug as string}.md`), planDir, 'audit acknowledge target', { allowAbsolute: true });
    if (!fs.existsSync(safeFilePath)) ioError(`file not found: threads/${slug as string}.md`);
    const content = fs.readFileSync(safeFilePath, 'utf-8');
    currentValue = deriveThreadStatus(extractFrontmatter(content, safeFilePath), content);
  } else if (category === 'seeds') {
    if (!seedId) ioError('--seed-id is required for --category seeds');
    safeFilePath = requireSafePath(path.join(planDir, 'seeds', `${seedId as string}.md`), planDir, 'audit acknowledge target', { allowAbsolute: true });
    if (!fs.existsSync(safeFilePath)) ioError(`file not found: seeds/${seedId as string}.md`);
    const content = fs.readFileSync(safeFilePath, 'utf-8');
    currentValue = ((extractFrontmatter(content, safeFilePath).status as string) || 'dormant').toLowerCase();
  } else if (category === 'todos') {
    if (!filename) ioError('--filename is required for --category todos');
    // #4256: todos are root-scoped shared state — derive the todos base and
    // pass it as BOTH the path base and the requireSafePath boundary. The
    // old workstream-scoped planDir boundary would refuse a root todos file
    // outright, and even a path fix alone would have thrown here.
    const rootTodos = todosDir(cwd);
    safeFilePath = requireSafePath(path.join(rootTodos, 'pending', filename as string), rootTodos, 'audit acknowledge target', { allowAbsolute: true });
    if (!fs.existsSync(safeFilePath)) ioError(`file not found: todos/pending/${filename as string}`);
    currentValue = ''; // presence-only — see scanTodos
  } else if (category === 'quick_tasks') {
    if (!quickDir) ioError('--dir is required for --category quick_tasks');
    const taskDir = requireSafePath(path.join(planDir, 'quick', quickDir as string), planDir, 'audit acknowledge target dir', { allowAbsolute: true });
    if (!fs.existsSync(taskDir)) ioError(`directory not found: quick/${quickDir as string}`);
    // Shared with scanQuickTasks (#3458 follow-up) so the reader and this
    // writer can never disagree about which file is the task's record.
    const resolvedSummaryPath = resolveQuickTaskSummaryFile(taskDir, quickDir as string);
    if (resolvedSummaryPath) {
      safeFilePath = requireSafePath(resolvedSummaryPath, planDir, 'audit acknowledge target', { allowAbsolute: true });
      const content = fs.readFileSync(safeFilePath, 'utf-8');
      currentValue = ((extractFrontmatter(content, safeFilePath).status as string) || 'unknown').toLowerCase();
    } else {
      // No SUMMARY.md at all — the audit's own observed status is 'missing'.
      // There is nowhere to carry the marker, so create the canonical
      // `${dir}-SUMMARY.md` with ONLY `status: missing` + the marker — the
      // acknowledgment's own snapshot of "no summary exists yet", which
      // self-invalidates the moment a real SUMMARY.md is written (the
      // scanner then reads THAT file's own status instead).
      safeFilePath = requireSafePath(path.join(taskDir, `${quickDir as string}-SUMMARY.md`), planDir, 'audit acknowledge target', { allowAbsolute: true });
      currentValue = 'missing';
      createIfMissing = true;
      fmForCreate = { status: 'missing' };
    }
  } else {
    ioError(`unknown --category "${category as string}". Available: debug_sessions, quick_tasks, threads, todos, seeds, uat_gaps, verification_gaps, context_questions, deferred_items`);
    return; // unreachable — ioError throws — satisfies TS control-flow analysis
  }

  const presenceOnly = category === 'todos';
  const fm = createIfMissing ? fmForCreate : extractFrontmatter(fs.readFileSync(safeFilePath, 'utf-8'), safeFilePath);
  fm.audit_acknowledged = presenceOnly ? { ...markerBase } : { ...markerBase, [snapshotKey]: currentValue };
  const newContent = createIfMissing
    ? spliceFrontmatter('', fm)
    : spliceFrontmatter(fs.readFileSync(safeFilePath, 'utf-8'), fm);
  platformWriteSync(safeFilePath, newContent);
  output({ acknowledged: true, category, ...(presenceOnly ? {} : { [snapshotKey]: currentValue }) }, raw, 'true');
}

export = {
  auditOpenArtifacts,
  formatAuditReport,
  listAuditPhaseTargets,
  cmdAuditAcknowledge,
  // #3805: exported so uat.cts's cmdAuditUat routes the SAME artifacts'
  // suppression through the ONE predicate instead of hand-rolling a tenth
  // copy outside this file's visibility (the exact defect class the
  // predicate's own header warns about). The snapshot derivations ride
  // along so the snapshotKeys cannot drift between the two consumers.
  isAuditItemAcknowledged,
  deriveUatGapSnapshotValue,
  // #2142: exported so src/milestone.cts's archiveQuickTaskDirectories README
  // index generator shares this ONE discovery rule rather than re-deriving it.
  resolveQuickTaskSummaryFile,
};
