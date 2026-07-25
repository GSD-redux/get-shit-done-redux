/**
 * Roadmap — Roadmap parsing and update operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, phaseMarkdownRegexSource, phaseTokenMatches, stripProjectCodePrefix, OPTIONAL_PHASE_TAG_SOURCE, roadmapPhaseLookupSources } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, replaceInCurrentMilestone } = roadmapParserModule;
import { tokenizeHeadings } from './markdown-sectionizer.cjs';
import { updateTableCell } from './markdown-table.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, withPlanningLock, findContextMdIn } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { countMatchedSummaries } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, parseMustHavesBlock } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { readVerificationStatus } = verificationMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhasePlansAndSummaries {
  planCount: number;
  summaryCount: number;
  hasContext: boolean;
  hasResearch: boolean;
}

interface PhaseSearchResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal?: string | null;
  mode?: string | null;
  success_criteria?: string[];
  section?: string;
  error?: string;
  message?: string;
}

interface TruthValue {
  count: number;
  text: string;
}

// ─── coerceTruthToString ──────────────────────────────────────────────────────

/**
 * Coerce an arbitrary YAML scalar/object into a string for cross-cutting
 * truth aggregation. Handles:
 *   - strings (passthrough)
 *   - numbers / booleans (String() coercion — issue #2770: bare YAML ints
 *     like `- 3` must be surfaced, not silently skipped)
 *   - kv-shaped objects from parseMustHavesBlock continuation kv (issue
 *     #2757) — extract the first meaningful string field
 *
 * Returns the empty string when no usable text can be derived; callers should
 * skip empty results.
 */
function coerceTruthToString(t: unknown): string {
  if (t === null || t === undefined) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number' || typeof t === 'boolean' || typeof t === 'bigint') {
    return String(t);
  }
  if (typeof t === 'object') {
    // Prefer common title-bearing keys produced by parseMustHavesBlock. `statement` is the canonical
    // truth/prohibition payload field — and the carrier of #1154's object-form backstop truth
    // `{ statement, verification: backstop }`, so it leads (a non-inferable truth must be coerced by
    // its statement, never dropped — the Hyrum backward-compat guard for the new marker).
    for (const k of ['statement', 'title', 'text', 'name', 'rule', 'path', 'provides']) {
      const v = (t as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  return '';
}

// ─── countPhasePlansAndSummaries ──────────────────────────────────────────────

function countPhasePlansAndSummaries(phaseDir: string): PhasePlansAndSummaries {
  const { planCount, summaryCount } = scanPhasePlans(phaseDir);
  // hasContext and hasResearch are not plan-scan concerns — read the directory
  // once and share the listing for all non-plan metadata that cmdRoadmapAnalyze needs.
  let phaseFiles: string[] = [];
  try { phaseFiles = fs.readdirSync(phaseDir); } catch { /* empty */ }
  return {
    planCount,
    summaryCount,
    hasContext: findContextMdIn(phaseFiles) !== null,
    hasResearch: phaseFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
  };
}

// `phaseMarkdownRegexSource` lives in phase-id.cjs (#3537) and is imported above.

// ─── searchPhaseInContent ─────────────────────────────────────────────────────

/**
 * Search for a phase header (and its section) within the given content string.
 * Returns a result object if found (either a full match or a malformed_roadmap
 * checklist-only match), or null if the phase is not present at all.
 */
function searchPhaseInContent(content: string, escapedPhase: string, phaseNum: string): PhaseSearchResult | null {
  // #1729: OPTIONAL_PHASE_TAG_SOURCE after the number tolerates a pre-colon ( ) tag.
  const headingPattern = new RegExp(
    `^(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*(.+)$`,
    'i'
  );
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex((heading) => headingPattern.test(heading.text));
  const headerMatch = headingIndex === -1 ? null : headings[headingIndex].text.match(headingPattern);

  if (!headerMatch) {
    // Fallback: check if phase exists in summary list but missing detail section
    const checklistPattern = new RegExp(
      `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*([^*]+)\\*\\*`,
      'i'
    );
    const checklistMatch = content.match(checklistPattern);

    if (checklistMatch) {
      return {
        found: false,
        phase_number: phaseNum,
        phase_name: checklistMatch[1].trim(),
        error: 'malformed_roadmap',
        message: `Phase ${phaseNum} exists in summary list but missing "### Phase ${phaseNum}:" detail section. ROADMAP.md needs both formats.`
      };
    }

    return null;
  }

  const phaseName = headerMatch[1].trim();
  const headerIndex = headings[headingIndex].offset;

  const currentHeading = headings[headingIndex];
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= currentHeading.level);
  const sectionEnd = nextHeading ? nextHeading.offset : content.length;

  const section = content.slice(headerIndex, sectionEnd).trim();

  // Extract goal if present (supports both **Goal:** and **Goal**: formats)
  const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
  const goal = goalMatch ? goalMatch[1].trim() : null;

  // Mode: vertical-MVP slice mode flag. Lowercased + trimmed for canonical
  // comparison; unrecognized values are preserved verbatim for forward-compat.
  const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
  const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

  // Extract success criteria as structured array. A criterion may wrap onto extra
  // indented lines (no `N.` prefix); those continuations must fold INTO their
  // criterion, not end the run (#2522 — the old `(?:\s*\d+\.\s*[^\n]+)+` broke on a
  // wrapped line, truncating it and silently dropping every criterion below it).
  // `\n*` before each numbered line keeps blank-line-separated criteria working.
  const criteriaMatch = section.match(
    /\*\*Success Criteria\*\*[^\n]*:\s*\n((?:\n*[ \t]*\d+\.[^\n]*\n?(?:[ \t]+(?!\d+\.)[^\n]*\n?)*)+)/i);
  const success_criteria = criteriaMatch
    ? criteriaMatch[1].trim().split(/\n+(?=[ \t]*\d+\.)/)
        .map(entry => entry.replace(/^\s*\d+\.\s*/, '').replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
    : [];

  return {
    found: true,
    phase_number: phaseNum,
    phase_name: phaseName,
    goal,
    mode,
    success_criteria,
    section,
  };
}

// ─── getRoadmapPhaseWithFallback ──────────────────────────────────────────────

/**
 * Two-pass phase lookup that mirrors cmdRoadmapGetPhase's resolution strategy.
 *
 * Pass 1: current-milestone slice (extractCurrentMilestone).
 * Pass 2: full roadmap content (stripShippedMilestones) — covers cross-milestone
 *         and older frontend phases that are no longer in the current milestone slice.
 *
 * Returns the phase section string if found, null if ROADMAP.md is missing,
 * or throws if ROADMAP.md read fails.
 *
 * Used by check-command-router (computeUiPlanGate) so ui-plan-gate uses the SAME
 * phase resolution as `roadmap.get-phase` — not a milestone-only subset.
 */
function getRoadmapPhaseWithFallback(cwd: string, phaseNum: string): string | null {
  if (/^999(?:\.|$)/.test(stripProjectCodePrefix(phaseNum))) return null;
  const roadmapPath = planningPaths(cwd).roadmap;
  // Read directly rather than gating on fs.existsSync: existsSync returns false
  // on EACCES/EIO too, which would mask an UNREADABLE roadmap as "missing" and
  // let a blocking gate certify empty scope (#2365 review). Honor the documented
  // contract — null only when genuinely absent (ENOENT), otherwise throw.
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw err;
  }
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);

  // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
  // prefix-tolerant) so this resolver matches getRoadmapPhaseInternal and a
  // bare-number query resolves a drifted project-code-prefixed heading.
  for (const source of roadmapPhaseLookupSources(phaseNum)) {
    const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum);
    if (milestoneResult && !milestoneResult.error) return milestoneResult.section ?? null;
    const fullResult = searchPhaseInContent(fullContent, source, phaseNum);
    if (fullResult && !fullResult.error) return fullResult.section ?? null;
  }

  return null;
}

// ─── cmdRoadmapGetPhase ───────────────────────────────────────────────────────

function cmdRoadmapGetPhase(cwd: string, phaseNum: string, raw: boolean): void {
  if (/^999(?:\.|$)/.test(stripProjectCodePrefix(phaseNum))) {
    output({ found: false, phase_number: phaseNum }, raw, '');
    return;
  }
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ found: false, error: 'ROADMAP.md not found' }, raw, '');
    return;
  }

  try {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const milestoneContent = extractCurrentMilestone(rawContent, cwd);

    const fullContent = stripShippedMilestones(rawContent);

    // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
    // prefix-tolerant) so all three roadmap resolvers share one contract and a
    // bare-number query resolves a drifted `### Phase AB-29:` heading. This
    // preserves the #3599 exact-prefix-first and #3537 padding-tolerant behavior
    // (both now encoded in roadmapPhaseLookupSources' ordering). A clean match
    // (milestone or full, any source) wins immediately; a malformed_roadmap
    // (checklist-only) candidate is surfaced only if no source finds a real
    // heading — so a milestone checklist never blocks a full-roadmap header.
    let malformed: PhaseSearchResult | null = null;
    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum);
      if (milestoneResult && !milestoneResult.error) {
        output(milestoneResult, raw, milestoneResult.section);
        return;
      }
      const fullResult = searchPhaseInContent(fullContent, source, phaseNum);
      if (fullResult && !fullResult.error) {
        output(fullResult, raw, fullResult.section);
        return;
      }
      if (!malformed) malformed = (milestoneResult?.error ? milestoneResult : (fullResult?.error ? fullResult : null));
    }

    if (malformed) {
      output(malformed, raw, '');
      return;
    }

    output({ found: false, phase_number: phaseNum }, raw, '');
  } catch (e) {
    error('Failed to read ROADMAP.md: ' + (e as Error).message);
  }
}

// ─── cmdRoadmapAnalyze ────────────────────────────────────────────────────────

function cmdRoadmapAnalyze(cwd: string, raw: boolean): void {
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw, undefined);
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const content = extractCurrentMilestone(rawContent, cwd);
  const phasesDir = planningPaths(cwd).phases;

  // Extract all phase headings: ## Phase N: Name or ### Phase N: Name
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const phasePattern = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+(\d+[A-Z]?(?:[.-]\d+)*)(?:\s*\([^)\n]{0,200}\))?\s*:\s*([^\n]+)/gi;
  const phases: Array<{
    number: string;
    name: string;
    goal: string | null;
    mode: string | null;
    depends_on: string | null;
    plan_count: number;
    summary_count: number;
    has_context: boolean;
    has_research: boolean;
    disk_status: string;
    roadmap_complete: boolean;
  }> = [];
  let match: RegExpExecArray | null;

  // Phase 0 (pre-milestone) and Phase 999 (backlog) are sentinels, not real
  // phases. They legitimately have no directory and must never be surfaced as
  // current/next phase or counted in phase_count. Mirrors the engine-wide
  // sentinel convention (phase-id getMilestoneFromPhaseId, roadmap-command-router
  // SENTINELS, the #1445 /^999/ progress filters). (#1580)
  const isSentinelPhase = (num: string): boolean => {
    const major = parseInt(num, 10);
    return major === 0 || major === 999;
  };

  // Build phase directory lookup once (O(1) readdir instead of O(N) per phase)
  const _phaseDirNames = (() => {
    try {
      return fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch { return []; }
  })();

  while ((match = phasePattern.exec(content)) !== null) {
    const phaseNum = match[1];
    if (isSentinelPhase(phaseNum)) continue;
    const phaseName = match[2].replace(/\(INSERTED\)/i, '').trim();

    // Extract goal from the section
    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    // #3691: `\d` → `\d[\d.]*` so decimal phase headings (e.g. `### Phase 02.3:`) are
    // recognised as section boundaries.
    const nextHeader = restOfContent.match(/\n#{2,4}\s+(?:\[[^\]]{1,200}\]\s*)?Phase\s+\d[\d.-]*/i);
    const sectionEnd = nextHeader ? sectionStart + nextHeader.index! : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    // Check completion on disk
    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;

    // DEAD catch removed (#2245 audit): _phaseDirNames.find(...) is a pure
    // array lookup on an already-resolved string array, and
    // countPhasePlansAndSummaries is itself fully defensive (its own
    // readdirSync is self-guarded, and it delegates to scanPhasePlans, which
    // never throws) — nothing in this block can throw, so the try/catch could
    // never be triggered.
    const dirMatch = _phaseDirNames.find(d => phaseTokenMatches(d, normalized));

    if (dirMatch) {
      const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatch));
      planCount = counts.planCount;
      summaryCount = counts.summaryCount;
      hasContext = counts.hasContext;
      hasResearch = counts.hasResearch;

      if (summaryCount >= planCount && planCount > 0) diskStatus = 'complete';
      else if (summaryCount > 0) diskStatus = 'partial';
      else if (planCount > 0) diskStatus = 'planned';
      else if (hasResearch) diskStatus = 'researched';
      else if (hasContext) diskStatus = 'discussed';
      else diskStatus = 'empty';
    }

    // Check ROADMAP checkbox status.
    // #3537: padding-tolerant fragment — the heading discovered above may use
    // a different padding than the summary-bullet checkbox below it (mixed
    // padding inside one ROADMAP is legal and seen in real projects).
    const checkboxPattern = new RegExp(`-\\s*\\[(x| )\\]\\s*.*Phase\\s+${phaseMarkdownRegexSource(phaseNum)}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`, 'i');
    const checkboxMatch = content.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? checkboxMatch[1] === 'x' : false;

    // If roadmap marks phase complete, trust that over disk file structure.
    // Phases completed before GSD tracking (or via external tools) may lack
    // the standard PLAN/SUMMARY pairs but are still done.
    if (roadmapComplete && diskStatus !== 'complete') {
      diskStatus = 'complete';
    }

    phases.push({
      number: phaseNum,
      name: phaseName,
      goal,
      mode,
      depends_on,
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
    });
  }

  // Extract milestone info
  const milestones: Array<{ heading: string; version: string }> = [];
  const milestonePattern = /##\s*(.*v(\d+(?:\.\d+)+)[^(\n]*)/gi;
  let mMatch: RegExpExecArray | null;
  while ((mMatch = milestonePattern.exec(content)) !== null) {
    milestones.push({
      heading: mMatch[1].trim(),
      version: 'v' + mMatch[2],
    });
  }

  // Find current and next phase
  const currentPhase = phases.find(p => p.disk_status === 'planned' || p.disk_status === 'partial') || null;
  const nextPhase = phases.find(p => p.disk_status === 'empty' || p.disk_status === 'no_directory' || p.disk_status === 'discussed' || p.disk_status === 'researched') || null;

  // Aggregated stats
  const totalPlans = phases.reduce((sum, p) => sum + p.plan_count, 0);
  const totalSummaries = phases.reduce((sum, p) => sum + p.summary_count, 0);
  const completedPhases = phases.filter(p => p.disk_status === 'complete').length;

  // Detect phases in summary list without detail sections (malformed ROADMAP).
  // The char class must allow `-` (not just `.`) so dash-separated milestone-prefixed
  // IDs (e.g. `1-01`) match the detail-heading scanner above; otherwise they truncate
  // at the dash (`1-01` -> `1`) and every such phase reports a phantom missing detail.
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const checklistPattern = /-\s*\[[ x]\]\s*\*\*Phase\s+(\d+[A-Z]?(?:[.-]\d+)*)/gi;
  const checklistPhases = new Set<string>();
  let checklistMatch: RegExpExecArray | null;
  while ((checklistMatch = checklistPattern.exec(content)) !== null) {
    checklistPhases.add(checklistMatch[1]);
  }
  const detailPhases = new Set(phases.map(p => p.number));
  const missingDetails = [...checklistPhases].filter(p => !detailPhases.has(p) && !isSentinelPhase(p));

  const result = {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
  };

  output(result, raw, undefined);
}

// ─── cmdRoadmapUpdatePlanProgress ─────────────────────────────────────────────

/**
 * Scope a ROADMAP.md content string down to its "Progress table" writable
 * slice, run `edit` against just that slice, then splice the result back into
 * the original content (ADR-2143 §7). Layered scoping:
 *   1. Milestone scope — everything after the LAST `</details>` close tag
 *      (mirrors `replaceInCurrentMilestone`), so a same-numbered phase row in
 *      an archived milestone is never touched.
 *   2. Heading scope — within that milestone slice, the `## Progress` heading
 *      section (up to the next `#`/`##` heading) when present, else the whole
 *      milestone slice (mirrors phase-lifecycle.cjs's `deriveProgressFromRoadmap`
 *      read-side scoping, #2012 decoy avoidance — a differently-headed table
 *      sharing the same column names must not be picked up instead).
 * `edit` always returns a string and never fails — a no-op edit (table/row not
 * found within the scoped slice) simply returns its input unchanged, mirroring
 * the prior regex `.replace()`'s no-match-is-a-no-op semantics.
 */
function editProgressTableSlice(content: string, edit: (scoped: string) => string): string {
  const lastDetailsClose = content.lastIndexOf('</details>');
  const milestoneOffset = lastDetailsClose === -1 ? 0 : lastDetailsClose + '</details>'.length;
  const before = content.slice(0, milestoneOffset);
  const milestoneSlice = content.slice(milestoneOffset);

  const progressMatch = milestoneSlice.match(/^##[ \t]+Progress\b/im);
  if (!progressMatch || progressMatch.index === undefined) {
    return before + edit(milestoneSlice);
  }

  const headingOffset = progressMatch.index;
  const beforeHeading = milestoneSlice.slice(0, headingOffset);
  const fromHeading = milestoneSlice.slice(headingOffset);
  const nextHeading = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeading >= 0 ? fromHeading.slice(0, nextHeading) : fromHeading;
  const after = nextHeading >= 0 ? fromHeading.slice(nextHeading) : '';

  return before + beforeHeading + edit(scoped) + after;
}

function cmdRoadmapUpdatePlanProgress(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap update-plan-progress');
  }

  const roadmapPath = planningPaths(cwd).roadmap;

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo!.plans.length;
  // Count only summaries that pair with a real plan (#1988): stray non-plan
  // summaries (30-FIX-CR02-SUMMARY.md, 30-GAPCLOSURE-SUMMARY.md, …) must not
  // inflate summary_count and silently flip the phase to Complete.
  const summaryCount = countMatchedSummaries(phaseInfo!.plans, phaseInfo!.summaries);

  if (planCount === 0) {
    output({ updated: false, reason: 'No plans found', plan_count: 0, summary_count: 0 }, raw, 'no plans');
    return;
  }

  // Verification gate (#2022): do NOT check the phase checkbox or stamp a
  // completion date until the phase's verification status is 'passed', matching
  // cmdPhaseComplete's gate (phase.cts:1436). Previously the checkbox fired the
  // moment the last plan summary landed — before gsd-verifier had verified.
  const phaseDir = path.join(cwd, phaseInfo!.directory);
  const verificationPassed = readVerificationStatus(phaseDir).status === 'passed';
  const isComplete = summaryCount >= planCount && verificationPassed;
  const status = isComplete ? 'Complete' : summaryCount > 0 ? 'In Progress' : 'Planned';
  const today = realClock.localToday();

  if (!fs.existsSync(roadmapPath)) {
    output({ updated: false, reason: 'ROADMAP.md not found', plan_count: planCount, summary_count: summaryCount }, raw, 'no roadmap');
    return;
  }

  // Wrap entire read-modify-write in lock to prevent concurrent corruption
  withPlanningLock(cwd, () => {
    let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const phasePattern = phaseMarkdownRegexSource(phaseNum);

    // Progress table row: update Plans Complete/Status/Completed columns BY
    // COLUMN NAME (handles 4- or 5-column RoadmapProgress tables regardless of
    // Milestone-column presence) via the markdown-table seam (ADR-2143 §7) —
    // supersedes the prior ordinal cells[]-index regex. Scoped to the current
    // milestone's `## Progress` table (editProgressTableSlice above).
    // #2245 Blocker 4: optional dot must be followed by whitespace-or-end, not
    // dot-OR-whitespace-OR-end as alternatives — the prior form let a bare "."
    // satisfy the whole lookahead, so completing phase "2" over-matched a
    // decimal sub-phase row like "2.5 Extra". Matches "2", "2.", "2 Alpha";
    // rejects "2.5 Extra" (replicates OLD's `\.?\s` intent on the now-TRIMMED
    // cell value, where end-of-string is the trimmed equivalent of "no more
    // characters after the optional dot").
    const phaseCellRe = new RegExp(`^${phasePattern}\\.?(?:\\s|$)`, 'i');
    const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;

    roadmapContent = editProgressTableSlice(roadmapContent, (scoped) => {
      let text = scoped;

      const plansResult = updateTableCell(text, rowMatch, 'Plans Complete', ` ${summaryCount}/${planCount} `);
      if (plansResult.ok) text = plansResult.value;

      const statusResult = updateTableCell(text, rowMatch, 'Status', ` ${status.padEnd(11)}`);
      if (statusResult.ok) text = statusResult.value;

      // Preserve only a valid ISO date (#1161: idempotent; self-heal garbage).
      // Ragged-tolerant (#2245 Blocker 2): probe the CURRENT Completed cell via
      // a no-op updateTableCell write (its own tolerant row scan) rather than
      // findTableWithColumns (which requires the WHOLE table to parse — a
      // ragged SIBLING row elsewhere used to silently no-op this row's date
      // stamp/clear too). The decision (write vs no-op) is folded into the
      // newValue callback so a single updateTableCell call both reads and
      // writes.
      const completedResult = updateTableCell(text, rowMatch, 'Completed', (current) => {
        if (isComplete) {
          return dateShape.test(current.trim()) ? current : ` ${today} `;
        }
        return '  ';
      });
      if (completedResult.ok) text = completedResult.value;

      return text;
    });

    // Update plan count in phase detail section.
    // Three recognised forms (all tolerated; canonical template uses the first):
    //   `**Plans**: N plans`  — bold word + outer colon (gsd-core/templates/roadmap.md)
    //   `**Plans:** N plans`  — bold "Plans:" (colon inside bold)
    //   `Plans: N plans`      — plain text header
    const planCountPattern = new RegExp(
      `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:\\*\\*Plans\\*\\*:|\\*\\*Plans:\\*\\*|(?:^|\\n)Plans:)\\s*)[^\\n]+`,
      'i'
    );
    const planCountText = isComplete
      ? `${summaryCount}/${planCount} plans complete`
      : `${summaryCount}/${planCount} plans executed`;
    roadmapContent = replaceInCurrentMilestone(roadmapContent, planCountPattern, `$1${planCountText}`);

    // If complete: check checkbox
    if (isComplete) {
      const checkboxPattern = new RegExp(
        `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
        'i'
      );
      roadmapContent = replaceInCurrentMilestone(roadmapContent, checkboxPattern, `$1x$2 (completed ${today})`);
    }

    // Mark completed plan checkboxes (e.g. "- [ ] 50-01-PLAN.md", "- [ ] 50-01:", or "- [ ] **50-01**")
    for (const summaryFile of phaseInfo!.summaries) {
      const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      if (!planId) continue;
      const planEscaped = escapeRegex(planId);
      const planCheckboxPattern = new RegExp(
        `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
        'i'
      );
      roadmapContent = roadmapContent.replace(planCheckboxPattern, '$1x$2');
    }

    // Compute the active (post-</details>) region offset ONCE.  Both the
    // missing-plan DETECTION and the row INSERTION must use the same active
    // region string so that a plan row that exists only in an archived <details>
    // block is not counted as "already present" in the active milestone section.
    // (Finding 1 code-review: detection was previously running against the full
    //  roadmapContent, causing archived rows to suppress active-section inserts.)
    const lastDetailsClose = roadmapContent.lastIndexOf('</details>');
    const activeRegion = lastDetailsClose === -1
      ? roadmapContent
      : roadmapContent.slice(lastDetailsClose + '</details>'.length);

    // Compute which plan files are MISSING a checkbox row in the ACTIVE region.
    // This handles three cases:
    //   (a) Fresh template — no rows at all: all plans are missing.
    //   (b) Partial gap — some rows exist, others don't: only the absent ones.
    //   (c) All rows present — nothing to insert (idempotent).
    //
    // Detection is scoped to the active region so a plan that appears in an
    // archived <details> block is still correctly detected as missing from the
    // active milestone section.
    const missingPlans = phaseInfo!.plans.filter((planFile) => {
      const planEscaped = escapeRegex(planFile);
      return !new RegExp(`-\\s*\\[[x ]\\]\\s*(?:\\*\\*)?${planEscaped}`, 'i').test(activeRegion);
    });

    if (missingPlans.length > 0) {
      // Insert missing plan checklist rows (#1163).  We prefer to anchor to the
      // bare `Plans:` checklist header (canonical template form) and fall back to
      // the bold `**Plans**:`/`**Plans:**` summary line only when no bare header
      // is present.  Using two separate patterns avoids the lazy-quantifier trap
      // where a single alternation would stop at the first matching alternative
      // (the bold summary) before reaching the checklist header.
      //
      // Canonical template (gsd-core/templates/roadmap.md) uses BOTH lines:
      //   **Plans**: N plans   ← summary (colon outside bold)
      //   Plans:               ← checklist header (PREFERRED insertion anchor)
      // Rows must land after `Plans:`, not between the summary and the header.
      //
      // Pattern A: anchor to bare `Plans:` header (preferred).
      // Pattern B: fallback to bold summary when no bare header exists.
      const insertRowsPatternA = new RegExp(
        `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:^|\\n)(?:Plans:)[^\\n]*)`,
        'i'
      );
      const insertRowsPatternB = new RegExp(
        `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:\\*\\*Plans\\*\\*:|\\*\\*Plans:\\*\\*)[^\\n]*)`,
        'i'
      );

      const sortedMissing = [...missingPlans].sort();
      const newRows = sortedMissing.map(p => `- [ ] ${p}`).join('\n');
      const inserter = (match: string) => `${match}\n${newRows}`;

      // Scope insertion to the active (post-</details>) milestone region to
      // prevent duplicate phase headings in archived sections from receiving rows.
      // replaceInCurrentMilestone only accepts a string replacement, so we
      // perform the scoped replace manually here (same strategy as that helper).
      // Note: lastDetailsClose was computed above (shared with detection).
      const scopedReplace = (src: string, pat: RegExp) => src.replace(pat, inserter);
      let withRows: string;
      if (lastDetailsClose === -1) {
        // activeRegion === roadmapContent when there are no </details> blocks.
        const regionA = scopedReplace(activeRegion, insertRowsPatternA);
        withRows = regionA !== activeRegion ? regionA : scopedReplace(activeRegion, insertRowsPatternB);
      } else {
        const beforeDetails = roadmapContent.slice(0, lastDetailsClose + '</details>'.length);
        const regionA = scopedReplace(activeRegion, insertRowsPatternA);
        const afterWithRows = regionA !== activeRegion ? regionA : scopedReplace(activeRegion, insertRowsPatternB);
        withRows = beforeDetails + afterWithRows;
      }
      if (withRows !== roadmapContent) {
        roadmapContent = withRows;
        // Mark any newly-inserted rows that already have summaries as complete
        for (const summaryFile of phaseInfo!.summaries) {
          const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
          if (!planId) continue;
          const planEscaped = escapeRegex(planId);
          const planCheckboxPattern = new RegExp(
            `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
            'i'
          );
          roadmapContent = roadmapContent.replace(planCheckboxPattern, '$1x$2');
        }
      }
    }

    platformWriteSync(roadmapPath, roadmapContent);
  });
  output({
    updated: true,
    phase: phaseNum,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
  }, raw, `${summaryCount}/${planCount} ${status}`);
}

// ─── cmdRoadmapAnnotateDependencies ───────────────────────────────────────────

/**
 * Annotate the ROADMAP.md plan list for a phase with wave dependency notes
 * and a cross-cutting constraints subsection derived from PLAN frontmatter.
 *
 * Wave dependency notes: "Wave 2 — blocked on Wave 1 completion" inserted as
 * bold headers before each wave group in the plan checklist.
 *
 * Cross-cutting constraints: must_haves.truths strings that appear in 2+ plans
 * are surfaced in a "Cross-cutting constraints" subsection below the plan list.
 *
 * The operation is idempotent: if wave headers already exist in the section
 * the function returns without modifying the file.
 */
function cmdRoadmapAnnotateDependencies(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap annotate-dependencies');
  }

  const roadmapPath = planningPaths(cwd).roadmap;
  if (!fs.existsSync(roadmapPath)) {
    output({ updated: false, reason: 'ROADMAP.md not found' }, raw, 'no roadmap');
    return;
  }

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo || phaseInfo.plans.length === 0) {
    output({ updated: false, reason: 'no plans found for phase', phase: phaseNum }, raw, 'no plans');
    return;
  }

  // Read each PLAN.md and extract wave + must_haves.truths
  const planData: Array<{ planFile: string; planId: string; wave: number; truths: unknown[] }> = [];
  for (const planFile of phaseInfo.plans) {
    const planPath = path.join(path.resolve(cwd, phaseInfo.directory), planFile);
    try {
      const content = fs.readFileSync(planPath, 'utf-8');
      const fm = extractFrontmatter(content);
      const wave = parseInt(fm.wave as string, 10) || 1;
      const planId = planFile.replace(/-PLAN\.md$/i, '').replace(/PLAN\.md$/i, '');
      const truths = parseMustHavesBlock(content, 'truths') || [];
      planData.push({ planFile, planId, wave, truths });
    } catch { /* skip unreadable plans */ }
  }

  if (planData.length === 0) {
    output({ updated: false, reason: 'could not read plan frontmatter' }, raw, 'no frontmatter');
    return;
  }

  // Group plans by wave (sorted)
  const waveGroups = new Map<number, typeof planData>();
  for (const p of planData) {
    if (!waveGroups.has(p.wave)) waveGroups.set(p.wave, []);
    waveGroups.get(p.wave)!.push(p);
  }
  const waves = [...waveGroups.keys()].sort((a, b) => a - b);

  // Find cross-cutting truths: appear in 2+ plans (de-duplicated, case-insensitive).
  //
  // Issue #2770: must **coerce, not skip**. A previous guard
  // `if (typeof t !== 'string') continue` silently dropped numeric scalars
  // (YAML ints like `- 3`) and kv-shaped truths (`- title: X`), so the
  // cross-cutting analysis lost real constraints rather than crashing on
  // `t.trim()`. We coerce primitives via `String(t)` and extract a sensible
  // string field from object-shaped items produced by parseMustHavesBlock's
  // continuation-kv path (issue #2757 produces those shapes for nested keys).
  const truthCounts = new Map<string, TruthValue>();
  for (const { truths } of planData) {
    const seen = new Set<string>();
    for (const t of truths) {
      const text = coerceTruthToString(t);
      if (!text) continue;
      const trimmed = text.trim();
      const key = trimmed.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!truthCounts.has(key)) truthCounts.set(key, { count: 0, text: trimmed });
      truthCounts.get(key)!.count++;
    }
  }
  const crossCuttingTruths = [...truthCounts.values()]
    .filter(v => v.count >= 2)
    .map(v => v.text);

  // Patch ROADMAP.md
  let updated = false;
  withPlanningLock(cwd, () => {
    const content = fs.readFileSync(roadmapPath, 'utf-8');

    // Find the phase section.
    // #3537: padding-tolerant fragment so the caller's resolved padded id
    // matches un-padded ROADMAP headings.
    const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
    const phaseHeaderPattern = new RegExp(`(#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*)`, 'i');
    const phaseMatch = content.match(phaseHeaderPattern);
    if (!phaseMatch) return;

    const phaseStart = phaseMatch.index!;
    const restAfterHeader = content.slice(phaseStart);
    const nextPhaseOffset = restAfterHeader.slice(1).search(/\n#{2,4}\s+Phase\s+\d/i);
    const phaseEnd = nextPhaseOffset >= 0 ? phaseStart + 1 + nextPhaseOffset : content.length;
    const phaseSection = content.slice(phaseStart, phaseEnd);

    // Idempotency: skip if annotation markers already present
    if (
      /\*\*Wave\s+\d+/i.test(phaseSection) ||
      /\*\*Cross-cutting constraints:\*\*/i.test(phaseSection)
    ) return;

    // Find the Plans: section within the phase section.
    // #3691 Bug 1: `Plans:\s*\n` required no text after the colon, missing variants like
    // `Plans: 3 plans across 2 waves\n` or `**Plans:** 3 plans\n` (bold-wrapped).
    // `\*{0,2}Plans\*{0,2}:[^\n]*\n` accepts any text (or none) after the colon
    // and tolerates optional `**` markdown bold wrappers on either side.
    // The checklist group uses `+` (not `*`) so that a bold `**Plans:**` description
    // line with no immediately-following checklist items (e.g. a summary line above a
    // separate bare `Plans:` block) does not consume the match and prevent the actual
    // list from being found.
    // Review fix (F2): `(?:^|\n)` anchors the match to start-of-line so mid-line
    // occurrences like `***Plans:***` embedded in a sentence or `OpenPlans: foo`
    // do not trigger a false match. Groups 1 and 2 retain the same semantics.
    const plansBlockMatch = phaseSection.match(/(?:^|\n)(\*{0,2}Plans\*{0,2}:[^\n]*\n)((?:\s*-\s*\[[ x]\][^\n]*\n?)+)/i);
    if (!plansBlockMatch) return;

    const plansHeader = plansBlockMatch[1];
    const existingList = plansBlockMatch[2];
    const listLines = existingList.split('\n').filter(l => /^\s*-\s*\[/.test(l));

    if (listLines.length === 0) return;

    // #314 perf: build a first-wins Map so per-line lookup is O(1) instead of O(plans).
    // First-wins mirrors .find() semantics: if the same planId appears more than once
    // in planData, the earlier entry wins — identical to what .find() returned before.
    const planById = new Map<string, typeof planData[number]>();
    for (const p of planData) {
      if (!planById.has(p.planId)) planById.set(p.planId, p);
    }

    // Build wave-annotated plan list
    const linesByWave = new Map<number, string[]>();
    for (const line of listLines) {
      // Match plan ID from line: "- [ ] 01-01-PLAN.md — ..." or "- [ ] 01-01: ..."
      // #3691 Bug 3: `[\w-]+?` excluded `.`, so decimal IDs like `02.3-01` were captured
      // as `02` only and never matched planData entries. `[\w.-]+?` preserves the
      // terminating alternation (`-PLAN.md|.md|:|\s—`) as the boundary anchor.
      const idMatch = line.match(/\[\s*[x ]\s*\]\s*([\w.-]+?)(?:-PLAN\.md|\.md|:|\s—)/i);
      const planId = idMatch ? idMatch[1] : null;
      // Review fix (F3): reject malformed IDs that start with `.`, contain consecutive
      // dots, or otherwise violate the `^\w[\w.-]*$` contract. A leading-dot ID
      // (e.g. `.invalid-PLAN.md`) would silently default to wave 1 — defensively
      // skip the line instead so corrupted ROADMAP entries don't corrupt wave layout.
      if (planId && !/^\w[\w.-]*$/.test(planId)) continue;
      const planEntry = planId ? (planById.get(planId) || null) : null;
      const wave = planEntry ? planEntry.wave : 1;
      if (!linesByWave.has(wave)) linesByWave.set(wave, []);
      linesByWave.get(wave)!.push(line);
    }

    const annotatedLines: string[] = [];
    const sortedWaves = [...linesByWave.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sortedWaves.length; i++) {
      const w = sortedWaves[i];
      const waveLines = linesByWave.get(w)!;
      if (sortedWaves.length > 1) {
        const dep = i > 0 ? ` *(blocked on Wave ${sortedWaves[i - 1]} completion)*` : '';
        annotatedLines.push(`**Wave ${w}**${dep}`);
      }
      annotatedLines.push(...waveLines);
      if (i < sortedWaves.length - 1) annotatedLines.push('');
    }

    // Append cross-cutting constraints subsection if any found
    if (crossCuttingTruths.length > 0) {
      annotatedLines.push('');
      annotatedLines.push('**Cross-cutting constraints:**');
      for (const t of crossCuttingTruths) {
        annotatedLines.push(`- ${t}`);
      }
    }

    const newListBlock = annotatedLines.join('\n') + '\n';
    // #1103: when `(?:^|\n)` consumed a leading `\n` (mid-string match), re-emit it
    // so the line preceding the Plans: header is not fused onto it.
    const leadingNewline = plansBlockMatch[0].startsWith('\n') ? '\n' : '';
    const newPhaseSection = phaseSection.replace(
      plansBlockMatch[0],
      leadingNewline + plansHeader + newListBlock
    );

    const nextContent = content.slice(0, phaseStart) + newPhaseSection + content.slice(phaseEnd);
    if (nextContent === content) return;
    platformWriteSync(roadmapPath, nextContent);
    updated = true;
  });

  output({
    updated,
    phase: phaseNum,
    waves: waves.length,
    cross_cutting_constraints: crossCuttingTruths.length,
  }, raw, updated ? `annotated ${waves.length} wave(s), ${crossCuttingTruths.length} constraint(s)` : 'skipped (already annotated or no plan list)');
}

export = {
  cmdRoadmapGetPhase,
  getRoadmapPhaseWithFallback,
  cmdRoadmapAnalyze,
  cmdRoadmapUpdatePlanProgress,
  cmdRoadmapAnnotateDependencies,
};
