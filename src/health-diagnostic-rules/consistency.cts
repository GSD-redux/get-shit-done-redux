/**
 * Health Diagnostic — `validate.consistency`-only rules (Phase 12, #3310,
 * ADR-3180 §8.4).
 *
 * Group: "consistency" — a NEW `C0NN` code namespace, parallel to (not part
 * of) `validate.health`'s `E`/`W`/`I` space Phase 11 minted. These four
 * subjects are `cmdValidateConsistency`'s (`src/verify.cts:1466-1612`)
 * own findings, not `validate.health` findings — see the design doc's
 * "Code namespace" section for why they get their own prefix instead of
 * competing for the next free `W0NN` number.
 *
 * Ported behavior-preserving from `cmdValidateConsistency`
 * (`src/verify.cts:1504-1519` for C001, `:1570-1576` for C002, `:1584-1587`
 * for C003, `:1596-1602` for C004) — relocated, not reinvented. The
 * duplicate subjects `cmdValidateConsistency` also computed (phase-in-
 * roadmap-no-dir / dir-on-disk-not-in-roadmap) are NOT here: those are
 * W006/W007, reused verbatim from
 * `src/health-diagnostic-rules/roadmap-disk-consistency.cts` via
 * `health-diagnostic.cts`'s `CONSISTENCY_RULES` composition, not
 * reimplemented in this file (design doc, "Which rules run where").
 *
 * All four remedies are `ADVISE` — none of these four subjects had a repair
 * path in the pre-migration code either, matching Phase 11's own convention
 * for message-only findings with no automated fix.
 *
 * Design: .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/40-design.md
 * Test matrix: .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic-rules/consistency.cts,
 * compiled to gsd-core/bin/lib/health-diagnostic-rules/consistency.cjs (gitignored).
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
import phaseIdMod = require('../phase-id.cjs');
const { isSentinelPhaseId } = phaseIdMod;

// ─── C001 — gap in disk phase numbering (integer sequence) ────────────────
// (verify.cts:1504-1519)

function checkC001(snapshot: PlanningSnapshot): Diagnostic[] {
  // verify.cts:1505 — `if (config.phase_naming !== 'custom')`; the
  // integer-sequence gap check is skipped entirely under custom phase
  // naming, since a custom naming scheme has no integer sequence to have a
  // gap in.
  if (snapshot.config.value?.['phase_naming'] === 'custom') return [];

  const integerPhases = snapshot.allPhaseDirNames.value
    // #3225: exclude sentinel phase ids (999.x/0.x) — never part of the
    // sequential numbering, mirrors verify.cts:1510 verbatim.
    .filter((p) => !p.includes('.') && !isSentinelPhaseId(p))
    .map((p) => parseInt(p, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const diagnostics: Diagnostic[] = [];
  for (let i = 1; i < integerPhases.length; i++) {
    if (integerPhases[i] !== integerPhases[i - 1] + 1) {
      diagnostics.push({
        code: 'C001',
        severity: SEVERITY.WARNING,
        message: `Gap in phase numbering: ${integerPhases[i - 1]} → ${integerPhases[i]}`,
        remedy: adviseRemedy('Create the missing phase directory or renumber to close the gap'),
      });
    }
  }
  return diagnostics;
}

// ─── C002 — gap in plan numbering within a phase ───────────────────────────
// (verify.cts:1570-1576)

// Fidelity note: the original's `phaseLabel` (verify.cts:1532,
// `posixNormalize(path.relative(planBase, phasePath))`) is a
// `.planning/`-relative posix path, which for the flat `phases/<dir>` case
// this rule scans reduces to the bare directory name (`phaseDir` below) —
// same string, not a narrower one, since `perPhasePlanNumbering` only
// enumerates the flat `phases/` root (see `PlanningSnapshot`'s own doc
// comment on this field for the one disclosed scope reduction, an active
// archived milestone's second phase root, which is out of scope here too).
function checkC002(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const { phaseDir, planNums } of snapshot.perPhasePlanNumbering.value) {
    for (let i = 1; i < planNums.length; i++) {
      if (planNums[i] !== planNums[i - 1] + 1) {
        diagnostics.push({
          code: 'C002',
          severity: SEVERITY.WARNING,
          message: `Gap in plan numbering in ${phaseDir}: plan ${planNums[i - 1]} → ${planNums[i]}`,
          remedy: adviseRemedy('Create the missing plan or renumber to close the gap'),
        });
      }
    }
  }
  return diagnostics;
}

// ─── C003 — orphan SUMMARY with no matching live PLAN ──────────────────────
// (verify.cts:1584-1587)

function checkC003(snapshot: PlanningSnapshot): Diagnostic[] {
  return snapshot.perPhaseOrphanSummaries.value.map(({ phaseDir, orphanSummary }) => ({
    code: 'C003',
    severity: SEVERITY.WARNING,
    message: `Summary ${orphanSummary} in ${phaseDir} has no matching PLAN.md`,
    remedy: adviseRemedy('Create the matching PLAN.md or remove the orphan summary'),
  }));
}

// ─── C004 — PLAN missing `wave` frontmatter ────────────────────────────────
// (verify.cts:1596-1602)

function checkC004(snapshot: PlanningSnapshot): Diagnostic[] {
  return snapshot.perPhaseWaveMissingPlans.value.map(({ phaseDir, plan }) => ({
    code: 'C004',
    severity: SEVERITY.WARNING,
    message: `${phaseDir}/${plan}: missing 'wave' in frontmatter`,
    remedy: adviseRemedy("Add a 'wave' key to the plan's frontmatter"),
  }));
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    code: 'C001',
    severity: SEVERITY.WARNING,
    description: 'Gap in disk phase numbering (integer sequence)',
    repairable: false,
    check: checkC001,
  },
  {
    code: 'C002',
    severity: SEVERITY.WARNING,
    description: 'Gap in plan numbering within a phase',
    repairable: false,
    check: checkC002,
  },
  {
    code: 'C003',
    severity: SEVERITY.WARNING,
    description: 'Orphan SUMMARY with no matching live PLAN',
    repairable: false,
    check: checkC003,
  },
  {
    code: 'C004',
    severity: SEVERITY.WARNING,
    description: "PLAN missing 'wave' in frontmatter",
    repairable: false,
    check: checkC004,
  },
];

export = { RULES };
