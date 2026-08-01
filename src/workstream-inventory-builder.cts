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

/**
 * Which authoritative signal claimed the current milestone is shipped.
 *
 *  - `snapshot` — `milestones/<version>-ROADMAP.md` exists. Written by
 *    `milestone complete`; the strongest signal a tool can produce.
 *  - `heading`  — the LIVE ROADMAP carries a shipped marker for the current
 *    milestone. Operator-typed prose; the weakest signal.
 *  - `legacy`   — the over-broad project-lifetime fallback used only when the
 *    current milestone version cannot be determined (#1913 protection for
 *    malformed/legacy projects).
 *  - `null`     — no shipped signal.
 */
export type MilestoneShippedSignal = 'snapshot' | 'heading' | 'legacy' | null;

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
  milestoneShipped?: boolean;
  /**
   * #2562 review: WHICH shipped signal fired, so the builder can cross-validate
   * it against the milestone's own artifacts at the right strength. The two
   * signals are not interchangeable — see the `shippedContradicted` block below.
   * Supersedes the `milestoneShipped` boolean; a caller passing only the boolean
   * is treated as `'legacy'` (ungated), preserving pre-review behavior.
   */
  milestoneShippedSignal?: MilestoneShippedSignal;
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
  /**
   * #2562: whether milestone scoping is active, stated by the caller rather than
   * inferred from `currentMilestonePhaseCount > 0`. The two are not equivalent:
   * a current milestone that is declared but not yet populated is scoped AND has
   * zero phases, and inferring from the count alone reads it as "unscoped" —
   * which silently falls back to counting the project's entire phase history as
   * the current milestone's, reporting 100% for a milestone with no work done.
   * Defaults to the count-derived value so pre-#2562 callers are unaffected.
   */
  milestoneScoped?: boolean;
}

export interface WorkstreamInventory {
  name: string;
  path: string;
  active: boolean;
  files: WorkstreamFilesExist;
  status: string;
  /**
   * Whether `status` was derived ("derived") or taken verbatim from the STATE.md
   * field ("field"). `"derived"` covers TWO cases and does NOT imply
   * `status === 'milestone complete'`: a shipped signal fired and was accepted,
   * OR a shipped signal was refused by the artifacts and the STATE field claimed
   * completion anyway, so `status` was derived DOWN to `'in_progress'`. Check
   * `milestone_shipped_unverified` to tell them apart.
   */
  status_source: 'field' | 'derived';
  /** True when the derived status disagrees with the STATE.md `Status` field (the field is stale). */
  status_conflict: boolean;
  /**
   * #2562 review: a shipped signal fired for the current milestone but the
   * milestone's own artifacts contradict it, so the claim was NOT trusted.
   * Distinct from `status_conflict`, which reports the derived-vs-STATE-field
   * disagreement. Without this the rejection would be silent: `status` falls
   * back to the field and no output says a shipped marker was seen and refused.
   */
  milestone_shipped_unverified: boolean;
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
    milestoneShippedSignal,
    currentMilestonePhaseCount = 0,
    milestoneScoped,
  } = inputs;

  // A caller that passes only the legacy boolean states THAT a signal fired but
  // not which one. Treat it as `legacy` — the ungated strength — so pre-review
  // callers keep their exact behavior rather than silently acquiring a new gate.
  const shippedSignal: MilestoneShippedSignal =
    milestoneShippedSignal !== undefined ? milestoneShippedSignal : (milestoneShipped ? 'legacy' : null);
  const milestoneShippedResolved = shippedSignal !== null;

  // #2562: when scoping is active, prior-milestone phase directories are
  // excluded from the completion rollup and the denominator. The caller states
  // this; the count-derived default is the pre-#2562 fallback for callers that
  // do not, and cannot represent a scoped-but-empty current milestone.
  const scoped = milestoneScoped ?? currentMilestonePhaseCount > 0;

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
  // #2562 review: in-milestone phase directories still present under `phases/`,
  // whatever their status. A CLEAN archive has none — `milestone complete` moves
  // them all out — so this counts exactly the phases that outlived the archive,
  // which is what distinguishes "archived" from "archived, then reopened".
  // Deliberately NOT "…and unfinished": a complete live dir beside a declared
  // but never-scaffolded phase is a dirty archive too, and the dirless phase has
  // no directory to inspect.
  let liveInMilestonePhases = 0;

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
      liveInMilestonePhases++;
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
  //
  // #2562 review: a shipped signal is a CLAIM, and a claim its own milestone's
  // artifacts contradict must not be echoed as fact — the defect class this issue
  // is about reaches `status`, not just `progress_percent`. The two signals need
  // DIFFERENT cross-checks; one check for both regresses the commonest shape:
  //
  //  - `heading` — operator-typed marker in the LIVE roadmap. Nothing has been
  //    archived, so every phase the milestone declares should be on disk and
  //    complete. Gate on the full ratio, which also catches the
  //    declared-but-never-scaffolded phases that have no directory to inspect.
  //  - `snapshot` — `milestones/<version>-ROADMAP.md`. The `milestone complete`
  //    run that writes it also MOVES the milestone's phase directories into
  //    `milestones/<version>-phases/` (milestone.cts:783-790) while COPYING —
  //    never truncating — the live ROADMAP (:700-702), so its Progress rows
  //    survive. A CLEAN archive therefore reads 0/N by construction, and gating
  //    it on the ratio alone would strip `milestone complete` from every
  //    archived milestone. But a live in-milestone directory means the archive
  //    is NOT clean — a phase was added or reopened after it, reachable because
  //    `milestone complete` does not advance STATE's `milestone:` field
  //    (state-transition.cts:83, :1335); only `/gsd-new-milestone` does (:1224).
  //    Once any in-milestone directory is live the ratio IS meaningful again, so
  //    the check is the conjunction. Requiring the live directory to itself be
  //    unfinished was too narrow: it let a complete live dir alongside a
  //    declared-but-unscaffolded phase reproduce the reported symptom, since a
  //    dirless phase has nothing to inspect.
  //
  // The whole cross-check is scoped-only, and NOT because of the signal: when
  // scoping is off, `effectivePhaseCount` is the whole-roadmap count and
  // membership is everything, so there is no current-milestone artifact set to
  // check a current-milestone claim against. `legacy` is additionally ungated by
  // signal — it is the fallback for an unknown milestone version, which is
  // exactly when scoping cannot engage either.
  const fieldStatus = stateProjection.status;
  const shippedContradicted = scoped && (
    shippedSignal === 'heading'
      ? completedPhases < effectivePhaseCount
      : shippedSignal === 'snapshot'
        ? liveInMilestonePhases > 0 && completedPhases < effectivePhaseCount
        : false
  );
  const useDerived = milestoneShippedResolved && !shippedContradicted;
  // Refusing the claim does not make the STATE field a safe fallback: it is
  // operator-written and in this window it commonly ALSO reads "milestone
  // complete", which would re-report the refused claim through the other door.
  // Against contradicting artifacts, NEITHER source may assert completion.
  const artifactOverride = shippedContradicted && isCompletedInventory(fieldStatus);
  const status = useDerived
    ? 'milestone complete'
    : artifactOverride
      ? 'in_progress'
      : fieldStatus;
  const status_source: 'field' | 'derived' = useDerived || artifactOverride ? 'derived' : 'field';
  const status_conflict = (useDerived && !isCompletedInventory(fieldStatus)) || artifactOverride;

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
    milestone_shipped_unverified: shippedContradicted,
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
