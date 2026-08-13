/**
 * Health Diagnostic — Phase directory structure rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "Phase directory structure" (design doc, "Rule table organization"
 * table) — W005, W023, I001, W009.
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:1893-1990`, the exact call sites for W005/W023/I001/W009),
 * with two disclosed fidelity reductions forced by `PlanningSnapshot`'s
 * current shape (see each rule's own comment below):
 *
 * - I001 cannot name the individual unsummarized PLAN filename (`snapshot.
 *   phases.value[i]` exposes only `planCount`/`summaryCount`, not per-plan
 *   filenames) — this rule reports a coarser per-PHASE message instead.
 * - W023's original "described" list called `determinePhaseStatus`
 *   (`commands.cts:154`), a SIX-way status string ('Not Started'/'Planned'/
 *   'In Progress'/'Executed'/'Needs Review'/'Complete') computed from its own
 *   raw `readdirSync` + `*-VERIFICATION.md` frontmatter read of `phaseDir`.
 *   This rule cannot re-run that raw read (§8.1 rule 1 forbids ambient I/O in
 *   `check`), so `derivePhaseStatusLabel` below reconstructs the same
 *   six-way label from fields `PlanningSnapshot` already exposes —
 *   `PhaseSnapshot.planCount`/`summaryCount` (the plan/no-plan and
 *   in-progress/planned branches, identical inputs to the original) and
 *   `PhaseSnapshot.complete`/`verificationStatus` (`isPhaseComplete`'s own
 *   §7.4 disk-strict routing of the SAME `*-VERIFICATION.md` file) for the
 *   verification-gated branches. This is a disclosed fidelity reduction, not
 *   a byte-for-byte guarantee: `verificationStatus` is the DIFFERENT,
 *   `readVerificationStatus`-routed vocabulary ('passed'/'gaps_found'/
 *   'human_needed'/'stale'/'unknown'/'missing') and can disagree with a raw
 *   frontmatter re-read in edge cases (e.g. a stale-but-frontmatter-"passed"
 *   VERIFICATION.md routes to 'stale', not 'passed', under §7.4's staleness
 *   handling — this rule reports 'Executed' there, not 'Complete'). No new
 *   ambient I/O and no new `PlanningSnapshot` field were needed — every input
 *   was already on `PhaseSnapshot`.
 *
 * W009's original message interpolates `${slash('plan-phase')}`
 * (`verify.cts:1982`, ``Re-run ${slash('plan-phase')} with --research to
 * regenerate``), a per-project runtime-resolved value (`formatGsdSlash`,
 * `src/runtime-slash.cts`) this rule's `(snapshot) => Diagnostic[]`
 * signature has no access to. Hardcodes the canonical `/gsd-plan-phase`
 * hyphen form instead, mirroring the sibling "config.json validation"
 * group's W016 rule (`src/health-diagnostic-rules/config-validation.cts`),
 * which hardcodes `/gsd-ai-integration-phase` the same way for the
 * identical reason.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/phase-structure.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import validateMod = require('../validate.cjs');
// #612: `isPhaseDirName` is the convention-SELECTED shape test wrapping
// `phaseDirNameRe`. Handed no convention it delegates to that very regex, so a
// legacy repo's W005 reading is byte-identical; handed 'bracket' it also
// recognizes `{CODE}.{MM}-{PP}-slug`, which `phaseDirNameRe` rejects outright —
// left un-threaded, W005 fires on EVERY phase directory of a repo that opted
// into the convention, i.e. the check inverts on exactly the repos PR-2 widens.
const { isPhaseDirName } = validateMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('../phase-id.cjs');
const { extractPhaseToken, normalizePhaseName, comparePhaseNum } = phaseIdMod;

// ─── W005 — phase directory doesn't follow NN-name format (verify.cts:1893-1902) ─

function checkW005(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const name of snapshot.phaseDirs.value) {
    if (!isPhaseDirName(name, snapshot.phaseIdConvention)) {
      diagnostics.push({
        code: 'W005',
        severity: SEVERITY.WARNING,
        message: `Phase directory "${name}" doesn't follow NN-name format`,
        remedy: adviseRemedy('Rename to match pattern (e.g., 01-setup)'),
      });
    }
  }
  return diagnostics;
}

// ─── W023 — phase directories collide on normalized key (verify.cts:1904-1950) ─
//
// Groups `snapshot.phaseDirs.value` by `normalizePhaseName(extractPhaseToken(name))`
// — the exact same two owners (`phase-id.cjs`) the original `verify.cts:1917-1918`
// call site uses, relocated verbatim rather than reimplemented. Sorted with
// `comparePhaseNum` + a `localeCompare` tiebreak, mirroring
// `verify.cts:1930-1932`'s deterministic-output rationale. See the file-level
// comment for the disclosed "described" fidelity reduction.

/**
 * Reconstruct `commands.cts:154`'s `determinePhaseStatus` six-way label from
 * fields `PhaseSnapshot` already exposes (no ambient I/O, no new snapshot
 * field — see file-level comment). `complete`/`verificationStatus` come from
 * `isPhaseComplete`'s §7.4 disk-strict routing of the same `*-VERIFICATION.md`
 * file the original raw read targeted.
 */
function derivePhaseStatusLabel(
  planCount: number,
  summaryCount: number,
  complete: boolean,
  verificationStatus: string,
): string {
  if (planCount === 0) return 'Not Started';
  if (summaryCount < planCount && summaryCount > 0) return 'In Progress';
  if (summaryCount < planCount) return 'Planned';
  // summaryCount >= planCount > 0 — verification-gated, same as the original's
  // post-count fall-through.
  if (complete) return 'Complete';
  if (verificationStatus === 'human_needed') return 'Needs Review';
  // gaps_found / stale / missing / unknown all land here, same as the
  // original's "verification exists but unrecognized" and "no verification
  // file" branches both returning 'Executed'.
  return 'Executed';
}

function checkW023(snapshot: PlanningSnapshot): Diagnostic[] {
  const groups = new Map<string, string[]>();
  for (const name of snapshot.phaseDirs.value) {
    const token = extractPhaseToken(name);
    const key = normalizePhaseName(token);
    const list = groups.get(key);
    if (list) list.push(name);
    else groups.set(key, [name]);
  }

  const phaseByDir = new Map(snapshot.phases.value.map((p) => [p.dir, p]));

  const diagnostics: Diagnostic[] = [];
  for (const [key, dirs] of groups) {
    if (dirs.length < 2) continue;
    const described = dirs
      .slice()
      .sort((a, b) => comparePhaseNum(a, b) || String(a).localeCompare(String(b)))
      .map((d) => {
        const phase = phaseByDir.get(d);
        const plans = phase ? phase.planCount : 0;
        const summaries = phase ? phase.summaryCount : 0;
        const complete = phase ? phase.complete : false;
        const verificationStatus = phase ? phase.verificationStatus : 'missing';
        const status = derivePhaseStatusLabel(plans, summaries, complete, verificationStatus);
        return `${d} (${status})`;
      })
      .join(', ');
    diagnostics.push({
      code: 'W023',
      severity: SEVERITY.WARNING,
      message: `Phase directories collide on normalized key "${key}": ${described}`,
      remedy: adviseRemedy(
        'Inspect each directory; rename or remove the duplicate so only one directory maps to this phase key',
      ),
    });
  }
  return diagnostics;
}

// ─── I001 — plan(s) without a matching SUMMARY.md (verify.cts:1952-1965) ───
//
// GENUINE FIDELITY GAP (see file-level comment): the original is PER-PLAN
// (`${e.name}/${plan} has no SUMMARY.md`, `plan` an individual PLAN.md
// filename from `findUnsummarizedPlans`). `PlanningSnapshot`'s
// `phases.value[i]` carries only `planCount`/`summaryCount` NUMBERS per
// phase — no per-plan filenames — so this rule cannot name which plan lacks
// a summary without reading the phase directory directly inside `check`
// (forbidden by §8.1 rule 1). This rule instead reports one coarser
// per-PHASE diagnostic naming the deficit count, not the individual
// filename(s).

function checkI001(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const phase of snapshot.phases.value) {
    const deficit = phase.planCount - phase.summaryCount;
    if (deficit > 0) {
      diagnostics.push({
        code: 'I001',
        severity: SEVERITY.INFO,
        message: `Phase ${phase.dir} has ${deficit} plan(s) without a matching summary`,
        remedy: adviseRemedy('May be in progress'),
      });
    }
  }
  return diagnostics;
}

// ─── W009 — Validation Architecture in RESEARCH.md but no VALIDATION.md ────
// (verify.cts:1967-1990)

function checkW009(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const entry of snapshot.researchValidationStatus.value) {
    if (entry.hasValidationArchitecture && !entry.hasValidationMd) {
      diagnostics.push({
        code: 'W009',
        severity: SEVERITY.WARNING,
        message: `Phase ${entry.dir}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
        remedy: adviseRemedy('Re-run /gsd-plan-phase with --research to regenerate'),
      });
    }
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    code: 'W005',
    severity: SEVERITY.WARNING,
    description: 'Phase directory naming mismatch',
    repairable: false,
    check: checkW005,
  },
  {
    code: 'W023',
    severity: SEVERITY.WARNING,
    description: 'Phase directories collide on normalized key',
    repairable: false,
    check: checkW023,
  },
  {
    code: 'I001',
    severity: SEVERITY.INFO,
    description: 'Plan without SUMMARY (may be in progress)',
    repairable: false,
    check: checkI001,
  },
  {
    code: 'W009',
    severity: SEVERITY.WARNING,
    description: 'Phase has Validation Architecture in RESEARCH.md but no VALIDATION.md',
    repairable: false,
    check: checkW009,
  },
];

export = { RULES };
