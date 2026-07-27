/**
 * Phase — Phase CRUD, query, and lifecycle operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/phase.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 *
 * Re-export shim note (issue #4 / ADR-3524):
 *   The phase lifecycle pure-computation helpers live in phase-lifecycle.cjs.
 *   cmdPhaseComplete uses
 *   deriveProgressFromRoadmap + clampPercent from that module to fix the
 *   non-idempotent Completed Phases blind-increment bug.
 *
 *   The async mutation handlers (phaseAdd, phaseInsert, phaseRemove, phaseComplete)
 *   in phase-lifecycle.ts are I/O-bound and remain per-side per ADR-3524 Section 4.
 *   This file provides the CJS (sync) implementations of those handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal, readSubdirectories } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const {
  escapeRegex,
  normalizePhaseName,
  phaseMarkdownRegexSource,
  comparePhaseNum,
  phaseTokenMatches,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
} = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal, getArchivedPhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, getMilestonePhaseFilter, currentMilestoneRawRanges, withPhaseSection } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { updateTableCell, deleteTableRow, escapeCell } from './markdown-table.cjs';
import { deleteSection, updateBullet } from './markdown-sectionizer.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat-predicate.cjs is an export= CommonJS module
import uatPredicate = require('./uat-predicate.cjs');
const { evaluateUatPassed } = uatPredicate;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
const { readVerificationStatus } = verificationMod;

const { planningDir, withPlanningLock, listAvailableWorkstreams, getActiveWorkstream } =
  planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
const {
  readModifyWriteStateMd,
  stateExtractField,
  stateReplaceField,
  syncStateFrontmatter,
  withStateLock,
  updatePerformanceMetricsSection,
} = stateMod;

// #2893 — strict canonical filter: `{padded_phase}-{NN}-PLAN.md` or `PLAN.md`.
const isCanonicalPlanFile = (f: string): boolean => f.endsWith('-PLAN.md') || f === 'PLAN.md';

// Any .md file with PLAN anywhere in the basename — diagnostic net
const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
const looksLikePlanFile = (f: string): boolean =>
  /\.md$/i.test(f) &&
  /PLAN/i.test(f) &&
  !PLAN_OUTLINE_RE.test(f) &&
  !PLAN_PRE_BOUNCE_RE.test(f);

/**
 * Scope an `updateTableCell` call to the `## Traceability` (or
 * `## Traceability Status`) heading's own section — up to the next H1/H2
 * heading — instead of handing it the WHOLE REQUIREMENTS.md content.
 *
 * F1 (#2245 review, BLOCKER): `updateTableCell` binds to the FIRST GFM table
 * found in whatever text it is given. The shipped requirements template
 * (gsd-core/templates/requirements.md) puts an `## Out of Scope` table
 * (`| Feature | Reason |`, no `Status` column) BEFORE `## Traceability` — so
 * an unscoped whole-file call targets the Out-of-Scope table instead, fails
 * with `{ok:false, reason:'unknown column: Status'}`, and the real
 * Traceability row is never flipped, while the checkbox surface still flips
 * and the command reports success (the #2140 silent-divergence class one
 * level deeper). Mirrors `editProgressHeadingSlice` below, which scopes
 * `## Progress` writes to that heading's own slice for the same reason.
 *
 * Falls back to running `updateTableCell` against the whole `text` when no
 * `## Traceability` heading exists — matching the previous (unscoped)
 * behaviour for a REQUIREMENTS.md whose traceability table sits under some
 * other heading, or with no heading at all (never worse than before this fix).
 */
function updateTraceabilityCell(
  text: string,
  match: (row: Record<string, string>, index: number) => boolean,
  column: string,
  newValue: string | ((current: string) => string),
): ReturnType<typeof updateTableCell> {
  const headingMatch = text.match(/^##[ \t]+Traceability(?:[ \t]+Status)?\b/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return updateTableCell(text, match, column, newValue);
  }
  const headingOffset = headingMatch.index;
  const before = text.slice(0, headingOffset);
  const fromHeading = text.slice(headingOffset);
  const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
  const after = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

  const result = updateTableCell(scoped, match, column, newValue);
  if (!result.ok) return result;
  return { ok: true, value: before + result.value + after };
}

/**
 * Extract the MAJOR version segment from a version-ish string: "v1", "v1.3",
 * "V1.0", and "1.0" all yield "1"; "v2" yields "2". Used (#2334 BLOCKER fix)
 * to compare a `## v<N> ...` REQUIREMENTS.md heading against the current
 * milestone's version at MAJOR-version granularity only — "v1" heading vs
 * milestone "v1.3" is the SAME major version and must not be treated as a
 * version mismatch. Returns null when `raw` has no leading digit run (not a
 * version-shaped string), which the caller treats as "cannot resolve".
 */
function extractMajorVersion(raw: string): string | null {
  const m = raw.trim().match(/^v?(\d+)/i);
  return m ? m[1] : null;
}

function describeNonCanonicalPlans(dirFiles: string[], matchedFiles: string[]): string | null {
  const matched = new Set(matchedFiles);
  const offenders = dirFiles.filter((f) => looksLikePlanFile(f) && !matched.has(f));
  if (offenders.length === 0) return null;
  return (
    `Found ${offenders.length} plan-shaped file(s) in this phase that don't match the canonical ` +
    `naming convention "{padded_phase}-{NN}-PLAN.md" (or bare "PLAN.md") and were skipped: ` +
    offenders.map((f) => `"${f}"`).join(', ') +
    `. Rename to the canonical form (e.g. "01-01-PLAN.md") so the executor can detect them. ` +
    `See agents/gsd-planner.md write_phase_prompt step for the full contract.`
  );
}

function extractCanonicalPlanId(filename: string): string {
  const base = filename
    .replace(/-PLAN\.md$/i, '')
    .replace(/-SUMMARY\.md$/i, '')
    .replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  // #2043: a phase/plan token component is either a zero-padded number (≥2 digits)
  // or a single-digit-plus-letter id ("3A"); a *bare* single digit is a slug word,
  // so "46-6-rs-…" is not paired into a "46-6" id while "3A-01" stays intact.
  const tokenRe = /^(?:\d{2,}[A-Z]?|\d[A-Z])(?:\.\d+)*$/i;
  // #2232: the PAIRED plan component is a zero-padded continuation segment
  // (exactly 2 digits), so a ≥3-digit slug word (a year) is not paired into a
  // bogus "14-2026" id. The leading phase component keeps tokenRe's unbounded
  // \d{2,} — phase numbers ≥100 are legitimate; only continuations are capped.
  const planTokenRe = new RegExp(
    `^(?:${phaseIdMod.PHASE_CONTINUATION_SEGMENT_SOURCE}[A-Z]?|\\d[A-Z])(?:\\.\\d+)*$`,
    'i',
  );
  const phaseIdx = parts.findIndex((p) => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && planTokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
}

interface PhaseListOptions {
  type?: string;
  phase?: string;
  includeArchived?: boolean;
}

function cmdPhasesList(cwd: string, options: PhaseListOptions, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const { type, phase, includeArchived } = options;

  if (!fs.existsSync(phasesDir)) {
    if (type) {
      output({ files: [], count: 0 }, raw, '');
    } else {
      output({ directories: [], count: 0 }, raw, '');
    }
    return;
  }

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    let dirs: string[] = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    if (includeArchived) {
      const archived = getArchivedPhaseDirs(cwd);
      for (const a of archived) {
        dirs.push(`${a.name} [${a.milestone}]`);
      }
    }

    dirs.sort((a, b) => comparePhaseNum(a, b));

    if (phase) {
      const normalized = normalizePhaseName(phase);
      const match = dirs.find((d) => phaseTokenMatches(d, normalized));
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    }

    if (type) {
      const files: string[] = [];
      const warnings: string[] = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered: string[];
        if (type === 'plans') {
          filtered = dirFiles.filter(isCanonicalPlanFile);
          const w = describeNonCanonicalPlans(dirFiles, filtered);
          if (w) warnings.push(`${dir}: ${w}`);
        } else if (type === 'summaries') {
          filtered = dirFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result: Record<string, unknown> = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
      };
      if (warnings.length) result['warning'] = warnings.join(' | ');
      output(result, raw, files.join('\n'));
      return;
    }

    output({ directories: dirs, count: dirs.length }, raw, dirs.join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to list phases: ' + msg);
  }
}

function cmdPhaseNextDecimal(cwd: string, basePhase: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(basePhase);

  try {
    let baseExists = false;
    const decimalSet = new Set<number>();

    if (fs.existsSync(phasesDir)) {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      baseExists = dirs.some((d) => phaseTokenMatches(d, normalized));

      const dirPattern = new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${escapeRegex(normalized)}\\.(\\d+)`);
      for (const dir of dirs) {
        const match = dir.match(dirPattern);
        if (match) decimalSet.add(parseInt(match[1], 10));
      }
    }

    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      try {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const phasePattern = new RegExp(
          `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalized)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
          'gi',
        );
        let pm: RegExpExecArray | null;
        while ((pm = phasePattern.exec(roadmapContent)) !== null) {
          decimalSet.add(parseInt(pm[1], 10));
        }
      } catch {
        /* ROADMAP.md read failure is non-fatal */
      }
    }

    const existingDecimals = Array.from(decimalSet)
      .sort((a, b) => a - b)
      .map((n) => `${normalized}.${n}`);

    let nextDecimal: string;
    if (decimalSet.size === 0) {
      nextDecimal = `${normalized}.1`;
    } else {
      nextDecimal = `${normalized}.${Math.max(...decimalSet) + 1}`;
    }

    output(
      {
        found: baseExists,
        base_phase: normalized,
        next: nextDecimal,
        existing: existingDecimals,
      },
      raw,
      nextDecimal,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to calculate next decimal phase: ' + msg);
  }
}

function getRoadmapModeForPhase(cwd: string, phaseNum: string): string | null {
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);
  const escapedPhase = phaseMarkdownRegexSource(phaseNum);
  const phaseHeader = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`, 'i');

  for (const content of [milestoneContent, fullContent]) {
    const headerMatch = content.match(phaseHeader);
    if (!headerMatch || headerMatch.index === undefined) continue;

    const sectionStart = headerMatch.index;
    const rest = content.slice(sectionStart);
    const nextHeader = rest.slice(headerMatch[0].length).match(/\n#{2,4}\s+Phase\s+\S/i);
    const sectionEnd = nextHeader
      ? sectionStart + headerMatch[0].length + (nextHeader.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    if (modeMatch) return modeMatch[1].trim().toLowerCase();
  }

  return null;
}

function cmdPhaseMvpMode(cwd: string, args: string[], raw: boolean): void {
  const phaseNum = args[0];
  if (!phaseNum) {
    error('Usage: phase.mvp-mode <phase-number> [--cli-flag]', ERROR_REASON.USAGE);
  }

  const cliFlagPresent = args.includes('--cli-flag');
  const roadmapMode = getRoadmapModeForPhase(cwd, phaseNum);
  const config = loadConfig(cwd);
  const configMvpMode = Boolean(config.mvp_mode);

  let active = false;
  let source = 'none';
  if (cliFlagPresent) {
    active = true;
    source = 'cli_flag';
  } else if (roadmapMode === 'mvp') {
    active = true;
    source = 'roadmap';
  } else if (configMvpMode) {
    active = true;
    source = 'config';
  }

  output(
    {
      active,
      source,
      roadmap_mode: roadmapMode,
      config_mvp_mode: configMvpMode,
      cli_flag_present: cliFlagPresent,
    },
    raw,
  );
}

function cmdFindPhase(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase identifier required');
  }

  const planBase = planningDir(cwd);
  const normalized = normalizePhaseName(phase);
  const notFound = {
    found: false,
    directory: null,
    phase_number: null,
    phase_name: null,
    plans: [],
    summaries: [],
    searched_directories: [] as string[],
  };

  const searchDirs: string[] = [];
  const flatPhasesDir = path.join(planBase, 'phases');
  if (fs.existsSync(flatPhasesDir)) searchDirs.push(flatPhasesDir);
  try {
    const milestonesDir = path.join(planBase, 'milestones');
    const entries = fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^v\d+.*-phases$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      searchDirs.push(path.join(milestonesDir, e.name));
    }
  } catch {
    /* no milestones dir */
  }

  notFound.searched_directories = searchDirs.map((searchDir) =>
    toPosixPath(
      path.join(path.relative(cwd, planBase), path.relative(planBase, searchDir)),
    ),
  );

  for (const searchDir of searchDirs) {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      // #2237: fail loud when multiple directories match the same bare phase
      // number — prevents cross-project file writes when unrelated projects
      // share a .planning/phases/ tree.
      const matches = dirs.filter((d) => phaseTokenMatches(d, normalized));
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        output({
          ...notFound,
          ambiguous_matches: matches,
          warning: `Phase ${normalized} is ambiguous: ${matches.length} directories match (${matches.map(m => `"${m}"`).join(', ')}). Set a distinct project_code in .planning/config.json to scope resolution.`,
        }, raw, '');
        return;
      }
      const match = matches[0];

      const dirMatch =
        match.match(
          new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i')
        ) || match.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
      const phaseNumber = dirMatch ? dirMatch[1] : normalized;
      const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;

      const phaseDir = path.join(searchDir, match);
      const phaseFiles = fs.readdirSync(phaseDir);
      const plans = phaseFiles.filter(isCanonicalPlanFile).sort();
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').sort();
      const planNamingWarning = describeNonCanonicalPlans(phaseFiles, plans);

      const result: Record<string, unknown> = {
        found: true,
        directory: toPosixPath(
          path.join(
            path.relative(cwd, planBase),
            path.relative(planBase, searchDir),
            match,
          ),
        ),
        phase_number: phaseNumber,
        phase_name: phaseName,
        plans,
        summaries,
      };
      if (planNamingWarning) result['warning'] = planNamingWarning;

      output(result, raw, result['directory']);
      return;
    } catch {
      continue;
    }
  }

  output(notFound, raw, '');
}

function extractObjective(content: string): string | null {
  const m = content.match(/<objective>\s*\n?\s*(.+)/);
  return m ? m[1].trim() : null;
}

interface RawPlan {
  id: string;
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  objective: string | null;
  filesModified: string[];
  taskCount: number;
  hasSummary: boolean;
}

// O(V + E). Assigns each in-phase plan its longest-path topological level over the
// in-phase dependsOn DAG (Kahn's algorithm). Returns { level: Map<id,number>, visited: number }.
// visited < rawPlans.length signals a dependency cycle.
function computeDependencyLevels(
  rawPlans: RawPlan[],
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
): { level: Map<string, number>; visited: number } {
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const p of rawPlans) {
    if (!inDeg.has(p.id)) inDeg.set(p.id, 0);
    if (!adj.has(p.id)) adj.set(p.id, []);
    for (const dep of p.dependsOn) {
      const depLower = dep.toLowerCase();
      const resolvedDep = planMap.has(depLower)
        ? (planMap.get(depLower) as RawPlan).id
        : canonicalToId.get(depLower);
      if (!resolvedDep) continue;
      if (!adj.has(resolvedDep)) adj.set(resolvedDep, []);
      (adj.get(resolvedDep) as string[]).push(p.id);
      inDeg.set(p.id, (inDeg.get(p.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const p of rawPlans) {
    if ((inDeg.get(p.id) ?? 0) === 0) {
      queue.push(p.id);
      level.set(p.id, 0);
    }
  }

  // Dequeue by head index (queue[head++]), NOT Array.shift(): shift() is O(n) per
  // call in V8. Head-index dequeue is O(1) amortized -> O(V+E) overall. (#307)
  let head = 0;
  let visited = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    visited++;
    const curLevel = level.get(cur) as number;
    for (const dep of adj.get(cur) ?? []) {
      const newLevel = curLevel + 1;
      if (newLevel > (level.get(dep) ?? -1)) {
        level.set(dep, newLevel);
      }
      inDeg.set(dep, (inDeg.get(dep) as number) - 1);
      if (inDeg.get(dep) === 0) {
        queue.push(dep);
      }
    }
  }

  return { level, visited };
}

function cmdPhasePlanIndex(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  let phaseDir: string | null = null;
  let phaseDirName: string | null = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => phaseTokenMatches(d, normalized));
    if (match) {
      phaseDir = path.join(phasesDir, match);
      phaseDirName = match;
    }
  } catch {
    // phases dir doesn't exist
  }

  if (!phaseDir) {
    output(
      { phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], has_checkpoints: false },
      raw,
    );
    return;
  }
  void phaseDirName; // used only to set phaseDir above

  const phaseFiles = fs.readdirSync(phaseDir);
  const planFiles = phaseFiles.filter(isCanonicalPlanFile).sort();
  const summaryFiles = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
  const planNamingWarning = describeNonCanonicalPlans(phaseFiles, planFiles);

  const completedPlanIds = new Set(
    summaryFiles.flatMap((s) => {
      const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      const canonical = extractCanonicalPlanId(s);
      return canonical === exact ? [exact] : [exact, canonical];
    }),
  );

  // ── Pass 1: parse each plan file ─────────────────────────────────────────

  const rawPlans: RawPlan[] = [];

  for (const planFile of planFiles) {
    const planId = planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    // Pass planPath so a truncated PLAN.md names the file in the #1882 diagnostic.
    const fm = extractFrontmatter(content, planPath);

    const xmlTasks = content.match(/<task[\s>]/gi) || [];
    const mdTasks = content.match(/##\s*Task\s*\d+/gi) || [];
    const taskCount = xmlTasks.length || mdTasks.length;

    const parsedWave = parseInt(fm['wave'] as string, 10);
    const declaredWave = Number.isNaN(parsedWave) ? null : parsedWave;

    let dependsOn: string[] = [];
    const fmDeps = fm['depends_on'];
    if (Array.isArray(fmDeps)) {
      dependsOn = fmDeps.map(String);
    } else if (typeof fmDeps === 'string' && fmDeps.trim() !== '') {
      dependsOn = [fmDeps];
    }

    let autonomous = true;
    if (fm['autonomous'] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
      autonomous = fm['autonomous'] === 'true' || String(fm['autonomous']) === 'true';
    }

    let filesModified: string[] = [];
    const fmFiles = fm['files_modified'] || fm['files-modified'];
    if (fmFiles) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
      filesModified = Array.isArray(fmFiles) ? fmFiles.map(String) : [String(fmFiles)];
    }

    const hasSummary =
      completedPlanIds.has(planId) || completedPlanIds.has(extractCanonicalPlanId(planFile));

    rawPlans.push({
      id: planId,
      declaredWave,
      dependsOn,
      autonomous,
      objective: extractObjective(content) || (fm['objective'] as string | null) || null,
      filesModified,
      taskCount,
      hasSummary,
    });
  }

  // ── Pass 2: topological level assignment via depends_on DAG ──────────────

  const seenLower = new Map<string, string>();
  for (const p of rawPlans) {
    const lower = p.id.toLowerCase();
    const existing = seenLower.get(lower);
    if (existing !== undefined) {
      error(
        `depends_on index collision in phase ${normalized}: plan IDs '${existing}' and '${p.id}' are identical when case-folded. Rename one file to avoid ambiguous dependency resolution.`,
      );
      return;
    }
    seenLower.set(lower, p.id);
  }

  const planMap = new Map(rawPlans.map((p) => [p.id.toLowerCase(), p]));
  const canonicalToId = new Map(
    rawPlans.map((p) => [extractCanonicalPlanId(p.id).toLowerCase(), p.id]),
  );

  const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);

  if (visited < rawPlans.length) {
    const cycleNodes = rawPlans.filter((p) => !level.has(p.id)).map((p) => p.id);
    error(
      `depends_on cycle detected in phase ${normalized} — cycle involves: ${cycleNodes.join(', ')}`,
    );
    return;
  }

  // ── Pass 3: determine lowest bucket key and build output ─────────────────

  const anyWaveZero = rawPlans.some((p) => p.declaredWave === 0);
  const levelOffset = anyWaveZero ? 0 : 1;

  const plans: Record<string, unknown>[] = [];
  const waves: Record<string, string[]> = {};
  const incomplete: string[] = [];
  let hasCheckpoints = false;
  const warnings: string[] = [];

  for (const rawPlan of rawPlans) {
    if (!rawPlan.autonomous) {
      hasCheckpoints = true;
    }
    if (!rawPlan.hasSummary) {
      incomplete.push(rawPlan.id);
    }

    const computedWave = (level.get(rawPlan.id) ?? 0) + levelOffset;
    const effectiveWave = computedWave;
    if (rawPlan.declaredWave !== null && rawPlan.declaredWave !== computedWave) {
      warnings.push(
        `Plan ${rawPlan.id}: declared wave: ${rawPlan.declaredWave} but depends_on DAG places it in wave ${computedWave}`,
      );
    }

    const plan: Record<string, unknown> = {
      id: rawPlan.id,
      wave: effectiveWave,
      depends_on: rawPlan.dependsOn.map((dep) => {
        const lower = String(dep).toLowerCase();
        return planMap.has(lower) ? (planMap.get(lower) as RawPlan).id : dep;
      }),
      autonomous: rawPlan.autonomous,
      objective: rawPlan.objective,
      files_modified: rawPlan.filesModified,
      task_count: rawPlan.taskCount,
      has_summary: rawPlan.hasSummary,
    };

    plans.push(plan);

    const waveKey = String(effectiveWave);
    if (!waves[waveKey]) {
      waves[waveKey] = [];
    }
    waves[waveKey].push(rawPlan.id);
  }

  const result: Record<string, unknown> = {
    phase: normalized,
    plans,
    waves,
    incomplete,
    has_checkpoints: hasCheckpoints,
  };
  if (planNamingWarning) result['warning'] = planNamingWarning;
  if (warnings.length > 0) result['warnings'] = warnings;

  output(result, raw);
}

// #2390 — phase.add title-shape heuristic. A description at or under this many
// characters, and with no sentence-ending punctuation followed by more text,
// reads as a short Title. Anything longer or multi-sentence reads as a Goal,
// not a Title. phase.add still writes the phase verbatim (it never mangles
// ROADMAP.md), but when the description looks goal-shaped the JSON result
// gains a `warning` key naming the gap, so the caller — or the orchestrating
// add-phase workflow — can split title vs. goal instead of the whole paragraph
// landing silently in the `### Phase N:` header.
const PHASE_ADD_TITLE_MAX_LEN = 80;
const PHASE_ADD_MULTI_SENTENCE_RE = /[.!?]['")\]]?\s+\S/;

function describeGoalShapedTitle(description: string): string | null {
  const trimmed = description.trim();
  const tooLong = trimmed.length > PHASE_ADD_TITLE_MAX_LEN;
  const multiSentence = PHASE_ADD_MULTI_SENTENCE_RE.test(trimmed);
  if (!tooLong && !multiSentence) return null;
  const reasons = [
    tooLong ? `${trimmed.length} chars (over the ${PHASE_ADD_TITLE_MAX_LEN}-char title threshold)` : null,
    multiSentence ? 'multiple sentences' : null,
  ].filter(Boolean).join(', ');
  return (
    `description looks goal-shaped, not title-shaped (${reasons}). It was written verbatim ` +
    `as the phase title; consider a short title with the detail moved to **Goal:**.`
  );
}

function cmdPhaseAdd(cwd: string, description: string, raw: boolean, customId?: string): void {
  if (!description) {
    error('description required for phase add');
  }

  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { newPhaseId, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const projectCode = (config.project_code as string) || '';
    const prefix = projectCode ? `${projectCode}-` : '';

    let _newPhaseId: number | string;
    let _dirName: string;

    if (customId || config.phase_naming === 'custom') {
      _newPhaseId = customId || slug.toUpperCase();
      if (!_newPhaseId) error('--id required when phase_naming is "custom"');
      _dirName = `${prefix}${_newPhaseId}-${slug}`;
    } else {
      // Collect all phase numbers visible in the current-milestone content.
      // Three sources are scanned so that a phase in ANY representation
      // (section header, roadmap bullet, or on-disk directory) is counted:

      // 1) Section headers: ### Phase N: / ## Phase N: / #### Phase N:
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const headerPattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      // 2) Roadmap bullet entries: - [ ] **Phase N: ...** (all checkbox variants)
      // The lookahead accepts colon, decimal-dot, whitespace, bold-close asterisk,
      // or end-of-line so titleless forms ("- [ ] **Phase 11**", "- [ ] Phase 11")
      // are counted and cannot collide with a freshly-added phase. (#1229)
      const bulletPattern = /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim;

      const usedPhaseNums = new Set<number>();
      let m: RegExpExecArray | null;

      while ((m = headerPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num !== 999) usedPhaseNums.add(num);
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num !== 999) usedPhaseNums.add(num);
      }

      // 3) On-disk phase directories (e.g. phases/11-foo/ with no header yet)
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num !== 999) usedPhaseNums.add(num);
        }
      }

      // phase.add appends after the highest *used* number. Collecting numbers from
      // section headers, roadmap bullets, AND on-disk dirs above is what prevents the
      // #1229 collision (a bullet-only Phase N is now counted), so max+1 cannot reuse
      // an existing number.
      const maxUsed = usedPhaseNums.size > 0 ? Math.max(...usedPhaseNums) : 0;
      _newPhaseId = maxUsed + 1;
      const paddedNum = String(_newPhaseId).padStart(2, '0');
      _dirName = `${prefix}${paddedNum}-${slug}`;
    }

    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    const dependsOn =
      config.phase_naming === 'custom'
        ? ''
        : `\n**Depends on:** Phase ${typeof _newPhaseId === 'number' ? _newPhaseId - 1 : 'TBD'}`;
    const phaseEntry =
      `\n### Phase ${_newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_newPhaseId} to break down)\n`;

    let updatedContent: string;
    const lastSeparator = rawContent.lastIndexOf('\n---');
    if (lastSeparator > 0) {
      updatedContent = rawContent.slice(0, lastSeparator) + phaseEntry + rawContent.slice(lastSeparator);
    } else {
      updatedContent = rawContent + phaseEntry;
    }

    platformWriteSync(roadmapPath, updatedContent);
    return { newPhaseId: _newPhaseId, dirName: _dirName };
  });

  const titleWarning = describeGoalShapedTitle(description);

  const result: Record<string, unknown> = {
    phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
    padded:
      typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
    naming_mode: config.phase_naming,
  };
  if (titleWarning) result['warning'] = titleWarning;

  output(result, raw, result['padded']);
}

function cmdPhaseAddBatch(cwd: string, descriptions: string[], raw: boolean): void {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    error('descriptions array required for phase add-batch');
  }
  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }
  const projectCode = (config.project_code as string) || '';
  const prefix = projectCode ? `${projectCode}-` : '';

  const results = withPlanningLock(cwd, () => {
    let rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);
    let maxPhase = 0;
    if (config.phase_naming !== 'custom') {
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num === 999) continue;
        if (num > maxPhase) maxPhase = num;
      }
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num === 999) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }
    }
    const added: Record<string, unknown>[] = [];
    for (const description of descriptions) {
      const slug = generateSlugInternal(description) || '';
      let newPhaseId: number | string;
      let dirName: string;
      if (config.phase_naming === 'custom') {
        newPhaseId = slug.toUpperCase();
        dirName = `${prefix}${newPhaseId}-${slug}`;
      } else {
        maxPhase += 1;
        newPhaseId = maxPhase;
        dirName = `${prefix}${String(newPhaseId).padStart(2, '0')}-${slug}`;
      }
      const dirPath = path.join(planningDir(cwd), 'phases', dirName);
      platformEnsureDir(dirPath);
      platformWriteSync(path.join(dirPath, '.gitkeep'), '');
      const dependsOn =
        config.phase_naming === 'custom'
          ? ''
          : `\n**Depends on:** Phase ${typeof newPhaseId === 'number' ? newPhaseId - 1 : 'TBD'}`;
      const phaseEntry =
        `\n### Phase ${newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${newPhaseId} to break down)\n`;
      const lastSeparator = rawContent.lastIndexOf('\n---');
      rawContent =
        lastSeparator > 0
          ? rawContent.slice(0, lastSeparator) + phaseEntry + rawContent.slice(lastSeparator)
          : rawContent + phaseEntry;
      added.push({
        phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
        padded:
          typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
        name: description,
        slug,
        directory: toPosixPath(
          path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
        ),
        naming_mode: config.phase_naming,
      });
    }
    platformWriteSync(roadmapPath, rawContent);
    return added;
  });
  output({ phases: results, count: results.length }, raw);
}

function cmdPhaseInsert(cwd: string, afterPhase: string, description: string, raw: boolean): void {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { decimalPhase, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const normalizedAfter = normalizePhaseName(afterPhase);
    const afterPhaseEscaped = phaseMarkdownRegexSource(normalizedAfter);
    const targetPattern = new RegExp(`#{2,4}\\s*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:`, 'i');
    const headingMatch = targetPattern.test(content);

    const bulletPattern = new RegExp(
      `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
      'i',
    );
    const anyHeadingPattern = /#{2,4}\s*Phase\s+\d/i;
    const roadmapHasHeadingPhases = anyHeadingPattern.test(content);
    const isBulletStyle = !headingMatch && bulletPattern.test(content) && !roadmapHasHeadingPhases;

    if (!headingMatch && !isBulletStyle) {
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
        'i',
      );
      if (checklistPattern.test(content)) {
        error(
          `Phase ${afterPhase} exists in roadmap summary but is missing a detail section (### Phase ${afterPhase}: ...).`,
        );
      }
      error(`Phase ${afterPhase} not found in ROADMAP.md`);
    }

    const phasesDir = path.join(planningDir(cwd), 'phases');
    const normalizedBase = normalizePhaseName(afterPhase);
    const decimalSet = new Set<number>();

    // #2245 audit: existsSync-guarded, mirroring cmdPhaseNextDecimal's identical
    // scan above — a missing phasesDir (no decimal sub-phases yet) is the
    // expected, silent case (empty decimalSet). A readdirSync failure once the
    // dir is confirmed to EXIST is a genuine anomaly; swallowing it used to let
    // `phase insert` proceed with an incomplete decimalSet and risk writing a
    // decimal phase number that collides with an existing on-disk directory
    // the scan simply never saw — surfaced loud instead, like the sibling.
    if (fs.existsSync(phasesDir)) {
      // Initialized (not just declared) so TS's definite-assignment check is
      // satisfied without relying on control-flow narrowing through error()'s
      // `never` return, which TS does not propagate through a destructured
      // module-property function reference — error() still halts the process
      // before `dirs` below is ever computed from this placeholder value.
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error(`Failed to scan phase directories for existing decimal phases: ${msg}`);
      }
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const decimalPattern = new RegExp(
        `^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${escapeRegex(normalizedBase)}\\.(\\d+)`,
      );
      for (const dir of dirs) {
        const dm = dir.match(decimalPattern);
        if (dm) decimalSet.add(parseInt(dm[1], 10));
      }
    }

    const rmPhasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalizedBase)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'gi',
    );
    let rmMatch: RegExpExecArray | null;
    while ((rmMatch = rmPhasePattern.exec(rawContent)) !== null) {
      decimalSet.add(parseInt(rmMatch[1], 10));
    }

    const nextDecimal = decimalSet.size === 0 ? 1 : Math.max(...decimalSet) + 1;
    const _decimalPhase = `${normalizedBase}.${nextDecimal}`;
    const insertConfig = loadConfig(cwd);
    const projectCode = (insertConfig.project_code as string) || '';
    const pfx = projectCode ? `${projectCode}-` : '';
    const _dirName = `${pfx}${_decimalPhase}-${slug}`;
    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    let updatedContent: string;

    if (isBulletStyle) {
      const boldBulletPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:`,
        'i',
      );
      const useBold = boldBulletPattern.test(content);
      const phaseLabel = useBold
        ? `**Phase ${_decimalPhase}: ${description}**`
        : `Phase ${_decimalPhase}: ${description}`;
      const bulletEntry = `\n- [ ] ${phaseLabel}`;

      const targetBulletPattern = new RegExp(
        `(-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
        'i',
      );
      const bulletMatchResult = rawContent.match(targetBulletPattern);
      if (!bulletMatchResult) {
        error(`Could not find Phase ${afterPhase} bullet line`);
      }

      const bulletLineEnd =
        rawContent.indexOf(bulletMatchResult![0]) + bulletMatchResult![0].length;
      const afterBullet = rawContent.slice(bulletLineEnd);
      const nextBulletMatch = afterBullet.match(/\n-\s*\[[ x]\]\s*(?:\*\*)?Phase\s+\d/i);

      let insertIdx: number;
      if (nextBulletMatch) {
        insertIdx = bulletLineEnd + (nextBulletMatch.index as number);
      } else {
        insertIdx = bulletLineEnd;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + bulletEntry + rawContent.slice(insertIdx);
    } else {
      const phaseEntry =
        `\n### Phase ${_decimalPhase}: ${description} (INSERTED)\n\n**Goal:** [Urgent work - to be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${afterPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_decimalPhase} to break down)\n`;

      const headerPattern = new RegExp(
        `(#{2,4}\\s*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*\\n)`,
        'i',
      );
      const headerMatch = rawContent.match(headerPattern);
      if (!headerMatch) {
        error(`Could not find Phase ${afterPhase} header`);
      }

      const headerIdx = rawContent.indexOf(headerMatch![0]);
      const afterHeader = rawContent.slice(headerIdx + headerMatch![0].length);
      const nextPhaseMatch = afterHeader.match(/\n#{2,4}\s+Phase\s+\d[\d.]*/i);

      let insertIdx: number;
      if (nextPhaseMatch) {
        insertIdx = headerIdx + headerMatch![0].length + (nextPhaseMatch.index as number);
      } else {
        insertIdx = rawContent.length;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + phaseEntry + rawContent.slice(insertIdx);
    }

    platformWriteSync(roadmapPath, updatedContent);
    return { decimalPhase: _decimalPhase, dirName: _dirName };
  });

  const result = {
    phase_number: decimalPhase,
    after_phase: afterPhase,
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
  };

  output(result, raw, decimalPhase);
}

interface RenameDirInfo {
  dir: string;
  prefix: string;
  oldDecimal: number;
  slug: string;
}

interface RenameIntInfo {
  dir: string;
  oldInt: number;
  letter: string;
  decimal: number | null;
  slug: string;
}

function renameDecimalPhases(
  phasesDir: string,
  baseInt: number,
  removedDecimal: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const decPattern = new RegExp(`^(0*${baseInt})\\.(\\d+)-(.+)$`);
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameDirInfo[] = dirs
    .map((dir) => {
      const m = dir.match(decPattern);
      return m
        ? { dir, prefix: m[1], oldDecimal: parseInt(m[2], 10), slug: m[3] }
        : null;
    })
    .filter((item): item is RenameDirInfo => item !== null && item.oldDecimal > removedDecimal)
    .sort((a, b) => b.oldDecimal - a.oldDecimal);

  for (const item of toRename) {
    const newDecimal = item.oldDecimal - 1;
    const oldPhaseId = `${baseInt}.${item.oldDecimal}`;
    const newPhaseId = `${baseInt}.${newDecimal}`;
    const newDirName = `${item.prefix}.${newDecimal}-${item.slug}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.includes(oldPhaseId)) {
        const newFileName = f.replace(oldPhaseId, newPhaseId);
        retryRenameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function renameIntegerPhases(
  phasesDir: string,
  removedInt: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameIntInfo[] = dirs
    .map((dir) => {
      const m = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
      if (!m) return null;
      const dirInt = parseInt(m[1], 10);
      return dirInt > removedInt && dirInt !== 999
        ? {
            dir,
            oldInt: dirInt,
            letter: m[2] ? m[2].toUpperCase() : '',
            decimal: m[3] ? parseInt(m[3], 10) : null,
            slug: m[4],
          }
        : null;
    })
    .filter((item): item is RenameIntInfo => item !== null)
    .sort((a, b) =>
      a.oldInt !== b.oldInt ? b.oldInt - a.oldInt : (b.decimal || 0) - (a.decimal || 0),
    );

  for (const item of toRename) {
    const newInt = item.oldInt - 1;
    const newPadded = String(newInt).padStart(2, '0');
    const oldPadded = String(item.oldInt).padStart(2, '0');
    const letterSuffix = item.letter || '';
    const decimalSuffix = item.decimal !== null ? `.${item.decimal}` : '';
    const oldPrefix = `${oldPadded}${letterSuffix}${decimalSuffix}`;
    const newPrefix = `${newPadded}${letterSuffix}${decimalSuffix}`;
    const newDirName = `${newPrefix}-${item.slug}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.startsWith(oldPrefix)) {
        const newFileName = newPrefix + f.slice(oldPrefix.length);
        retryRenameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function decrementRoadmapPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return String(num - 1);
}

function decrementRoadmapPhaseToken(raw: string, removedInt: number): string {
  const match = String(raw).match(/^(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const num = parseInt(match[1], 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return `${num - 1}${match[2] || ''}`;
}

function decrementRoadmapPaddedPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return String(num - 1).padStart(raw.length, '0');
}

/**
 * Return the RAW text of the `dataRowIndex`-th data row line (0-based, in
 * file order — header and delimiter rows excluded) of the FIRST GFM table
 * found in `sectionText`, or `null` when the table or that row doesn't exist.
 *
 * F8 (#2245 review, nit) support helper: addresses a table row by its
 * STRUCTURAL position rather than by matching its (possibly non-unique)
 * trimmed cell content — see the Progress-ordinal renumber's padding-recovery
 * use below for why content-matching is unsafe here (two rows with identical
 * trimmed Phase text, or a row whose already-rewritten new value coincides
 * with another row's pre-edit text, would otherwise resolve to the wrong line).
 */
function findDataRowLine(sectionText: string, dataRowIndex: number): string | null {
  const lines = sectionText.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  let seen = -1;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    seen += 1;
    if (seen === dataRowIndex) return lines[i];
  }
  return null;
}

function updateRoadmapAfterPhaseRemoval(
  roadmapPath: string,
  targetPhase: string,
  isDecimal: boolean,
  removedInt: number,
  cwd: string,
): void {
  withPlanningLock(cwd, () => {
    let content = fs.readFileSync(roadmapPath, 'utf-8');
    const escaped = escapeRegex(targetPhase);

    // SECTION-DELETION (not a section-body edit) — removes the phase's ENTIRE
    // detail section INCLUDING its own heading line. Migrated onto deleteSection
    // (ADR-2143 §4 / markdown-sectionizer T7): it locates the target heading via
    // tokenizeHeadings + this predicate, then splices out the range from that
    // heading's own start through the next heading of the SAME-OR-HIGHER level —
    // whatever that heading's text is. This fixes a data-loss bug in the prior
    // hand-rolled regex, whose lookahead only recognised ANOTHER "Phase N:"
    // heading as a stop boundary: removing the LAST phase in a roadmap left no
    // such heading to stop at, so the lazy `[\s\S]*?` scan ran to EOF and swept
    // away everything after it — including a trailing `## Progress` heading and
    // its tracking table.
    const phaseHeadingRe = new RegExp(
      `^Phase\\s+${escaped}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'i',
    );
    content = deleteSection(
      content,
      (h) => h.level >= 2 && h.level <= 4 && phaseHeadingRe.test(h.text),
    );
    content = content.replace(
      new RegExp(`\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${escaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*`, 'gi'),
      '',
    );
    // ROW-DELETION (not a cell update) — removes the WHOLE Progress-table row
    // for a removed phase via deleteTableRow (ADR-2143 §7 row-removal sibling
    // of updateTableCell). Scoped to the `## Progress` section — mirroring
    // deriveProgressFromRoadmap's read-side scoping (phase-lifecycle.cts) —
    // so a same-numbered row in an earlier, unrelated table (e.g. a
    // `| Phase | Requirements | Count |` table preceding `## Progress`,
    // #2012) is never touched. Matches the row by its FIRST cell only: for an
    // integer removal, a zero-pad-insensitive leading-integer comparison
    // (`01.`, `1.`, `1 `, bare `1` all match phase 1; a decimal sub-phase
    // cell like `2.5` never matches an integer removal); for a decimal
    // removal, the exact decimal token. This replaces the prior regex's
    // `\.?\s` requirement, which silently left a COMPACT unpadded row (e.g.
    // `|2|0/2|Planned|-|`) undeleted — its closing `|` follows the digit with
    // no whitespace to match (#2245 audit) — and which was also unscoped to
    // any particular table.
    const progressHeadingMatch = content.match(/^##[ \t]+Progress\b/im);
    if (progressHeadingMatch && progressHeadingMatch.index !== undefined) {
      const headingOffset = progressHeadingMatch.index;
      const before = content.slice(0, headingOffset);
      const fromHeading = content.slice(headingOffset);
      const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
      const progressSection =
        nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
      const rest = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

      const matchRemovedProgressRow = (row: Record<string, string>): boolean => {
        const firstCellRaw = (Object.values(row)[0] ?? '').trim();
        if (isDecimal) {
          return new RegExp(`^${escaped}\\.?(?:\\s|$)`, 'i').test(firstCellRaw);
        }
        const leadingMatch = firstCellRaw.match(/^0*(\d+)(\.\d+)?/);
        if (!leadingMatch || leadingMatch[2]) return false;
        return parseInt(leadingMatch[1], 10) === removedInt;
      };

      const deleteResult = deleteTableRow(progressSection, matchRemovedProgressRow);
      if (deleteResult.ok) {
        content = before + deleteResult.value + rest;
      }
    }

    if (!isDecimal) {
      // #1729: fold an optional pre-colon ( ) tag into the suffix capture so it
      // is re-emitted verbatim — a tagged later phase still gets renumbered.
      content = content.replace(
        /(#{2,4}\s*Phase\s+)(\d+(?:\.\d+)?)((?:\s*\([^)\n]{0,200}\))?\s*:)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}${suffix}`,
      );
      content = content.replace(
        /(-\s*\[[ x]\]\s*.*?Phase\s+)(\d+)(\s*:|\s+)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseNumber(num, removedInt)}${suffix}`,
      );
      // ORDINAL-RENUMBER — CELL EDIT (not row-deletion) — migrated onto
      // updateTableCell (ADR-2143 §7, sibling of the deleteTableRow scoping
      // directly above). The prior whole-document regex
      // `/(\|\s*)(\d+)(\.\s)/g` rewrote ANY `| N. ` cell anywhere in the
      // file — including a same-shaped cell in an UNRELATED, earlier table
      // (e.g. a `| Phase | Requirements | Count |` table, or a decoy table,
      // preceding `## Progress`; #2245-class scoping defect, same family as
      // the row-delete fix above). Scoped here to the `## Progress` section
      // only, mirroring that same section-slice-then-splice-back pattern.
      //
      // Loops because updateTableCell only rewrites the FIRST matching row
      // per call. `processedOrdinalRows` tracks by row INDEX (stable across
      // iterations — this only edits cell content, it never inserts/deletes
      // rows) so an already-decremented row's new value — which may still
      // numerically exceed `removedInt` — is never re-selected and
      // decremented a second time (matching on the row's CURRENT value alone,
      // without this guard, would keep re-firing on each pass).
      //
      // `phaseCellShapeRe` is the exact digit+dot-space shape the old regex
      // required: a decimal sub-phase ordinal like `2.5` (no whitespace
      // between the dot and the next character) never matches it, so it is
      // left untouched — identical decimal-safety to the prior behaviour.
      //
      // updateTableCell hands the callback the TRIMMED, UNESCAPED cell value
      // only, so the row's original leading/trailing alignment padding is
      // recovered by a narrow, anchored lookup within that row's OWN raw
      // line — addressed by ROW INDEX (`matchedRowIndex`, via
      // `findDataRowLine`), not by searching the whole section for content
      // matching the trimmed value (F8 #2245 review: two rows with identical
      // trimmed Phase text, or a row whose already-rewritten new value
      // coincides with another row's pre-edit text, would otherwise resolve
      // to the WRONG row's padding — the first/leftmost content match found).
      // The lookup searches for `escapeCell(current)` (F3 #2245 review: the
      // ESCAPED form, e.g. `Foo \| Bar`) — the raw line always carries the
      // escaped form, so searching for the unescaped `current` would
      // silently fail to find an escaped-pipe cell's own line — preserving
      // every other byte of the row (ADR-2143 §7 byte-parity) while only the
      // digits actually change.
      const ordinalHeadingMatch = content.match(/^##[ \t]+Progress\b/im);
      if (ordinalHeadingMatch && ordinalHeadingMatch.index !== undefined) {
        const ordinalHeadingOffset = ordinalHeadingMatch.index;
        const ordinalBefore = content.slice(0, ordinalHeadingOffset);
        const ordinalFromHeading = content.slice(ordinalHeadingOffset);
        const ordinalNextHeadingOffset = ordinalFromHeading.search(/\n#{1,2}[ \t]/);
        let ordinalSection =
          ordinalNextHeadingOffset >= 0
            ? ordinalFromHeading.slice(0, ordinalNextHeadingOffset)
            : ordinalFromHeading;
        const ordinalRest =
          ordinalNextHeadingOffset >= 0 ? ordinalFromHeading.slice(ordinalNextHeadingOffset) : '';

        const phaseCellShapeRe = /^(\d+)(\.\s)/;
        const processedOrdinalRows = new Set<number>();
        let matchedRowIndex: number | null = null;

        for (;;) {
          matchedRowIndex = null;
          const cellResult = updateTableCell(
            ordinalSection,
            (row, index) => {
              if (processedOrdinalRows.has(index)) return false;
              const m = phaseCellShapeRe.exec(row['Phase'] ?? '');
              if (!m) return false;
              const num = parseInt(m[1], 10);
              if (!Number.isInteger(num) || num <= removedInt || num === 999) return false;
              processedOrdinalRows.add(index);
              matchedRowIndex = index;
              return true;
            },
            'Phase',
            (current) => {
              const m = phaseCellShapeRe.exec(current);
              if (!m) return current;
              const decremented = decrementRoadmapPhaseNumber(m[1], removedInt);
              const newContent = `${decremented}${m[2]}${current.slice(m[0].length)}`;
              const targetLine =
                matchedRowIndex === null ? null : findDataRowLine(ordinalSection, matchedRowIndex);
              const padMatch = targetLine
                ? new RegExp(`^[ \\t]*\\|(\\s*)${escapeRegex(escapeCell(current))}(\\s*)\\|`).exec(targetLine)
                : null;
              const leadPad = padMatch ? padMatch[1] : ' ';
              const trailPad = padMatch ? padMatch[2] : ' ';
              return `${leadPad}${escapeCell(newContent)}${trailPad}`;
            },
          );
          if (!cellResult.ok) break;
          ordinalSection = cellResult.value;
        }

        content = ordinalBefore + ordinalSection + ordinalRest;
      }
      content = content.replace(
        /(?<![0-9-])(\d{2})-(\d{2})(?=(?:(?:-[A-Za-z][A-Za-z0-9-]*)?-(?:PLAN|SUMMARY)\.md)|(?![0-9-]))/g,
        (_match, phaseNum: string, planNum: string) =>
          `${decrementRoadmapPaddedPhaseNumber(phaseNum, removedInt)}-${planNum}`,
      );
      content = content.replace(
        /(\*\*Depends on\*\*\s*:\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
      content = content.replace(
        /(Depends on:\*\*\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
    }

    platformWriteSync(roadmapPath, content);
  });
}

interface PhaseRemoveOptions {
  force?: boolean;
}

function cmdPhaseRemove(
  cwd: string,
  targetPhase: string,
  options: PhaseRemoveOptions,
  raw: boolean,
): void {
  if (!targetPhase) error('phase number required for phase remove');

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');

  if (!fs.existsSync(roadmapPath)) error('ROADMAP.md not found');

  const normalized = normalizePhaseName(targetPhase);
  const isDecimal = targetPhase.includes('.');
  const force = options.force || false;

  const subdirs = readSubdirectories(phasesDir, true);
  const targetDir = subdirs.find((d) => phaseTokenMatches(d, normalized)) || null;

  if (targetDir && !force) {
    const files = fs.readdirSync(path.join(phasesDir, targetDir));
    const summaries = files.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    if (summaries.length > 0) {
      error(
        `Phase ${targetPhase} has ${summaries.length} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  if (targetDir) fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });

  let renamedDirs: { from: string; to: string }[] = [];
  let renamedFiles: { from: string; to: string }[] = [];
  try {
    const renamed = isDecimal
      ? renameDecimalPhases(
          phasesDir,
          parseInt(normalized.split('.')[0], 10),
          parseInt(normalized.split('.')[1], 10),
        )
      : renameIntegerPhases(phasesDir, parseInt(normalized, 10));
    renamedDirs = renamed.renamedDirs;
    renamedFiles = renamed.renamedFiles;
  } catch (e) {
    // #2245 audit (was ERROR-HIDING): renameDecimalPhases/renameIntegerPhases
    // rename subsequent phase directories ON DISK one at a time — a mid-loop
    // failure leaves SOME directories already renumbered and others not, with
    // no way to recover which (the callee's own renamedDirs/renamedFiles never
    // reach this scope when it throws). Silently swallowing this and falling
    // through to updateRoadmapAfterPhaseRemoval below used to rewrite
    // ROADMAP.md's phase numbers assuming the ENTIRE renumbering succeeded,
    // permanently desyncing ROADMAP.md from the actual (partially-renamed)
    // on-disk directory names. Surface loud instead of compounding it.
    const msg = e instanceof Error ? e.message : String(e);
    error(`Failed to renumber phase directories after removing phase ${targetPhase}: ${msg}`);
  }

  updateRoadmapAfterPhaseRemoval(
    roadmapPath,
    targetPhase,
    isDecimal,
    parseInt(normalized, 10),
    cwd,
  );

  const statePath = path.join(planningDir(cwd), 'STATE.md');
  if (fs.existsSync(statePath)) {
    readModifyWriteStateMd(
      statePath,
      (stateContent: string) => {
        const totalRaw = stateExtractField(stateContent, 'Total Phases');
        if (totalRaw) {
          stateContent =
            stateReplaceField(stateContent, 'Total Phases', String(parseInt(totalRaw, 10) - 1)) ||
            stateContent;
        }
        const ofMatch = stateContent.match(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i);
        if (ofMatch) {
          stateContent = stateContent.replace(
            /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i,
            `$1${parseInt(ofMatch[2], 10) - 1}$3`,
          );
        }
        return stateContent;
      },
      cwd,
    );
  }

  output(
    {
      removed: targetPhase,
      directory_deleted: targetDir,
      renamed_directories: renamedDirs,
      renamed_files: renamedFiles,
      roadmap_updated: true,
      state_updated: fs.existsSync(statePath),
    },
    raw,
  );
}

interface WriteSpec {
  filePath: string;
  before: string;
  after: string;
}

function writePlanningFileSet(writes: WriteSpec[]): void {
  const applied: WriteSpec[] = [];
  try {
    for (const write of writes) {
      if (write.before === write.after) continue;
      platformWriteSync(write.filePath, write.after);
      applied.push(write);
    }
  } catch (err) {
    for (const write of applied.reverse()) {
      try {
        platformWriteSync(write.filePath, write.before);
      } catch (rollbackErr) {
        const errObj = err as Error & { rollbackError?: unknown };
        errObj.rollbackError = rollbackErr;
        const rollbackMsg =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        errObj.message +=
          `\nWARNING: rollback failed while restoring ${write.filePath} ` +
          `(${rollbackMsg}). Planning files under .planning/ may be left in an ` +
          `inconsistent, partially rolled back state. Inspect ROADMAP.md / REQUIREMENTS.md / ` +
          `STATE.md before re-running phase complete.`;
        break;
      }
    }
    throw err;
  }
}

function phaseDisplayNameFromRoadmap(roadmapContent: string | null, phaseNum: string | null): string | null {
  if (!roadmapContent || !phaseNum) return null;
  const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
  const heading = roadmapContent.match(new RegExp(`^#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:\\s*([^\\n]+)`, 'im'));
  if (!heading) return null;
  const name = heading[1].replace(/\(INSERTED\)/i, '').trim();
  return name || null;
}

function phaseDisplayNameFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  const name = slug.replace(/-/g, ' ').trim();
  return name || null;
}

function cmdPhaseComplete(cwd: string, phaseNum: string, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  // #2028: fail safe in workstream mode with no active workstream. With no active
  // workstream and no --ws, planningDir(cwd) resolves to root .planning, so
  // phase.complete would write STATE.md/ROADMAP.md (and mislabel milestone status)
  // into the shared root that other workstreams read. Mirror the #1912 guard that
  // init.progress got (resolution: GSD_WORKSTREAM env > stored active pointer; an
  // explicit --ws sets GSD_WORKSTREAM upstream and satisfies the check).
  const availableWorkstreams = listAvailableWorkstreams(cwd);
  const resolvedWorkstream = process.env['GSD_WORKSTREAM'] || getActiveWorkstream(cwd);
  if (availableWorkstreams.length > 0 && !resolvedWorkstream) {
    error(
      `phase.complete requires a workstream in workstream mode — no active workstream is set, so root STATE.md/ROADMAP.md (likely stale) would be written. ` +
        `Pass --ws <name> or run ${formatGsdSlash('workstream set', resolveRuntime(cwd)) as string} first. ` +
        `Available workstreams: ${availableWorkstreams.join(', ')}`,
    );
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const today = realClock.localToday();

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;

  const planCount: number = phaseInfo['plans']
    ? (phaseInfo['plans'] as string[]).length
    : 0;
  const summaryCount: number = phaseInfo['summaries']
    ? (phaseInfo['summaries'] as string[]).length
    : 0;
  let requirementsUpdated = false;

  const warnings: string[] = [];
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  try {
    const phaseFiles = fs.readdirSync(phaseFullDir);

    for (const file of phaseFiles.filter((f) => f.includes('-UAT') && f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/result: pending/.test(content)) warnings.push(`${file}: has pending tests`);
      if (/result: blocked/.test(content)) warnings.push(`${file}: has blocked tests`);
      if (/status: partial/.test(content)) warnings.push(`${file}: testing incomplete (partial)`);
      if (/status: diagnosed/.test(content)) warnings.push(`${file}: has diagnosed gaps`);
    }

    for (const file of phaseFiles.filter(
      (f) => f.includes('-VERIFICATION') && f.endsWith('.md'),
    )) {
      const verificationFilePath = path.join(phaseFullDir, file);
      const content = fs.readFileSync(verificationFilePath, 'utf-8');
      // #1159 (Defect A): read ONLY the frontmatter `status` key to avoid false positives
      // from historical metadata in the file body (e.g. `previous_status: gaps_found`).
      // A full-text regex like /status: gaps_found/ matches the substring inside
      // `previous_status: gaps_found`, producing spurious warnings even when the
      // current frontmatter status is `passed`.
      const verFm = extractFrontmatter(content, verificationFilePath) as Record<string, unknown>;
      // Normalise to lower-case so `status: Passed` (title-case) is not missed.
      const verStatus = typeof verFm['status'] === 'string' ? verFm['status'].trim().toLowerCase() : '';
      if (verStatus === 'human_needed') warnings.push(`${file}: needs human verification`);
      if (verStatus === 'gaps_found') warnings.push(`${file}: has unresolved gaps`);
    }
  } catch {
    /* best-effort (#2245 audit): this is an ADVISORY pre-scan of UAT/
     * VERIFICATION files for `warnings` in the phase-complete output — the
     * actual completion GATE is readVerificationStatus below (a separate
     * mechanism). A readdirSync/readFileSync failure here just means fewer
     * warnings are surfaced this run, not a blocked or corrupted completion. */
  }

  let nextPhaseNum: string | null = null;
  let nextPhaseName: string | null = null;
  let isLastPhase = true;

  const verificationBlocked = withPlanningLock(cwd, () => {
    // #2617: pass the project's runtime so the blocked-completion error below
    // suggests the command surface this runtime actually installs
    // ($gsd-… on Codex) rather than a hard-coded Claude-style string.
    const verificationStatus = readVerificationStatus(phaseFullDir, { runtime: resolveRuntime(cwd) });
    if (verificationStatus.status !== 'passed') {
      return verificationStatus;
    }

    const runPhaseCompleteTransaction = () => {
      const writes: WriteSpec[] = [];
      let roadmapContent: string | null = null;

      if (fs.existsSync(roadmapPath)) {
        const originalRoadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        roadmapContent = originalRoadmapContent;

        const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
        // #2067: the gap between `]` and `Phase N` must allow only whitespace /
        // markdown bold emphasis — NOT greedy `.*`. A greedy gap matched a later
        // phase whose description merely mentioned the completed phase number,
        // so completing an already-checked phase (idempotent re-run) checked the
        // wrong phase's box. Mirrors the tight pattern used by phase-insert
        // (`]\\s*(?:\\*\\*)?Phase`).
        // #2067/#2200: line-anchored (^, optional leading indent) so an
        // inline / backticked prose literal cannot match. Milestone-scoped below
        // (mutateMilestonePhase) so a Backlog entry or a same-numbered shipped-
        // milestone phase cannot be flipped either.
        // ADR-2143 §4 note / #2245 audit: this is the phase-LIST checkbox — it
        // lives in the milestone's `- [ ] Phase N: …` checklist, OUTSIDE any
        // `### Phase N` detail section, so there is no section for
        // withPhaseSection to bind to. Migrated onto the sectionizer's
        // `updateBullet` bullet-write seam: the pattern itself is unchanged,
        // only the "find the right line, splice it back" plumbing moved off a
        // whole-slice `.replace()` onto the seam. Applied per single physical
        // line by updateBullet, so the pattern no longer needs the `m` flag
        // (it never sees more than one line at a time); see
        // planCountBodyPattern below for the sites that were migrated onto
        // withPhaseSection instead.
        //
        // #2245 review Fix 6: this is behaviour-preserving for GSD-GENERATED
        // inputs (the only shape ROADMAP.md ever actually has), NOT byte-parity
        // across every conceivable input. `updateBullet` is fence-aware — a
        // checkbox-shaped line inside a fenced (``` / ~~~) code block is never
        // offered to `match`/`transform` — whereas the retired whole-slice
        // `.replace()` had no such fence tracking and would have flipped a
        // bullet-shaped line inside a fence too. That divergence has no live
        // bug because a GSD-authored ROADMAP.md milestone checklist never puts
        // its own `- [ ] Phase N: …` entries inside a fenced code block, but it
        // is a real (and correct) behavioural difference on pathological input.
        const checkboxPattern = new RegExp(
          `^[ \\t]*(-\\s*\\[)[ ](\\]\\s*(?:\\*\\*)?\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
          'i',
        );

        // Progress table row: update Plans Complete/Status/Completed columns BY
        // COLUMN NAME (handles 4- or 5-column RoadmapProgress tables) via the
        // markdown-table seam (ADR-2143 §7) — supersedes the prior ordinal
        // cells[]-index regex. Applied inside mutateMilestonePhase below (per
        // milestone window), further scoped to the ## Progress heading within
        // that window so the row lookup doesn't bind to an earlier table (e.g.
        // | Phase | Requirements | Count |) whose rows also start with the
        // phase number (#2012).
        // #2245 Blocker 4: optional dot must be followed by whitespace-or-end,
        // not dot-OR-whitespace-OR-end as alternatives — the prior form let a
        // bare "." satisfy the whole lookahead, so completing phase "2"
        // over-matched a decimal sub-phase row like "2.5 Extra". Matches "2",
        // "2.", "2 Alpha"; rejects "2.5 Extra".
        const phaseCellRe = new RegExp(`^${phaseEscaped}\\.?(?:\\s|$)`, 'i');
        const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());
        const dateShape = /^\d{4}-\d{2}-\d{2}$/;

        /**
         * Within `text` (already scoped to one milestone window by the
         * caller), scope further to the `## Progress` heading section (up to
         * the next `#`/`##` heading) when present, run `edit` against just
         * that slice, and splice the result back — falling back to the whole
         * `text` when no `## Progress` heading exists (mirrors phase-
         * lifecycle.cjs's deriveProgressFromRoadmap read-side scoping).
         */
        const editProgressHeadingSlice = (text: string, edit: (scoped: string) => string): string => {
          const progressMatch = text.match(/^##[ \t]+Progress\b/im);
          if (!progressMatch || progressMatch.index === undefined) {
            return edit(text);
          }
          const headingOffset = progressMatch.index;
          const beforeHeading = text.slice(0, headingOffset);
          const fromHeading = text.slice(headingOffset);
          const nextHeading = fromHeading.search(/\n#{1,2}[ \t]/);
          const scoped = nextHeading >= 0 ? fromHeading.slice(0, nextHeading) : fromHeading;
          const after = nextHeading >= 0 ? fromHeading.slice(nextHeading) : '';
          return beforeHeading + edit(scoped) + after;
        };

        // ADR-2143 §4: the plan-count write is now routed through
        // withPhaseSection (see mutateMilestonePhase below), which hands this
        // pattern ONLY phase N's own detail-section body — so the pattern no
        // longer needs its own `#{2,4}\s*Phase\s+N` anchor + skip-ahead-past-
        // interior-headings lookahead; the section boundary itself confines
        // the match (the #2067/#2200 boundary-crossing class is now
        // structurally impossible for this site rather than regex-enforced).
        const planCountBodyPattern = /(\*\*Plans:\*\*\s*)[^\n]+/i;

        const phaseInfoSummaries = phaseInfo['summaries'] as string[];

        // #2200: apply the phase-checkbox flip, the plan-count write, and the
        // per-plan checkbox flips ONLY within the current milestone's region(s)
        // (primary section + optional Phase Details section). A bullet/heading in
        // a shipped milestone, a Backlog section, or a backticked prose literal is
        // outside the window and stays untouched. With no versioned active
        // milestone, fall back to whole-content mutation (prior behaviour).
        const mutateMilestonePhase = (slice: string): string => {
          let s = slice;
          s = updateBullet(
            s,
            (_bulletText, rawLine) => checkboxPattern.test(rawLine),
            (rawLine) => rawLine.replace(checkboxPattern, `$1x$2 (completed ${today})`),
          );

          s = editProgressHeadingSlice(s, (scoped) => {
            let text = scoped;

            const plansResult = updateTableCell(text, rowMatch, 'Plans Complete', ` ${summaryCount}/${planCount} `);
            if (plansResult.ok) text = plansResult.value;

            const statusResult = updateTableCell(text, rowMatch, 'Status', ' Complete    ');
            if (statusResult.ok) text = statusResult.value;

            // Preserve only a valid ISO date (#1161: idempotent; self-heal
            // garbage). Ragged-tolerant (#2245 Blocker 2): decide via the
            // CURRENT Completed cell inside a single updateTableCell callback
            // (its own tolerant row scan) rather than gating on
            // findTableWithColumns (which requires the WHOLE table to parse —
            // a ragged SIBLING row elsewhere used to silently no-op this
            // row's date stamp too).
            const completedResult = updateTableCell(text, rowMatch, 'Completed', (current) =>
              dateShape.test(current.trim()) ? current : ` ${today} `);
            if (completedResult.ok) text = completedResult.value;

            return text;
          });

          // ADR-2143 §4: the plan-count write and the per-plan checkbox flips
          // are both scoped to phase N's OWN detail section via
          // withPhaseSection — the edit callback below only ever sees that
          // section's body, so neither regex can escape into a sibling
          // phase's section, a shipped milestone, or a Backlog entry.
          s = withPhaseSection(s, phaseNum, (body) => {
            let b = body.replace(planCountBodyPattern, `$1${summaryCount}/${planCount} plans complete`);
            for (const summaryFile of phaseInfoSummaries) {
              const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
              if (!planId) continue;
              const planEscaped = escapeRegex(planId);
              const planCheckboxPattern = new RegExp(
                `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
                'i',
              );
              b = b.replace(planCheckboxPattern, '$1x$2');
            }
            return b;
          });
          return s;
        };

        const milestoneRanges = currentMilestoneRawRanges(roadmapContent, cwd);
        if (milestoneRanges) {
          // Splice later windows first so an earlier window's offsets are not
          // shifted by a length-changing mutation in a later window.
          const windows = [milestoneRanges.details, milestoneRanges.primary]
            .filter((w): w is { start: number; end: number } => w !== null)
            .sort((a, b) => b.start - a.start);
          for (const w of windows) {
            roadmapContent =
              roadmapContent.slice(0, w.start)
              + mutateMilestonePhase(roadmapContent.slice(w.start, w.end))
              + roadmapContent.slice(w.end);
          }
        } else {
          roadmapContent = mutateMilestonePhase(roadmapContent);
        }

        writes.push({
          filePath: roadmapPath,
          before: originalRoadmapContent,
          after: roadmapContent,
        });

        const reqPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');
        if (fs.existsSync(reqPath)) {
          const phaseEsc = phaseMarkdownRegexSource(phaseNum);
          const currentMilestoneRoadmap = extractCurrentMilestone(roadmapContent, cwd);
          const phaseSectionMatch = currentMilestoneRoadmap.match(
            new RegExp(
              `(#{2,4}\\s*Phase\\s+${phaseEsc}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
              'i',
            ),
          );

          const sectionText = phaseSectionMatch ? phaseSectionMatch[1] : '';
          const reqMatch = sectionText.match(
            /\*\*Requirements:?\*\*[^\S\n]*:?[^\S\n]*([^\n]+)/i,
          );

          const originalReqContent = fs.readFileSync(reqPath, 'utf-8');
          let reqContent = originalReqContent;

          // #2316: `citedReqIds` — the REQ-IDs ROADMAP's own **Requirements:**
          // line for this phase actually cites — is hoisted out of the
          // `if (reqMatch)` block (previously scoped only inside it) so the
          // ghost-ID cross-check below (~#2316-1) can consult it. `TBD` is the
          // literal placeholder `phase.add`/`-batch`/`-insert` seed
          // (`**Requirements**: TBD`, src/phase.cts:833,920,1078) — never a
          // real REQ-ID, so it is filtered out wherever a cited-ID list feeds
          // a warning (#2316-7 boundary).
          const isPlaceholderReqId = (id: string): boolean => id.toUpperCase() === 'TBD';
          let citedReqIds: string[] = [];
          // #2316-1: Traceability-row writes that matched NO row (ghost or
          // otherwise) — the `if (reqUpdate.ok)` below previously had no
          // `else`, discarding this fact silently instead of surfacing it.
          const traceabilityWriteMisses: string[] = [];

          if (reqMatch) {
            // #2334 HIGH 3: filter the tokenized capture to the REQ-ID SHAPE —
            // the SAME shape bodyReqIds (`\*\*([A-Z][A-Z0-9]*-\d+)\*\*`, below)
            // and tableReqIds (`([A-Z][A-Z0-9]*-\d+)`, below) already require —
            // so the ghost-ID / unregistered comparisons stay shape-symmetric.
            // Without this, `[^\n]+` split on `[,\s]+` turned EVERY word after
            // the ID list into a "cited REQ-ID": the shipped
            // `templates/roadmap.md:32` line
            // `**Requirements**: [REQ-01, REQ-02]  <!-- brackets optional, ... -->`
            // warned to register `<!--`, `brackets`, `optional`, `-->`, etc., and
            // `**Requirements:** None` warned to register the literal word
            // `None`. This subsumes the `TBD` placeholder special-case (`TBD`
            // does not match the REQ-ID shape either); `isPlaceholderReqId` is
            // kept below as a defensive no-op for any caller that still hands
            // it a raw token.
            const REQ_ID_SHAPE_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
            citedReqIds = reqMatch[1]
              .replace(/[\[\]]/g, '')
              .split(/[,\s]+/)
              .map((r) => r.trim())
              .filter(Boolean)
              .filter((r) => REQ_ID_SHAPE_RE.test(r));

            for (const reqId of citedReqIds) {
              const reqEscaped = escapeRegex(reqId);
              reqContent = reqContent.replace(
                new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi'),
                '$1x$2',
              );

              // Traceability row: | <REQ-ID> | Phase N | Pending|In Progress | ->
              // ... Complete | via the markdown-table seam (ADR-2143 §7). Match the
              // row by its FIRST cell's value (the requirement-ID column) regardless
              // of that column's HEADER name — real tables head it `REQ-ID`, others
              // `Requirement` (#2769/#2203); this mirrors the prior regex's first-cell
              // `\|\s*<id>\s*\|` anchor, not a by-name lookup. Object.values(row) is in
              // header order, so [0] is the first column. Case-insensitive.
              const reqRowMatch = (row: Record<string, string>): boolean =>
                (Object.values(row)[0] ?? '').trim().toLowerCase() === reqId.toLowerCase();
              // Ragged-tolerant (#2245 Blocker 2): drive the write purely off
              // updateTableCell's own tolerant row scan — a DIFFERENT
              // requirement's row elsewhere in the same table having a
              // mismatched cell count must never silently no-op THIS
              // requirement's write. The "only flip Pending/In Progress ->
              // Complete" gate is folded into the newValue callback so one
              // updateTableCell call both probes and writes.
              const reqUpdate = updateTraceabilityCell(reqContent, reqRowMatch, 'Status', (current) =>
                /^(?:pending|in progress)$/i.test(current.trim()) ? ' Complete ' : current);
              if (reqUpdate.ok) {
                reqContent = reqUpdate.value;
              } else if (!isPlaceholderReqId(reqId)) {
                traceabilityWriteMisses.push(reqId);
              }
            }
          }

          // #1159 (Defect B): collect requirement IDs only from ACTIVE sections.
          // Requirements under headings whose text contains "deferred", "backlog",
          // "future", or an OFF-milestone `v<N>` (case-insensitive) are explicitly
          // out of current scope and must not be flagged as missing from the
          // Traceability table.
          //
          // Strategy: walk lines, track heading depth, and toggle a "deferred" flag
          // when a heading matching the pattern is encountered.  A sub-heading (higher
          // depth) that is ITSELF in a deferred parent remains deferred unless it
          // opens a same-or-shallower heading that does NOT match the pattern.
          // Lines inside fenced code blocks (``` or ~~~) are treated as content, not
          // headings, to avoid false deferred-section detection from code examples.
          //
          // #2334 BLOCKER fix (regresses closed bug #1159 against GSD's OWN
          // shipped template): #2316-4a dropped the bare `v\d+` alternative
          // entirely to stop it over-matching an ACTIVE heading like "## v1
          // Requirements" — but the shipped `templates/requirements.md:35`
          // scaffold ships `## v2 Requirements` / "Deferred to future release"
          // as its ONLY deferred marker, and `v\d+` was the ONLY alternative
          // that ever matched a bare version heading (the deferred-ness lives
          // in body prose, not the heading text). Dropping it regressed #1159
          // for every project scaffolded from the shipped template.
          //
          // Fix: make the `v<N>` alternative MILESTONE-AWARE instead of
          // deleting it. A `## v<N> ...` heading is deferred ONLY when `<N>`
          // (MAJOR version only — "v1" vs milestone "v1.3" is the SAME major
          // version) does not match the CURRENT milestone's major version,
          // resolved via `stateExtractField` against STATE.md's `milestone:`
          // frontmatter field (the same seam `getMilestoneInfo`/state.cts's
          // frontmatter builder already use — no bespoke frontmatter parsing).
          // "## v1 Requirements" while the milestone is v1.x is the ACTIVE
          // milestone's own section (#2316's original ask) and must NOT be
          // swallowed; "## v2 Requirements" while the milestone is v1.x is a
          // genuinely future milestone (#1159's ask, and the literal shipped-
          // template shape) and MUST stay suppressed. `deferred`/`backlog`/
          // `future` are unaffected by milestone resolution — a genuinely
          // deferred heading always spells one of those words too (see
          // #2316-5 regression guard: "## Deferred v2 Requirements", "##
          // Future Backlog", "## Deferred", "## Backlog", "## Future").
          //
          // Fail-safe: when the milestone version cannot be resolved at all
          // (no STATE.md, or no `milestone:` field), fall back to the OLD
          // pre-#2316-4a behavior and treat every `v\d+` heading as deferred.
          // A false "deferred" here only ever SUPPRESSES a warning — strictly
          // safer than spamming a warning on every v\d+-headed scaffold when
          // we cannot tell whether it names the active milestone.
          const DEFERRED_KEYWORD_RE = /\b(?:deferred|backlog|future)\b/i;
          const HEADING_VERSION_RE = /\bv(\d+)(?:\.\d+)*\b/i;
          const stateRawForMilestone = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : null;
          const currentMilestoneRaw = stateRawForMilestone
            ? stateExtractField(stateRawForMilestone, 'milestone')
            : null;
          const currentMilestoneMajor = currentMilestoneRaw ? extractMajorVersion(currentMilestoneRaw) : null;
          const bodyReqIds: string[] = [];
          // deferredDepth: the heading level that opened the current deferred block,
          // or 0 when we are in an active section.
          let deferredDepth = 0;
          let inFence = false;
          for (const line of reqContent.split(/\r?\n/)) {
            // Track fenced code blocks (``` or ~~~).
            if (/^\s*(?:```|~~~)/.test(line)) {
              inFence = !inFence;
              continue;
            }
            if (inFence) continue; // ignore content inside a code fence

            const headingM = line.match(/^(#{1,6})\s+(.*)/);
            if (headingM) {
              const depth = headingM[1].length;
              const text = headingM[2];
              if (deferredDepth > 0 && depth > deferredDepth) {
                // Sub-heading inside a deferred block: stays deferred regardless of name.
                continue;
              }
              // Heading at same level or shallower than current deferred opener,
              // or no active deferred block yet.
              if (DEFERRED_KEYWORD_RE.test(text)) {
                deferredDepth = depth; // enter a deferred block
              } else {
                const versionMatch = text.match(HEADING_VERSION_RE);
                if (versionMatch) {
                  const headingMajor = versionMatch[1];
                  deferredDepth =
                    currentMilestoneMajor === null || headingMajor !== currentMilestoneMajor
                      ? depth // unresolved milestone (fail-safe) or off-milestone version -> deferred
                      : 0; // same major version as the current milestone -> active
                } else {
                  deferredDepth = 0; // back in an active section
                }
              }
              continue;
            }

            if (deferredDepth > 0) continue; // skip content in deferred sections

            // Collect bold REQ-ID patterns from active-section lines.
            const reqPat = /\*\*([A-Z][A-Z0-9]*-\d+)\*\*/g;
            let bodyMatch: RegExpExecArray | null;
            while ((bodyMatch = reqPat.exec(line)) !== null) {
              const id = bodyMatch[1];
              if (!bodyReqIds.includes(id)) bodyReqIds.push(id);
            }
          }

          const traceabilityHeadingMatch = reqContent.match(/^#{1,6}\s+Traceability\b/im);
          const traceabilitySection = traceabilityHeadingMatch
            ? reqContent.slice(traceabilityHeadingMatch.index)
            : '';
          const tableReqIds = new Set<string>();
          // #2203: match REQ-IDs in any pipe-delimited cell (not just the first
          // column) so a traceability table that leads with a status column (e.g.
          // | ☐ | REQ-01 | …) is parsed correctly instead of reporting every row
          // as missing.
          const tableRowPat = /\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|/g;
          let tableMatch: RegExpExecArray | null;
          while ((tableMatch = tableRowPat.exec(traceabilitySection)) !== null) {
            tableReqIds.add(tableMatch[1]);
          }

          const unregistered = bodyReqIds.filter((id) => !tableReqIds.has(id));
          if (unregistered.length > 0) {
            warnings.push(
              `REQUIREMENTS.md: ${unregistered.length} REQ-ID(s) found in body but missing from Traceability table: ${unregistered.join(', ')} — add them manually to keep traceability in sync`,
            );
          }

          // #2316-1: ghost REQ-IDs — cited by ROADMAP's own **Requirements:**
          // line for this phase, but registered NOWHERE in REQUIREMENTS.md
          // (neither its body nor its Traceability table). The `unregistered`
          // check above only ever compares REQUIREMENTS.md's own body against
          // its own Traceability table; it never consults `citedReqIds`, so an
          // ID that ROADMAP cites but REQUIREMENTS.md never defines at all was
          // previously invisible to every guard. `TBD` (the phase.add/-batch/
          // -insert placeholder) is excluded — see #2316-7 boundary.
          //
          // #2334 HIGH 2: classify "ghost" by PROBING THE ACTUAL WRITE
          // SURFACES this same function just wrote to (:1947 checkbox,
          // :1967 Traceability row) — case-insensitively — mirroring
          // milestone.cts's `notFound`/`hasRow`/`doneCheckbox` classification
          // (src/milestone.cts:117-141,209-215), instead of set-differencing
          // `bodyReqIds` (deferred-filtered, case-sensitive, bold-only) and
          // `tableReqIds` (case-sensitive) against `citedReqIds`. Those two
          // indexes can disagree with the writes: an ID under a `##
          // Deferred` heading gets its checkbox ticked by the write loop
          // above but is deliberately EXCLUDED from `bodyReqIds` by the
          // deferred-heading filter (#1159), so the old set-diff reported it
          // as an unregistered ghost in the SAME response that just ticked
          // its checkbox; a case-mismatched citation (`known-01` vs
          // `**KNOWN-01**`) lands its write via the writes' case-insensitive
          // regexes but failed the old set-diff's case-SENSITIVE
          // `Array.includes`/`Set.has`. An ID whose checkbox OR Traceability
          // row actually matched is registered — not a ghost — regardless of
          // which section (deferred or not) it lives under.
          const reqIsRegisteredAnywhere = (id: string): boolean => {
            const reqEscaped = escapeRegex(id);
            // Surface 1 — checkbox, EITHER state (`[ ]` or `[x]`), case-
            // insensitive: existence check, not the write's space-only match.
            if (new RegExp(`-\\s*\\[[ xX]\\]\\s*\\*\\*${reqEscaped}\\*\\*`, 'i').test(reqContent)) {
              return true;
            }
            // Surface 2 — Traceability row exists at all (any Status value),
            // via the SAME no-op-probe-through-updateTraceabilityCell
            // technique milestone.cts's `hasRow` uses (:210-214): a case-
            // insensitive first-cell match, regardless of current Status.
            const rowProbeMatch = (row: Record<string, string>): boolean =>
              (Object.values(row)[0] ?? '').trim().toLowerCase() === id.toLowerCase();
            return updateTraceabilityCell(reqContent, rowProbeMatch, 'Status', (current) => current).ok;
          };
          const ghostReqIds = citedReqIds.filter(
            (id) => !isPlaceholderReqId(id) && !reqIsRegisteredAnywhere(id),
          );
          if (ghostReqIds.length > 0) {
            warnings.push(
              `ROADMAP Phase ${phaseNum} cites REQ-ID(s) not registered anywhere in REQUIREMENTS.md (neither body nor Traceability table): ${ghostReqIds.join(', ')} — add them to REQUIREMENTS.md or correct the ROADMAP citation`,
            );
          }

          // #2316-1 cont.: a cited ID whose Traceability-row write matched no
          // row for a reason OTHER than being a ghost (e.g. a malformed table)
          // still deserves a warning instead of a silent discard — but skip
          // IDs already reported above as ghosts to avoid a duplicate message
          // for the same root cause.
          const traceabilityWriteFailures = traceabilityWriteMisses.filter(
            (id) => !ghostReqIds.includes(id),
          );
          if (traceabilityWriteFailures.length > 0) {
            warnings.push(
              `REQUIREMENTS.md: Traceability row write skipped for REQ-ID(s) cited by ROADMAP (no matching row found): ${traceabilityWriteFailures.join(', ')}`,
            );
          }

          writes.push({ filePath: reqPath, before: originalReqContent, after: reqContent });
          // #2316-3: `requirements_updated` must reflect whether REQUIREMENTS.md
          // content actually CHANGED, not merely that the file existed in the
          // transaction — mirrors the `writes.push({filePath,before,after})`
          // diff-tracking pattern used for the ROADMAP write above. A phase
          // whose citations match nothing (ghost REQ-IDs only) must report
          // `false`, not a bare "the file was present" `true`.
          requirementsUpdated = reqContent !== originalReqContent;
        }
      }

      try {
        const isDirInMilestone = getMilestonePhaseFilter(cwd);
        const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter(isDirInMilestone)
          .sort((a, b) => comparePhaseNum(a, b));

        for (const dir of dirs) {
          const dm = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
          if (dm) {
            if (/^999(?:\.|$)/.test(dm[1])) continue;
            if (comparePhaseNum(dm[1], phaseNum) > 0) {
              nextPhaseNum = dm[1];
              nextPhaseName = dm[2] || null;
              isLastPhase = false;
              break;
            }
          }
        }
      } catch {
        /* best-effort (#2245 audit): stage 1 of a deliberate 3-stage
         * cascading fallback for locating the next phase (disk dirs → roadmap
         * headings/checkboxes → lowest-outstanding-checkbox override, #2028
         * below). A disk-scan failure here is indistinguishable from "found
         * nothing on disk" and correctly falls through to stage 2, which
         * derives the same information independently from ROADMAP.md content
         * — not a silent data-loss path. */
      }

      if (isLastPhase && roadmapContent !== null) {
        try {
          const roadmapForPhases = extractCurrentMilestone(roadmapContent, cwd);
          // #1591: match BOTH heading-style phases (`### Phase N:`) AND
          // checkbox-list items, INCLUDING the canonical bold form the roadmap
          // template emits (`- [ ] **Phase N: Name**`). When the active
          // milestone's checklist is `- [ ]` items inside a <details> block
          // (and the next phase has no directory yet, so the disk-based
          // resolver finds nothing), this roadmap-enumeration fallback is the
          // only path that can find the next phase. The prior heading-only
          // pattern missed checkbox items, and a checkbox-only broadening still
          // missed the bold template rows → is_last_phase=true on a mid-milestone
          // phase. Allow optional `**`/`__` emphasis after the marker and stop
          // the name capture at emphasis so bold names slug cleanly; the number
          // capture is unchanged.
          // #1729: `(?:\s*\([^)\n]{0,200}\))?` after the number tolerates a pre-colon
          // ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE) so
          // `### Phase N (Cluster B): X` resolves. Captures are unchanged.
          const phasePattern = new RegExp(
            `(?:#{2,4}|-\\s*\\[[ xX]\\])\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)`,
            'gi'
          );
          let pm: RegExpExecArray | null;
          while ((pm = phasePattern.exec(roadmapForPhases)) !== null) {
            if (comparePhaseNum(pm[1], phaseNum) > 0) {
              nextPhaseNum = pm[1];
              nextPhaseName = pm[2]
                .replace(/\(INSERTED\)/i, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
              isLastPhase = false;
              break;
            }
          }
        } catch {
          /* best-effort (#2245 audit): stage 2 of the next-phase cascade
           * (see stage 1's comment above) — a failure here just leaves
           * isLastPhase as stage 1 left it; stage 3 (#2028) below runs next
           * regardless and provides a further, independent override. */
        }
      }

      // #2028: don't stamp "All phases complete" when a LOWER-numbered phase is
      // still outstanding. The two blocks above only clear isLastPhase when a
      // HIGHER-numbered phase exists, so completing the numerically-highest phase
      // out of order (e.g. Phase 10 before Phase 9) wrongly read as milestone-end.
      // A phase is complete iff its roadmap checkbox is `[x]` (phase.complete sets
      // this on completion — including the one just marked above); any earlier
      // phase in this milestone whose checkbox is still `[ ]` means the milestone
      // is not done, and the LOWEST such phase is the real next actionable item —
      // point next_phase at it so STATE.md advances to the gap rather than parking
      // on the just-completed phase. Roadmaps without phase checkboxes (heading-
      // only) retain the prior behavior — there is nothing to scan. The checkbox
      // pattern mirrors the sibling phasePattern's anchoring (only whitespace/bold
      // between the box and "Phase", a required `:`) so unrelated checklist lines
      // that merely mention "Phase N" don't match.
      if (isLastPhase && roadmapContent !== null) {
        try {
          const milestoneScope = extractCurrentMilestone(roadmapContent, cwd);
          const cbPattern = new RegExp(
            `-\\s*\\[(x| )\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)`,
            'gi'
          );
          let cbm: RegExpExecArray | null;
          let lowestOutstanding: { num: string; name: string } | null = null;
          while ((cbm = cbPattern.exec(milestoneScope)) !== null) {
            const isChecked = cbm[1].toLowerCase() === 'x';
            if (!isChecked && comparePhaseNum(cbm[2], phaseNum) < 0) {
              if (lowestOutstanding === null || comparePhaseNum(cbm[2], lowestOutstanding.num) < 0) {
                lowestOutstanding = {
                  num: cbm[2],
                  name: cbm[3].replace(/\(INSERTED\)/i, '').trim().toLowerCase().replace(/\s+/g, '-'),
                };
              }
            }
          }
          if (lowestOutstanding !== null) {
            isLastPhase = false;
            nextPhaseNum = lowestOutstanding.num;
            nextPhaseName = lowestOutstanding.name;
          }
        } catch {
          /* best-effort (#2245 audit): stage 3 (#2028) of the next-phase
           * cascade — a failure here simply leaves isLastPhase/nextPhaseNum
           * as stages 1-2 already determined them; this stage only ever
           * overrides toward "not last" when it finds a genuinely lower
           * outstanding phase, never the reverse. */
        }
      }

      if (fs.existsSync(statePath)) {
        const originalStateContent = platformReadSync(statePath) || '';
        let stateContent = originalStateContent;

        // ADR-1769 Phase 3: the STATE.md field-update policy (Current Phase
        // shape/name, Status, Current Plan, Last Activity + Description, and
        // the Completed/Total Phases + Progress percent block) now dispatches
        // to the STATE.md Transition Module. The ~90-line inline RMW callback
        // that lived here is the pure `completePhaseCore` in
        // src/state-transition.cts, backed by the field-classification table.
        // `updatePerformanceMetricsSection` + `syncStateFrontmatter` stay in
        // this adapter: they are section-table / disk-scan concerns, not
        // classified fields, and `syncStateFrontmatter` is the post-sync this
        // transaction needs (it does NOT go through readModifyWriteStateMd
        // because STATE.md is committed atomically with ROADMAP/REQUIREMENTS).
        const nextPhaseDisplayName =
          phaseDisplayNameFromRoadmap(roadmapContent, nextPhaseNum) ??
          phaseDisplayNameFromSlug(nextPhaseName);
        const completeResult = transitionCore(
          stateContent,
          {
            kind: 'completePhase',
            phaseNum,
            nextPhaseNum,
            nextPhaseName: nextPhaseDisplayName,
            isLastPhase,
            planCount,
            summaryCount,
          },
          {
            clock: realClock,
            progressProvider: () => null, // completePhase derives progress from the roadmap, not disk
            roadmapProvider: () => roadmapContent,
            sourcePath: statePath,
          },
        );
        stateContent = completeResult.content;

        stateContent = updatePerformanceMetricsSection(
          stateContent,
          cwd,
          phaseNum,
          planCount,
          summaryCount,
        );
        stateContent = syncStateFrontmatter(stateContent, cwd);

        writes.push({ filePath: statePath, before: originalStateContent, after: stateContent });
      }

      writePlanningFileSet(writes);
    };

    if (fs.existsSync(statePath)) {
      withStateLock(statePath, runPhaseCompleteTransaction);
    } else {
      runPhaseCompleteTransaction();
    }
    return null;
  });

  if (verificationBlocked) {
    const nextStep = verificationBlocked.next_command
      ? ` Next: ${verificationBlocked.next_command}`
      : '';
    error(
      `Phase ${phaseNum} verification is incomplete: ${verificationBlocked.next_action}${nextStep}`,
      ERROR_REASON.PHASE_VERIFICATION_INCOMPLETE,
    );
  }

  let autoPruned = false;
  try {
    const configPath = path.join(planningDir(cwd), 'config.json');
    if (fs.existsSync(configPath)) {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const workflow = rawConfig['workflow'] as Record<string, unknown> | undefined;
      const autoPruneEnabled = workflow && workflow['auto_prune_state'] === true;
      if (autoPruneEnabled && fs.existsSync(statePath)) {
        // Non-hoisted: load-order matters (stateMod must be fully resolved first).
        const { cmdStatePrune } = stateMod;
        cmdStatePrune(cwd, { keepRecent: '3', dryRun: false, silent: true }, true);
        autoPruned = true;
      }
    }
  } catch {
    /* intentionally empty — auto-prune is best-effort */
  }

  const result = {
    completed_phase: phaseNum,
    phase_name: phaseInfo['phase_name'],
    plans_executed: `${summaryCount}/${planCount}`,
    next_phase: nextPhaseNum,
    next_phase_name: nextPhaseName,
    is_last_phase: isLastPhase,
    date: today,
    roadmap_updated: fs.existsSync(roadmapPath),
    state_updated: fs.existsSync(statePath),
    requirements_updated: requirementsUpdated,
    auto_pruned: autoPruned,
    warnings,
    has_warnings: warnings.length > 0,
  };

  output(result, raw);
}

function cmdPhaseUatPassed(
  cwd: string,
  phaseNum: string | undefined,
  raw: boolean,
  opts: { policy?: { requireVerification?: boolean } } = {},
): void {
  if (!phaseNum) {
    error('phase number required for phase uat-passed');
  }

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  const report = evaluateUatPassed(phaseFullDir, { policy: opts.policy });

  output({ phase: phaseNum, ...report }, raw);
}

// #1437 — phase.list-plans: list plan files for a given phase number.
// Returns the full scan result from scanPhasePlans so callers can read plan
// paths without re-discovering the phase directory themselves.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

function cmdPhaseListPlans(cwd: string, phaseNum: string | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase list-plans');
  }

  const phaseInfo = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfo) {
    output({ phase: phaseNum, plan_count: 0, has_plans: false, plans: [], phase_dir: null }, raw);
    return;
  }

  const phaseDir = path.join(cwd, (phaseInfo as unknown as Record<string, unknown>)['directory'] as string);
  const scan = scanPhasePlans(phaseDir);
  const phaseRel = (phaseInfo as unknown as Record<string, unknown>)['directory'] as string;

  // Build absolute-usable relative paths for each plan file.
  const plans = scan.planFiles.map((f: string) => toPosixPath(path.join(phaseRel, f)));

  output({
    phase: phaseNum,
    phase_dir: phaseRel,
    plan_count: scan.planCount,
    has_plans: scan.planCount > 0,
    plans,
  }, raw);
}

export = {
  cmdPhasesList,
  cmdPhaseNextDecimal,
  cmdFindPhase,
  cmdPhasePlanIndex,
  cmdPhaseAdd,
  cmdPhaseAddBatch,
  cmdPhaseMvpMode,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
  cmdPhaseUatPassed,
  cmdPhaseListPlans,
  computeDependencyLevels,
};
