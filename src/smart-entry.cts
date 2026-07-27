/**
 * Smart Entry — state-aware situation classifier for the /gsd front door.
 *
 * Reads project + workflow state (`.planning/STATE.md`, ROADMAP.md, git) and
 * classifies the user's situation into one of a small set of enumerated values,
 * each carrying a recommended next action and a menu of alternatives. Pure
 * detection → classification; no side effects, no writes.
 *
 * Surfaced as `gsd-tools smart-entry [--json]`. The markdown `/gsd` command +
 * workflow shells out to `smart-entry --json`, renders an AskUserQuestion menu
 * (with a --text numbered-list fallback for non-Claude runtimes), and dispatches
 * the chosen action to an existing slash command. See
 * docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md and
 * docs/adr/1787-gsd-next-smart-entry.md.
 *
 * Relationship to `/gsd:progress --next`: this classifier is a *menu* front door,
 * not a second router. For in-project forward motion (planning → executing →
 * verify-pending) the recommended action delegates to `/gsd:progress --next`
 * (workflows/next.md) — the single, gated advancement engine (Route 0 resume-
 * incomplete-phase invariant + Gates 1-3). smart-entry never re-derives forward
 * routing itself; a standalone advancement command that bypassed those gates is
 * exactly what got the old flat `/gsd-next` removed (#3054). Its distinct value is
 * the states `--next` cannot reach: pre-project (no-project), remediation (paused,
 * blocked, verify-failed), and lifecycle exits (idle-stranded, complete).
 *
 * Design note: this is the gsd-core analog of gsd-pi's `showSmartEntry` branch
 * tree, redesigned for gsd-core's `.planning/` phase loop. gsd-pi's
 * milestone/slice/task model does not exist here; the situation table is the
 * translation, not a port.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectSection } from './markdown-sectionizer.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-lifecycle.cjs is an export= CommonJS module
import phaseLifecycle = require('./phase-lifecycle.cjs');
const { deriveProgressFromRoadmap } = phaseLifecycle;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateDocument = require('./state-document.cjs');
const { stateExtractField } = stateDocument;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseId = require('./phase-id.cjs');
const { comparePhaseNum, extractPhaseToken, normalizePhaseName, phaseTokenMatches } = phaseId;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Situation id — the gsd-core analog of gsd-pi's phase enum. */
export type Situation =
  | 'no-project'
  | 'paused'
  | 'blocked'
  | 'verify-failed'
  | 'needs-first-phase'
  | 'planning'
  | 'executing'
  | 'verify-pending'
  | 'idle-stranded'
  | 'complete'
  | 'unknown';

export interface SmartEntryAction {
  id: string;
  label: string;
  /** Full slash command string the workflow dispatches, including flags. */
  command: string;
  recommended: boolean;
}

export interface SmartEntrySignals {
  current_phase: number | null;
  total_phases: number | null;
  status: string;
  progress: number | null;
  has_planning: boolean;
  has_roadmap: boolean;
  git_dirty: boolean;
  git_unpushed: boolean;
  paused: boolean;
  blockers: string[];
  has_git: boolean;
  /** Latest verify report failed (STATUS: blocked/failed) or status says so. */
  verify_failed: boolean;
  /** last_activity older than IDLE_STALE_MS (computed with the clock seam). */
  stale_activity: boolean;
  /**
   * Global phase counts derived from ROADMAP.md's `## Progress` table (#2427).
   * Preferred over the cached milestone-scoped `total_phases` (which goes stale
   * when phases are appended after a milestone switch). Null when ROADMAP.md is
   * absent or has no parseable Progress table — callers fall back to the legacy
   * STATE.md comparison in that case.
   */
  roadmap_total_phases: number | null;
  roadmap_completed_phases: number | null;
}

export interface SmartEntryResult {
  situation: Situation;
  recommended: string;
  summary: string;
  signals: SmartEntrySignals;
  actions: SmartEntryAction[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Staleness threshold for idle-stranded detection. A clean tree whose last
 * activity is older than this (with non-complete status) is considered stranded
 * committed-but-unshipped work. Hardcoded for v1; configurable later.
 */
const IDLE_STALE_MS = 72 * 60 * 60 * 1000; // 72h

/** @internal a single source of truth so the structure test can assert coverage. */
export const SITUATIONS: readonly Situation[] = Object.freeze([
  'no-project',
  'paused',
  'blocked',
  'verify-failed',
  'needs-first-phase',
  'planning',
  'executing',
  'verify-pending',
  'idle-stranded',
  'complete',
  'unknown',
]);

// ─── Detection ─────────────────────────────────────────────────────────────────

/** Frontmatter scalar helper: prefer YAML frontmatter, fall back to body field. */
function fmScalar(fm: Record<string, unknown>, body: string, key: string, bodyField: string): string | null {
  const v = fm[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return stateExtractField(body, bodyField);
}

/** Read a scalar value from a nested frontmatter object (e.g. progress.total_phases). */
function fmScalarKey(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function parseIntOrNull(s: string | null): number | null {
  if (s === null) return null;
  const cleaned = s.replace('%', '').trim();
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function phaseTokenFromDirName(name: string): string | null {
  const token = extractPhaseToken(name);
  return /^\d+(?:[A-Z])?(?:\.\d+)*(?:-|$)/i.test(token) ? token : null;
}

/**
 * Parse a `last_activity` value that may be an ISO date or a free-form string
 * into an epoch-ms timestamp. Returns null when unparseable.
 */
function parseActivityTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

interface GitSignals {
  has_git: boolean;
  dirty: boolean;
  unpushed: boolean;
}

/** Read-only git signals. Any git error is swallowed → "no git signal". */
function readGitSignals(cwd: string): GitSignals {
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return '';
    }
  };
  // Cheap "is this a git repo" probe that also doubles as the dirty check.
  const status = run(['status', '--porcelain']);
  if (status === '' && !run(['rev-parse', '--is-inside-work-tree']).trim()) {
    return { has_git: false, dirty: false, unpushed: false };
  }
  const dirty = status.trim().length > 0;
  // `git log @{u}..HEAD` lists commits on this branch not on its upstream.
  // Non-empty ⇒ unpushed. Errors (no upstream, detached HEAD) ⇒ not unpushed.
  const unpushed = run(['log', '@{u}..HEAD', '--oneline']).trim().length > 0;
  return { has_git: true, dirty, unpushed };
}

/** Leading numeric phase token from a STATE.md scalar or body `Phase:` value. */
function phaseTokenFromState(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const match = raw.trim().match(/^(\d+(?:[A-Z])?(?:\.\d+)*)/i);
  return match ? match[1] : null;
}

/**
 * Detect whether the current phase's verify report indicates failure. The
 * canonical signal is a phase summary/verify artifact whose STATUS: marker reads
 * blocked, failed, or fail. Scoped to STATE.md's current phase so a leftover or
 * newer phase tree cannot skew routing. Returns true only on a clear positive signal.
 */
function detectVerifyFailed(cwd: string, currentPhaseRaw: string | null): boolean {
  const phasesDir = path.join(planningPaths(cwd).phases);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(phasesDir)
      .map((name) => ({ name, phaseToken: phaseTokenFromDirName(name) }))
      .filter((entry): entry is { name: string; phaseToken: string } => entry.phaseToken !== null)
      .sort((a, b) => comparePhaseNum(a.phaseToken, b.phaseToken) || a.name.localeCompare(b.name))
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;

  const phaseToken = phaseTokenFromState(currentPhaseRaw);
  let targetDir: string | undefined;
  if (phaseToken) {
    const normalized = normalizePhaseName(phaseToken);
    targetDir = entries.find((name) => phaseTokenMatches(name, normalized));
    if (!targetDir) return false;
  } else {
    // No current phase in state — fall back to the highest-numbered phase dir.
    targetDir = entries[entries.length - 1];
  }
  const latestDir = path.join(phasesDir, targetDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(latestDir);
  } catch {
    return false;
  }
  const candidates = files.filter((f) => /summary|verif(?:y|ication)|uat/i.test(f));
  for (const name of candidates) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(latestDir, name), 'utf-8');
    } catch {
      continue;
    }
    const statusMatch = content.match(/STATUS:\s*([A-Za-z_-]+)/i);
    if (statusMatch && /\b(blocked|fail(ed)?)\b/i.test(statusMatch[1])) {
      return true;
    }
  }
  return false;
}

/** Parse `.planning/STATE.md` (frontmatter + body) into the raw signals we need. */
function readStateFile(statePath: string): {
  fm: Record<string, unknown>;
  body: string;
} | null {
  let content: string;
  try {
    content = fs.readFileSync(statePath, 'utf-8');
  } catch {
    return null;
  }
  const fm = extractFrontmatter(content, statePath) as Record<string, unknown>;
  const body = content.replace(/^---[\s\S]*?---\s*/, '');
  return { fm, body };
}

/** Collect the full signal set from disk for `cwd`. Exported for unit tests. */
export function detectSignals(cwd: string, now: () => number = Date.now): SmartEntrySignals {
  const paths = planningPaths(cwd);
  const hasPlanning = fs.existsSync(paths.planning);
  const hasRoadmap = fs.existsSync(paths.roadmap);
  const git = readGitSignals(cwd);

  const empty: SmartEntrySignals = {
    current_phase: null,
    total_phases: null,
    status: '',
    progress: null,
    has_planning: hasPlanning,
    has_roadmap: hasRoadmap,
    git_dirty: git.dirty,
    git_unpushed: git.unpushed,
    paused: false,
    blockers: [],
    has_git: git.has_git,
    verify_failed: false,
    stale_activity: false,
    roadmap_total_phases: null,
    roadmap_completed_phases: null,
  };
  if (!hasPlanning) return empty;

  const parsed = readStateFile(paths.state);
  if (!parsed) return empty;
  const { fm, body } = parsed;

  // STATE.md has two lineages of schemas (see state.cjs parseProsePhaseField):
  //   - scalar frontmatter: `current_phase: 3`, `total_phases: 5`
  //   - nested frontmatter: `progress: { total_phases: 5, percent: 40 }`
  //   - body prose:         `Phase: 3`, `**Status:** verifying`, `Total Phases: 5`
  // Read each field across every form, scalar-first then nested then body, so
  // the classifier works on real STATE.md files written by current GSD.
  const statusRaw = fmScalar(fm, body, 'status', 'Status');
  const pausedAtRaw = fmScalar(fm, body, 'paused_at', 'Paused At');
  const lastActivityRaw = fmScalar(fm, body, 'last_activity', 'Last Activity');

  // current_phase: scalar fm → nested (none) → body "Current Phase" → body "Phase".
  // The body `Phase:` field is the canonical location in prose-form STATE.md
  // (e.g. "Phase: 3" or "Phase: 3 — ui-review"); parse the leading number.
  const currentPhaseRaw =
    fmScalar(fm, body, 'current_phase', 'Current Phase') ??
    stateExtractField(body, 'Phase');

  // total_phases & percent: nested `progress:` object takes precedence in the
  // nested schema; scalar fm / body fields cover the flat schema.
  const progressFm = typeof fm.progress === 'object' ? fm.progress : null;
  const totalPhasesRaw: string | null =
    fmScalarKey(progressFm, 'total_phases') ??
    fmScalar(fm, body, 'total_phases', 'Total Phases');
  const progressRaw: string | null =
    fmScalarKey(progressFm, 'percent') ??
    fmScalar(fm, body, 'progress', 'Progress');

  // Blockers list: `- <text>` items under a `## Blockers` heading.
  const blockers: string[] = [];
  const blockersSection = collectSection(body, (h) => h.level === 2 && h.text.trim().toLowerCase() === 'blockers', { levelBounded: true });
  if (blockersSection) {
    const items = blockersSection.body.match(/^-\s+(.+)$/gm) || [];
    for (const item of items) blockers.push(item.replace(/^-\s+/, '').trim());
  }

  const paused = Boolean(pausedAtRaw && pausedAtRaw.trim());

  // Stale = no recorded activity for IDLE_STALE_MS. Used only by idle-stranded.
  // Computed here (with the clock seam) so the pure classify() stays a function
  // of (signals, staleActivity) and detectSignals owns all disk reads.
  const lastActivityMs = parseActivityTimestamp(lastActivityRaw);
  const staleActivity = lastActivityMs !== null && now() - lastActivityMs > IDLE_STALE_MS;

  // Verify-failed may be signalled either by STATE.md status or by a failed
  // STATUS: marker on the current phase's summary/verify artifact.
  const verifyFailed =
    /\bverify-fail(ed)?|verification-fail|uat-fail\b/i.test(statusRaw || '') ||
    detectVerifyFailed(cwd, currentPhaseRaw);

  // #2427: derive global phase counts from ROADMAP.md's Progress table. These
  // are preferred over STATE.md's cached milestone-scoped `total_phases` (which
  // goes stale when phases are appended after a milestone switch) for the
  // completion check. Null when ROADMAP.md is absent or has no parseable
  // Progress table — isComplete falls back to the legacy comparison in that case.
  let roadmapTotalPhases: number | null = null;
  let roadmapCompletedPhases: number | null = null;
  if (hasRoadmap) {
    try {
      const roadmapContent = fs.readFileSync(paths.roadmap, 'utf8');
      const derived = deriveProgressFromRoadmap(roadmapContent);
      roadmapTotalPhases = derived.totalPhases;
      roadmapCompletedPhases = derived.completedPhases;
    } catch {
      /* ROADMAP.md unreadable — leave null; isComplete falls back to legacy. */
    }
  }

  return {
    current_phase: parseIntOrNull(currentPhaseRaw),
    total_phases: parseIntOrNull(totalPhasesRaw),
    status: (statusRaw || '').toLowerCase(),
    progress: parseIntOrNull(progressRaw),
    has_planning: hasPlanning,
    has_roadmap: hasRoadmap,
    git_dirty: git.dirty,
    git_unpushed: git.unpushed,
    paused,
    blockers,
    has_git: git.has_git,
    verify_failed: verifyFailed,
    stale_activity: staleActivity,
    roadmap_total_phases: roadmapTotalPhases,
    roadmap_completed_phases: roadmapCompletedPhases,
  };
}

// ─── Situation classification ─────────────────────────────────────────────────

/**
 * True when the workflow has fully completed all phases.
 *
 * #2427: completion is grounded in ROADMAP.md's Progress table (global,
 * authoritative, never stale) when available, with a legacy fallback to
 * STATE.md's cached `total_phases` when the roadmap has no parseable Progress
 * table (e.g. a fresh project or a non-standard roadmap layout). The status
 * regex was tightened to require milestone-level completion language
 * (`milestone complete` / `all phases complete` / `complete(d)`) and no longer
 * matches per-phase messages like "Phase X shipped — PR #N" that falsely
 * satisfied the pre-fix alternation (`\bcomplete(d)?|done|shipped\b`).
 */
function isComplete(s: SmartEntrySignals): boolean {
  // Prefer ROADMAP-derived counts (global, authoritative) over STATE.md's
  // cached milestone-scoped total_phases (stale-prone). Fall back to legacy
  // when the roadmap has no Progress table.
  if (s.roadmap_total_phases !== null && s.roadmap_completed_phases !== null) {
    if (s.roadmap_total_phases === 0) return false;
    if (s.roadmap_completed_phases < s.roadmap_total_phases) return false;
  } else {
    // Legacy path: STATE.md comparison. Still subject to the two-scale bug,
    // but only fires when ROADMAP.md is absent or has no Progress table.
    if (s.total_phases === null || s.current_phase === null) return false;
    if (s.current_phase < s.total_phases) return false;
  }
  // Status regex: require milestone-level completion language. The pre-fix
  // regex matched any "shipped" / "done" substring (per-phase language).
  // Tightened to match:
  //   - "milestone complete" (ADR-2207 terminal status — usually written as
  //     "<version> milestone complete", e.g. "v1.0 milestone complete"; the
  //     substring match handles both forms)
  //   - "all phases complete" (ADR-2207 intermediate terminal)
  //   - "complete" / "completed" (legacy short form — STATE.md milestone
  //     status is a single value, not a per-phase log)
  // Intentionally does NOT match "done" alone even though normalizeStateStatus
  // (state-document.cts) treats "done" as "completed" — in the milestone
  // status field, "done" is per-phase noise (e.g. "Phase X done"), not a
  // milestone-completion signal. Mirrors workstream-inventory-builder.cts's
  // terminal pattern \bmilestone\s+complete\b.
  return /\b(milestone\s+complete|all\s+phases\s+complete|complete(d)?)\b/i.test(s.status);
}

/** Idle-stranded: clean tree, committed work not shipped, optionally stale. */
function isIdleStranded(s: SmartEntrySignals): boolean {
  if (/\bcomplete(d)?|done|shipped|paused\b/i.test(s.status)) return false;
  if (s.git_dirty) return false;
  // Unpushed commits are the strongest signal. Otherwise require staleness.
  return s.git_unpushed || s.stale_activity;
}

/**
 * Classify signals into a situation. Priority order matters — the first
 * matching predicate wins (e.g. paused beats blocked). Exported for unit tests.
 * Pure function of signals (staleness + verify-failed are precomputed on signals).
 */
export function classify(s: SmartEntrySignals): Situation {
  if (!s.has_planning) return 'no-project';
  if (s.paused) return 'paused';
  if (s.blockers.length > 0) return 'blocked';
  if (s.verify_failed) return 'verify-failed';
  if (s.total_phases === null || s.total_phases <= 0 || !s.has_roadmap) return 'needs-first-phase';
  if (isComplete(s)) return 'complete';
  if (/\bplanning|planned\b/i.test(s.status)) return 'planning';
  if (/\bexecut(e|ing)|active|in.progress|building\b/i.test(s.status)) return 'executing';
  if (/\bverify|review|needs.review|pending.review\b/i.test(s.status)) return 'verify-pending';
  if (isIdleStranded(s)) return 'idle-stranded';
  return 'unknown';
}

// ─── Action sets ──────────────────────────────────────────────────────────────

const action = (
  id: string,
  label: string,
  command: string,
  recommended = false,
): SmartEntryAction => ({ id, label, command, recommended });

function rec(id: string, label: string, command: string): SmartEntryAction {
  return action(id, label, command, true);
}

/** Per-situation ordered action list; recommended action first. */
export function actionsFor(situation: Situation, s: SmartEntrySignals): SmartEntryAction[] {
  const phaseN = s.current_phase ?? '';
  const execLabel = phaseN === '' ? 'Continue executing' : `Continue executing phase ${phaseN}`;
  switch (situation) {
    case 'no-project':
      return [
        rec('new-project', 'Start a new project', '/gsd:new-project'),
        action('map-codebase', 'Map an existing codebase', '/gsd:map-codebase'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('help', 'Show help', '/gsd:help'),
      ];
    case 'paused':
      return [
        rec('resume-work', 'Resume work', '/gsd:resume-work'),
        action('progress', 'Show progress', '/gsd:progress'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('help', 'Show help', '/gsd:help'),
      ];
    case 'blocked':
      return [
        rec('debug', 'Debug the blocker', '/gsd:debug'),
        action('verify-work', 'Verify current work', '/gsd:verify-work'),
        action('capture', 'Capture a note', '/gsd:capture'),
        action('progress', 'Show progress', '/gsd:progress'),
      ];
    case 'verify-failed':
      return [
        rec('verify-work', 'Re-verify work', '/gsd:verify-work'),
        action('debug', 'Debug the failure', '/gsd:debug'),
        action('code-review', 'Review recent work', '/gsd:code-review'),
        action('progress', 'Show progress', '/gsd:progress'),
      ];
    case 'needs-first-phase':
      return [
        rec('discuss-phase', 'Discuss the first phase', '/gsd:discuss-phase'),
        action('plan-phase', 'Plan phase 1', '/gsd:plan-phase'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('progress', 'Show progress', '/gsd:progress'),
      ];
    case 'planning':
      // Forward motion → delegate to the single gated engine (see 'executing').
      return [
        rec('progress-next', `Advance to the next step (plan phase ${phaseN || 1})`, '/gsd:progress --next'),
        action('plan-phase', `Plan phase ${phaseN || 1}`, '/gsd:plan-phase'),
        action('discuss-phase', 'Discuss before planning', '/gsd:discuss-phase'),
        action('progress', 'Show progress', '/gsd:progress'),
      ];
    case 'executing':
      // In-project forward motion delegates to the single gated engine
      // (/gsd:progress --next → workflows/next.md). Its Route 0 resume-incomplete
      // -phase invariant + Gates 1-3 must not be bypassed by dispatching a raw
      // /gsd:execute-phase here — that divergence is why the old flat /gsd-next
      // was removed (#3054). Direct execute stays as an explicit secondary choice.
      return [
        rec('progress-next', 'Advance to the next step', '/gsd:progress --next'),
        action('execute-phase', execLabel, '/gsd:execute-phase'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('code-review', 'Review recent work', '/gsd:code-review'),
      ];
    case 'verify-pending':
      // Forward motion → delegate to the single gated engine (see 'executing').
      return [
        rec('progress-next', 'Advance to the next step (verify)', '/gsd:progress --next'),
        action('verify-work', 'Verify work', '/gsd:verify-work'),
        action('code-review', 'Review recent work', '/gsd:code-review'),
        action('ship', 'Ship completed work', '/gsd:ship'),
      ];
    case 'idle-stranded':
      return [
        rec('ship', 'Ship committed work', '/gsd:ship'),
        action('complete-milestone', 'Complete the milestone', '/gsd:complete-milestone'),
        action('progress', 'Show progress', '/gsd:progress'),
        action('capture', 'Capture a note', '/gsd:capture'),
      ];
    case 'complete':
      return [
        rec('new-milestone', 'Start a new milestone', '/gsd:new-milestone'),
        action('extract-learnings', 'Extract learnings', '/gsd:extract-learnings'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('progress', 'Show progress', '/gsd:progress'),
      ];
    case 'unknown':
    default:
      return [
        rec('progress', 'Show progress', '/gsd:progress'),
        action('progress-next', 'Advance to the next step', '/gsd:progress --next'),
        action('quick', 'Quick task', '/gsd:quick'),
        action('help', 'Show help', '/gsd:help'),
      ];
  }
}

// ─── Summary line ─────────────────────────────────────────────────────────────

function buildSummary(situation: Situation, s: SmartEntrySignals): string {
  switch (situation) {
    case 'no-project':
      return 'No project yet — start fresh or map an existing codebase';
    case 'paused':
      return 'Work is paused — pick up where you left off';
    case 'blocked':
      return `Blocked${s.blockers.length ? ` · ${s.blockers.length} blocker(s)` : ''} — resolve before continuing`;
    case 'verify-failed':
      return 'Recent verification failed — re-verify or debug';
    case 'needs-first-phase':
      return 'Project initialized — plan your first phase';
    case 'planning':
      return `Phase ${s.current_phase ?? '?'} of ${s.total_phases ?? '?'} — needs a plan`;
    case 'executing':
      return progressLine('executing', s);
    case 'verify-pending':
      return progressLine('ready to verify', s);
    case 'idle-stranded':
      return 'Committed work not shipped — time to ship';
    case 'complete':
      return 'All phases complete — start a new milestone';
    case 'unknown':
    default:
      return 'Unsure of state — showing progress';
  }
}

function progressLine(tail: string, s: SmartEntrySignals): string {
  const parts: string[] = [];
  if (s.current_phase !== null && s.total_phases !== null) {
    parts.push(`Phase ${s.current_phase} of ${s.total_phases}`);
  } else if (s.current_phase !== null) {
    parts.push(`Phase ${s.current_phase}`);
  }
  if (s.progress !== null) parts.push(`${s.progress}%`);
  parts.push(tail);
  return parts.join(' · ');
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Run the full detect → classify → assemble pipeline. Pure: no stdout, no
 * writes. Exported for direct unit testing and reuse. The clock seam drives
 * staleness detection inside detectSignals.
 */
export function classifyProject(cwd: string, now: () => number = Date.now): SmartEntryResult {
  const signals = detectSignals(cwd, now);
  const situation = classify(signals);
  const actions = actionsFor(situation, signals);
  const recommended = actions.find((a) => a.recommended)?.id ?? 'progress';
  const summary = buildSummary(situation, signals);
  return { situation, recommended, summary, signals, actions };
}

/**
 * `gsd-tools smart-entry` entry point. `--json` emits machine JSON; default
 * emits a human-readable summary line. Never throws for a missing `.planning/`
 * (returns `no-project`); other internal failures surface a typed error via
 * `output()` so the workflow can fall back to `/gsd:progress`.
 */
export function runSmartEntry(cwd: string, args: string[], raw: boolean): void {
  const json = args.includes('--json');
  const result = classifyProject(cwd);
  if (json) {
    output(result, raw, undefined);
    return;
  }
  // Human mode: a compact one-liner plus the recommended action.
  const human = `${result.summary}\nRecommended: ${result.recommended} → ${
    result.actions.find((a) => a.id === result.recommended)?.command ?? '/gsd:progress'
  }`;
  output(null, true, human);
}
