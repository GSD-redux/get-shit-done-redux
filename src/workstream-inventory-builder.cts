/**
 * Workstream Inventory Builder — pure projection from pre-collected
 * filesystem data to typed WorkstreamInventory. No I/O. No async.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/workstream-inventory-builder.cjs collapsed to a TypeScript source
 * of truth. Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 */

import path from 'node:path';

// Internal helpers
function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

/**
 * #2562: verification verdicts that DISQUALIFY a phase from `complete`, even
 * when its SUMMARY count meets its PLAN count. Deliberately scoped to the two
 * EXPLICIT failing verdicts the verifier emits — `missing`/`unknown` (verifier
 * off / not yet run) and `stale` (mtime-derived, #2348) are intentionally left
 * untouched so verifier-disabled projects do not regress to never-complete.
 */
const FAILING_VERIFICATION_STATUSES = new Set<string>(['gaps_found', 'human_needed']);

export function isCompletedInventory(status: unknown): boolean {
  const s = (typeof status === 'string'
    ? status
    : typeof status === 'number' || typeof status === 'boolean'
      ? String(status)
      : ''
  ).trim().toLowerCase();
  return /\bmilestone\s+complete\b/.test(s) || /\barchived\b/.test(s);
}

export interface PhaseFilesCount {
  directory: string;
  planCount: number;
  summaryCount: number;
  /**
   * #2562: the directory's canonical phase key (`phaseKeyFromDir`). Two stale
   * same-numbered directories (`05-x` alongside `5-x-old` — Bug #2445's
   * scenario) share a key and must count ONCE in the rollup, or the numerator
   * outgrows a denominator that counts distinct phases. Absent → the directory
   * name is its own key (no de-duplication).
   */
  phaseKey?: string;
  /** #2562: directory mtime, the Bug #2445 tie-break when two directories share a phase key. */
  mtimeMs?: number;
  /**
   * #2562: whether this phase directory belongs to the CURRENT milestone.
   * Only meaningful when milestone scoping is active (see
   * `currentMilestonePhaseCount`); undefined/true otherwise.
   */
  inMilestone?: boolean;
  /**
   * #2562: the phase's `*-VERIFICATION.md` verdict (`readVerificationStatus`).
   * A phase with SUMMARY count ≥ PLAN count but a failing verdict
   * (`gaps_found`/`human_needed`) must NOT count as complete.
   */
  verificationStatus?: string;
}

export interface PhaseStatus {
  directory: string;
  status: 'complete' | 'in_progress' | 'pending';
  plan_count: number;
  summary_count: number;
}

export interface WorkstreamFilesExist {
  roadmap: boolean;
  state: boolean;
  requirements: boolean;
}

export interface StateProjection {
  status: string;
  current_phase: string | null | undefined;
  last_activity: string | null | undefined;
}

export interface BuildWorkstreamInventoryInputs {
  name: string;
  projectDir: string;
  workstreamDir: string;
  phaseDirNames: string[];
  activeWorkstreamName: string;
  phaseFilesCounts: PhaseFilesCount[];
  roadmapPhaseCount: number;
  stateProjection: StateProjection;
  filesExist: WorkstreamFilesExist;
  /**
   * True when an authoritative shipped signal is present for this workstream
   * (an archived milestone snapshot under milestones/, or a SHIPPED marker in
   * the workstream ROADMAP). When true, the inventory status is DERIVED as
   * "milestone complete" regardless of the mutable STATE.md `Status` field,
   * so a stale field can never report a shipped workstream as executing (#1913).
   */
  milestoneShipped: boolean;
  /**
   * #2562: number of phases the CURRENT milestone declares in the ROADMAP
   * `## Progress` table (including phases declared but never scaffolded). When
   * > 0, milestone scoping is active: only phases whose directory belongs to
   * the current milestone (`PhaseFilesCount.inMilestone`) feed the completion
   * rollup, and this value — not `roadmapPhaseCount` — is the denominator, so
   * completed prior-milestone phases can never inflate the percentage to 100.
   * 0 disables scoping and preserves the legacy `roadmapPhaseCount` behavior.
   */
  currentMilestonePhaseCount?: number;
}

export interface WorkstreamInventory {
  name: string;
  path: string;
  active: boolean;
  files: WorkstreamFilesExist;
  status: string;
  /** Whether `status` was derived from an authoritative signal ("derived") or taken verbatim from the STATE.md field ("field"). */
  status_source: 'field' | 'derived';
  /** True when the derived status disagrees with the STATE.md `Status` field (the field is stale). */
  status_conflict: boolean;
  current_phase: string | null | undefined;
  last_activity: string | null | undefined;
  phases: PhaseStatus[];
  phase_count: number;
  completed_phases: number;
  roadmap_phase_count: number;
  total_plans: number;
  completed_plans: number;
  progress_percent: number;
}

export function buildWorkstreamInventory(inputs: BuildWorkstreamInventoryInputs): WorkstreamInventory {
  const {
    name,
    projectDir,
    workstreamDir,
    phaseDirNames,
    activeWorkstreamName,
    phaseFilesCounts,
    roadmapPhaseCount,
    stateProjection,
    filesExist,
    milestoneShipped,
    currentMilestonePhaseCount = 0,
  } = inputs;

  // #2562: milestone scoping is active when the current milestone declares a
  // known phase count. When active, prior-milestone phase directories are
  // excluded from the completion rollup and the denominator.
  const scoped = currentMilestonePhaseCount > 0;

  // Index counts by directory for O(1) lookup during sort/iteration
  const countsMap = new Map<string, PhaseFilesCount>();
  for (const entry of phaseFilesCounts) {
    countsMap.set(entry.directory, entry);
  }

  // #2562 / Bug #2445: pick ONE directory per phase key for the rollup. Stale
  // same-numbered directories left over from a prior milestone would otherwise
  // each add to the numerator while the denominator counts distinct phases —
  // pushing completed_phases past it, where the old `Math.min` cap silently
  // rounded the result up to 100% and hid an unstarted phase. Newest-on-disk
  // wins, mirroring state.cts's #2445 de-duplication.
  const rollupDirByKey = new Map<string, string>();
  for (const dir of [...phaseDirNames].sort()) {
    const entry = countsMap.get(dir);
    if (scoped && entry?.inMilestone === false) continue;
    const key = entry?.phaseKey ?? dir;
    const incumbent = rollupDirByKey.get(key);
    if (incumbent === undefined) {
      rollupDirByKey.set(key, dir);
      continue;
    }
    const incumbentMtime = countsMap.get(incumbent)?.mtimeMs ?? 0;
    if ((entry?.mtimeMs ?? 0) > incumbentMtime) rollupDirByKey.set(key, dir);
  }
  const rollupDirs = new Set(rollupDirByKey.values());

  const phases: PhaseStatus[] = [];
  let completedPhases = 0;
  let totalPlans = 0;
  let completedPlans = 0;

  for (const dir of [...phaseDirNames].sort()) {
    const counts = countsMap.get(dir);
    const planCount = counts?.planCount ?? 0;
    const summaryCount = counts?.summaryCount ?? 0;
    // #2562: SUMMARY≥PLAN parity is necessary but not sufficient — a phase whose
    // verification verdict is an explicit failing one is still in progress.
    const verificationStatus = counts?.verificationStatus ?? 'missing';
    const summariesMeetPlans = summaryCount >= planCount && planCount > 0;
    const status: 'complete' | 'in_progress' | 'pending' =
      summariesMeetPlans && !FAILING_VERIFICATION_STATUSES.has(verificationStatus)
        ? 'complete'
        : planCount > 0
          ? 'in_progress'
          : 'pending';
    // #2562: only current-milestone phases feed the rollup when scoping is on,
    // and only one directory per phase key (see rollupDirs above).
    const countsTowardMilestone = (!scoped || counts?.inMilestone !== false) && rollupDirs.has(dir);
    if (countsTowardMilestone) {
      totalPlans += planCount;
      completedPlans += Math.min(summaryCount, planCount);
      if (status === 'complete') completedPhases++;
    }
    phases.push({
      directory: dir,
      status,
      plan_count: planCount,
      summary_count: summaryCount,
    });
  }

  // #2562: the denominator is the current milestone's declared phase count when
  // scoping is active (catches phases declared but never scaffolded), else the
  // legacy whole-roadmap heading count.
  const effectivePhaseCount = scoped ? currentMilestonePhaseCount : roadmapPhaseCount;

  // #2562 invariant: the numerator counts de-duplicated in-milestone phase keys
  // and the denominator counts the union of those keys with the roadmap's own
  // declarations, so the numerator can never exceed it. Raising the numerator
  // above the denominator means the two sides were derived in different key
  // spaces — the defect class this issue is about. The old `Math.min(100, …)`
  // capped that away and reported 100%; this makes it fail loudly instead.
  if (scoped && completedPhases > effectivePhaseCount) {
    throw new Error(
      `workstream inventory invariant violated for "${name}": completed_phases (${completedPhases}) ` +
      `exceeds the current-milestone denominator (${effectivePhaseCount}). The completion numerator and ` +
      `denominator were derived in different phase-key spaces.`
    );
  }

  // #1913: derive status from authoritative shipped signals rather than trusting
  // the mutable STATE.md `Status` field. When a shipped signal is present, the
  // workstream is "milestone complete" regardless of a stale field value.
  const fieldStatus = stateProjection.status;
  const useDerived = milestoneShipped;
  const status = useDerived ? 'milestone complete' : fieldStatus;
  const status_source: 'field' | 'derived' = useDerived ? 'derived' : 'field';
  const status_conflict = useDerived && !isCompletedInventory(fieldStatus);

  return {
    name,
    path: toPosixPath(path.relative(projectDir, workstreamDir)),
    active: name === activeWorkstreamName,
    files: {
      roadmap: filesExist.roadmap,
      state: filesExist.state,
      requirements: filesExist.requirements,
    },
    status,
    status_source,
    status_conflict,
    current_phase: stateProjection.current_phase,
    last_activity: stateProjection.last_activity,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    roadmap_phase_count: effectivePhaseCount,
    total_plans: totalPlans,
    completed_plans: completedPlans,
    // The `Math.min` cap is unreachable under milestone scoping (the invariant
    // above throws first) and survives only for the legacy unscoped path, where
    // the denominator is a roadmap heading count that a caller cannot guarantee
    // bounds the numerator.
    progress_percent:
      effectivePhaseCount > 0
        ? Math.min(100, Math.round((completedPhases / effectivePhaseCount) * 100))
        : 0,
  };
}
