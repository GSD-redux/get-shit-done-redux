/**
 * Planning Snapshot — a parsed projection of `.planning/` (Phase 10, #3308,
 * ADR-3180 §8.1).
 *
 * Composed EXCLUSIVELY from the already-consolidated §7 owners
 * (`getMilestoneInfo`, `listMilestonePhaseDirs`, `isPhaseComplete`,
 * `scanPhasePlans`, `stateFieldValue`, `planningPaths`) plus the frozen
 * `SCOPE` enum. This module introduces no new semantic derivation — it
 * introduces exactly one new thing: `worstScope`, a way to combine several
 * independently-scoped owner answers into one composite record without
 * letting a caller treat a non-answer as data.
 *
 * `buildPlanningSnapshot(cwd)` is the sole export consumers reach for;
 * `worstScope` is exported alongside it for direct unit coverage.
 *
 * Design: .gsd/phase/refactor-3308-planning-snapshot-parsed-projection/40-design.md
 *
 * ADR-457 build-at-publish: source in src/planning-snapshot.cts, compiled to
 * gsd-core/bin/lib/planning-snapshot.cjs (gitignored).
 */

import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths } = planningWorkspace;
import { platformReadSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
import { stateFieldValue, stateCurrentPositionSlice } from './state-document.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

// ─── worstScope — the one new piece of coordination logic ───────────────────

/**
 * Severity ordering (`UNREADABLE` worst, `COMPLETE` best) is a genuine design
 * choice, not inherited from anywhere — see the design doc's "Scope
 * combination" section. `TRUNCATED` vs `UNSCOPED` are not ranked against each
 * other by any upstream decision; this ordering exists only so a future
 * diagnostic rule can name which failure was worse when several compound.
 */
const SCOPE_SEVERITY: Record<Scope, number> = {
  [SCOPE.COMPLETE]: 0,
  [SCOPE.TRUNCATED]: 1,
  [SCOPE.UNSCOPED]: 2,
  [SCOPE.UNREADABLE]: 3,
};

/**
 * Combine several independently-scoped owner answers into the single worst
 * (most severe) `Scope` among them. Pure, no I/O. Not a re-derivation of any
 * §7 owner — it folds together already-final `scope` outputs, which is new
 * coordination logic no single owner has visibility to express itself.
 */
function worstScope(...scopes: Scope[]): Scope {
  return scopes.reduce((worst, s) => (SCOPE_SEVERITY[s] > SCOPE_SEVERITY[worst] ? s : worst));
}

// ─── Snapshot shape ───────────────────────────────────────────────────────────

interface PhaseSnapshot {
  dir: string;
  complete: boolean;
  verificationStatus: string;
  planCount: number;
  summaryCount: number;
  scope: Scope;
}

interface PlanningSnapshot {
  milestone: ReturnType<typeof getMilestoneInfo>;
  phaseDirs: ReturnType<typeof listMilestonePhaseDirs>;
  phases: { value: PhaseSnapshot[]; scope: Scope };
  currentPhaseLabel: { value: string | null; scope: Scope };
}

/**
 * Build one `PhaseSnapshot` for a single already-enumerated phase directory
 * name. `isPhaseComplete` and `scanPhasePlans` each perform their own raw
 * `readdirSync` against `fullPhaseDir` and can independently degrade — see
 * the design doc's "Scope combination" section for why the two are genuinely
 * uncorrelated (isPhaseComplete's readability check never re-derives or
 * requires scanPhasePlans, and vice versa).
 */
function buildPhaseSnapshot(phasesDir: string, dir: string): PhaseSnapshot {
  const fullPhaseDir = path.join(phasesDir, dir);
  const completionResult = isPhaseComplete(fullPhaseDir);
  const scanResult = scanPhasePlans(fullPhaseDir);
  return {
    dir,
    complete: completionResult.value.complete,
    verificationStatus: completionResult.value.verification.status,
    planCount: scanResult.planCount,
    summaryCount: scanResult.summaryCount,
    scope: worstScope(completionResult.scope, scanResult.scope),
  };
}

/**
 * Resolve `currentPhaseLabel` — the raw `Phase:` field STATE.md records under
 * `## Current Position` (e.g. `"3 of 8 (User Auth)"`), not a normalized
 * phase-directory id (see the design doc's Known limits).
 *
 * This module performs the one STATE.md read no §7 owner does, mirroring
 * every existing STATE.md caller (`cmdStateSnapshot`, `cmdStatePrune`):
 * `platformReadSync` + `extractFrontmatter` + `stripFrontmatter`.
 *
 * - STATE.md absent (ENOENT, `platformReadSync` returns `null`) is a real
 *   non-answer, NOT corruption — a project that never ran `state.init`
 *   legitimately has no STATE.md yet. `warnUnusableInput` is NOT called.
 * - STATE.md present but unreadable (any other read error, e.g. EISDIR) is
 *   corruption — `warnUnusableInput(STATE_UNREADABLE)` fires exactly once.
 * - An unterminated frontmatter fence is reported by `extractFrontmatter`
 *   itself (`FRONTMATTER_UNTERMINATED`) — this function does not duplicate
 *   that diagnostic; it still attempts a body-only field read on whatever
 *   `stripFrontmatter` leaves behind.
 */
function buildCurrentPhaseLabel(statePath: string): { value: string | null; scope: Scope } {
  let content: string | null;
  try {
    content = platformReadSync(statePath);
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.STATE_UNREADABLE, source: statePath });
    return { value: null, scope: SCOPE.UNREADABLE };
  }
  if (content === null) {
    return { value: null, scope: SCOPE.UNREADABLE };
  }

  const frontmatter = extractFrontmatter(content, statePath);
  const body = stripFrontmatter(content);
  const section = stateCurrentPositionSlice(body);
  return stateFieldValue(frontmatter, section ?? body, null, 'Phase', {
    scope: section === null ? SCOPE.TRUNCATED : SCOPE.COMPLETE,
  });
}

/**
 * Build the full `.planning/` projection for `cwd`. Composes exactly the six
 * §7 owners named in the design doc's "Owners consumed" table — no
 * re-derivation, no new semantic answer. See the design doc for the
 * behavior table and rejected alternatives.
 */
function buildPlanningSnapshot(cwd: string): PlanningSnapshot {
  const paths = planningPaths(cwd);
  const milestone = getMilestoneInfo(cwd);
  const phaseDirs = listMilestonePhaseDirs(paths.phases, { cwd });

  const phasesValue = phaseDirs.value.map((dir) => buildPhaseSnapshot(paths.phases, dir));

  return {
    milestone,
    phaseDirs,
    phases: {
      value: phasesValue,
      scope: worstScope(phaseDirs.scope, ...phasesValue.map((p) => p.scope)),
    },
    currentPhaseLabel: buildCurrentPhaseLabel(paths.state),
  };
}

export = {
  buildPlanningSnapshot,
  worstScope,
};
