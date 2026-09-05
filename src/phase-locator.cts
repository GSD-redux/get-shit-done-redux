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
 *   - ./phase-id.cjs       (normalizePhaseName, matchPhaseDirs, phaseNumberForMatch)
 *   - ./core-utils.cjs     (readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath)
 *   - ./planning-workspace.cjs (planningDir)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { normalizePhaseName, matchPhaseDirs, phaseNumberForMatch, isSentinelPhaseId, comparePhaseNum, isForeignPrefixedPhaseQuery } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const { readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath, findUnsummarizedPlans } = coreUtilsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspace;
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
 * Most-recent-milestone-first order, compared numerically segment-by-segment
 * on the version (e.g. `v1.10` before `v1.9`) — NOT lexicographically. A
 * lexicographic `.sort().reverse()` (the prior implementation) ranks `v1.9`
 * ahead of `v1.10` because the string `"1.9"` sorts after `"1.10"`; that is
 * deterministic but wrong for every double-digit-or-higher minor/patch
 * version, and #3458 is what first surfaces archived phases in audit output
 * where the misordering becomes user-visible.
 * Never throws: an absent/unreadable milestones/ dir yields [].
 */
function compareArchiveVersionDesc(aName: string, bName: string): number {
  const aParts = (aName.match(/^v([\d.]+)-phases$/)?.[1] ?? '').split('.').map(Number);
  const bParts = (bName.match(/^v([\d.]+)-phases$/)?.[1] ?? '').split('.').map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const a = aParts[i] ?? 0;
    const b = bParts[i] ?? 0;
    if (a !== b) return b - a; // descending: newest (numerically largest) first
  }
  return 0;
}

function listArchiveVersionDirs(cwd: string, wsOverride?: string | null): ArchiveVersionDir[] {
  // #3804: enumerate BOTH archive shapes under the CURRENT SCOPE's milestones
  // tree (planningDir — GSD_WORKSTREAM/GSD_PROJECT-aware, exactly the
  // #2855 scoping findPhaseInternal and getArchivedPhaseDirs rely on):
  //   flat:               <scope>/milestones/vX.Y-phases/<phase-dir>/
  //   workstream archive: <scope>/milestones/ws-<slug>-<date>/phases/<phase-dir>/
  // Pre-#3804 only the flat shape matched, so workstream-archived milestones
  // were invisible (the reporter's repo: 20 hidden phase artifacts). The
  // ws-* shape's phase dirs sit one level deeper (under phases/) and its dir
  // name fails ^v[\d.]+-phases$ — both the name AND the level are modeled.
  // Version labels: flat keeps the bare vX.Y; ws-* shapes carry the dir name
  // (no numeric version). Flat-newest-first (compareArchiveVersionDesc), then
  // ws dirs by name descending — deterministic. The AUDIT's cross-workstream
  // enumeration (audit.cts listAuditPhaseTargets) calls this helper once per
  // tree (root + each workstream) rather than widening this scope — the
  // #2855 no-leak contract for findPhaseInternal/getArchivedPhaseDirs is
  // preserved untouched.
  const milestonesDir = path.join(planningDir(cwd, wsOverride ?? undefined), 'milestones');
  const out: ArchiveVersionDir[] = [];
  const seen = new Set<string>();
  const pushVersion = (version: string, archivePath: string): void => {
    const rel = toPosixPath(path.relative(cwd, archivePath));
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ version, archivePath });
  };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(milestonesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const flat = entries
    .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
    .map(e => e.name)
    .sort(compareArchiveVersionDesc);
  for (const archiveName of flat) {
    pushVersion(archiveName.match(/^(v[\d.]+)-phases$/)![1], path.join(milestonesDir, archiveName));
  }
  const wsDirs = entries
    .filter(e => e.isDirectory() && /^ws-/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();
  for (const wsName of wsDirs) {
    pushVersion(wsName, path.join(milestonesDir, wsName, 'phases'));
  }

  return out;
}

function searchPhaseInDir(baseDir: string, relBase: string, normalized: string): PhaseSearchResult | null {
  try {
    const dirs = readSubdirectories(baseDir, true);
    // #2528: canonical two-pass selection (exact token match, then the
    // bare-integer leading-digit-run fallback) shared with the find-phase and
    // phase-plan-index scans — see phase-id.cts::matchPhaseDirs.
    const { matches, usedBareFallback } = matchPhaseDirs(dirs, normalized);
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

    const phaseToken = phaseNumberForMatch(match, usedBareFallback);
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
      // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
      // (generateSlugInternal, core-utils.cts) rather than re-implementing
      // it. `maxLen: null` preserves this site's pre-migration untruncated
      // contract — the 60-char default would drop an on-disk phase slug's
      // reported value out of sync with the real directory name.
      phase_slug: phaseName ? coreUtilsModule.generateSlugInternal(phaseName, null) : null,
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
 *
 * `opts.ws` is tri-state, matching `planningDir`'s own contract: `undefined`
 * (the default — do not pass `ws` at all) resolves the AMBIENT workstream
 * from `GSD_WORKSTREAM`; `null` FORCES the project root regardless of any
 * ambient workstream; a string forces that specific workstream.
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
  // #3597: `ws` must default to `undefined`, NOT `null`. `undefined` means
  // "resolve the ambient workstream" (mirrors planningDir's own contract,
  // src/planning-workspace.cts:124); `null` means "force the project root".
  // Every cwd-bearing caller derives `phasesDir` ambiently (planningPaths(cwd)
  // / planningDir(cwd) with no explicit ws), so defaulting `ws` to `null` here
  // forced the milestone WINDOW to the root ROADMAP while the caller's
  // `phasesDir` stayed workstream-scoped — numerator and denominator drawn
  // from different scoped sets (ADR-3180 §7.6 rule 3 violation). That is what
  // made `--ws <name> progress` read `phase_scope: "unreadable"` and withhold
  // `percent` once `workstream create` migrated the root ROADMAP away.
  const { cwd, ws, versionOverride = null, phaseIdConvention = null } = opts;

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

/**
 * #3882 (ADR-3473 §8.2, issue #3882): the single owner of "the PHYSICAL set
 * of phase directories on disk, entirely un-windowed" — the OTHER axis
 * `listMilestonePhaseDirs` above deliberately does not offer. That owner
 * refuses sentinels UNCONDITIONALLY (see its own doc comment); it has no way
 * to say "physical set, sentinels included". That is exactly what an
 * archival, lookup-index, or health-sweep caller needs — e.g. a heading ->
 * directory lookup index that must resolve a directory regardless of
 * milestone window (`cmdRoadmapAnalyze`'s `_phaseDirNames`,
 * `cmdInitMilestoneOp`'s `diskPhaseDirs`) — which is why those callers used
 * to hand-roll a `readdirSync` instead of calling either owner.
 *
 * `includeSentinels` is REQUIRED, with no default value. #3882/ADR-3473 §8.2:
 * "a caller that wants sentinels asks for them explicitly" — obtaining
 * sentinel-inclusion by silent omission is exactly the defect class this
 * axis exists to close, so the call site is refused at COMPILE TIME without
 * it, not merely documented against it here.
 *
 * Mirrors `listMilestonePhaseDirs`'s own absent/unreadable handling
 * (ADR-3180 Decision 2): an ABSENT `phasesDir` is a real empty (a project
 * with no phase directories yet), `scope: SCOPE.COMPLETE`; a `phasesDir`
 * that EXISTS but cannot be read is a NON-answer, `scope: SCOPE.UNREADABLE`
 * — a caller must not treat that empty list as "this project has no
 * phases."
 */
function listAllPhaseDirs(
  phasesDir: string,
  opts: { includeSentinels: boolean; phaseIdConvention?: string | null },
): { value: string[]; scope: Scope } {
  const { includeSentinels, phaseIdConvention = null } = opts;

  if (!fs.existsSync(phasesDir)) return { value: [], scope: SCOPE.COMPLETE };

  let names: string[];
  try {
    names = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }

  const value = names
    .filter((name) => includeSentinels || !isSentinelPhaseId(name, phaseIdConvention ?? undefined))
    .sort((a, b) => comparePhaseNum(a, b));

  return { value, scope: SCOPE.COMPLETE };
}

function getArchivedPhaseDirs(cwd: string, wsOverride?: string | null): ArchivedPhaseDir[] {
  // #2855: same workstream-scoped resolution as findPhaseInternal above, via
  // the shared listArchiveVersionDirs helper. `phase.list --include-archived`
  // (the primary non-init consumer) must not leak a different workstream's
  // archive either.
  const results: ArchivedPhaseDir[] = [];

  for (const { version, archivePath } of listArchiveVersionDirs(cwd, wsOverride)) {
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

/**
 * #3804 — the CROSS-WORKSTREAM archive enumeration the audit surfaces need.
 * getArchivedPhaseDirs above is deliberately #2855-SCOPED (an ambient
 * workstream must not leak other trees' phases to findPhaseInternal), but
 * audit-uat's charter (#2766: outstanding items do not stop mattering) is
 * cross-workstream: enumerate the project root plus every workstream's own
 * milestones tree, labeling workstream entries '<ws>/<version>' so
 * acknowledge-by-label stays unambiguous. Deduped by full path (the same
 * tree cannot be reached twice, but the guard keeps the invariant explicit).
 */
function getAllArchivedPhaseDirs(cwd: string): ArchivedPhaseDir[] {
  const out: ArchivedPhaseDir[] = [];
  const seen = new Set<string>();
  const collect = (labelPrefix: string, wsOverride: string | null): void => {
    for (const archived of getArchivedPhaseDirs(cwd, wsOverride)) {
      const rel = toPosixPath(path.relative(cwd, archived.fullPath));
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push({ ...archived, milestone: `${labelPrefix}${archived.milestone}` });
    }
  };
  collect('', null);
  const workstreamsDir = path.join(planningRoot(cwd), 'workstreams');
  try {
    const wsEntries = fs.readdirSync(workstreamsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const ws of wsEntries) {
      collect(`${ws}/`, ws);
    }
  } catch {
    /* no workstreams dir — the root pass above already ran */
  }
  return out;
}

/**
 * #2056 / #2105: `findPhaseInternal` matches a phase token against on-disk
 * directories with no notion of project scope, so a token carrying a FOREIGN
 * project-code prefix (`OTHER-05` in a `project_code: "MINE"` project) would
 * otherwise resolve to this project's same-numbered directory — bug #2237.
 * This is the guarded form every phase-token consumer must use; the bare
 * `findPhaseInternal` above is the unscoped primitive it wraps.
 *
 * Lives here, beside the primitive it guards, rather than in a caller: #4030
 * added a second consumer (`loop render-hooks --phase`, `loop-resolver.cts`)
 * and routing that through the first consumer (`init.cts`) would have inverted
 * the dependency tree and closed a require cycle.
 */
function phaseInfoMatchesExactPrefix(
  phaseInfo: Record<string, unknown> | null,
  phase: string,
): boolean {
  const num = phaseInfo?.['phase_number'];
  const numStr = typeof num === 'string' ? num : (typeof num === 'number' ? String(num) : '');
  return numStr.toUpperCase() === phase.toUpperCase();
}

function guardedFindPhase(
  cwd: string,
  phase: string,
  projectCode: unknown,
): Record<string, unknown> | null {
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
  if (isForeignPrefixedPhaseQuery(phase, projectCode) && !phaseInfoMatchesExactPrefix(phaseInfo, phase)) {
    phaseInfo = null;
  }
  return phaseInfo;
}

export = {
  searchPhaseInDir,
  findPhaseInternal,
  guardedFindPhase,
  getArchivedPhaseDirs,
  getAllArchivedPhaseDirs,
  listMilestonePhaseDirs,
  listAllPhaseDirs,
};
