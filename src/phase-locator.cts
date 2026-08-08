/**
 * Phase Locator — Phase-directory search and location
 *
 * ADR-857 rollout phase 2d: extracted from core.cts (issue #881).
 * Owns active-phase discovery against the `.planning/phases/` tree
 * (`searchPhaseInDir`, `findPhaseInternal`) and archived-phase-dir
 * enumeration (`getArchivedPhaseDirs`), matching phase ids/tokens against
 * the filesystem. Behaviour is preserved byte-for-behaviour from the prior
 * location; only the module boundary moved. The core.cjs re-export spine
 * was retired in epic #1267; callers import phase-locator helpers directly.
 *
 * Dependencies (leaf modules only — no loadConfig):
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs       (normalizePhaseName, phaseTokenMatches, extractPhaseToken)
 *   - ./core-utils.cjs     (readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath)
 *   - ./planning-workspace.cjs (planningDir)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { normalizePhaseName, phaseTokenMatches, extractPhaseToken, isSentinelPhaseId, comparePhaseNum } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const { readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath, findUnsummarizedPlans } = coreUtilsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterModule = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDependencyGraphModule = require('./plan-dependency-graph.cjs');
const { computeHaltPropagation, buildSummaryFileIndex, isSummaryFileHalted } = planDependencyGraphModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter } = roadmapParserModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

// ─── Phase search types ───────────────────────────────────────────────────────

interface PhaseSearchResult {
  found: boolean;
  directory: string;
  phase_number: string;
  phase_name: string | null;
  phase_slug: string | null;
  plans: string[];
  summaries: string[];
  incomplete_plans: string[];
  has_research: boolean;
  has_context: boolean;
  has_verification: boolean;
  has_reviews: boolean;
  archived?: string;
  ambiguous_matches?: string[];
  /**
   * #2830: plan filenames (from `plans`) whose own SUMMARY declares
   * `status: halted` — a designed stop, not an ordinary completion.
   */
  halted_plans: string[];
  /**
   * #2830: plan filename -> the halted plan id(s) (canonical, e.g. "01-02")
   * transitively blocking it, for every entry in `incomplete_plans` that is
   * blocked by an upstream halt. A plan filename absent from this map is not
   * blocked (either not incomplete, or incomplete with no halted upstream).
   */
  blocked_by: Record<string, string[]>;
  /**
   * #2830: the runnable-only view — `incomplete_plans` filtered to exclude
   * anything present as a key in `blocked_by`. `incomplete_plans` itself
   * keeps its pre-#2830 meaning ("no matching SUMMARY yet") unchanged.
   */
  runnable_plans: string[];
}

/**
 * #2830: parse a plan file's `depends_on` frontmatter. Returns [] — never
 * throws — on a missing/unreadable/malformed plan or absent field, matching
 * this primitive's existing fail-safe posture (a plan directory this
 * primitive can otherwise read must never throw here).
 */
function parsePlanDependsOn(phaseDir: string, planFile: string): string[] {
  try {
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    const fm = extractFrontmatter(content, planPath);
    const fmDeps = fm['depends_on'];
    if (Array.isArray(fmDeps)) return fmDeps.map(String);
    if (typeof fmDeps === 'string' && fmDeps.trim() !== '') return [fmDeps];
    return [];
  } catch {
    return [];
  }
}

interface ArchivedPhaseDir {
  name: string;
  milestone: string;
  basePath: string;
  fullPath: string;
}

interface ArchiveVersionDir {
  version: string;
  archivePath: string;
}

// ─── Phase search helpers ─────────────────────────────────────────────────────

/**
 * #2855: single source of truth for resolving and enumerating a project's
 * (or, when a workstream is active, that workstream's OWN) archived-milestone
 * directories — `<planningDir(cwd)>/milestones/vX.Y-phases/`. Both
 * `findPhaseInternal`'s archive fallback and `getArchivedPhaseDirs` used to
 * carry independent copies of this resolve-then-enumerate logic, which is
 * exactly the shape that let the original #2855 bug (hardcoded root path)
 * exist in one copy and not the other. Sharing this seam means a future
 * change to how the archive tree is located only needs to happen once.
 * Most-recent-milestone-first order (reverse-sorted directory names).
 * Never throws: an absent/unreadable milestones/ dir yields [].
 */
function listArchiveVersionDirs(cwd: string): ArchiveVersionDir[] {
  const milestonesDir = path.join(planningDir(cwd), 'milestones');
  if (!fs.existsSync(milestonesDir)) return [];

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    return milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse()
      .map(archiveName => ({
        version: archiveName.match(/^(v[\d.]+)-phases$/)![1],
        archivePath: path.join(milestonesDir, archiveName),
      }));
  } catch {
    return [];
  }
}

function searchPhaseInDir(baseDir: string, relBase: string, normalized: string): PhaseSearchResult | null {
  try {
    const dirs = readSubdirectories(baseDir, true);
    const matches = dirs.filter(d => phaseTokenMatches(d, normalized));
    if (matches.length === 0) return null;

    // #2237: fail loud when multiple directories match the same bare phase
    // number — this happens when unrelated projects share a .planning/phases/
    // tree. Silently taking the first match risks cross-project file writes.
    if (matches.length > 1) {
      return {
        found: false,
        directory: '',
        phase_number: normalized,
        phase_name: null,
        phase_slug: null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
        has_reviews: false,
        ambiguous_matches: matches,
        halted_plans: [],
        blocked_by: {},
        runnable_plans: [],
      };
    }

    const match = matches[0];

    const phaseToken = extractPhaseToken(match);
    const phaseNumber = phaseToken || normalized;
    const afterToken = match.slice(phaseToken ? phaseToken.length : 0).replace(/^-/, '');
    const phaseName = afterToken || null;
    const phaseDir = path.join(baseDir, match);
    const { plans: unsortedPlans, summaries: unsortedSummaries, hasResearch, hasContext, hasVerification, hasReviews } = getPhaseFileStats(phaseDir);
    const plans = unsortedPlans.sort();
    const summaries = unsortedSummaries.sort();

    // #3183 (ADR-3180 Decision 2): the summary→plan pairing used to be a
    // bespoke rule local to this function (a third pairing rule alongside
    // scanPhasePlans's completion check and countMatchedSummaries). Routed
    // through the canonical core-utils.findUnsummarizedPlans instead, which
    // shares its `summaryCandidates` matching rule with countMatchedSummaries
    // so the count and this named list can never disagree.
    const incompletePlans = findUnsummarizedPlans(plans, summaries);

    // #2830: reverse lookup from a completed plan's id (exact or canonical) to
    // its actual summary filename. Shared builder (also used by phase.cts's
    // cmdPhasePlanIndex) so the two can never disagree about which summary
    // belongs to which plan.
    const summaryFileByPlanId = buildSummaryFileIndex(summaries, extractCanonicalPlanId);

    // #2830: this primitive previously never parsed depends_on at all — see
    // src/plan-dependency-graph.cts's file header. Build the same
    // PlanHaltNode[] shape phase.cts's cmdPhasePlanIndex builds (id resolution
    // mirrors its planMap/canonicalToId pattern) and hand it to the ONE
    // shared halt-propagation traversal so this reader and the wave-grouping
    // reader can never diverge on the halt rule again.
    const planIds = plans.map(p => p.replace('-PLAN.md', '').replace('PLAN.md', ''));
    const planIdByLower = new Map(planIds.map(id => [id.toLowerCase(), id]));
    const canonicalToPlanId = new Map(
      plans.map((p, i) => [extractCanonicalPlanId(p).toLowerCase(), planIds[i]]),
    );

    const haltNodes = plans.map((p, i) => {
      const planId = planIds[i];
      const canonical = extractCanonicalPlanId(p);
      const summaryFile = summaryFileByPlanId.get(planId) ?? summaryFileByPlanId.get(canonical);
      const halted = summaryFile !== undefined && isSummaryFileHalted(path.join(phaseDir, summaryFile));
      const resolvedDependsOn = parsePlanDependsOn(phaseDir, p)
        .map((dep) => {
          const lower = dep.toLowerCase();
          return planIdByLower.get(lower) ?? canonicalToPlanId.get(lower) ?? null;
        })
        .filter((id): id is string => id !== null);
      return { id: planId, resolvedDependsOn, halted };
    });
    const { blockedBy } = computeHaltPropagation(haltNodes);

    const haltedPlans = plans.filter((_, i) => haltNodes[i].halted);
    const incompletePlanSet = new Set(incompletePlans);
    const blockedByFiles: Record<string, string[]> = {};
    const runnablePlans: string[] = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (!incompletePlanSet.has(p)) continue;
      const causes = blockedBy.get(planIds[i]) ?? [];
      if (causes.length > 0) {
        blockedByFiles[p] = causes;
      } else {
        runnablePlans.push(p);
      }
    }

    return {
      found: true,
      directory: toPosixPath(path.join(relBase, match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
      has_reviews: hasReviews,
      halted_plans: haltedPlans,
      blocked_by: blockedByFiles,
      runnable_plans: runnablePlans,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd: string, phase: unknown): PhaseSearchResult | null {
  if (!phase) return null;

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  const relPhasesDir = toPosixPath(path.relative(cwd, phasesDir));
  const current = searchPhaseInDir(phasesDir, relPhasesDir, normalized);
  if (current) return current;

  // #2855: scope the archived-milestone fallback to the SAME workstream as the
  // active-phase search above (planningDir(cwd) resolves GSD_WORKSTREAM/GSD_PROJECT
  // the identical way both places), not the hardcoded project-root tree. Archived
  // phases genuinely live under a workstream's own `.planning/workstreams/<ws>/
  // milestones/` — that is where archivePhaseDirectories (milestone.cts) writes
  // them via the same planningDir(cwd) resolution. Hardcoding root here let a
  // pending workstream phase resolve to an unrelated workstream's (or a flat-mode
  // project's) archived phase that merely shares a phase number. Shared with
  // getArchivedPhaseDirs via listArchiveVersionDirs (see its doc comment).
  for (const { version, archivePath } of listArchiveVersionDirs(cwd)) {
    const relBase = toPosixPath(path.relative(cwd, archivePath));
    const result = searchPhaseInDir(archivePath, relBase, normalized);
    if (result) {
      result.archived = version;
      return result;
    }
  }

  return null;
}

/**
 * #3185 (epic #3180 Phase 3, ADR-3180 Decision 1 row "Phase enumeration"):
 * the SINGLE canonical owner of "which phase directories belong to the current
 * milestone". Applies the milestone window AND the sentinel filter, in that
 * order, and returns the surviving directory names.
 *
 * Before this existed the derivation had four independent implementations and
 * only `cmdRoadmapAnalyze` carried both halves; `cmdProgressRender`,
 * `cmdStats` and `cmdPhasesList` each carried neither or one.
 *
 * TWO THINGS THIS GETS RIGHT THAT A HEADING-SIDE FILTER CANNOT:
 *
 * 1. The sentinel test runs against DIRECTORY NAMES and is UNCONDITIONAL.
 *    `getMilestonePhaseFilter` excludes sentinels from its ROADMAP HEADING
 *    set, but when that set is empty it degrades to a literal `() => true`
 *    pass-all predicate and never consults the heading set at all — so its
 *    own sentinel exclusion becomes unreachable exactly when it is needed,
 *    and every directory on disk (backlog included) is reported as a
 *    current-milestone phase. That degrade is the #3167 symptom path.
 *
 * 2. The sentinel predicate is the canonical `isSentinelPhaseId`
 *    (`src/phase-id.cts`, SENTINEL_RANGES [0, 999]), not a local literal.
 *    The rule had five copies and three different regexes before this phase,
 *    and they disagreed about Phase 0.
 *
 * The pass-all degrade is narrowed MINIMALLY: it stays over-inclusive for
 * non-sentinel directories, so a project whose window declares no phases
 * still sees its real phase directories. Only sentinels are refused.
 *
 * `scope` distinguishes a REAL empty from a NON-answer (ADR-3180 Decision 2):
 * an absent `phasesDir` is a real empty (a new project genuinely has no
 * phases) and inherits the window's scope, whereas a `phasesDir` that exists
 * but cannot be read is UNREADABLE.
 */
function listMilestonePhaseDirs(
  phasesDir: string,
  opts: {
    cwd?: string;
    ws?: string | null;
    versionOverride?: string | null;
    phaseIdConvention?: string | null;
  } = {},
): { value: string[]; scope: Scope } {
  const { cwd, ws = null, versionOverride = null, phaseIdConvention = null } = opts;

  // Without a cwd there is nothing to scope AGAINST — the caller asked for an
  // unscoped read, which is a real answer (mirrors extractCurrentMilestoneScoped's
  // row 1). Sentinels are still refused: they are never milestone phases.
  let inWindow: (dirName: string) => boolean = () => true;
  let scope: Scope = SCOPE.COMPLETE;
  if (cwd) {
    const filter = getMilestonePhaseFilter(cwd, versionOverride, phaseIdConvention, ws);
    inWindow = filter;
    scope = filter.scope;
  }

  // An ABSENT phases dir is a real empty, not a failure: a freshly-created
  // project genuinely has no phase directories yet. Distinguishing this from
  // the unreadable case below is the whole point of the scope discriminator.
  if (!fs.existsSync(phasesDir)) return { value: [], scope };

  let names: string[];
  try {
    names = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // The directory EXISTS but could not be read (EACCES/EIO). An empty list
    // here is a NON-answer and must not be reported as "this milestone has no
    // phases" — that collapse is the defect class this epic removes.
    return { value: [], scope: SCOPE.UNREADABLE };
  }

  const value = names
    .filter((name) => inWindow(name) && !isSentinelPhaseId(name, phaseIdConvention ?? undefined))
    .sort((a, b) => comparePhaseNum(a, b));

  return { value, scope };
}

function getArchivedPhaseDirs(cwd: string): ArchivedPhaseDir[] {
  // #2855: same workstream-scoped resolution as findPhaseInternal above, via
  // the shared listArchiveVersionDirs helper. `phase.list --include-archived`
  // (the primary non-init consumer) must not leak a different workstream's
  // archive either.
  const results: ArchivedPhaseDir[] = [];

  for (const { version, archivePath } of listArchiveVersionDirs(cwd)) {
    const dirs = readSubdirectories(archivePath, true);

    for (const dir of dirs) {
      results.push({
        name: dir,
        milestone: version,
        basePath: toPosixPath(path.relative(cwd, archivePath)),
        fullPath: path.join(archivePath, dir),
      });
    }
  }

  return results;
}

export = {
  searchPhaseInDir,
  findPhaseInternal,
  getArchivedPhaseDirs,
  listMilestonePhaseDirs,
};
