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
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON, formatDiagnosticToken } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateContract = require('./state-contract.cjs');
const { publishStateContract } = stateContract;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
// #2528: `extractCanonicalPlanId` used to exist here as a byte-identical second
// copy, and this PR had to patch BOTH with the same rewind rule — the exact
// generative-fix divergence CLAUDE.md warns about. Collapsed onto core-utils'
// copy, which was already the leaf owner, so there is no second surface left to
// drift and no parity test needed to police one.
const {
  toPosixPath, generateSlugInternal, readSubdirectories, extractCanonicalPlanId,
  findUnsummarizedPlans, normalizeLineEndings,
} = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const {
  normalizePhaseName,
  phaseMarkdownRegexSource,
  comparePhaseNum,
  matchPhaseDirs,
  isSentinelPhaseId,
  scopeToPhase,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
} = phaseIdMod;
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal, getArchivedPhaseDirs, listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, currentMilestoneRawRanges, withPhaseSection, findMilestoneScopeHeadingLines } = roadmapParserMod;
// #4129: the single owner of "count the ROADMAP's milestone Complete rows"
// (pure computation, no I/O — no cycle on this path) for the intent-first
// progress counters the phase-complete transaction passes downstream.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-lifecycle.cjs is an export= CommonJS module
import phaseLifecycleMod = require('./phase-lifecycle.cjs');
const { deriveProgressFromRoadmap: deriveProgressFromRoadmapForIntent, clampPercent: clampPercentForIntent } = phaseLifecycleMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync, contentChangedAfterNormalize } from './shell-command-projection.cjs';
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
// #2572: the artifact↔disk core behind the `verify-summary` verb. `verify.cts`
// has no transitive import path back to `phase.cts`, so this edge introduces no
// cycle (the reverse edge, `state.cts → verify.cjs`, would).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify.cjs is an export= CommonJS module
import verifyMod = require('./verify.cjs');
const { readVerificationStatus } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-dependency-graph.cjs is an export= CommonJS module
import planDependencyGraphMod = require('./plan-dependency-graph.cjs');
const { computeHaltPropagation, buildSummaryFileIndex, isSummaryFileHalted, isSummaryFileBlocked } = planDependencyGraphMod;

// #612: `resolvePhaseIdConvention` selects the write-time milestone-scope
// guard's terminator vocabulary (see assertDescriptionPreservesMilestoneScope).
const {
  planningDir, withPlanningLock, listAvailableWorkstreams,
  peekActiveWorkstream, diagnoseUnresolvedActiveWorkstream, describeUnresolvedWorkstreamReason,
  resolvePhaseIdConvention,
} = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- milestone-lock.cjs is an export= CommonJS module
import milestoneLockMod = require('./milestone-lock.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument, planIdFromFile } = planDocumentMod;
const { extractFrontmatter } = frontmatterMod;
const {
  readModifyWriteStateMd,
  stateExtractField,
  stateReplaceField,
  syncAndPreserveStateMd,
  withStateLock,
  updatePerformanceMetricsSection,
} = stateMod;

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
    // #3185 (ADR-3180 Decision 1): only the ENUMERATION routes through the
    // single owner. The two other modes below ask genuinely DIFFERENT
    // questions and are exempt by documented reason, never by a file
    // allowlist (ADR-3180 Decision 4a):
    //
    //   --phase <n>        locating ONE phase by token is phase LOCATION, a
    //                      question src/phase-locator.cts already owns via
    //                      findPhaseInternal/searchPhaseInDir. Scoping it to
    //                      the current milestone would make an out-of-window
    //                      phase report "Phase not found".
    //   --include-archived archived directories are BY DEFINITION from other
    //                      milestones; filtering them through the CURRENT
    //                      milestone window would return nothing at all.
    //
    // Generalizing #3183's rule ("a diagnostic about file NAMING wants the
    // physical set; only a question about outstanding WORK wants the live
    // set"): a LOOKUP wants the physical set; only "which phases belong to
    // this milestone" wants the scoped set.
    const archivedLabels: string[] = includeArchived
      ? getArchivedPhaseDirs(cwd).map((a) => `${a.name} [${a.milestone}]`)
      : [];

    let dirs: string[];
    // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
    // can tell a genuinely-empty milestone from one it could not scope. Only
    // the ENUMERATION path scopes anything; the LOOKUP path below has no
    // enumeration to report a scope for.
    let phaseScope: string | null = null;
    if (phase) {
      // LOOKUP (b): search the physical set, plus archived when asked.
      const lookupPool = [...readSubdirectories(phasesDir, true), ...archivedLabels];
      const normalized = normalizePhaseName(phase);
      // The pool is #3185's (physical set + archived); the matcher is this
      // PR's. `dirs` is deliberately not read here: on this base it is not
      // assigned until the branch below picks a match.
      const { matches } = matchPhaseDirs(lookupPool, normalized);
      const match = matches[0];
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    } else {
      // ENUMERATION (a): milestone-scoped and sentinel-filtered, plus
      // archived when asked (c).
      const enumerated = listMilestonePhaseDirs(phasesDir, { cwd });
      phaseScope = enumerated.scope;
      dirs = [...enumerated.value, ...archivedLabels];
      dirs.sort((a, b) => comparePhaseNum(a, b));
    }

    if (type) {
      const files: string[] = [];
      const warnings: string[] = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered: string[];
        if (type === 'plans') {
          // #3183: this is a "what plan files physically exist" query (this
          // IS the file-listing command), not a live-completion question, so
          // it uses the single owner's allPlanFiles (root+nested, INCLUDING
          // status: superseded) rather than a root-only readdirSync filter
          // that also missed nested plans.
          //
          // #2893 (regression fix): `allPlanFiles` also carries
          // `isRootPlanFile`'s loose `/PLAN/i` fallback (deliberately
          // permissive for live-plan COUNTING elsewhere — see
          // plan-count-single-owner.test.cjs). That fallback silently
          // recognized a non-canonically-named file (e.g.
          // `01-PLAN-01-foundation.md`) as "matched", which defeated this
          // command's #2893 naming-convention diagnostic entirely (no
          // warning, file listed as if valid). Intersect with the STRICT
          // `isCanonicalPlanFile` predicate so this diagnostic — and the
          // `files` list this command actually returns — only ever
          // recognizes the canonical root/nested forms, exactly like the
          // pre-#3183 behavior this feature was built and tested against.
          filtered = scanPhasePlans(dirPath).allPlanFiles.filter(isCanonicalPlanFile);
          const w = describeNonCanonicalPlans(dirFiles, filtered);
          if (w) warnings.push(`${dir}: ${w}`);
        } else if (type === 'summaries') {
          filtered = scanPhasePlans(dirPath).summaryFiles;
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result: Record<string, unknown> = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
        // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
        // can tell a genuinely-empty milestone from one it could not scope.
        phase_scope: phaseScope,
      };
      if (warnings.length) result['warning'] = warnings.join(' | ');
      output(result, raw, files.join('\n'));
      return;
    }

    // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
    // can tell a genuinely-empty milestone from one it could not scope.
    output({ directories: dirs, count: dirs.length, phase_scope: phaseScope }, raw, dirs.join('\n'));
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
      baseExists = matchPhaseDirs(dirs, normalized).matches.length > 0;

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

/**
 * `phase.tdd-applicable <plan-file> [--cli-flag]` (#4273, Phase 1 of epic
 * #4272) — resolves whether the TDD RED/GREEN/REFACTOR gate applies to a
 * given plan, in strict precedence order: an explicit `--cli-flag` wins over
 * the plan's own `type: tdd` frontmatter, which wins over any task in the
 * plan carrying `tdd="true"` (the #4265 mixed-mode shape), which wins over
 * the project-wide `workflow.tdd_mode` config default. Mirrors
 * `cmdPhaseMvpMode`'s precedence-cascade shape immediately above.
 */
function cmdPhaseTddApplicable(cwd: string, args: string[], raw: boolean): void {
  const planPath = args[0];
  if (!planPath) {
    error('Usage: phase.tdd-applicable <plan-file> [--cli-flag]', ERROR_REASON.USAGE);
  }

  const resolvedPath = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  if (!fs.existsSync(resolvedPath)) {
    error(`Plan file not found: ${planPath}`, ERROR_REASON.PHASE_NOT_FOUND);
  }

  const cliFlagPresent = args.includes('--cli-flag');
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const doc = parsePlanDocument(content, resolvedPath);
  const planType = doc.type;
  const taskTddAttribute = doc.tasks.some((t) => t.tdd === 'true');
  const config = loadConfig(cwd);
  const configTddMode = Boolean(config.tdd_mode);

  let applicable = false;
  let source = 'none';
  if (cliFlagPresent) {
    applicable = true;
    source = 'cli_flag';
  } else if (planType === 'tdd') {
    applicable = true;
    source = 'plan_frontmatter';
  } else if (taskTddAttribute) {
    applicable = true;
    source = 'task_attribute';
  } else if (configTddMode) {
    applicable = true;
    source = 'config';
  }

  output(
    {
      applicable,
      source,
      plan_type: planType,
      config_tdd_mode: configTddMode,
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
    // #3218: scalar counts alongside the arrays above. Left `null` (not `0`)
    // when the phase can't be resolved at all — a fabricated `0` here would
    // read identically to "phase exists with zero plans", which is a real,
    // distinct answer (see the `status: superseded` case below).
    plan_count: null,
    summary_count: null,
    plan_count_all: null,
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
      // #2528: selection delegates to the canonical two-pass matcher (exact
      // token match, then the bare-integer leading-digit-run fallback) shared
      // with the locator and the phase-plan-index scan.
      const { matches } = matchPhaseDirs(dirs, normalized);
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
      // #3183: canonical, live (superseded-excluded) plan/summary sets
      // (root+nested) from the single owner, rather than a root-only
      // isCanonicalPlanFile filter + hand-rolled summary filter.
      //
      // #2893 (regression fix): both `plans` and the naming-diagnostic
      // "matched" set are further intersected with the STRICT
      // `isCanonicalPlanFile` predicate — scanPhasePlans's own
      // planFiles/allPlanFiles carry `isRootPlanFile`'s loose `/PLAN/i`
      // fallback (deliberately permissive for live-plan COUNTING elsewhere),
      // which silently recognized a non-canonically-named file (e.g.
      // `01-PLAN-01-foundation.md`) as a valid plan here and defeated this
      // command's #2893 naming-convention diagnostic (no warning, offender
      // listed in `plans` as if valid).
      const phaseScan = scanPhasePlans(phaseDir);
      const plans = phaseScan.planFiles.filter(isCanonicalPlanFile).sort();
      const summaries = phaseScan.summaryFiles.slice().sort();
      // describeNonCanonicalPlans is a NAMING-CONVENTION diagnostic, unrelated
      // to supersession — compare against allPlanFiles (every plan-shaped file
      // the owner recognizes, canonical or not) rather than the live-only
      // `plans`, so a superseded-but-canonically-named plan is not misreported
      // as a naming violation.
      const canonicalAllPlanFiles = phaseScan.allPlanFiles.filter(isCanonicalPlanFile);
      const planNamingWarning = describeNonCanonicalPlans(phaseFiles, canonicalAllPlanFiles);

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
        // #3218: scalar counts additive alongside `plans[]`/`summaries[]`,
        // which stay unchanged for existing consumers. Naming mirrors
        // `roadmap.analyze`'s `plan_count`/`summary_count` (live, i.e.
        // status:superseded EXCLUDED — same set as `plans`/`summaries`
        // above) so the two surfaces read alike. `plan_count_all` is the
        // PHYSICAL count — every canonically-named plan file on disk,
        // status:superseded INCLUDED, same set `planNamingWarning` above
        // diffs against (`canonicalAllPlanFiles`). The `_all` suffix
        // deliberately echoes `scanPhasePlans`'s own `allPlanFiles` field so
        // a reader can trace the name back to its source rather than guess
        // which of two similarly-named integers is the filtered one.
        plan_count: plans.length,
        summary_count: summaries.length,
        plan_count_all: canonicalAllPlanFiles.length,
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

interface RawPlan {
  id: string;
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  objective: string | null;
  filesModified: string[];
  filesDeleted: string[];
  taskCount: number;
  hasSummary: boolean;
  /** #2830: true iff this plan's own SUMMARY declares `status: halted` (a designed stop). */
  halted: boolean;
  /** #1689: optional per-plan specialist executor hint (frontmatter `agent_hint:`). null when unset. */
  agentHint: string | null;
}

/**
 * Resolve a raw `depends_on` token to the `RawPlan.id` it refers to
 * (case-folded exact match, falling back to canonical-id matching, falling
 * back to the in-phase short-form plan number — #3897 rung 4). Returns
 * `null` when the token does not resolve to any plan in this phase (a typo
 * or a cross-phase reference) — every call site treats that as "ignore this
 * edge", never a throw. Shared by `computeDependencyLevels`'s DAG-edge
 * resolution and (#2830) the halt-propagation node resolution, so the two can
 * never disagree about which token resolves to which plan. NOT used by the
 * `depends_on` display mapping (#3785/N3) — that stays a passthrough by
 * design; see the comment at its call site.
 *
 * `shortFormToId` (#3897 rung 4, ADR-3473 §8.9) is the third tier, consulted
 * only when neither `planMap` nor `canonicalToId` resolves the token. It is
 * optional so any caller that has not been threaded through yet (there are
 * none left in this file) degrades to the pre-#3897 two-tier behavior rather
 * than throwing on a missing argument.
 */
function resolveDependencyId(
  dep: string,
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
  shortFormToId?: Map<string, string>,
): string | null {
  const lower = dep.toLowerCase();
  if (planMap.has(lower)) return (planMap.get(lower) as RawPlan).id;
  if (canonicalToId.has(lower)) return canonicalToId.get(lower) as string;
  return shortFormToId?.get(lower) ?? null;
}

// #3897 rung 4 (ADR-3473 §8.9) — builds the third depends_on resolution tier:
// a map from an in-phase BARE PLAN NUMBER (e.g. "01") to the plan id whose
// canonical id ends with that number. Recovered from the retired SDK lineage
// (sdk/src/query/phase.ts at 11918dcc3^) with ONE deliberate narrowing: the
// lost implementation indexed ANY trailing dash-segment of a canonical id,
// with no constraint that the segment be a plan NUMBER — so a phase
// containing both `09-FIX-auth-PLAN.md` and `09-GAP-auth-PLAN.md` (canonical
// id `09-FIX-auth`, trailing segment "auth") would silently bind
// `depends_on: ["auth"]` to whichever sorted first, fabricating a
// wave-affecting DAG edge with ZERO warning — a mis-resolved edge, which is
// worse than a dropped one (found in isolated correctness review, #3897).
// `docs/reference/plan-md.md` already documents this tier as resolving "the
// bare plan number", so requiring `/^\d+$/` on the trailing segment is a
// strict narrowing onto the tier's OWN documented contract, not a behavior
// change for any legitimate input. Do NOT restore the unconstrained
// lastDash-slice "to match the recovered original" — the original was wrong
// here; this rung deliberately departs from it in this one respect, and only
// this one. Everything else — the `lastDash` bound, first-write-wins,
// lowercasing — is kept exactly as recovered:
//   - first write wins, deterministic because rawPlans is passed in sorted
//     plan-file order (D4/T44) and this loop iterates in that same order;
//   - a canonical id with no dash (`lastDash === -1` or `lastDash === 0`,
//     e.g. "24" or "-01") or a trailing dash (`lastDash === canonical.length
//     - 1`, e.g. "09-") is never indexed (D5).
// Exported so callers can build this map once and so tests assert against
// this REAL implementation rather than a hand-rolled copy that could
// silently disagree with it after a future change here (CLAUDE.md's
// generative-fix-divergence rule).
function buildShortFormToId(rawPlans: RawPlan[]): Map<string, string> {
  const shortFormToId = new Map<string, string>();
  for (const p of rawPlans) {
    const canonical = extractCanonicalPlanId(p.id);
    const lastDash = canonical.lastIndexOf('-');
    if (lastDash > 0 && lastDash < canonical.length - 1) {
      const shortForm = canonical.slice(lastDash + 1).toLowerCase();
      if (/^\d+$/.test(shortForm) && !shortFormToId.has(shortForm)) {
        shortFormToId.set(shortForm, p.id);
      }
    }
  }
  return shortFormToId;
}

// O(V + E). Assigns each in-phase plan its longest-path topological level over the
// in-phase dependsOn DAG (Kahn's algorithm). Returns { level: Map<id,number>, visited: number,
// order: string[] }. visited < rawPlans.length signals a dependency cycle. `order` (#2830) is
// the exact dequeue order this pass already produces — a valid topological order — passed to
// computeHaltPropagation as `precomputedOrder` so halt propagation does not re-run Kahn's
// algorithm a second time over the same graph.
//
// `shortFormToId` (#3897 rung 4, optional — see resolveDependencyId) is threaded through so a
// bare in-phase plan-number token (`depends_on: ["01"]`) resolves as a real DAG edge instead of
// being dropped and silently collapsing the dependent plan to wave 1 (D3).
function computeDependencyLevels(
  rawPlans: RawPlan[],
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
  shortFormToId?: Map<string, string>,
): { level: Map<string, number>; visited: number; order: string[]; unresolved: Array<{ plan: string; token: string }> } {
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  // #3427 / ADR-3473 §8.5: a depends_on token that resolves via NONE of the
  // three tiers (planMap, canonicalToId, shortFormToId) is a dropped edge.
  // Naming it here (rather than silently `continue`-ing past it) lets
  // cmdPhasePlanIndex surface the token's own warning instead of
  // manufacturing a wave-mismatch verdict from the resulting damaged graph
  // (#3427).
  const unresolved: Array<{ plan: string; token: string }> = [];

  for (const p of rawPlans) {
    if (!inDeg.has(p.id)) inDeg.set(p.id, 0);
    if (!adj.has(p.id)) adj.set(p.id, []);
    for (const dep of p.dependsOn) {
      const resolvedDep = resolveDependencyId(dep, planMap, canonicalToId, shortFormToId);
      if (!resolvedDep) {
        unresolved.push({ plan: p.id, token: String(dep) });
        continue;
      }
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

  return { level, visited, order: queue, unresolved };
}

function cmdPhasePlanIndex(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  let phaseDir: string | null = null;
  let phaseDirName: string | null = null;
  let ambiguousMatches: string[] | null = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    // #2528: selection delegates to the canonical two-pass matcher shared with
    // the locator and the find-phase scan (this site previously first-matched
    // with `.find()` and had no multi-match guard — the #2237 fail-loud rule
    // now applies here too, so the three resolution paths cannot disagree).
    const { matches } = matchPhaseDirs(dirs, normalized);
    if (matches.length > 1) {
      ambiguousMatches = matches;
    } else if (matches.length === 1) {
      phaseDir = path.join(phasesDir, matches[0]);
      phaseDirName = matches[0];
    }
  } catch {
    // phases dir doesn't exist
  }

  if (ambiguousMatches) {
    output(
      {
        phase: normalized,
        error: `Phase ${normalized} is ambiguous: ${ambiguousMatches.length} directories match (${ambiguousMatches.map((m) => `"${m}"`).join(', ')}).`,
        ambiguous_matches: ambiguousMatches,
        plans: [], waves: {}, incomplete: [], has_checkpoints: false,
      },
      raw,
    );
    return;
  }

  if (!phaseDir) {
    output(
      { phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], runnable: [], has_checkpoints: false },
      raw,
    );
    return;
  }
  void phaseDirName; // used only to set phaseDir above

  // phaseFiles stays root-only readdirSync — it feeds only
  // describeNonCanonicalPlans's near-miss naming diagnostic below, which is
  // advisory text, not a counted/scheduled file set.
  const phaseFiles = fs.readdirSync(phaseDir);
  // #3183 (highest-severity site, ADR-3180 Decision 2): canonical LIVE
  // plan/summary sets (root+nested, status: superseded EXCLUDED) from the
  // single owner. This fixes two real bugs in the wave/dependency index this
  // function builds: (1) a superseded plan used to still get scheduled into
  // an execution wave, and (2) a phase using the #3139 nested `plans/`
  // layout used to report ZERO plans (root-only readdirSync, no `plans/`
  // join).
  // #2893 (regression fix): intersected with the STRICT `isCanonicalPlanFile`
  // predicate — scanPhasePlans's own planFiles/allPlanFiles carry
  // `isRootPlanFile`'s loose `/PLAN/i` fallback (deliberately permissive for
  // live-plan COUNTING elsewhere), which silently scheduled a
  // non-canonically-named file (e.g. `01-PLAN-01-foundation.md`) into a wave
  // here and defeated this command's #2893 naming-convention diagnostic (no
  // warning). Restores the pre-#3183, tested behavior: only canonical
  // root/nested filenames are ever counted or scheduled by this command.
  const phaseScan = scanPhasePlans(phaseDir);
  const planFiles = phaseScan.planFiles.filter(isCanonicalPlanFile).sort();
  const summaryFiles = phaseScan.summaryFiles;
  // describeNonCanonicalPlans is a NAMING-CONVENTION diagnostic, unrelated to
  // supersession — compare against allPlanFiles (every plan-shaped file the
  // owner recognizes, canonical or not) rather than the live-only planFiles,
  // so a superseded-but-canonically-named plan is not misreported as a
  // naming violation.
  const planNamingWarning = describeNonCanonicalPlans(
    phaseFiles,
    phaseScan.allPlanFiles.filter(isCanonicalPlanFile),
  );

  // #3183: completion pairing via the canonical findUnsummarizedPlans
  // (shares its `summaryCandidates` matching rule with countMatchedSummaries,
  // and is layout-agnostic — it pairs a nested `plans/PLAN-01.md` with
  // `plans/SUMMARY-01.md` correctly) instead of a bespoke ID-Set built from
  // extractCanonicalPlanId, which only ever handled the root-canonical
  // `-PLAN.md`/`-SUMMARY.md` naming form.
  //
  // #3345: the summary list is filtered through the SAME shared predicate
  // scanPhasePlans filters its countable set with
  // (plan-dependency-graph.cjs's isSummaryFileBlocked), so a SUMMARY declaring
  // `status: blocked` reads as NO completion record here — has_summary false,
  // the plan lands in `incomplete` — exactly matching the count side. Fail-open
  // on a SUMMARY with no status key / unreadable file (filename fallback);
  // `status: halted` stays summarized (#2830 designed stop). summaryFileByPlanId
  // below still indexes EVERY summary on disk because the halted lookup is a
  // file resolution for reading status, not a completion pairing.
  const countableSummaryFiles = summaryFiles.filter(
    (f) => !isSummaryFileBlocked(path.join(phaseDir, f)),
  );
  const unsummarizedPlanFiles = new Set(findUnsummarizedPlans(planFiles, countableSummaryFiles));
  // #2830: reverse lookup from a completed plan's id (exact or canonical) to
  // the actual summary filename, so a plan's own SUMMARY frontmatter can be
  // read for its `status`. Shared builder (also used by phase-locator.cts's
  // searchPhaseInDir) so the two can never disagree about which summary
  // belongs to which plan. This is a FILE resolution for reading halted
  // status, not a completion-count pairing rule, so it is unaffected by the
  // #3183 pairing migration above.
  const summaryFileByPlanId = buildSummaryFileIndex(summaryFiles, extractCanonicalPlanId);

  // ── Pass 1: parse each plan file ─────────────────────────────────────────

  const rawPlans: RawPlan[] = [];

  for (const planFile of planFiles) {
    const planId = planIdFromFile(planFile);
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    // #2790: plan-body parsing is owned by the shared Plan Document Module, so
    // this command and the read-only `planning.inspect` query cannot drift on
    // what a plan document says. planPath is still passed so a truncated
    // PLAN.md names the file in the #1882 diagnostic.
    const planDoc = parsePlanDocument(content, planPath);

    const hasSummary = !unsummarizedPlanFiles.has(planFile);

    // #2830: a plan can have a SUMMARY (hasSummary=true) and still be halted —
    // a designed stop still writes a completion record, just one whose status
    // says "halted" rather than "complete". Only look up the summary file
    // when one exists; there is nothing to read otherwise.
    const summaryFile =
      summaryFileByPlanId.get(planId) ?? summaryFileByPlanId.get(extractCanonicalPlanId(planFile));
    const halted = hasSummary && summaryFile !== undefined
      ? isSummaryFileHalted(path.join(phaseDir, summaryFile))
      : false;

    rawPlans.push({
      id: planId,
      declaredWave: planDoc.declaredWave,
      dependsOn: planDoc.dependsOn,
      autonomous: planDoc.autonomous,
      objective: planDoc.objective,
      filesModified: planDoc.filesModified,
      filesDeleted: planDoc.filesDeleted,
      agentHint: planDoc.agentHint,
      taskCount: planDoc.taskCount,
      hasSummary,
      halted,
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
  // #3897 rung 4 (ADR-3473 §8.9) — the third depends_on resolution tier.
  // Resolves a bare in-phase plan-number short form (e.g. "01") to its owning
  // plan id. In-phase only by construction (T49): the map is built from THIS
  // phase's rawPlans alone, so a short form colliding with a different
  // phase's plan can never be a candidate. See {@link buildShortFormToId}'s
  // own comment for the numeric-only narrowing this rung applies on top of
  // the recovered SDK-lineage algorithm.
  const shortFormToId = buildShortFormToId(rawPlans);

  const { level, visited, order, unresolved } = computeDependencyLevels(rawPlans, planMap, canonicalToId, shortFormToId);

  if (visited < rawPlans.length) {
    const cycleNodes = rawPlans.filter((p) => !level.has(p.id)).map((p) => p.id);
    error(
      `depends_on cycle detected in phase ${normalized} — cycle involves: ${cycleNodes.join(', ')}`,
    );
    return;
  }

  // #2830: single shared halt-propagation pass, reusing the SAME id
  // resolution (planMap/canonicalToId) AND the SAME topological order
  // (`order`, computeDependencyLevels's own Kahn's-algorithm dequeue
  // sequence) — passed as `precomputedOrder` so computeHaltPropagation does
  // NOT run Kahn's algorithm a second time over this graph.
  const haltNodes = rawPlans.map((p) => ({
    id: p.id,
    resolvedDependsOn: p.dependsOn
      .map((dep) => resolveDependencyId(String(dep), planMap, canonicalToId, shortFormToId))
      .filter((id): id is string => id !== null),
    halted: p.halted,
  }));
  const { blockedBy } = computeHaltPropagation(haltNodes, order);

  // ── Pass 3: determine lowest bucket key and build output ─────────────────

  const anyWaveZero = rawPlans.some((p) => p.declaredWave === 0);
  const levelOffset = anyWaveZero ? 0 : 1;

  const plans: Record<string, unknown>[] = [];
  const waves: Record<string, string[]> = {};
  const incomplete: string[] = [];
  const runnable: string[] = [];
  let hasCheckpoints = false;
  const warnings: string[] = [];

  // #3427 / ADR-3473 §8.5: name every dropped depends_on edge (plan AND
  // token) rather than letting it silently collapse the plan to a DAG root.
  // A plan with at least one unresolved token gets ITS OWN warning here and
  // the wave-mismatch verdict below is suppressed for that plan ONLY — a
  // plan with no dropped edges and a genuinely wrong `wave:` still warns
  // (N3, D6, T25).
  const plansWithUnresolvedTokens = new Set<string>();
  for (const { plan, token } of unresolved) {
    plansWithUnresolvedTokens.add(plan);
    warnings.push(
      `Plan ${plan}: depends_on token ${formatDiagnosticToken(token)} does not resolve to any plan in this phase — edge dropped, wave placement for this plan may be unreliable`,
    );
  }

  for (const rawPlan of rawPlans) {
    if (!rawPlan.autonomous) {
      hasCheckpoints = true;
    }
    const blockedByIds = blockedBy.get(rawPlan.id) ?? [];
    if (!rawPlan.hasSummary) {
      incomplete.push(rawPlan.id);
      // #2830: the runnable-only view — incomplete AND not transitively
      // blocked by a halted upstream plan. Additive alongside `incomplete`,
      // which keeps its existing "no SUMMARY yet" meaning unchanged.
      if (blockedByIds.length === 0) {
        runnable.push(rawPlan.id);
      }
    }

    const computedWave = (level.get(rawPlan.id) ?? 0) + levelOffset;
    const effectiveWave = computedWave;
    // #3427 (D5/N3): suppress the wave-mismatch verdict for a plan that has
    // at least one unresolved depends_on token — its own dropped-edge
    // warning above already explains the degraded wave placement, so the
    // mismatch here would blame the author for a DAG the tool itself
    // couldn't build. A plan with NO unresolved tokens still gets a genuine
    // mismatch reported (N3, T25) — the suppression is per-plan, never blanket.
    if (
      rawPlan.declaredWave !== null &&
      rawPlan.declaredWave !== computedWave &&
      !plansWithUnresolvedTokens.has(rawPlan.id)
    ) {
      warnings.push(
        `Plan ${rawPlan.id}: declared wave: ${rawPlan.declaredWave} but depends_on DAG places it in wave ${computedWave}`,
      );
    }

    const plan: Record<string, unknown> = {
      id: rawPlan.id,
      wave: effectiveWave,
      // DELIBERATELY not `resolveDependencyId`: the emitted field is a DISPLAY
      // mapping, not the DAG resolution. It rewrites a dep only when it names a
      // plan directly (planMap) and otherwise passes it through verbatim — a
      // short canonical prefix like `24-01` stays `24-01` rather than becoming
      // `24-01-auth-hardening`. #3785 pins that contract. Full resolution via
      // canonicalToId is used for the wave DAG and #2830 halt propagation only;
      // routing this line through it too silently changed the output shape.
      depends_on: rawPlan.dependsOn.map((dep) => {
        const lower = String(dep).toLowerCase();
        return planMap.has(lower) ? (planMap.get(lower) as RawPlan).id : dep;
      }),
      autonomous: rawPlan.autonomous,
      objective: rawPlan.objective,
      files_modified: rawPlan.filesModified,
      files_deleted: rawPlan.filesDeleted,
      agent_hint: rawPlan.agentHint,
      task_count: rawPlan.taskCount,
      has_summary: rawPlan.hasSummary,
      // #2830: additive fields — halted is this plan's OWN status; blocked_by
      // names the halted plan(s) transitively upstream of it (empty when not
      // blocked). Neither mutates has_summary/incomplete's existing meaning.
      halted: rawPlan.halted,
      blocked_by: blockedByIds,
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
    runnable,
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

/**
 * #3163: compute the byte offset in `rawContent` where a new `### Phase N:`
 * entry should be inserted — at the end of the active phase list, scoped to the
 * CURRENT MILESTONE so the entry can never land before a trailing `---` in
 * shipped/history/backlog material (the file's last `---` on a long roadmap
 * sits deep in archive). When no current milestone can be resolved (no
 * STATE.md `milestone:` and no in-progress `🚧`/`🔄` marker), fall back to the
 * legacy whole-file lastIndexOf('\n---') so simple no-milestone roadmaps keep
 * their existing behavior.
 */
function phaseEntryInsertOffset(rawContent: string, cwd: string): number {
  const ranges = currentMilestoneRawRanges(rawContent, cwd);
  if (!ranges) {
    const legacy = rawContent.lastIndexOf('\n---');
    return legacy > 0 ? legacy : rawContent.length;
  }
  const window = rawContent.slice(ranges.primary.start, ranges.primary.end);
  const lastSeparator = window.lastIndexOf('\n---');
  return lastSeparator > 0 ? ranges.primary.start + lastSeparator : ranges.primary.end;
}

/**
 * #3262 (write-time milestone-scope guard): the phase-creation and
 * phase-insertion entry templates interpolate the caller's `description`
 * verbatim into `### Phase N: ${description}`. A description embedding a
 * level 1-3 heading that carries a milestone marker (version token,
 * ✅/📋/🚧/🔄, or the word "Milestone") would splice a heading that TERMINATES
 * the current milestone window (`computeMilestoneSectionEnd`) and silently
 * drops every later phase out of the derived milestone phase set. Reject
 * before any write or phase-directory creation — the fail-loud sibling of
 * the edit-phase workflow's depends_on gate. The predicate itself
 * (`findMilestoneScopeHeadingLines`) is fence-aware and Phase-heading-exempt,
 * so ordinary descriptions and the phase's own numbered heading never trip it.
 *
 * #612: the predicate is convention-SELECTED, because the terminator
 * vocabulary it mirrors is. On an opted-in bracket repo the ADR-canonical
 * `## [GSD.09] Hidden` carries none of the markers listed above and yet
 * terminates the window, so the blind call accepted the exact description the
 * guard exists to reject — measured at this CLI seam, two `phase add` calls,
 * the second phase silently outside the milestone phase set. Resolved through
 * the same tolerant shape the read path uses (`planningDir` throws on a
 * poisoned `GSD_PROJECT`/`GSD_WORKSTREAM` segment, and this guard runs BEFORE
 * `loadConfig` and the ROADMAP existence check — an unresolvable convention
 * must degrade to the pre-existing legacy vocabulary, never turn a rejection
 * into a crash).
 */
function assertDescriptionPreservesMilestoneScope(cwd: string, description: string, command: string): void {
  let convention: string | null = null;
  try {
    convention = resolvePhaseIdConvention(cwd);
  } catch { /* unresolvable convention → treat as not-configured (base behaviour) */ }
  const offending = findMilestoneScopeHeadingLines(description, convention);
  if (offending.length === 0) return;
  const markerList = convention === 'bracket'
    ? `(a vN.N version token, a ✅/📋/🚧/🔄 marker, the word "Milestone", or — under the bracket convention — a "[CODE.NN] Name" milestone heading)`
    : `(a vN.N version token, a ✅/📋/🚧/🔄 marker, or the word "Milestone")`;
  error(
    `${command}: description contains a milestone-scoping heading line — writing it to ROADMAP.md would terminate ` +
      `the current milestone window and silently drop later phases out of the milestone scope. ` +
      `Offending line(s): ${offending.map((line) => JSON.stringify(line)).join(', ')}. ` +
      `Rewrite the line so it is not a level 1-3 "#" heading carrying a milestone marker ` +
      markerList + `.`
  );
}

/**
 * #3849 — widen "used phase numbers" beyond this checkout. Every sibling git
 * worktree carries its own `.planning/` on its own branch, so a phase minted
 * there is invisible to the cwd-scoped sources (headers, bullets, on-disk
 * dirs). Scan each sibling's phase-directory names (cheap — dir names alone
 * caught the real incident) and its WHOLE ROADMAP.md headers (a row can exist
 * before any directory does; milestone-scoping is wrong here because a number
 * used under any milestone on another branch is still taken).
 *
 * #4225 — the horizon must track the ALLOCATION scope. When the allocation is
 * workstream-scoped (`--ws`/`GSD_WORKSTREAM`, resolved into the env before
 * dispatch), the sibling's copy of the SAME workstream is what carries that
 * scope's independent numbering; the sibling's ROOT roadmap and phases/
 * belong to a different numbering universe (docs/FEATURES.md §51 REQ-WS-01 —
 * workstream state is isolated in `.planning/workstreams/{name}/`) and must
 * not contribute. `planningDir(wt, ws)` reuses the canonical resolver, so the
 * sibling scope matches the local scope's own resolution (env workstream plus
 * env project segment) by construction; `ws === null` (no workstream active)
 * keeps the #3849 root-scope horizon byte-for-byte.
 *
 * Widen, never refuse: a missing `.planning/`, an unreadable sibling, a
 * non-git cwd, or an unavailable git binary each leave `used` untouched —
 * allocation then behaves exactly as it did before this horizon existed.
 * A sibling that simply lacks the active workstream's directory is the same
 * fail-open case: it contributes nothing. Sentinels reuse the canonical
 * `isSentinelPhaseId`; the dir pattern is the same one the on-disk scan uses,
 * so decimal sub-phases (`411.1-foo`) are correctly not integers.
 */
function collectSiblingWorktreePhaseNums(cwd: string, used: Set<number>): void {
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      // Same subprocess band as the other git call sites (smart-entry, check-command-router):
      // inside the 5-30s git window, hidden console window on Windows, bounded buffer.
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return; // not a git repo / git unavailable — unchanged behavior
  }
  // #4225: the env workstream, read once with planningDir's own discriminator
  // (`?? null` = deliberately no workstream — never re-derived per sibling).
  // A poisoned value would already have thrown at the local `planningDir(cwd)`
  // call every allocator makes before reaching this horizon; the per-sibling
  // try/catch below still keeps any resolution failure fail-open.
  const ws = process.env['GSD_WORKSTREAM'] ?? null;
  const siblingPlanningDir = (wt: string): string => planningDir(wt, ws);
  const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
  // Same header shape the allocators scan locally (#1729 tag tolerance).
  const headerPattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = line.slice('worktree '.length).trim();
    if (!wt || path.resolve(wt) === path.resolve(cwd)) continue;
    try {
      for (const entry of fs.readdirSync(path.join(siblingPlanningDir(wt), 'phases'))) {
        const match = entry.match(dirNumPattern);
        if (!match) continue;
        const num = parseInt(match[1], 10);
        if (!isSentinelPhaseId(num)) used.add(num);
      }
    } catch {
      /* worktree has no .planning (or no copy of this scope) — normal, contributes nothing */
    }
    try {
      const content = fs.readFileSync(path.join(siblingPlanningDir(wt), 'ROADMAP.md'), 'utf-8');
      let m: RegExpExecArray | null;
      headerPattern.lastIndex = 0;
      while ((m = headerPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (!isSentinelPhaseId(num)) used.add(num);
      }
    } catch {
      /* no roadmap in that worktree (or scope) — normal, contributes nothing */
    }
  }
}

function cmdPhaseAdd(cwd: string, description: string, raw: boolean, customId?: string): void {
  if (!description) {
    error('description required for phase add');
  }
  assertDescriptionPreservesMilestoneScope(cwd, description, 'phase add');

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
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
      }

      // 3) On-disk phase directories (e.g. phases/11-foo/ with no header yet)
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
          if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
        }
      }

      // phase.add appends after the highest *used* number. Collecting numbers from
      // section headers, roadmap bullets, AND on-disk dirs above is what prevents the
      // #1229 collision (a bullet-only Phase N is now counted), so max+1 cannot reuse
      // an existing number.
      // 4) Sibling git worktrees (#3849) — same max+1, wider horizon: a number
      // taken on another branch is still taken.
      collectSiblingWorktreePhaseNums(cwd, usedPhaseNums);
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

    const insertAt = phaseEntryInsertOffset(rawContent, cwd);
    const updatedContent = rawContent.slice(0, insertAt) + phaseEntry + rawContent.slice(insertAt);

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
  // #3227 (design doc §40 row 26 / "Not-corruption" rule): every
  // `publishStateContract` call site in this file is audited so a refreshed
  // state.json `updated_at` always means something on disk actually moved —
  // a stale-but-refreshed timestamp is worse than no refresh, because it
  // reads as fresh to a downstream watcher. This site is unconditional
  // because every reachable path either exits via `error()` (process.exit,
  // never reaches here) or falls through to the unconditional
  // `platformEnsureDir`/`platformWriteSync` pair above that always creates
  // the phase directory and rewrites ROADMAP.md — there is no code path that
  // reaches this line without having just written to disk. Best-effort —
  // cannot throw, cannot change this command's exit code or output.
  publishStateContract(cwd);
}

function cmdPhaseAddBatch(cwd: string, descriptions: string[], raw: boolean): void {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    error('descriptions array required for phase add-batch');
  }
  // #3262: validate every description BEFORE the lock — the batch is
  // all-or-nothing, so one offending description must reject the whole batch
  // with no ROADMAP write and no phase directories created.
  for (const description of descriptions) {
    assertDescriptionPreservesMilestoneScope(cwd, description, 'phase add-batch');
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
      // Same three cwd-scoped sources as cmdPhaseAdd (#1229): headers, roadmap
      // bullets, on-disk dirs. The bullet scan was missing here — a bullet-only
      // `Phase N` row was invisible to batch allocation (#3849 secondary).
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      const bulletPattern = /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (isSentinelPhaseId(num)) continue;
        if (num > maxPhase) maxPhase = num;
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (isSentinelPhaseId(num)) continue;
        if (num > maxPhase) maxPhase = num;
      }
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
          if (isSentinelPhaseId(num)) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }
      // 4) Sibling git worktrees (#3849) — same max+1, wider horizon.
      const siblingNums = new Set<number>();
      collectSiblingWorktreePhaseNums(cwd, siblingNums);
      for (const num of siblingNums) {
        if (num > maxPhase) maxPhase = num;
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
      const insertAt = phaseEntryInsertOffset(rawContent, cwd);
      rawContent = rawContent.slice(0, insertAt) + phaseEntry + rawContent.slice(insertAt);
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
  // #3227: unconditional here because `platformWriteSync(roadmapPath, rawContent)`
  // above always rewrites ROADMAP.md for every description in the batch before
  // this line is reached; the only refusal path is the `error('ROADMAP.md not
  // found')` above, which terminates the process and never reaches here.
  publishStateContract(cwd);
}

function cmdPhaseInsert(cwd: string, afterPhase: string, description: string, raw: boolean): void {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }
  assertDescriptionPreservesMilestoneScope(cwd, description, 'phase insert');

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
      // #3413 review fix: bulletEntry stays hardcoded '\n'. The on-disk EOL
      // is decided at write time by platformWriteSync's normalizeContent /
      // _normalizeMd (shell-command-projection.cts), which unconditionally
      // converts \r\n -> \n for any .md target — so whatever terminator is
      // used here in memory is erased before the file is ever written, and
      // templating it via detectEol(rawContent) was inert dead code. '\n'
      // matches what platformWriteSync enforces anyway.
      const bulletEntry = `\n- [ ] ${phaseLabel}`;

      // #3413: was `[^\n]*`, which on CRLF content swallows the line's
      // trailing \r into the match, shifting bulletLineEnd to land BETWEEN
      // the \r and \n of the original CRLF pair — a pure splice-POSITION
      // bug on the not-yet-write-normalized CRLF read (independent of the
      // final on-disk EOL, which platformWriteSync always forces to LF for
      // .md targets regardless). Widening to [^\r\n]* stops the match at the
      // true line-content boundary so bulletLineEnd lands cleanly before the
      // terminator.
      const targetBulletPattern = new RegExp(
        `(-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\r\\n]*)`,
        'i',
      );
      const bulletMatchResult = rawContent.match(targetBulletPattern);
      if (!bulletMatchResult) {
        error(`Could not find Phase ${afterPhase} bullet line`);
      }

      const bulletLineEnd =
        rawContent.indexOf(bulletMatchResult![0]) + bulletMatchResult![0].length;
      const afterBullet = rawContent.slice(bulletLineEnd);
      const nextBulletMatch = afterBullet.match(/\r?\n-\s*\[[ x]\]\s*(?:\*\*)?Phase\s+\d/i);

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
      const nextPhaseMatch = afterHeader.match(/\r?\n#{2,4}\s+Phase\s+\d[\d.]*/i);

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
  // #3227: unconditional here because `platformWriteSync(roadmapPath, updatedContent)`
  // above always rewrites ROADMAP.md with the inserted phase before this line is
  // reached; every refusal along the way (bad args, missing ROADMAP.md, unresolved
  // target bullet/header) exits via `error()`, which terminates the process.
  publishStateContract(cwd);
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

/**
 * Find a free name to move an occupying file aside to, on collision, so the
 * intended rename can proceed without destroying either file. Appends the
 * literal `.orphaned` suffix to the whole existing filename (never `.md`,
 * so no phase-directory scan predicate — all of which filter on
 * `.endsWith('.md')` / `.endsWith('-VERIFICATION.md')` etc — can ever pick
 * the displaced file back up as any phase's artifact). Falls back to a
 * numeric discriminator (`.orphaned.2`, `.orphaned.3`, ...) if `.orphaned`
 * itself is taken, bounded at 100 attempts so a pathological directory
 * cannot loop forever; returns null if no free name is found within that
 * bound, letting the caller fall back to skip-and-report.
 */
function findOrphanedDisplacementName(dir: string, fileName: string): string | null {
  const base = `${fileName}.orphaned`;
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let n = 2; n <= 100; n++) {
    const candidate = `${base}.${n}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

function renameIntegerPhases(
  phasesDir: string,
  removedInt: number,
): {
  renamedDirs: { from: string; to: string }[];
  renamedFiles: { from: string; to: string }[];
  renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[];
} {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[] = [];
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameIntInfo[] = dirs
    .map((dir) => {
      const m = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
      if (!m) return null;
      const dirInt = parseInt(m[1], 10);
      // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
      return dirInt > removedInt && !isSentinelPhaseId(dirInt)
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
    // WARNING-3 (#3511 review): the directory match above accepts an
    // UNPADDED leading number (`\d+`), so a supported rename can pair a
    // 2-padded dir with an unpadded-numbered artifact — dir `9-slug` holding
    // `9-VERIFICATION.md`. Renaming files by `f.startsWith(oldPrefix)` alone
    // (oldPrefix always 2-padded) misses that file: it becomes desynced from
    // its now-renamed directory and the phase reads `missing`. Try the
    // UNPADDED old-prefix form as a fallback so such an artifact renames
    // alongside its directory. A trailing-digit boundary check keeps the
    // unpadded form from over-matching a DIFFERENT phase's file (unpadded
    // prefix "1" must not match "10-…").
    const oldPrefixUnpadded = `${item.oldInt}${letterSuffix}${decimalSuffix}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      let matchedPrefix: string | null = null;
      if (f.startsWith(oldPrefix)) {
        matchedPrefix = oldPrefix;
      } else if (
        oldPrefixUnpadded !== oldPrefix &&
        f.startsWith(oldPrefixUnpadded) &&
        // Token-boundary check: the character immediately after the unpadded
        // prefix must be a separator (`-`, `.`) or end-of-name, not any
        // non-digit. A bare `!/^\d/` test (prior form) let a LETTER through
        // too, so unpadded prefix "2" wrongly matched "2FA-notes.md" (a
        // wholly unrelated file whose name merely starts with the digit).
        (f.length === oldPrefixUnpadded.length || /^[-.]/.test(f.slice(oldPrefixUnpadded.length)))
      ) {
        matchedPrefix = oldPrefixUnpadded;
      }
      if (matchedPrefix) {
        const newFileName = newPrefix + f.slice(matchedPrefix.length);
        const destPath = path.join(phasesDir, newDirName, newFileName);
        // Collision guard: the padded and unpadded prefix forms can both
        // resolve to the SAME destination (e.g. `09-VERIFICATION.md` and
        // `9-VERIFICATION.md` in one directory both target
        // `08-VERIFICATION.md`), and a stray cross-phase file can already sit
        // at the destination name (e.g. a leftover `08-VERIFICATION.md`
        // belonging to a DIFFERENT phase, inside phase 9's directory).
        // Renaming blindly over an existing target silently destroys
        // whichever file loses; skipping the rename instead lets the stray
        // outrank the phase's own renamed artifact once it lands at the
        // canonical name. Neither is acceptable: move the OCCUPYING file
        // aside first (never overwrite, never skip the real rename), then
        // complete the intended rename so the phase's own artifact takes the
        // canonical name. This also handles a target that was already
        // claimed by an EARLIER file in this same pass, since that earlier
        // rename already created it on disk.
        if (fs.existsSync(destPath)) {
          const displacedName = findOrphanedDisplacementName(
            path.join(phasesDir, newDirName),
            newFileName,
          );
          if (displacedName === null) {
            // No free displacement name within the bounded search — fall
            // back to skip-and-report rather than looping or overwriting.
            renamedFileCollisions.push({ from: f, to: newFileName, displaced_to: null });
            continue;
          }
          retryRenameSync(destPath, path.join(phasesDir, newDirName, displacedName));
          retryRenameSync(path.join(phasesDir, newDirName, f), destPath);
          renamedFiles.push({ from: f, to: newFileName });
          renamedFileCollisions.push({ from: f, to: newFileName, displaced_to: displacedName });
          continue;
        }
        retryRenameSync(path.join(phasesDir, newDirName, f), destPath);
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles, renamedFileCollisions };
}

function decrementRoadmapPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
  return String(num - 1);
}

function decrementRoadmapPhaseToken(raw: string, removedInt: number): string {
  const match = String(raw).match(/^(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const num = parseInt(match[1], 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
  return `${num - 1}${match[2] || ''}`;
}

function decrementRoadmapPaddedPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
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

// #3685: mirror requirementsUpdated's diff-tracking contract — the caller
// (cmdPhaseRemove) used to report `roadmap_updated: true` unconditionally,
// hardcoded regardless of whether this transform actually changed
// ROADMAP.md's content. Returning a real before/after comparison here lets
// the caller report accurately, the same fix #3685 applied to
// `cmdPhaseComplete` and #2640/#2974 already applied to this same function's
// sibling `stateUpdated` flag a few lines below in `cmdPhaseRemove`.
function updateRoadmapAfterPhaseRemoval(
  roadmapPath: string,
  targetPhase: string,
  isDecimal: boolean,
  removedInt: number,
  cwd: string,
): boolean {
  return withPlanningLock(cwd, () => {
    const originalContent = fs.readFileSync(roadmapPath, 'utf-8');
    let content = originalContent;
    const escaped = escapeRegex(targetPhase);
    // #3572: ROADMAP headings and rows carry the normalized (zero-padded) form
    // of a decimal id — `phase insert 1` writes `### Phase 01.1:` while the
    // user's remove query is usually unpadded (`1.1`) — and integer headings
    // legitimately appear both padded (`02`) and unpadded (`2`). A `0*` prefix
    // makes the token padding-insensitive in both directions without widening
    // to other ids: the token stays anchored between `Phase\s+`/line-start and
    // `:`/whitespace/end, so `0*2` still never matches `Phase 12:`.
    const padTolerant = `0*${escaped}`;

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
      `^Phase\\s+${padTolerant}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'i',
    );
    content = deleteSection(
      content,
      (h) => h.level >= 2 && h.level <= 4 && phaseHeadingRe.test(h.text),
    );
    content = content.replace(
      new RegExp(`\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${padTolerant}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*`, 'gi'),
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
          return new RegExp(`^${padTolerant}\\.?(?:\\s|$)`, 'i').test(firstCellRaw);
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
        /(#{2,4}\s*Phase\s+)(\d+(?:\.\d+)?)((?:\s*\([^)\r\n]{0,200}\))?\s*:)/gi,
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
              // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
              if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return false;
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
    // #3685 / #3691: compare NORMALIZED bytes (what platformWriteSync actually
    // persists), not the raw pre-normalize `content` string, against the raw
    // pre-mutation `originalContent` read above — a raw `!==` here reports a
    // false `true` whenever this transform's regenerated output takes a
    // different-but-equivalent shape than the already-normalized on-disk
    // original (same normalization-order artifact #3685 fixed at
    // cmdMilestoneComplete; see contentChangedAfterNormalize's own doc).
    return contentChangedAfterNormalize(roadmapPath, originalContent, content);
  });
}

interface PhaseRemoveOptions {
  force?: boolean;
}

/**
 * #3572: insert `fieldLine` at the start of STATE.md's BODY — immediately after
 * the leading frontmatter block's closing `---` fence — so a body field never
 * lands before the opening fence. The former whole-content prepend
 * (`field + content`) put the line ABOVE the opening `---`, and
 * syncStateFrontmatter then treated the scrambled fence structure as TWO
 * frontmatter blocks, rebuilding a derived one on top of the original
 * (milestone_name from a ROADMAP heading, total_phases counting the removed
 * phase, a stray 'Total Phases: 0' between fences). A file with no leading
 * frontmatter is all body: the field goes to content start, preserving the
 * former behavior for that shape.
 */
function insertStateBodyFieldAtTop(content: string, fieldLine: string): string {
  // Split AND join on bare '\n' so CRLF line endings stay attached to their
  // own lines — each '\r' remains the tail of the line it terminated, where
  // the trimmed fence compare still matches it. (#3572 review: splitting on
  // '\n' but re-joining on a detected '\r\n' doubled every carriage return.)
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() === '---') {
    const closeIdx = lines.findIndex((l: string, i: number) => i > 0 && l.trim() === '---');
    if (closeIdx !== -1) {
      lines.splice(closeIdx + 1, 0, '', fieldLine);
      return lines.join('\n');
    }
  }
  return fieldLine + '\n' + content;
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
  // #2237/#2528: every other resolution path refuses to choose between multiple
  // directories claiming one phase number. This one is the DESTRUCTIVE path, so
  // taking `matches[0]` silently is strictly worse than anywhere else: it turns
  // "resolve nothing" into "delete one of two candidates, unrecoverably, and
  // renumber every phase after it". Refuse before any file is touched.
  const { matches: phaseDirMatches } = matchPhaseDirs(subdirs, normalized);
  if (phaseDirMatches.length > 1) {
    output(
      {
        removed: null,
        error:
          `Phase ${normalized} is ambiguous: ${phaseDirMatches.length} directories match `
          + `(${phaseDirMatches.map((m) => `"${m}"`).join(', ')}). Refusing to remove any of them. `
          + 'Set a distinct project_code in .planning/config.json, or pass the full directory name.',
        ambiguous_matches: phaseDirMatches,
        directory_deleted: null,
        renamed_directories: [],
        renamed_files: [],
        roadmap_updated: false,
        state_updated: false,
      },
      raw,
    );
    return;
  }
  const targetDir = phaseDirMatches[0] || null;

  if (targetDir && !force) {
    // #3183: canonical summary set (root+nested) from the single owner —
    // a root-only readdirSync filter left nested (#3139 layout) summaries
    // invisible, letting a phase with completed nested work be deleted
    // without --force.
    const summaryCount = scanPhasePlans(path.join(phasesDir, targetDir)).summaryFiles.length;
    if (summaryCount > 0) {
      error(
        `Phase ${targetPhase} has ${summaryCount} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  if (targetDir) fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });

  let renamedDirs: { from: string; to: string }[] = [];
  let renamedFiles: { from: string; to: string }[] = [];
  let renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[] = [];
  try {
    if (isDecimal) {
      const renamed = renameDecimalPhases(
        phasesDir,
        parseInt(normalized.split('.')[0], 10),
        parseInt(normalized.split('.')[1], 10),
      );
      renamedDirs = renamed.renamedDirs;
      renamedFiles = renamed.renamedFiles;
    } else {
      const renamed = renameIntegerPhases(phasesDir, parseInt(normalized, 10));
      renamedDirs = renamed.renamedDirs;
      renamedFiles = renamed.renamedFiles;
      renamedFileCollisions = renamed.renamedFileCollisions;
    }
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

  const roadmapUpdated = updateRoadmapAfterPhaseRemoval(
    roadmapPath,
    targetPhase,
    isDecimal,
    parseInt(normalized, 10),
    cwd,
  );

  const statePath = path.join(planningDir(cwd), 'STATE.md');
  let stateUpdated = false;
  if (fs.existsSync(statePath)) {
    // #2640: report whether STATE.md content actually changed, not just file
    // existence (fs.existsSync was trivially true). Also ensure the body
    // transform produces a diff so readModifyWriteStateMd's no-op guard
    // (#948) doesn't skip the frontmatter resync — without that, the
    // progress.* frontmatter block stays stale when the body has no
    // 'Total Phases:' or 'of N' phrase.
    stateUpdated = readModifyWriteStateMd(
      statePath,
      (stateContent: string) => {
        let modified = stateContent;
        const totalRaw = stateExtractField(modified, 'Total Phases');
        if (totalRaw) {
          // #3572 review: clamp at 0 — a stale 'Total Phases: 0' (e.g. written by
          // an earlier remove whose dir-count was 0) must not decrement to -1 on
          // the next removal.
          modified =
            stateReplaceField(
              modified,
              'Total Phases',
              String(Math.max(0, parseInt(totalRaw, 10) - 1)),
            ) || modified;
        }
        const ofMatch = modified.match(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i);
        if (ofMatch) {
          modified = modified.replace(
            /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i,
            `$1${Math.max(0, parseInt(ofMatch[2], 10) - 1)}$3`,
          );
        }
        // #2640: if neither body field was found, the transform is a no-op.
        // readModifyWriteStateMd's no-op guard (#948) would then skip the
        // frontmatter resync, leaving progress.* stale. Force a body diff
        // ONLY when a phase directory was actually removed (targetDir !== null)
        // so the guard passes and syncStateFrontmatter rebuilds the frontmatter
        // from the post-deletion disk/ROADMAP state. Without the targetDir gate,
        // a no-op removal (ROADMAP-only phase, no directory) would inject a
        // spurious 'Total Phases:' line into a body that intentionally lacked one.
        if (targetDir && modified === stateContent) {
          // subdirs was read before the deletion; excluding the removed target
          // gives the remaining count. Renumbering changes names but not count.
          //
          // #2528: exclude the directory that was ACTUALLY deleted, by identity,
          // rather than re-deriving "which dir was the target" from the query.
          // The two are not the same predicate here: `targetDir` comes from
          // `matchPhaseDirs`, whose bare-integer fallback resolves digit-leading
          // dirs (`05-80-20-cleanup` for query `5`) that `phaseTokenMatches`
          // reports as non-matching — so a token re-derivation would count the
          // just-deleted directory as still present and write a `Total Phases`
          // one too high. Identity is also what the comment above already
          // claims this filter does, and the block is gated on targetDir.
          // (#3572 note: this body field counts DIRECTORIES on disk; the
          // frontmatter progress.* block is rebuilt by syncStateFrontmatter
          // from the post-removal ROADMAP — the two counts legitimately differ
          // when phases exist in ROADMAP without directories.)
          const remainingPhases = Math.max(0, subdirs.filter((d) => d !== targetDir).length);
          if (totalRaw) {
            modified =
              stateReplaceField(modified, 'Total Phases', String(remainingPhases)) || modified;
          } else {
            // No 'Total Phases:' field in the body — insert one at the start of
            // the BODY so the no-op guard sees a diff. #3572: the former
            // whole-content prepend landed the line BEFORE the opening '---'
            // fence and corrupted STATE.md into two frontmatter blocks.
            // syncStateFrontmatter will still rebuild the frontmatter
            // progress.* block from the real disk/ROADMAP count.
            modified = insertStateBodyFieldAtTop(modified, `Total Phases: ${remainingPhases}`);
          }
        }
        return modified;
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
      renamed_file_collisions: renamedFileCollisions,
      // #3685: mirror requirementsUpdated's diff-tracking contract — true only
      // when updateRoadmapAfterPhaseRemoval's content diff detected a real
      // change, not hardcoded regardless of whether ROADMAP.md's content
      // actually changed.
      roadmap_updated: roadmapUpdated,
      state_updated: stateUpdated,
    },
    raw,
  );
  // #3227: unconditional here because `updateRoadmapAfterPhaseRemoval` above
  // always rewrites ROADMAP.md before this line is reached; every refusal path
  // (bad target, missing ROADMAP.md, --force-required, renumber failure) exits
  // via `error()`, and the ambiguous-match case exits via an earlier `return`
  // before any file is touched.
  publishStateContract(cwd);
}

interface WriteSpec {
  filePath: string;
  before: string;
  after: string;
}

/**
 * #3227: returns the count of writes actually applied (entries whose
 * `before` differed from `after` and were therefore written to disk) — the
 * caller (`cmdPhaseComplete`) uses this as its publish-gate signal, since a
 * re-run against an already-completed phase can produce a `writes[]` array
 * where every entry is byte-identical to what's already on disk.
 */
function writePlanningFileSet(writes: WriteSpec[]): number {
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
  return applied.length;
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

// ─── #3697: the `**Requirements**:` line under-selection detector ────────────
//
// EXTRACTED from cmdPhaseComplete (round 3, review finding Blocker 1). The
// detection logic below is a parser, so `RULESET.TESTS.property-based-testing`
// requires at least one fast-check property test over it — and that is not
// reachable while the logic is a closure inside a command that only a
// subprocess can invoke (every #3697 test spawns the CLI; 100 fc runs cannot).
// Extraction is therefore load-bearing, not tidying: it is what makes the
// property test and the 2048-boundary fixtures (Blocker 2) expressible at all.
//
// BEHAVIOUR IS UNCHANGED BY THE MOVE. The two tokenizations below stay
// deliberately DIFFERENT and are co-located so they cannot drift apart:
//   * the SELECTOR strips `[` and `]` only, then splits on `[,\s]+`. Its output
//     IS `citedReqIds` — the ledger-writing set — so widening it would change
//     what phase-complete marks, which #3697 explicitly does not do.
//   * the DETECTOR additionally shaves brackets/quotes/emphasis and trailing
//     sentence punctuation, so it can see an operator or an ID that the
//     selector's stricter shape filter rejects.
// The gap between them is not a defect: it is why `ADR-7)` is not selected
// while `ADR-7` is still nameable in a warning.
//
// The `**Requirements**: TBD` placeholder is what phase.add / -batch / -insert
// seed (three sites in this file — locate them by the literal
// `Requirements**: TBD`, never by line number: an earlier revision of this
// comment cited 833/920/1078, which had drifted to 1132/1237/1413 by round 3).
// The shipped comma-list template is `gsd-core/templates/roadmap.md:32`.
type RequirementsLineAnalysis = {
  /** The ledger-writing set — byte-identical to the pre-extraction selector. */
  citedReqIds: string[];
  /** The detector's shaved tokens (see the tokenization note above). */
  tokens: string[];
  /** R1 — tokens that are THEMSELVES a range (`RANGE-01..RANGE-05`). */
  rangeTokens: string[];
  /** R2 — a bare operator with a selected, interior-implying ID either side. */
  hasSpacedRange: boolean;
  /** R2' — an operator GLUED to one endpoint (`RANGE-01 -RANGE-05`). */
  hasGluedRangeFragment: boolean;
  /** R3 — zero selection on a non-placeholder line, with ID-shaped residue. */
  inertIdShaped: string[];
  /**
   * R3b — zero selection on a non-placeholder line that carries ANY content.
   *
   * This is #3697's AC-1b/AC-4 verbatim ("warn when `citedReqIds.length === 0`
   * while the raw capture is non-empty and not `TBD`"), and it is deliberately
   * NOT gated on ID-shaped residue the way R3 is. Round 4 measured the reason:
   * every one of the fifteen #2334/#2339 negative-space fixtures is held
   * silent by non-zero SELECTION or by `placeholderLed`, and not one of them by
   * the ID-shape gate — so the gate was buying no negative space while costing
   * the acceptance criterion. `Deferred`, `N/A`, `Pending`, `TBA` and `-` were
   * silent because of it, while the docs, this census and the advice string all
   * said they warned.
   */
  zeroSelectionInert: boolean;
  /**
   * R4 — REQ-IDs the SELECTOR dropped because a delimiter was glued to them.
   *
   * `REQ-01; REQ-02` selects only `REQ-02`: the selector splits on `[,\s]+`,
   * so `REQ-01;` keeps its semicolon and fails the anchored ID shape. This is
   * #3697's own half-success failure mode — `requirements_updated: true` with
   * a silently unmarked requirement — reached by one wrong delimiter.
   *
   * Round 4 review called this indistinguishable from a parenthesised
   * citation, because `(ADR-7)` also shaves to a bare ID. At the RAW token
   * level they are not: `REQ-01;` is shaved of a trailing DELIMITER,
   * `ADR-7)` of a citation wrapper. This rule keys on that shave class and
   * requires the token to sit outside any parenthetical, which is what keeps
   * `(see ADR-7: section 3)` silent.
   */
  delimiterDroppedIds: string[];
  /** Tokens past the scan cap that could carry an ID — reported, never dropped. */
  oversizedTokens: string[];
  /** ID-shaped tokens the selector did not take. Reported as a fact; never routes. */
  unselectedIdShaped: string[];
  /** The line leads with `TBD` / `None`. */
  placeholderLed: boolean;
  /** R2's hits, as `[left, right]` endpoint pairs, so the channel below can ask
   *  about the endpoints the rule actually fired on. */
  spacedRangePairs: Array<[string, string]>;
  /**
   * Nothing on the line was DEMONSTRABLY dropped: no rule that names a specific
   * unselected ID fired, and any spaced range fired on endpoints the selector
   * actually took.
   *
   * This is the shared precondition of both NON-assertive voices — the
   * ambiguous range reading and the over-cap "not classified" report — and it
   * is named once because they had drifted apart. Round 7 review, Minor 1:
   * `rangeReadingOnly` carried the conjunction inline and omitted the cap,
   * while the over-cap channel carried its own copy that excluded a spaced
   * range wholesale. A line with a clean, fully-selected range beside an
   * unexamined over-cap token satisfied neither guard as intended and reached
   * the ambiguous voice.
   */
  nothingDemonstrablyDropped: boolean;
  /**
   * The round-3 channel discriminator (review finding Major 3). True when the
   * ONLY thing to report is a range *reading*: R2 fired, no other rule did, and
   * every endpoint R2 fired on was actually selected. Nothing was dropped, so
   * the line did not fail to parse and the warning must not claim it did.
   *
   * This is deliberately RULE-SCOPED rather than line-global. A line-global
   * "was anything ID-shaped left unselected?" test reads correctly on the
   * motivating example and misroutes as soon as the line carries an unrelated
   * parenthesised citation: `RANGE-01, RANGE-02 — RANGE-05 deferred per
   * (ADR-7)` has `(ADR-7)` outside the selector's bracket strip, so a global
   * test calls it a drop and sends the line back to the assertive channel —
   * reinstating exactly the false "could not be parsed" claim Major 3 is
   * about, and contradicting #3697-4, which pins a parenthetical citation as
   * NOT unparsed residue. Only the rules that fired may speak.
   */
  rangeReadingOnly: boolean;
  /** Any rule fired — the line warrants a warning. */
  warn: boolean;
};

// A range operator, enumerated. CENSUS (round 3): the domain is "separator
// spellings an author can put between two REQ-IDs", which is open, so the
// enumeration draws a boundary rather than covering it. Reached: ASCII `..`+,
// the seven Unicode dashes that are the SAME operator at different codepoints
// (U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2013 en,
// U+2014 em, U+2015 horizontal bar, U+2212 minus) plus ASCII `-`, U+2026
// ellipsis, and the words `to`/`thru`/`through`. NOT reached, and the
// consequence is a silent under-selection — #3697's own defect — for that
// spelling: `→`, `~`, `..=`, `..<`, `until`, and `up to` (two tokens, so it
// cannot be one operator token at all). Those stay out deliberately: each is a
// symbol or word with an independent non-range use between two IDs, which is
// the over-warning class #2334 cost three rounds. The Unicode dashes DO carry
// the ASCII hyphen's date/sub-number collision — an earlier round-3 commit
// claimed they did not, and was wrong — so they take the strict arm with it;
// see the rule below.
const REQ_RANGE_DASHES = '\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212';
// EVERY DASH IS STRICT — one rule, whatever the codepoint. `PREFIX-\d+ <dash>
// \d+` is also a date (`FY-2026-08`) and a sub-numbered ID (`API-2-01`), and
// that ambiguity is a property of the SHAPE, not of which dash key was pressed.
// The design already chose strictness for ASCII `-` on exactly this trade: a
// bare-hyphen tight range must carry a full ID on BOTH sides. Until round 3 the
// other dashes sat in the loose arm, so `RANGE-01 (target FY-2026<en-dash>08)`
// warned while its all-ASCII twin — pinned silent by #3697-4 — did not. That
// inconsistency predates this PR for U+2013/U+2014; round 3 briefly widened it
// to five more codepoints before this commit closed it for all seven.
// The cost is symmetric and already accepted: `RANGE-01, RANGE-02<dash>05`
// goes silent, exactly as `RANGE-01, RANGE-02-05` already does today. A bare
// `RANGE-02<dash>05` still warns — it selects nothing, so R3 catches it.
// LOOSE stays loose: `..`, `…` and the word operators have no date or
// sub-number reading between two numbers, so they keep the numeric endpoint.
const REQ_RANGE_OP = `(?:\\.{2,}|\\u2026|[${REQ_RANGE_DASHES}]|-|to|thru|through)`;
const REQ_RANGE_OP_LOOSE = `(?:\\.{2,}|\\u2026|to|thru|through)`;
const REQ_RANGE_OP_SYMBOL = `(?:\\.{2,}|\\u2026|[${REQ_RANGE_DASHES}]|-)`;
const REQ_RANGE_TOKEN_RE = new RegExp(
  `^([A-Z][A-Z0-9]*)-(?:\\d+)\\s*(?:${REQ_RANGE_OP_LOOSE}\\s*(?:\\1-)?|[-${REQ_RANGE_DASHES}]\\s*\\1-)\\d+$`,
  'i',
);
const REQ_PURE_RANGE_OP_RE = new RegExp(`^${REQ_RANGE_OP}$`, 'i');
const REQ_GLUED_RANGE_LEAD_RE = new RegExp(`^${REQ_RANGE_OP_SYMBOL}([A-Z][A-Z0-9]*-\\d+)$`, 'i');
const REQ_GLUED_RANGE_TRAIL_RE = new RegExp(`^([A-Z][A-Z0-9]*-\\d+)${REQ_RANGE_OP}$`, 'i');
const REQ_ID_SUBSTRING_RE = /[A-Z][A-Z0-9]*-\d+/i;
const REQ_ID_SHAPE_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const REQ_ID_PARTS_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/i;
// `LETTERS-\d+-\d+` — a date (`FY-2026-08`) or a sub-numbered ID (`API-2-01`).
// REQ_RANGE_TOKEN_RE's strict-dash arm exists precisely to keep this shape
// silent, because nothing at token level can tell the three readings apart.
// Round 4 review Minor 2: the skipped-text rider re-reported it through the
// side door — `REQ_ID_SUBSTRING_RE` is unanchored, so `FY-2026-08` matches as
// `FY-2026` and landed in `unselectedIdShaped`. Whenever any OTHER rule fired
// on a line carrying a date annotation, the warning then told the author to
// "check whether any of it is a requirement" about a date. Not a false
// warning — the line was warning anyway — but false CONTENT, and it is the
// #2334 voice.
// `PREFIX-<digits>-<digits>` — the shape the strict-dash range rule refuses to
// act on because it is equally a date (`FY-2026-08`) and a sub-numbered id
// (`API-2-01`). NO regex separates those: `API-2026-08` is a legal requirement
// id and `FY-26-08` is a date, and both filters that tried scored a miss in
// each direction under the pre-push review's continuation.
//
// So the rider stops adjudicating and starts DISCLOSING. Round 4 Minor 2's
// real complaint was that the rider told the author to check whether a DATE
// was a requirement; the fix is to name the ambiguity rather than to guess at
// it — which is the same thing the two warning voices already do about a
// range separator.
const REQ_AMBIGUOUS_NUMERIC_RE = /^[A-Z][A-Z0-9]*(?:-\d+){2,}$/i;

// The token-length cap. It bounds REQ_ID_SUBSTRING_RE, the one UNANCHORED
// regex here, which backtracks quadratically on a pathological token. Round 3
// review Nit 6 objected that the anchored regexes were left uncapped on the
// strength of a comment asserting they scan linearly; they are applied through
// the same cap now, so the claim is enforced rather than asserted. No real
// REQ-ID-carrying token approaches this bound.
const REQ_TOKEN_SCAN_LIMIT = 2048;

/**
 * The Requirements-line warning KINDS, as a stable machine vocabulary (round 4
 * review Major 3).
 *
 * Before this, the kind existed only in the prose of the message, so every
 * consumer and every test had to regex an English sentence — and rewording a
 * message silently un-asserted the tests that pinned it. The repo already had
 * the settled seam for exactly these semantics: `diffLiveConfig` emits
 * `kind:'unverified'` for a truncated scan (`CONTEXT.md`), and
 * `WAVE_CLEANUP_WARNING` carries codes in `src/worktree-safety.cts`.
 *
 * Carried ALONGSIDE the prose, never instead of it. `warnings[]` is a
 * documented `string[]` in `phase complete`'s JSON output, rendered by
 * execute-phase.md's "If has_warnings is true" step, so changing its element
 * shape would be a breaking output-contract change for a shipped command. The
 * code is emitted as its own additive `requirements_line_warning` field.
 */
const REQ_LINE_WARNING_CODE = {
  /** ID-shaped content was demonstrably not selected — the line failed to parse. */
  misparse: 'req-line-misparse',
  /** A range READING is at stake; every endpoint the rule fired on was selected. */
  rangeReading: 'req-line-range-reading',
  /** A token past the scan cap means the line was not classified — never that it is clean. */
  unverified: 'req-line-unverified',
} as const;

type ReqLineWarningCode = (typeof REQ_LINE_WARNING_CODE)[keyof typeof REQ_LINE_WARNING_CODE];

/** The formatter's result. `null` still means CLEAN, which is a value, not a failure. */
type ReqLineWarning = { code: ReqLineWarningCode; message: string };

// R4 — a full ID with a trailing statement delimiter glued to it. ANCHORED on
// both ends, so it is linear and needs no cap of its own beyond the token
// length guard its caller applies.
// Zero-width, bidi-control, joiner and variation-selector codepoints. INVISIBLE
// to the author, and the pre-push review's continuation drove the consequence
// from both sides: a line of only these warned with nothing on screen to
// explain it, AND stripping them wholesale from the detector made
// `REQ-01<ZWSP>, REQ-02` go SILENT while the selector really did drop REQ-01 —
// #3697's own defect, introduced by the fix for its mirror image. So they are
// never stripped from the line: they are DECORATION on a token (R4 below) and
// absence-of-content for the empty test (visibleContent), which are two
// different questions about the same character.
const REQ_INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060-\u2064\u2066-\u2069\uFE0F\uFEFF]/g;
// The wrappers R4 shaves. Emphasis, quotes and backticks, because the SELECTOR
// shaves none of them — `**REQ-01**` is genuinely not selected and is a real,
// silent drop.
//
// PARENTHESES ARE DELIBERATELY ABSENT, and this is load-bearing. A parenthesis
// is this rule's citation MARKER, not decoration to shave: `(REQ-02)` and
// `(ADR-7)` are the same shape and the rule declines both. Including them here
// made `REQ-01, (REQ-02), REQ-03 — REQ-05` report a glued delimiter that was
// never there, and broke #3697-9d's channel routing with it — caught by the
// suite immediately after the widening.
const REQ_WRAPPER_RE = /^["'`*_~“”‘’]+|["'`*_~“”‘’]+$/g;
// An id with a list delimiter glued to EITHER end, once styling is removed.
// The capture is the bare id; a match means the delimiter was ADJACENT to it.
const REQ_DELIMITED_ID_RE = /^[;:]*([A-Z][A-Z0-9]*-\d+)[;:]*$/i;



/**
 * CENSUS (round 4): the domain is "separators an author writes between two
 * REQ-IDs INSTEAD of a comma" — distinct from the range-operator domain
 * censused above, and it had no census at all before this round.
 *
 * ROUND 4'S CENSUS WAS WRONG, AND THE WAY IT WAS WRONG IS THE LESSON. It swept
 * 26 spellings and concluded "exactly two — `; ` and `: `". It reached that
 * answer because it swept the ONE-SIDED form (`REQ-01; REQ-02`) for the
 * semicolon and colon, and only the BARE and SYMMETRIC forms (`|`, ` | `) for
 * every other separator. Different members of the domain were tested in
 * different shapes, so the conclusion could not have come out any other way.
 *
 * Re-swept round 5, fully crossed: 21 separators x {bare, trailing-space,
 * leading-space, both-spaces} = 84 combinations, driven through the built
 * artifact. 26 select both IDs, 24 under-select and already warn, and
 * 34 UNDER-SELECT SILENTLY. All 34 are the same shape — a separator glued to
 * exactly ONE of the two IDs, e.g. `REQ-01/ REQ-02` or `REQ-01 /REQ-02` — for
 * every punctuation except `,` (the real delimiter) and `;` / `:` (R4).
 * Measured silent: | / + & \ > . ! ? • · ؛ ； ， － ~ and the word operators
 * `and` / `plus` in trailing-space form.
 *
 * So the honest statement is that R4 covers TWO CHARACTERS of a domain that is
 * wide open, not that the domain has two members. The round-4 review
 * hand-listed the semicolon; the colon is its sibling and fails identically;
 * everything else in that list is disclosed here and NOT caught. Widening the
 * delimiter class is a small change and deliberately not made at the end of a
 * round: three successive cuts of this rule fired on a citation.
 *
 * THE GATE IS ADJACENCY, and it is the part to read. Styling is stripped, then
 * the delimiter must be touching the id: `REQ-01;`, `;REQ-02`, `**REQ-01;**`
 * and the backticked form all qualify. `**REQ-01**;` does NOT — outside the
 * styling a `;` is sentence punctuation, which is why `REQ-01, see **REQ-7**;
 * next topic` is a citation and not a drop. An INVISIBLE anywhere in the token
 * qualifies without an adjacency test, because nobody types one on purpose, so
 * it is corruption rather than intent.
 *
 * Markdown styling on its own is NOT a trigger and NOT reported. It reaches
 * the skipped-text rider, which names the id without asserting a drop — but a
 * rider only exists inside a MESSAGE, and a message only exists when some rule
 * set `warn`. On a line where nothing else fires, `REQ-01, **REQ-02**` is
 * wholly silent. Saying it is "left to the rider" reads as coverage and is
 * not; #3697-19m pins the silence so this comment cannot drift back.
 *
 * NOT reached, stated rather than fixed, and the second member is WIDER than
 * this comment first claimed:
 *   - anything inside a parenthetical. A parenthesis is this rule's citation
 *     MARKER, never decoration to shave — `(REQ-02)` and `(ADR-7)` are the
 *     same shape and the rule declines both.
 *   - a decorated id whose prefix is on NO selected id: `REQ-01, FOO-02: x`
 *     stays silent even when FOO-02 is real. Prefix agreement is what
 *     separates a drop from a bare citation — `REQ-01, see ADR-7: section 3`
 *     carries `ADR-7:` in exactly `REQ-01;`'s shape — and it is the module's
 *     own idiom, not a new heuristic (reqEndpointsImplyInterior already
 *     requires an agreeing prefix). The gate is NOT complete: a citation that
 *     DOES share a selected prefix (`ADR-01, see ADR-7: sec 3`) still fires,
 *     and nothing at token level separates that from a real drop. Saying so is
 *     the honest position; a prose heuristic on "see" is exactly the free-text
 *     detector this module exists to avoid.
 * The trade, plainly: an under-report on a rare shape over an over-report on a
 * common one — the same call the strict-dash rule makes.
 */
function reqDelimiterDroppedIds(rawLine: string, selected: Set<string>, cap: number): string[] {
  // MATCHED parenthetical spans are removed OUTRIGHT, not tracked as a depth.
  //
  // Two bugs died here. A running depth counter let an unbalanced `(` stay open
  // to end-of-line and swallow every real drop after it. Promoting a whole
  // token to immune because it CONTAINED a matched character then leaked the
  // other way: `REQ-01, REQ-02;(note) REQ-03` is one whitespace token, so the
  // parenthetical conferred immunity on the `REQ-02;` sitting outside it.
  // Deleting the span states what is actually meant — for this rule a citation
  // is not on the line — while an UNMATCHED paren is a typo and confers
  // nothing.
  //
  // Square brackets go too, exactly as the SELECTOR strips them: `[REQ-01;
  // REQ-02]` is the documented form and was silently dropping REQ-01.
  //
  // INVISIBLES STAY. They are the evidence this rule reads; the tokenizer
  // strips them for the classification rules, and the two sites answer two
  // different questions about the same character.
  const chars = [...String(rawLine).replace(/<!--[\s\S]*?-->/g, ' ')];
  const openStack: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === '(') openStack.push(i);
    else if (chars[i] === ')' && openStack.length > 0) {
      const open = openStack.pop() as number;
      for (let j = open; j <= i; j += 1) chars[j] = ' ';
    }
  }
  const line = chars.join('').replace(/[[\]]/g, '');

  // The prefixes actually SELECTED on this line. A dropped id must agree with
  // one of them — that is what separates a delimiter typo from a citation,
  // since `REQ-01, see ADR-7: sec 3` carries `ADR-7:` in exactly `REQ-01;`'s
  // shape. Same-prefix agreement is the module's own idiom, not a new
  // heuristic (see reqEndpointsImplyInterior).
  const selectedPrefixes = new Set<string>();
  for (const id of selected) {
    const m = REQ_ID_PARTS_RE.exec(id);
    if (m) selectedPrefixes.add(m[1].toUpperCase());
  }

  const hits: string[] = [];
  for (const raw of line.split(/[,\s]+/)) {
    if (!raw || raw.length > cap) continue;
    // Strip STYLING only. What survives is the id plus whatever was glued
    // directly to it.
    const core = raw.replace(REQ_INVISIBLE_RE, '').replace(REQ_WRAPPER_RE, '');
    const m = REQ_DELIMITED_ID_RE.exec(core);
    if (!m) continue;
    const bare = m[1];
    // ADJACENCY IS THE WHOLE RULE. A `;`/`:` touching the id is a list
    // separator someone meant; the same character OUTSIDE the styling is
    // sentence punctuation — `see **REQ-7**; next topic` cites a requirement
    // while `**REQ-01;** REQ-02` fails to list one, and only the delimiter's
    // POSITION separates them. An INVISIBLE needs no adjacency test: nobody
    // types one on purpose, so anywhere in the token it is corruption rather
    // than intent.
    const hadAdjacentDelimiter = core !== bare;
    REQ_INVISIBLE_RE.lastIndex = 0;
    const hadInvisible = REQ_INVISIBLE_RE.test(raw);
    REQ_INVISIBLE_RE.lastIndex = 0;
    if (!hadAdjacentDelimiter && !hadInvisible) continue;
    if (selected.has(bare.toUpperCase())) continue;
    const parts = REQ_ID_PARTS_RE.exec(bare);
    if (parts && selectedPrefixes.has(parts[1].toUpperCase())) hits.push(bare);
  }
  return [...new Set(hits)];
}

/** Endpoints imply a dropped interior only on an AGREEING prefix and a gap > 1. */
function reqEndpointsImplyInterior(a: string, b: string): boolean {
  const ma = REQ_ID_PARTS_RE.exec(a);
  const mb = REQ_ID_PARTS_RE.exec(b);
  if (!ma || !mb) return false;
  if (ma[1].toUpperCase() !== mb[1].toUpperCase()) return false;
  // BigInt keeps the gap exact for numbers past 2^53.
  const gap = BigInt(mb[2]) - BigInt(ma[2]);
  return gap > 1n || gap < -1n;
}

function analyzeRequirementsLine(rawLine: string): RequirementsLineAnalysis {
  const line = typeof rawLine === 'string' ? rawLine : '';
  // SELECTOR — byte-identical to the pre-extraction expression.
  const citedReqIds = line
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((r) => REQ_ID_SHAPE_RE.test(r));

  // DETECTOR tokenization. A token with NO alphanumerics is shaved of brackets
  // ONLY, so `(..)` surfaces its operator while a bare `..` is not shaved to
  // nothing by the punctuation classes. A trailing run of 2+ dots is a glued
  // range operator (`REQ-01.. REQ-05`), not sentence punctuation — keep it.
  const tokens = line
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Invisibles are removed HERE, for the classification rules — an operator
    // spelled `<ZWSP>..<ZWSP>` is still the range operator, and a line of only
    // invisibles yields no tokens at all. R4 works on the RAW line and does
    // NOT strip them, because there they are the evidence of a dropped id.
    // Removing them in both places is what made `REQ-01<ZWSP>, REQ-02` silent;
    // removing them in neither is what made `REQ-01 <ZWSP>..<ZWSP> REQ-05`
    // silent. The two questions have two different answers.
    .replace(REQ_INVISIBLE_RE, '')
    .split(/[,\s]+/)
    .map((t) => {
      const trimmed = t.trim();
      if (!/[A-Za-z0-9]/.test(trimmed)) {
        return trimmed.replace(/^[[({]+/, '').replace(/[\])}]+$/, '');
      }
      if (/\.{2,}$/.test(trimmed)) {
        return trimmed.replace(/^[[({"'`*_~“”‘’]+/, '');
      }
      return trimmed.replace(/^[[({"'`*_~“”‘’]+/, '').replace(/[\])}.;:"'`*_~“”‘’]+$/, '');
    })
    .filter(Boolean);

  // Every predicate below is applied through the scan limit (Nit 6): a token
  // past the bound is not classified at all rather than classified expensively.
  const short = (t: string): boolean => t.length <= REQ_TOKEN_SCAN_LIMIT;
  const rangeTokens = tokens.filter((t) => short(t) && REQ_RANGE_TOKEN_RE.test(t));
  const spacedRangePairs: Array<[string, string]> = [];
  tokens.forEach((t, i) => {
    const left = tokens[i - 1] ?? '';
    const right = tokens[i + 1] ?? '';
    if (
      // EVERY participant is capped, not just the operator. Capping the operator
      // alone left `<2049-char ID> .. <2049-char ID>` running REQ_ID_SHAPE_RE and
      // BigInt over both neighbours unbounded — the cap read as uniform and was
      // not (found by the round's pre-push review).
      short(t) &&
      short(left) &&
      short(right) &&
      REQ_PURE_RANGE_OP_RE.test(t) &&
      i > 0 &&
      i < tokens.length - 1 &&
      REQ_ID_SHAPE_RE.test(left) &&
      REQ_ID_SHAPE_RE.test(right) &&
      reqEndpointsImplyInterior(left, right)
    ) {
      spacedRangePairs.push([left, right]);
    }
  });
  const hasSpacedRange = spacedRangePairs.length > 0;
  // A half-spaced range splits at the tokenizer, so R1's own `\s*` never sees
  // it. SYMBOL operators only on the LEAD arm: a word operator glued to an ID
  // is an ID — `TORANGE-05` is a valid prefix-agnostic REQ-ID. The TRAIL arm
  // keeps the word operators, because a valid ID must end in digits, so
  // `REQ-01through` can only be a glued typo.
  const hasGluedRangeFragment = tokens.some((t, i) => {
    // Neighbours capped for the same reason as R2 above.
    if (!short(t)) return false;
    const before = tokens[i - 1] ?? '';
    const after = tokens[i + 1] ?? '';
    const lead = REQ_GLUED_RANGE_LEAD_RE.exec(t);
    if (
      lead &&
      i > 0 &&
      short(before) &&
      REQ_ID_SHAPE_RE.test(before) &&
      reqEndpointsImplyInterior(before, lead[1])
    ) {
      return true;
    }
    const trail = REQ_GLUED_RANGE_TRAIL_RE.exec(t);
    return Boolean(
      trail &&
        i < tokens.length - 1 &&
        short(after) &&
        REQ_ID_SHAPE_RE.test(after) &&
        reqEndpointsImplyInterior(trail[1], after),
    );
  });
  const leadToken = (tokens[0] ?? '').toUpperCase();
  // CENSUS (round 3, review finding Minor 4): the placeholder domain is what
  // GSD itself seeds plus what an author writes for "deliberately empty".
  // Reached: `TBD` — the ONLY machine-written seed, at the three phase.add /
  // -batch / -insert sites — and `None`, the author convention. NOT reached:
  // `N/A`, `Deferred`, `Pending`, `TBA`, `-`. Consequence, and it is now
  // ENFORCED rather than asserted: such a line selects zero IDs and warns
  // through R3b below, which is what #3697's acceptance criterion asks for
  // ("when it selects zero IDs from a line that is non-empty and is not the
  // `TBD` placeholder"). Round 3 shipped this same paragraph while R3's
  // ID-shape gate made it false for all five words — bare `Deferred` was
  // silent, `Deferred (see ADR-7)` warned — and the claim sat in three
  // artifacts with no test in either direction. Inferring placeholder-ness
  // from arbitrary prose is still the free-text heuristic this detector
  // avoids: R3b keys on the SELECTION being empty, never on what the prose
  // means.
  const placeholderLed = leadToken === 'TBD' || leadToken === 'NONE';
  const inertIdShaped =
    citedReqIds.length === 0 && !placeholderLed
      ? tokens.filter((t) => short(t) && t.includes('-') && REQ_ID_SUBSTRING_RE.test(t))
      : [];
  // R3b — the acceptance criterion's own narrow form. `tokens.length > 0` is
  // what keeps an empty line and a comment-only line silent: the tokenizer
  // strips `<!-- ... -->` before splitting, so `<!-- fill in -->` yields no
  // tokens and cannot reach this rule. Every other zero-selection,
  // non-placeholder line warns.
  const zeroSelectionInert = citedReqIds.length === 0 && !placeholderLed && tokens.length > 0;

  // R2 is the ONLY ambiguous rule — a tight range, a glued fragment and R3
  // residue each implicate ID-shaped text the selector demonstrably did not
  // take, so any of them means the line really did fail to parse. R2 is
  // ambiguous only when its OWN endpoints were selected: the detector shaves
  // brackets and the selector does not, so R2 can fire on a `(RANGE-02)` that
  // was never selected — a real drop, and the assertive channel is right there.
  // A token past the cap is NOT classified — and must therefore not be
  // silently discarded. Round 3's first cut of the uniform cap did exactly
  // that: a 2049-char range token warned before the round and went silent
  // after it, which is #3697's own defect introduced by the fix for a nit
  // (found by the round's pre-push review). The cap bounds the WORK, not the
  // warning — so an over-cap token that could carry an ID is reported as
  // unclassified. The test is `includes('-')`, a linear scan, never the
  // unanchored regex the cap exists to keep off these tokens.
  // ANY over-cap token, not just one carrying `-`. The first cut filtered on
  // `includes('-')` and therefore missed an over-cap OPERATOR:
  // `REQ-01 <2049 dots> REQ-05` warned before this round (R2 was uncapped) and
  // went silent after it. A token we could not examine makes the line
  // unverified whatever characters it happens to contain. Computed below,
  // where the selected set is available.

  // ID-shaped tokens the selector did not take, ANYWHERE on the line. This is
  // reported as a fact, never used to pick the channel: `(ADR-7)` and
  // `(REQ-02)` are indistinguishable by shape, so routing on it would put the
  // false "could not be parsed" claim back on a line carrying a citation.
  // Naming them lets the author see what the tokenizer skipped without the
  // warning asserting a verdict it cannot support in either direction.
  const selected = new Set(citedReqIds.map((id) => id.toUpperCase()));
  // A token the SELECTOR took has had its own SELECTION verified — the selector
  // is uncapped and anchored, so it examined the whole token. That is not the
  // same as "no rule was suppressed by it", and conflating the two was the
  // second continuation review's CLAIM J/K: two over-cap valid IDs either side
  // of `..` are both selected, both exempted, and R2 is capped — so a line that
  // warned before this round went silent, which is the very regression the
  // field exists to close, arriving through the fix for its own over-report.
  //
  // The exemption therefore applies only when nothing could have been
  // suppressed: an over-cap token that was selected AND has no neighbour that
  // could pair with it into a range. Everything else is unexaminable and is
  // reported as such.
  const couldPairIntoRange = (i: number): boolean => {
    for (const n of [tokens[i - 1], tokens[i + 1]]) {
      if (n === undefined) continue;
      if (!short(n)) return true;
      if (REQ_PURE_RANGE_OP_RE.test(n)) return true;
      if (REQ_GLUED_RANGE_LEAD_RE.test(n) || REQ_GLUED_RANGE_TRAIL_RE.test(n)) return true;
    }
    return false;
  };
  const oversizedTokens = tokens.filter(
    (t, i) => !short(t) && (!selected.has(t.toUpperCase()) || couldPairIntoRange(i)),
  );
  const unselectedIdShaped = tokens.filter(
    (t) => short(t) && REQ_ID_SUBSTRING_RE.test(t) && !selected.has(t.toUpperCase()),
  );
  // R4 runs on the RAW line, not on `tokens`: the shave that makes `REQ-01;`
  // look like a clean `REQ-01` is exactly the evidence this rule needs, so it
  // has to see the character the tokenizer removed.
  const delimiterDroppedIds = reqDelimiterDroppedIds(rawLine, selected, REQ_TOKEN_SCAN_LIMIT);
  const nothingDemonstrablyDropped =
    rangeTokens.length === 0 &&
    !hasGluedRangeFragment &&
    inertIdShaped.length === 0 &&
    // R4 is a DEMONSTRATED drop, so neither non-assertive voice — one claiming
    // nothing was dropped, the other that nothing could be checked — may speak
    // for a line carrying one.
    delimiterDroppedIds.length === 0 &&
    // R2 firing on an endpoint the selector did NOT take is itself a
    // demonstrated drop, and the assertive channel is right there. Vacuously
    // true when no spaced range fired, which is what makes this a strict
    // superset of the `!hasSpacedRange` guard the over-cap channel used to
    // carry — that channel's behaviour on a line with no spaced range is
    // unchanged, byte for byte.
    spacedRangePairs.every(([a, b]) => selected.has(a.toUpperCase()) && selected.has(b.toUpperCase()));
  const rangeReadingOnly =
    hasSpacedRange &&
    nothingDemonstrablyDropped &&
    // The cap bounds the WORK, never the warning. An over-cap token is not
    // classified by ANY rule (R1-R4 all skip it), so the voice whose entire
    // claim is that nothing was dropped has no basis to speak for this line.
    // It falls to the over-cap channel below instead — `unverified`, because
    // the line was not CHECKED; not `misparse`, because nothing on it
    // demonstrably failed to parse either. Round 7 review, Minor 1.
    oversizedTokens.length === 0;

  // Named rather than inlined into the return literal (round 3 review Minor 3):
  // this disjunction is the module's single most important predicate, and in
  // the literal a later edit that reordered a local below the `return` would be
  // a TDZ ReferenceError at runtime rather than an error at the reader's eye
  // level. R3b joins it here — see its field docs above for why it is not
  // gated on ID shape.
  const warn =
    rangeTokens.length > 0 ||
    hasSpacedRange ||
    hasGluedRangeFragment ||
    inertIdShaped.length > 0 ||
    zeroSelectionInert ||
    delimiterDroppedIds.length > 0 ||
    oversizedTokens.length > 0;

  return {
    citedReqIds,
    tokens,
    rangeTokens,
    hasSpacedRange,
    hasGluedRangeFragment,
    inertIdShaped,
    zeroSelectionInert,
    placeholderLed,
    spacedRangePairs,
    nothingDemonstrablyDropped,
    rangeReadingOnly,
    delimiterDroppedIds,
    oversizedTokens,
    unselectedIdShaped,
    warn,
  };
}

/**
 * Render the warning, or null when the line is clean.
 *
 * TWO CHANNELS, and the split is round 3's fix for review finding Major 3. The
 * detector cannot distinguish `RANGE-02 — RANGE-05` meaning a range from the
 * same text meaning an annotation separator; they are textually identical and
 * no token-level rule separates them. What the old single-channel message did
 * was resolve that ambiguity by ASSERTION — it told the author the line "could
 * not be parsed" and to rewrite it, on a line where every ID present had in
 * fact been selected and nothing had been dropped. That is a false statement
 * under the annotation reading and the #2334 over-warning class.
 *
 * Going silent instead is not available: the range reading is equally live, and
 * staying quiet on it re-opens the exact silent under-selection #3697 is about.
 * So the ambiguity is DISCLOSED rather than decided —
 *
 *   * any rule other than R2 fired, or R2 fired on an endpoint that was not
 *     selected → something ID-shaped was demonstrably NOT taken. The line did
 *     fail to parse; say so plainly, as before.
 *   * R2 alone fired and both its endpoints were selected → nothing was
 *     dropped. State both readings and let the author pick; never claim a parse
 *     failure that did not occur.
 */
function formatRequirementsLineWarning(
  phaseNum: string,
  rawLine: string,
  analysis: RequirementsLineAnalysis,
): ReqLineWarning | null {
  if (!analysis.warn) return null;
  const shown = String(rawLine).trim();
  const rangeRuleFired =
    analysis.rangeTokens.length > 0 || analysis.hasSpacedRange || analysis.hasGluedRangeFragment;

  // Tokens the selector skipped, stated as a fact in EITHER channel. `(ADR-7)`
  // and `(REQ-02)` are the same shape, so no rule can say which one matters —
  // but the author can, and only if the warning tells them. Round 3's first
  // cut instead let this drive the channel, which put the false "could not be
  // parsed" claim back on a line carrying a citation.
  // Names only what the rule-specific clauses did NOT already name, so the
  // assertive voice can carry it too without repeating itself.
  const alreadyNamed = new Set(
    [...analysis.rangeTokens, ...analysis.inertIdShaped, ...analysis.delimiterDroppedIds].map((t) =>
      t.toUpperCase(),
    ),
  );
  const skippedNames = analysis.unselectedIdShaped.filter((t) => !alreadyNamed.has(t.toUpperCase()));
  // Named, then qualified. The `PREFIX-N-N` shape is the one the range rules
  // deliberately decline to act on, so the rider says WHY it might not be a
  // requirement instead of silently deciding it is not.
  const ambiguousNamed = skippedNames.filter((t) => REQ_AMBIGUOUS_NUMERIC_RE.test(t));
  const skipped =
    skippedNames.length > 0
      ? ` ID-shaped text on the line that was NOT selected: ${skippedNames.join(', ')}` +
        ` (parentheses are not stripped, unlike square brackets) — check whether any of it is a` +
        ` requirement.` +
        (ambiguousNamed.length > 0
          ? ` ${ambiguousNamed.join(', ')} may equally be a date or a sub-numbered id, which is` +
            ` why the range rules do not act on that shape.`
          : '')
      : '';
  // R4's clause. Named separately from the generic skipped-text rider because
  // this one is not a "check whether any of it is a requirement" hedge — the
  // token IS an ID, the selector demonstrably did not take it, and the cause
  // is nameable.
  const delimiterDropped =
    analysis.delimiterDroppedIds.length > 0
      ? ` ${analysis.delimiterDroppedIds.join(', ')} ${analysis.delimiterDroppedIds.length === 1 ? 'was' : 'were'}` +
        ` NOT selected: a \`;\` or \`:\` is glued to the ID, or it carries an invisible character, and` +
        ` the line is split on commas and whitespace only. Write each requirement as a bare ID` +
        ` separated by a comma.`
      : '';
  const oversized =
    analysis.oversizedTokens.length > 0
      ? ` One or more tokens exceed the ${REQ_TOKEN_SCAN_LIMIT}-character scan limit and were NOT` +
        ` classified, so this line may carry more than is reported here.`
      : '';

  if (analysis.rangeReadingOnly) {
    // AMBIGUOUS channel — the RANGE reading is what is at stake, not a parse
    // failure: every endpoint the range rule fired on was selected.
    //
    // What this voice must NOT do is claim the whole LINE is correct. It has
    // no basis for that: an unrelated `(REQ-02)` elsewhere on the line is
    // dropped by the selector and invisible to every rule, so "nothing needs
    // to change" is an affirmative false statement on exactly the input the
    // rule-scoped discriminator was built to reach. It speaks about the
    // SEPARATOR, and defers the rest to the skipped-text clause above.
    return {
      code: REQ_LINE_WARNING_CODE.rangeReading,
      message:
      `ROADMAP Phase ${phaseNum} **Requirements** line (\`${shown}\`) contains what reads as a range ` +
      `between two cited REQ-IDs. Range forms are not expanded, so no interior IDs were selected; ` +
      `the line selected: ${analysis.citedReqIds.join(', ')}. If a range was intended, rewrite it ` +
      `naming every requirement explicitly (e.g. \`REQ-01, REQ-02, REQ-03\`); if that separator is ` +
      `an annotation rather than a range, it selected nothing to expand and needs no change.` +
      delimiterDropped +
      skipped +
      oversized,
    };
  }

  if (analysis.oversizedTokens.length > 0 && analysis.nothingDemonstrablyDropped) {
    // A DEMONSTRATED drop outranks this voice, whose whole claim is that
    // NOTHING could be checked — both cannot be true at once. `REQ-01,
    // REQ-02: <over-cap token>` names REQ-02 in `delimiterDroppedIds` and
    // then reported `req-line-unverified`, whose message never mentions it:
    // the concrete, actionable finding masked by the token beside it. That
    // exclusion now lives in `nothingDemonstrablyDropped`, shared verbatim
    // with `rangeReadingOnly` above rather than duplicated here — the
    // duplication is what let the two drift (round 7 review, Minor 1). The
    // assertive channel already appends the over-cap rider, so routing a
    // demonstrated drop there loses nothing about the cap.
    // OVER-CAP channel — no rule could run, so no rule may be diagnosed. Say
    // exactly that: the line was not classified, rather than not a problem.
    return {
      code: REQ_LINE_WARNING_CODE.unverified,
      message:
      `ROADMAP Phase ${phaseNum} **Requirements** line (\`${shown.slice(0, 200)}…\`) could not be ` +
      `checked: one or more tokens exceed the ${REQ_TOKEN_SCAN_LIMIT}-character scan limit, so the ` +
      `REQ-ID selection on this line is unverified. Rewrite it as a comma-separated list ` +
      `(e.g. \`REQ-01, REQ-02, REQ-03\`).`,
    };
  }

  // ASSERTIVE channel — ID-shaped content was demonstrably not selected.
  // Deliberately says "selected", NOT "marked complete": a range whose
  // endpoints are themselves unregistered selects them and marks nothing, and a
  // warning that overclaims the write is a warning the reader learns to
  // distrust.
  const selectedDesc =
    analysis.citedReqIds.length > 0
      ? `the only REQ-ID(s) selected from it were: ${analysis.citedReqIds.join(', ')}`
      : 'it selected NO REQ-IDs at all, so nothing was marked';
  const unparsed = [...new Set([...analysis.rangeTokens, ...analysis.inertIdShaped])];
  // Only diagnose "range" when a range rule actually fired — an R3 warning on
  // non-range ID text must not claim one was written. And on the R3 path the
  // residue is ID-SHAPED TEXT, which is not the same claim as "a requirement we
  // failed to parse" (round 3 review finding Minor 4: `Deferred (see ADR-7)`
  // reported `ADR-7` as missed requirement content when it is a citation). Name
  // what it is, and name the placeholder escape the author actually has.
  const advice = rangeRuleFired
    ? ' Range forms are not expanded; rewrite the line naming every requirement explicitly ' +
      '(e.g. `REQ-01, REQ-02, REQ-03`).'
    : ' If these are requirements, name them explicitly (e.g. `REQ-01, REQ-02, REQ-03`); if the line ' +
      'is deliberately empty, write `TBD` or `None` — any other wording selects nothing and warns.';
  return {
    code: REQ_LINE_WARNING_CODE.misparse,
    message:
    `ROADMAP Phase ${phaseNum} **Requirements** line could not be parsed as a comma-separated REQ-ID list ` +
    `(\`${shown}\`) - ${selectedDesc}.` +
    (unparsed.length > 0
      ? rangeRuleFired
        ? ` Unparsed text: ${unparsed.join(', ')}.`
        : ` ID-shaped text that was not selected: ${unparsed.join(', ')}.`
      : '') +
    advice +
    delimiterDropped +
    skipped +
    oversized,
  };
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
  // #3579 root-cause fix: this is a check, not a consuming read — use the
  // non-mutating peek so an unresolvable pointer isn't self-healed (cleared)
  // here and then found "absent" by diagnoseUnresolvedActiveWorkstream below,
  // which would misreport a present-but-bad marker as no marker at all.
  const resolvedWorkstream = process.env['GSD_WORKSTREAM'] || peekActiveWorkstream(cwd);
  if (availableWorkstreams.length > 0 && !resolvedWorkstream) {
    // #3579: getActiveWorkstream now inherits a pointer-less session's read
    // from the shared .planning/active-workstream marker, so reaching this
    // branch with a marker actually present means the marker EXISTED but
    // didn't resolve (invalid name, or its workstream dir is gone) — a
    // materially different situation from "nothing was ever set" and one
    // that deserves its own diagnostic instead of the generic message below.
    const diagnosis = diagnoseUnresolvedActiveWorkstream(cwd);
    if (diagnosis.present) {
      error(
        `phase.complete requires a workstream in workstream mode — the active-workstream marker names '${diagnosis.value}', but it did not resolve: ${describeUnresolvedWorkstreamReason(diagnosis.reason)}. Root STATE.md/ROADMAP.md (likely stale) would be written otherwise. ` +
          `Pass --ws <name> or run ${formatGsdSlash('workstream set', resolveRuntime(cwd)) as string} to point it at an existing workstream. ` +
          `Available workstreams: ${availableWorkstreams.join(', ')}`,
        ERROR_REASON.WORKSTREAM_MODE_MARKER_UNRESOLVED,
        { marker_value: diagnosis.value, marker_reason: diagnosis.reason },
      );
    }
    error(
      `phase.complete requires a workstream in workstream mode — no active workstream is set, so root STATE.md/ROADMAP.md (likely stale) would be written. ` +
        `Pass --ws <name> or run ${formatGsdSlash('workstream set', resolveRuntime(cwd)) as string} first. ` +
        `Available workstreams: ${availableWorkstreams.join(', ')}`,
      ERROR_REASON.WORKSTREAM_MODE_NONE_ACTIVE,
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
  // #3685: mirror requirementsUpdated's diff-tracking contract at the
  // writes.push({filePath, before, after}) sites below, rather than
  // reporting via fs.existsSync (which is true whenever the file merely
  // exists, not when the transaction actually wrote a change).
  let roadmapUpdated = false;
  let stateUpdated = false;

  const warnings: string[] = [];
  // The machine kind of the Requirements-line warning, carried out to the JSON
  // result as its own field (round 4 review Major 3). Declared HERE, in the
  // same scope as `warnings[]`, because the assignment happens inside
  // withPlanningLock and the emission happens after it.
  let reqLineWarningCode: ReqLineWarningCode | undefined;
  // ADR-3408 §8.5 / D2 (#3374): "liberal but visible" — when the write-seam
  // composition's preservation stage restores a curated frontmatter value
  // over a disagreeing derived one, that divergence is surfaced here rather
  // than silently absorbed. Structured (field + reason), not prose, so a
  // caller can assert on the value rather than regex a rendered message.
  // Named `preservation_warnings`, NOT `warnings`: `warnings` above is
  // already a prose `string[]` on this exact command — reusing it for a
  // structured `{field, reason}[]` shape would be the "Generative Fix
  // Divergence" anti-pattern (two sibling fields, same name, different
  // element types). Mirrors `cmdMilestoneComplete`'s identical field
  // (milestone.cts).
  const preservationWarnings: Array<{ field: string; reason: string }> = [];
  // #3057 B3: mirrors `verification_stale_check_indeterminate` on init.cts /
  // roadmap.cts / uat-predicate.cts's outputs — set on the non-blocking path
  // below (inside withPlanningLock) alongside the warnings[] entry, so a
  // caller can assert on the typed field instead of the warning's prose.
  let staleCheckIndeterminate = false;
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  // #2648: fail-closed plan-coverage gate. phase.complete used to gate ONLY on a
  // single *-VERIFICATION.md status, so a phase could close "complete" while an
  // arbitrary number of its plans — including plans a lock/recovery decision
  // silently dropped — had no completion record (a confirmed production incident
  // closed a phase with 6/30 plans unexecuted, including its entire final UI
  // scope, with every tool-reported signal green). Now refuse completion when any
  // plan lacks a matching *-SUMMARY.md, UNLESS that plan is explicitly retired
  // via machine-readable `status: superseded` frontmatter (the #2349 marker).
  //
  // scanPhasePlans is the superseded-AWARE counter (it drops status: superseded
  // plans from planFiles before returning), so a deliberately-retired plan never
  // appears in the unsummarized set and never blocks completion — closing the
  // Goodhart hole (delete a SUMMARY to raise the %) without regressing the
  // legitimate lock/recovery pattern (retire a plan instead of executing it).
  // This is evaluated BEFORE the verification-gate transaction below so a
  // plan-coverage refusal fails fast without mutating ROADMAP/STATE. The count
  // path (cmdPhaseComplete's own planCount/summaryCount above) is NOT superseded-
  // aware (it comes from findPhaseInternal/phase-locator.cts); that is fine for
  // DISPLAY (the X/Y cell) but must not be the gate — the gate needs the
  // superseded-adjusted set so retired plans don't re-block the very phases the
  // marker exists to unblock. Matches roadmap.cts's already-correct-but-unenforced
  // `summaryCount >= planCount` predicate, now enforced at the completion seam.
  const coverageScan = scanPhasePlans(phaseFullDir);
  // #2648 security: fail CLOSED when the phase directory cannot be read.
  // scanPhasePlans deliberately swallows readdirSync errors and returns an empty
  // plan set ({planFiles: []}), which is indistinguishable from a readable empty
  // phase. For a COVERAGE gate that is the wrong posture: "I could not read the
  // plans" must mean "I cannot prove coverage," not "all plans are summarized" —
  // otherwise any I/O failure (permissions, ENOTDIR, EBUSY on Windows, a dir
  // present in ROADMAP.md but missing/unreadable on disk) silently re-opens the
  // exact hole this gate exists to close. Distinguish the two: a readable
  // directory with zero plans is a legitimately complete empty phase; an
  // UNREADABLE directory is a fail-closed refusal. Mirrors cmdPhaseInsert's own
  // readdirSync-fail-closed posture (a swallow there used to risk writing a
  // colliding phase number).
  try {
    fs.readdirSync(phaseFullDir);
  } catch (readErr) {
    error(
      `Phase ${phaseNum} cannot be completed: its plan directory is unreadable (${phaseInfo['directory'] as string}: ${(readErr as NodeJS.ErrnoException).code || (readErr as Error).message}), so plan coverage cannot be verified. Restore read access and retry — a coverage gate that passes when it cannot read the plans is no gate at all (#2648).`,
      ERROR_REASON.PHASE_PLAN_COVERAGE_INCOMPLETE,
    );
  }
  const unsummarizedPlans = findUnsummarizedPlans(
    coverageScan.planFiles,
    coverageScan.summaryFiles,
  );
  if (unsummarizedPlans.length > 0) {
    // Sanitize plan filenames before interpolation: they come raw from
    // readdirSync and could carry C0 control chars / DEL (a committable filename
    // could spoof the terminal in plain-error mode). Strip them so the message is
    // safe to print regardless of --json-errors. Path traversal sequences are not
    // a code-execution vector here (printed only, never reopened from the message).
    const sanitize = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, '?');
    const listed = unsummarizedPlans.slice(0, 20).map(sanitize).join(', ');
    const more = unsummarizedPlans.length > 20 ? ` (and ${unsummarizedPlans.length - 20} more)` : '';
    // Audit surface (#2648 review M1): name how many plans were excluded as
    // superseded so a reviewer can see WHICH work was declared retired, not just
    // that some plans are missing summaries. The status: superseded marker is a
    // committable, review-time-trusted bypass; surfacing its count keeps that
    // bypass visible rather than silent.
    const phaseInfoPlanCount = Array.isArray(phaseInfo['plans']) ? (phaseInfo['plans'] as string[]).length : 0;
    const supersededCount =
      coverageScan.planFiles.length === 0 ? 0 : Math.max(0, phaseInfoPlanCount - coverageScan.planFiles.length);
    const supersededNote = supersededCount > 0
      ? ` ${supersededCount} plan(s) excluded as status: superseded (retired).`
      : '';
    error(
      `Phase ${phaseNum} cannot be completed: ${unsummarizedPlans.length} plan(s) have no completion record (*-SUMMARY.md): ${listed}${more}.` +
        supersededNote +
        ` Execute the plans and write their summaries, or retire a plan with machine-readable \`status: superseded\` frontmatter (#2349) if it was deliberately dropped — a retired plan is excluded from this gate. ` +
        `Completing a phase with unexecuted plans is what lost an entire promised deliverable silently (#2648).`,
      ERROR_REASON.PHASE_PLAN_COVERAGE_INCOMPLETE,
    );
  }

  try {
    const phaseFiles = fs.readdirSync(phaseFullDir);
    // #3511: scope this advisory pre-scan to THIS phase's own token so a
    // stray, cross-phase, or ad-hoc file cannot name a warning against a
    // phase it does not belong to.
    const phaseFullDirBaseName = path.basename(phaseFullDir);

    for (const file of scopeToPhase(
      phaseFiles.filter((f) => f.includes('-UAT') && f.endsWith('.md')),
      phaseFullDirBaseName,
    )) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/result: pending/.test(content)) warnings.push(`${file}: has pending tests`);
      if (/result: blocked/.test(content)) warnings.push(`${file}: has blocked tests`);
      if (/status: partial/.test(content)) warnings.push(`${file}: testing incomplete (partial)`);
      if (/status: diagnosed/.test(content)) warnings.push(`${file}: has diagnosed gaps`);
    }

    for (const file of scopeToPhase(
      phaseFiles.filter((f) => f.includes('-VERIFICATION') && f.endsWith('.md')),
      phaseFullDirBaseName,
    )) {
      const verificationFilePath = path.join(phaseFullDir, file);
      // #3707-CR follow-up MINOR: normalize line endings at this read boundary
      // (same fix as src/verification.cts's readVerificationStatus) so a
      // lone-CR VERIFICATION.md's `---\r...\r---` frontmatter fence still
      // matches extractFrontmatter's byte-0 check instead of silently
      // dropping the human_needed/gaps_found advisory warning below.
      const content = normalizeLineEndings(fs.readFileSync(verificationFilePath, 'utf-8'));
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

  // #2572: artifact↔disk advisory for the SUMMARYs of the phase being completed.
  //
  // A SUMMARY asserts "I created these files". Nothing checked that claim for
  // phase summaries — the `verify-summary` verb has existed since the beginning
  // but was only ever pointed at `.planning/research/SUMMARY.md`. An interrupted
  // or over-reported phase therefore counted toward 100% silently.
  //
  // Joins the same ADVISORY channel as the pre-scan above: findings land in
  // `warnings[]` (rendered by execute-phase.md's "If has_warnings is true"
  // step), never in the completion GATE (readVerificationStatus below).
  // Completion is never blocked.
  //
  // `checkCommits: false` — only the file-existence half is surfaced here, so
  // the `git cat-file` probes would be spawned and their result discarded. The
  // hash pattern is a loose `\b[0-9a-f]{7,40}\b` that matches any hex-shaped
  // token in prose, too noisy to put in front of a user even as a warning.
  //
  // `Infinity` — report every referenced file, not the CLI verb's default first
  // two, so a phase that lists twelve files and landed three says so. The verb
  // keeps its 2-file default; only this caller opts out of the cap.
  try {
    const phaseDirRel = phaseInfo['directory'] as string;
    // `summaries` arrives pre-sorted from the phase locator, so warning order is
    // deterministic across platforms rather than readdir-dependent.
    const summaryNames = (phaseInfo['summaries'] as string[] | undefined) || [];
    for (const summaryName of summaryNames) {
      const v = verifyMod.verifySummaryCore(
        cwd,
        `${phaseDirRel}/${summaryName}`,
        Infinity,
        { checkCommits: false },
      );
      const missing = v.checks.files_created.missing;
      if (missing.length > 0) {
        warnings.push(
          `${summaryName}: references ${missing.length} file(s) not on disk: ${missing.join(', ')}`,
        );
      }
    }
  } catch {
    /* best-effort, same posture as the #2245 pre-scan above: an unreadable
     * SUMMARY means one fewer advisory this run, never a blocked completion. */
  }

  let nextPhaseNum: string | null = null;
  let nextPhaseName: string | null = null;
  let isLastPhase = true;

  // #3311: typed conflict descriptor surfaced on the result JSON alongside the
  // warnings[] entry below (same parity pattern as
  // verification_stale_check_indeterminate).
  let milestoneConflict: milestoneLockMod.MilestoneConflict | null = null;

  // #3227: set inside `runPhaseCompleteTransaction` below from
  // `writePlanningFileSet`'s applied-count return — the transaction always
  // RUNS (verification passed, the lock was taken, `writes[]` was built),
  // but a re-run against a phase whose ROADMAP/STATE bytes already reflect
  // completion produces a `writes[]` where every entry is byte-identical to
  // disk, so `writePlanningFileSet` applies none of them. That must not
  // still refresh state.json's `updated_at` (design doc §40 row 26).
  let anyPlanningWrite = false;

  const verificationBlocked = withPlanningLock(cwd, () => {
    // #3311: completing a phase while a live milestone claim (phase + session)
    // holds a DIFFERENT phase means two sessions are working two phases against
    // the single Current Position slot. Warn via the established warnings[]
    // channel (rendered by execute-phase.md's "If has_warnings is true" step)
    // rather than blocking — the claim may simply be stale-but-live.
    milestoneConflict = milestoneLockMod.checkMilestoneConflictForPhase(cwd, phaseNum);
    if (milestoneConflict) {
      const holder = milestoneConflict.locked_session ?? 'an unknown (headless) session';
      const actor = milestoneConflict.session ?? 'an unknown (headless) session';
      warnings.push(
        `milestone lock conflict (#3311): ${holder} holds the milestone claim for phase ` +
          `${milestoneConflict.locked_phase}, but ${actor} is completing phase ${phaseNum} — ` +
          `STATE.md's Current Position is a single slot; verify it before trusting it`,
      );
      milestoneLockMod.warnMilestoneConflict(milestoneConflict, `phase.complete ${phaseNum}`);
    }
    // #2617: pass the project's runtime so the blocked-completion error below
    // suggests the command surface this runtime actually installs
    // ($gsd-… on Codex) rather than a hard-coded Claude-style string.
    const verificationStatus = readVerificationStatus(phaseFullDir, { runtime: resolveRuntime(cwd) });
    // #3057 B3: the staleness check inside readVerificationStatus can itself
    // fail (fs / scanPhasePlans / clock error), in which case `status` above
    // was routed as if nothing were stale (unchanged fail-open routing) — but
    // that must not be silently identical to a check that actually ran and
    // found nothing stale. Join the SAME advisory channel the UAT/VERIFICATION
    // pre-scan above already uses (`warnings[]`, rendered by execute-phase.md's
    // "If has_warnings is true" step) rather than inventing a new one. This
    // only fires on the non-blocking path (status resolves to 'passed' despite
    // the indeterminate check) — the blocked path below carries its own note.
    if (verificationStatus.staleCheckIndeterminate) {
      staleCheckIndeterminate = true;
      warnings.push(
        `verification staleness check could not complete for phase ${phaseNum} — routed as not-stale, but this was not actually verified (#3057)`,
      );
    }
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
        // #3685 / #3691: normalize both sides before comparing — see
        // contentChangedAfterNormalize's doc (shell-command-projection.cts).
        // A raw `!==` here false-positives whenever this phase-complete
        // roadmap mutation regenerates a section in a different-but-
        // equivalent raw shape than the already-normalized on-disk original.
        roadmapUpdated = contentChangedAfterNormalize(roadmapPath, originalRoadmapContent, roadmapContent);

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
            // #2334 HIGH 3 + #3697: selection and under-selection detection both
            // live in `analyzeRequirementsLine` (module scope, above), extracted in
            // round 3 so the parser is directly testable — a closure in here is
            // reachable only by spawning the CLI, which no fast-check property test
            // can do. `citedReqIds` is byte-identical to the expression that stood
            // here; nothing about what phase-complete MARKS has changed.
            const reqLineAnalysis = analyzeRequirementsLine(reqMatch[1]);
            citedReqIds = reqLineAnalysis.citedReqIds;
            const reqLineWarning = formatRequirementsLineWarning(
              phaseNum,
              reqMatch[1],
              reqLineAnalysis,
            );
            if (reqLineWarning) {
              warnings.push(reqLineWarning.message);
              // Carried out to the JSON result as its own field — see
              // REQ_LINE_WARNING_CODE for why it is not folded into
              // `warnings[]`.
              reqLineWarningCode = reqLineWarning.code;
            }

            for (const reqId of citedReqIds) {
              const reqEscaped = escapeRegex(reqId);
              // Surface 1 — the checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**.
              // #2945: the flip is CONDITIONAL (porting #2788 defect-2's rollback from
              // cmdRequirementsMarkComplete). Capture the pre-flip content; if a
              // traceability row EXISTS for this ID below but its Status write is rejected
              // (Out/Deferred/Blocked), the checkbox is rolled back so the two surfaces
              // cannot silently diverge. A requirement recorded as deferred must not read
              // as shipped.
              const checkboxRe = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
              const beforeCheckbox = reqContent;
              reqContent = reqContent.replace(checkboxRe, '$1x$2');
              const checkboxFlipped = reqContent !== beforeCheckbox;

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
              // #2945: track tableHit (did the callback actually CHANGE the value?) so the
              // checkbox rollback below can distinguish "row existed and accepted" from
              // "row existed and rejected".
              let tableHit = false;
              const reqUpdate = updateTraceabilityCell(reqContent, reqRowMatch, 'Status', (current) => {
                // #2788: accept `Gaps Found` too so a phase stranded by revert-phase (the
                // gaps_found response) can complete without hand-editing the table.
                if (/^(?:pending|in progress|gaps found)$/i.test(current.trim())) {
                  tableHit = true;
                  return ' Complete ';
                }
                return current;
              });
              if (reqUpdate.ok) {
                reqContent = reqUpdate.value;
              } else if (!isPlaceholderReqId(reqId)) {
                traceabilityWriteMisses.push(reqId);
              }

              // #2945 defect-2 (port of milestone.cts:200-210): if a row EXISTS for this
              // ID but its Status write was rejected (row reads Out/Deferred/Blocked,
              // which the callback returned unchanged), roll the checkbox back so the
              // checkbox and the row cannot silently diverge. reqUpdate.ok === a row
              // matched (existence probe); !tableHit === the callback did not advance it.
              if (checkboxFlipped && reqUpdate.ok && !tableHit) {
                reqContent = beforeCheckbox;
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
          // #3685 / #3691: normalize both sides before comparing — same
          // false-positive shape as the sibling roadmapUpdated/stateUpdated
          // flags in this same transaction; all three must agree by
          // construction (see contentChangedAfterNormalize's doc).
          requirementsUpdated = contentChangedAfterNormalize(reqPath, originalReqContent, reqContent);
        }
      }

      // #3701 — the ROADMAP decides WHICH phase is next; the disk decides only HOW it
      // is spelled. Both scans select the numerically lowest phase above N.
      //
      // Both scans below are unchanged in what they match; what changed is that
      // the roadmap is no longer gated behind "the disk found nothing". It used
      // to be (`if (isLastPhase && roadmapContent !== null)`), which made a wrong
      // disk answer uncorrectable: phase directories are created lazily, but
      // `phase insert` scaffolds an inserted phase's directory immediately, so an
      // inserted decimal is routinely the ONLY directory above N and outranked
      // every phase preceding it in the roadmap. Observed: roadmap `1, 2, 02.1,
      // 3` with directories for 01 and 02.1 only reported `next_phase: "02.1"`
      // after completing 1 — and PERSISTED it to STATE.md — while
      // `roadmap.analyze` correctly said `2`.
      //
      // #3581 fixed exactly this at `init.progress` and named the rule: "the
      // frontier is ROADMAP ORDER, not artifact presence". This call site was not
      // in that change's scope.
      //
      // Why the disk scan survives, rather than being replaced:
      //   1. It is the only resolver when there is no ROADMAP.md, or when its
      //      phase rows do not parse.
      //   2. When both agree, it carries the SPELLING the output has always used
      //      — the zero-padded directory token and the on-disk slug (`02`/`beta`),
      //      where the roadmap would give `2` and a slugified title. Promoting the
      //      roadmap without this would silently change the reported value on
      //      every aligned project, which is the majority case.
      let diskNextNum: string | null = null;
      let diskNextName: string | null = null;
      let roadmapNextNum: string | null = null;
      let roadmapNextName: string | null = null;

      try {
        // #3185 (ADR-3180 Decision 1): "which phase directories belong to
        // the CURRENT milestone" — routed through the canonical owner
        // instead of a hand-rolled readdirSync + isDirInMilestone filter
        // (which also never excluded sentinels on its own, unlike the
        // owner; the per-directory isSentinelPhaseId check below stays as a
        // defensive second check against the REGEX-EXTRACTED token, which
        // is not necessarily identical to the raw directory name).
        const dirs = listMilestonePhaseDirs(phasesDir, { cwd }).value;

        for (const dir of dirs) {
          const dm = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
          if (dm) {
            // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
            if (isSentinelPhaseId(dm[1])) continue;
            // Numeric MINIMUM above N, not "first encountered". `listMilestonePhaseDirs`
            // does sort by `comparePhaseNum`, so a `break` on the first hit happens to be
            // correct today — but that makes this scan's correctness depend on an
            // upstream sort nothing here states. Selecting the minimum explicitly costs
            // one comparison and removes the hidden coupling.
            if (comparePhaseNum(dm[1], phaseNum) > 0
              && (diskNextNum === null || comparePhaseNum(dm[1], diskNextNum) < 0)) {
              diskNextNum = dm[1];
              diskNextName = dm[2] || null;
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

      if (roadmapContent !== null) {
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
          //
          // #4078: the checkbox branch's separator is no longer colon-only. The
          // canonical phase lookup has accepted the bullet-house dash grammar
          // (`- [ ] **Phase N — Name**`, em/en-dash/hyphen/colon) since #2199
          // (`BULLET_PHASE_LINE_PATTERN`, roadmap-parser.cjs), but this scan still
          // required `:`, so on a roadmap whose original rows use the dash grammar
          // the ONLY parseable row above N was typically a later phase.add-ingested
          // colon-form phase — positionally last — and it won the numeric-minimum
          // vote it should never have been alone in (observed: 18 of 18 selected,
          // phases 2–17 skipped). The heading branch stays colon-only, mirroring
          // `findRoadmapPhaseInContent`'s heading grammar exactly; only the
          // checkbox branch widens, and only to the separators #2199 already
          // accepts. The two branches keep separate capture groups, normalized
          // just below the loop.
          const phasePattern = new RegExp(
            `(?:#{2,4}\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)` +
            `|-\\s*\\[[ xX]\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*[—–:\\-]\\s*([^\\n*]+))`,
            'gi'
          );
          let pm: RegExpExecArray | null;
          while ((pm = phasePattern.exec(roadmapForPhases)) !== null) {
            // #4078: normalize the two alternation branches' captures (heading
            // branch → groups 1/2, widened checkbox branch → groups 3/4).
            const pmNum = pm[1] ?? pm[3];
            const pmName = pm[2] ?? pm[4];
            // #2786: skip sentinel phase ids (999.x backlog, 0.x drafts) — stage 1
            // already skips sentinel dirs on disk via isSentinelPhaseId (#3185);
            // stage 2's heading scan must not advance into backlog headings either.
            if (isSentinelPhaseId(pmNum)) continue;
            // #3701 review: the numeric MINIMUM above N, not the first row above N in
            // DOCUMENT order. This scan walks raw roadmap text, and one global regex
            // sweeps both the `## Phases` checklist and the `## Phase Details`
            // headings, so "first match" is a statement about where a line sits in the
            // file — not about which phase comes next.
            //
            // It mattered only once this scan started deciding the answer. Before, it
            // ran solely when the disk scan found nothing; now it outranks the disk, so
            // a roadmap listing rows out of numeric sequence (`1, 3, 2`) reported
            // `next_phase: 3` and PERSISTED it, skipping Phase 2 — on an input the
            // pre-#3701 code got right, because the disk scan is numerically sorted.
            // Phase NUMBERS define sequence here, exactly as `comparePhaseNum` does for
            // the disk scan and for #2028's lowest-outstanding override; the roadmap
            // defines which phases EXIST and which milestone they belong to.
            if (comparePhaseNum(pmNum, phaseNum) > 0
              && (roadmapNextNum === null || comparePhaseNum(pmNum, roadmapNextNum) < 0)) {
              roadmapNextNum = pmNum;
              roadmapNextName = pmName
                .replace(/\(INSERTED\)/i, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
            }
          }
        } catch {
          /* best-effort (#2245 audit): stage 2 of the next-phase cascade
           * (see stage 1's comment above) — a failure here just leaves
           * isLastPhase as stage 1 left it; stage 3 (#2028) below runs next
           * regardless and provides a further, independent override. */
        }
      }


      // Resolve. The roadmap wins on identity; the disk wins on spelling when it
      // is talking about the same phase.
      if (roadmapNextNum !== null) {
        // Same comparator both scans already use to order phases, so "the disk
        // and the roadmap mean the same phase" cannot drift from "N is above the
        // one just completed". `02` and `2` compare equal, which is the whole
        // point — they are the same phase spelled two ways.
        const diskAgrees = diskNextNum !== null && comparePhaseNum(diskNextNum, roadmapNextNum) === 0;
        nextPhaseNum = diskAgrees ? diskNextNum : roadmapNextNum;
        nextPhaseName = diskAgrees ? diskNextName : roadmapNextName;
        isLastPhase = false;
      } else if (diskNextNum !== null) {
        // No usable roadmap (absent, unreadable, or no parseable phase rows) —
        // the disk is all there is. Unchanged from the pre-#3701 behaviour.
        nextPhaseNum = diskNextNum;
        nextPhaseName = diskNextName;
        isLastPhase = false;
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
      // #3350: this stage answers a DIFFERENT question than stages 1-2 ("what is
      // the next actionable phase?" vs "is this the last phase?"), so it must not
      // be gated on their answer. Gating on isLastPhase let a merely-positionally
      // next higher heading (stage 2) permanently mask a genuinely-outstanding
      // lower phase — stage 2 cleared isLastPhase and this scan never ran. The
      // scan already refuses anything not strictly lower than the completed phase
      // (plus sentinels, #2949), so running it unconditionally cannot manufacture
      // a wrong answer: when no lower phase is outstanding it finds nothing and
      // stages 1-2's pick stands unchanged; in the masking case isLastPhase is
      // already false, so the last-phase signal has no reachable regression.
      if (roadmapContent !== null) {
        try {
          const milestoneScope = extractCurrentMilestone(roadmapContent, cwd);
          // #4078: the separator class here mirrors stage 2's widened checkbox
          // branch (and #2199's BULLET_PHASE_LINE_PATTERN): em/en-dash/hyphen/colon.
          // Without it, this lowest-outstanding override was blind to dash-grammar
          // rows and could not correct an out-of-order completion on the same
          // mixed-grammar roadmaps that broke stage 2.
          const cbPattern = new RegExp(
            `-\\s*\\[(x| )\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*[—–:\\-]\\s*([^\\n*]+)`,
            'gi'
          );
          let cbm: RegExpExecArray | null;
          let lowestOutstanding: { num: string; name: string } | null = null;
          while ((cbm = cbPattern.exec(milestoneScope)) !== null) {
            const isChecked = cbm[1].toLowerCase() === 'x';
            // #2949: exclude sentinel-range phase ids (0.x backlog, 999.x) from candidacy.
            // comparePhaseNum("0.1","12") === -12, so without this guard an unchecked 0.x
            // backlog row sorts below every real phase and is wrongly selected as next_phase,
            // corrupting STATE.md and desyncing current_phase from current_phase_name.
            // isSentinelPhaseId covers both sentinel ranges (SENTINEL_RANGES = [0, 999]); a
            // real lower-numbered outstanding phase (e.g. Phase 9) is NOT a sentinel and is
            // still selected, preserving #2028's out-of-order-completion behavior.
            if (!isChecked && !isSentinelPhaseId(cbm[2]) && comparePhaseNum(cbm[2], phaseNum) < 0) {
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
        // `updatePerformanceMetricsSection` stays in this adapter: it is a
        // section-table / disk-scan concern, not a classified field. The
        // sync + post-sync preservation this transaction needs runs via the
        // single write-seam composition, `syncAndPreserveStateMd` (it does
        // NOT go through readModifyWriteStateMd because STATE.md is
        // committed atomically with ROADMAP/REQUIREMENTS, ADR-3408 §8.3 /
        // #3374 / #3469).
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
        // #2736: the transition holds the next phase's exact display name in
        // the intent; pass it as authoritative so the sync's prose
        // re-derivation cannot rewrite current_phase_name to the name's own
        // parenthetical (`Closer-ruling measurement (D1a)` → `D1a`).
        // #3350: PAIR the override. When STATE.md's body carries no Current
        // Phase / Phase field to re-derive from (narrative prose), the #905
        // preserve guard in syncStateFrontmatter keeps the OLD frontmatter
        // current_phase while the authoritative current_phase_name advances —
        // leaving the two fields describing different phases. Pin BOTH to the
        // resolved next phase in that case. When the body DOES carry the field
        // (completePhaseCore just rewrote it), stay name-only so the body's
        // richer `N of T (name)` derived shape survives the sync.
        const fmBody = frontmatterMod.stripFrontmatter(stateContent);
        const bodyHasPhaseField =
          stateExtractField(fmBody, 'Current Phase') != null ||
          stateExtractField(fmBody, 'Phase') != null;
        // #4129: the POST-completion progress counters, derived from the very
        // ROADMAP this transaction just mutated (still in memory — it hits disk
        // only at writePlanningFileSet, AFTER this content was assembled).
        // buildStateFrontmatter's disk scan inside syncAndPreserveStateMd
        // reads the PRE-completion ROADMAP (and any stale-dated sibling
        // verification), so without this intent the persisted counter failed
        // to increment on the completing phase's own transaction. Routed
        // through the #2736 authoritativeFm seam's object direction: the
        // pre-preservation merge makes it the derived truth the ratchet
        // compares, and the post-preservation re-assert (completedOnlyRaise)
        // is a floor no preservation branch can drop below. clampPercent is
        // completePhaseCore's own percent formula (state-transition.cts),
        // reused so the frontmatter and the body `Progress:` line agree.
        const postCompletionRoadmapScope = roadmapContent !== null
          ? extractCurrentMilestone(roadmapContent, cwd)
          : null;
        const postCompletionRoadmapProgress = postCompletionRoadmapScope !== null
          ? deriveProgressFromRoadmapForIntent(postCompletionRoadmapScope)
          : null;
        const authoritativeProgress: Record<string, number> | undefined =
          postCompletionRoadmapProgress && postCompletionRoadmapProgress.completedPhases !== null
            ? postCompletionRoadmapProgress.totalPhases !== null && postCompletionRoadmapProgress.totalPhases > 0
              ? {
                  completed_phases: postCompletionRoadmapProgress.completedPhases,
                  percent: clampPercentForIntent(
                    postCompletionRoadmapProgress.completedPhases,
                    postCompletionRoadmapProgress.totalPhases,
                  ),
                }
              : { completed_phases: postCompletionRoadmapProgress.completedPhases }
            : undefined;
        const authoritativeFm: Record<string, unknown> | undefined = authoritativeProgress
          ? {
              ...(nextPhaseDisplayName
                ? bodyHasPhaseField || !nextPhaseNum
                  ? { current_phase_name: nextPhaseDisplayName }
                  : {
                      current_phase: String(nextPhaseNum),
                      current_phase_name: nextPhaseDisplayName,
                    }
                : {}),
              progress: authoritativeProgress,
            }
          : nextPhaseDisplayName
            ? bodyHasPhaseField || !nextPhaseNum
              ? { current_phase_name: nextPhaseDisplayName }
              : {
                  current_phase: String(nextPhaseNum),
                  current_phase_name: nextPhaseDisplayName,
                }
            : undefined;
        // ADR-3408 §8.3 / #3469: this deliberately bypasses
        // readModifyWriteStateMd (STATE.md is committed atomically with
        // ROADMAP/REQUIREMENTS), so it calls the single write-seam
        // composition (`syncAndPreserveStateMd`) directly instead of
        // assembling `syncStateFrontmatter` + `applyPostSyncPreservation`
        // itself — a call site re-assembling the pair, even with every step
        // calling an owner, is the exact re-derivation §8.3 forbids by name
        // (Phase 2 found this shape live here). The composition runs
        // snapshots from the on-disk pre-image (originalStateContent) and
        // the transformed content, table-driven applyStatePreservation, then
        // the #2736 authoritative re-assert (which restores the #3350
        // pairing override the preserve-always restore may have reverted).
        // resync=true is the lifecycle-transition posture (progress
        // recomputed from disk; only the preserve-when-unchanged deltas
        // apply). Fields the transition legitimately rewrote (Status, Phase,
        // Stopped At via completePhaseCore's #3374 continuity line) have
        // changed body sources, so their deltas do not fire.
        // ADR-3408 §8.5 / D2 (#3374): thread `divergedFields` through so this
        // command reports what it preserved, following `cmdMilestoneComplete`'s
        // shape (milestone.cts) — the same composition, the same out-param,
        // the same visibility contract.
        const divergedFields: string[] = [];
        stateContent = syncAndPreserveStateMd(
          originalStateContent,
          stateContent,
          statePath,
          cwd,
          {
            resync: true,
            authoritativeFm,
            divergedFields,
          },
        );
        for (const field of divergedFields) {
          preservationWarnings.push({ field, reason: 'preserved-over-disagreeing-derived' });
        }

        writes.push({ filePath: statePath, before: originalStateContent, after: stateContent });
        // #3685 / #3691: normalize both sides before comparing (same
        // transitionCore-regenerated-section artifact cmdMilestoneComplete
        // hit — see contentChangedAfterNormalize's doc). Reported "not
        // exposed" by a previous agent; the reviewer disproved that by
        // inspection and this branch closes it.
        stateUpdated = contentChangedAfterNormalize(statePath, originalStateContent, stateContent);
      }

      anyPlanningWrite = writePlanningFileSet(writes) > 0;
    };

    if (fs.existsSync(statePath)) {
      withStateLock(statePath, runPhaseCompleteTransaction);
    } else {
      runPhaseCompleteTransaction();
    }
    // #3311: a successful completion of the CLAIMED phase releases the
    // milestone claim — regardless of which session completes it (an
    // orchestrator cleaning up after a dead session must not be blocked by the
    // dead session's own claim). No-ops when the claim names another phase.
    milestoneLockMod.releaseMilestonePhase(cwd, phaseNum);
    return null;
  });

  if (verificationBlocked) {
    const nextStep = verificationBlocked.next_command
      ? ` Next: ${verificationBlocked.next_command}`
      : '';
    // #3057 B3: purely additive to the message text — does not change WHETHER
    // this blocks (verificationBlocked was already truthy) or the
    // ERROR_REASON, only whether the operator can see the staleness check
    // itself did not complete. The same fact is also attached as a typed
    // field (`verification_stale_check_indeterminate`) on the JSON-error-mode
    // payload so a test can assert on it by value instead of regexing this
    // human-readable note.
    const staleCheckIndeterminate = verificationBlocked.staleCheckIndeterminate === true;
    const indeterminateNote = staleCheckIndeterminate
      ? ' (staleness check could not complete — see #3057)'
      : '';
    error(
      `Phase ${phaseNum} verification is incomplete: ${verificationBlocked.next_action}${nextStep}${indeterminateNote}`,
      ERROR_REASON.PHASE_VERIFICATION_INCOMPLETE,
      { verification_stale_check_indeterminate: staleCheckIndeterminate },
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
    roadmap_updated: roadmapUpdated,
    state_updated: stateUpdated,
    requirements_updated: requirementsUpdated,
    auto_pruned: autoPruned,
    warnings,
    has_warnings: warnings.length > 0,
    // ADDITIVE, never a change to `warnings[]`'s element shape — that array is
    // a documented string[] consumed by execute-phase.md, so re-typing it
    // would break a shipped output contract. Absent when the line is clean.
    ...(reqLineWarningCode ? { requirements_line_warning: { code: reqLineWarningCode } } : {}),
    verification_stale_check_indeterminate: staleCheckIndeterminate,
    milestone_conflict: milestoneConflict,
    preservation_warnings: preservationWarnings,
  };

  output(result, raw);
  // #3227: gate on `anyPlanningWrite` (whether `writePlanningFileSet`
  // actually wrote anything), not on reaching this line — reaching here only
  // means verification passed and the transaction ran, not that ROADMAP.md
  // or STATE.md bytes changed (see the `anyPlanningWrite` declaration above).
  if (anyPlanningWrite) publishStateContract(cwd);
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
const { scanPhasePlans, isCanonicalPlanFile } = planScanMod;

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
  cmdPhaseTddApplicable,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
  analyzeRequirementsLine,
  formatRequirementsLineWarning,
  REQ_LINE_WARNING_CODE,
  cmdPhaseUatPassed,
  cmdPhaseListPlans,
  computeDependencyLevels,
  buildShortFormToId,
};
