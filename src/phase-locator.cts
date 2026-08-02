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
const { normalizePhaseName, phaseTokenMatches, extractPhaseToken } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const { readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath } = coreUtilsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;

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

    const completedPlanIds = new Set(
      summaries.flatMap(s => {
        const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
        const canonical = extractCanonicalPlanId(s);
        return canonical === exact ? [exact] : [exact, canonical];
      })
    );
    const incompletePlans = plans.filter(p => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      const canonical = extractCanonicalPlanId(p);
      return !completedPlanIds.has(planId) && !completedPlanIds.has(canonical);
    });

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
};
