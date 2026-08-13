/**
 * Health Diagnostic — Root existence + PROJECT.md rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "Root existence + PROJECT.md" (design doc, "Rule table organization"
 * table) — E002, E003, E004, W001. E001 (the `.planning/` root missing guard)
 * stays OUTSIDE the rule table entirely per the design doc's "Two guards that
 * stay OUTSIDE the rule table entirely" section — it is not a row here.
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:1681-1705`), the exact call sites for E002/E003/E004/W001.
 *
 * E002's original message interpolates `${slash('new-project')}`
 * (`verify.cts:1682`, ``Run ${slash('new-project')} to create``) and E003's
 * interpolates `${slash('new-milestone')}` (`verify.cts:1694`, ``Run
 * ${slash('new-milestone')} to create roadmap``) — both per-project
 * runtime-resolved values (`formatGsdSlash`, `src/runtime-slash.cts`) this
 * rule's `(snapshot) => Diagnostic[]` signature has no access to (§8.1 rule
 * 1 forbids ambient I/O, including `cwd`, inside `check`). Hardcodes the
 * canonical `/gsd-new-project`/`/gsd-new-milestone` hyphen form instead,
 * mirroring the sibling "config.json validation" group's W016 rule
 * (`src/health-diagnostic-rules/config-validation.cts`), which hardcodes
 * `/gsd-ai-integration-phase` the same way for the identical reason.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic-rules/root-existence.cts,
 * compiled to gsd-core/bin/lib/health-diagnostic-rules/root-existence.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// ─── E002 — PROJECT.md not found (verify.cts:1682) ─────────────────────────

function checkE002(snapshot: PlanningSnapshot): Diagnostic[] {
  if (snapshot.projectSections.exists) return [];
  return [
    {
      code: 'E002',
      severity: SEVERITY.ERROR,
      message: 'PROJECT.md not found',
      remedy: adviseRemedy('/gsd-new-project'),
    },
  ];
}

// ─── E003 — ROADMAP.md not found (verify.cts:1694) ─────────────────────────
//
// Condition uses `snapshot.milestone.scope === SCOPE.UNREADABLE`
// (`getMilestoneInfo`, `src/roadmap-parser.cts`). KNOWN AMBIGUITY (flagged in
// this batch's report, not silently papered over): `getMilestoneInfo` returns
// `SCOPE.UNREADABLE` for TWO distinct causes it does not otherwise
// distinguish — (1) ROADMAP.md absent (`platformReadSync` returns `null` ->
// synthetic `Error('missing')`, no errno, `reportUnreadableRoadmap` finds no
// `.code` and stays silent) and (2) ROADMAP.md present but unreadable (a real
// read fault, e.g. EACCES/EISDIR, which DOES carry an errno and fires
// `warnUnusableInput(ROADMAP_UNREADABLE)`). Unlike `config`/`projectSections`,
// `milestone` carries no `exists` discriminator, so this rule cannot tell the
// two apart from the snapshot alone without adding cwd/fs access to `check`
// (forbidden by §8.1 rule 1). This is a best-effort port of the pre-migration
// condition (`!fs.existsSync(roadmapPath)`), which itself only asked "does
// the file exist" — this rule now also fires (message-mismatched, but
// error-preserving) on a present-but-corrupt ROADMAP.md.

function checkE003(snapshot: PlanningSnapshot): Diagnostic[] {
  if (snapshot.milestone.scope !== SCOPE.UNREADABLE) return [];
  return [
    {
      code: 'E003',
      severity: SEVERITY.ERROR,
      message: 'ROADMAP.md not found',
      remedy: adviseRemedy('/gsd-new-milestone'),
    },
  ];
}

// ─── E004 — STATE.md not found (verify.cts:1697) ───────────────────────────
//
// Condition uses `snapshot.currentPhaseLabel.scope === SCOPE.UNREADABLE`
// (`buildStateFields`, `src/planning-snapshot.cts:210-249`). KNOWN GAP
// (flagged in this batch's report): `buildStateFields` collapses TWO distinct
// causes into the same `UNREADABLE` scope with no discriminator field at
// all — STATE.md absent (`platformReadSync` returns `null`, a real
// non-answer, `warnUnusableInput` NOT called) and STATE.md present but
// unreadable (any other read error, e.g. EISDIR, corruption,
// `warnUnusableInput(STATE_UNREADABLE)` fires). Unlike `config`, there is no
// `exists` flag on `currentPhaseLabel` (or on `PlanningSnapshot` generally)
// to distinguish "STATE.md was never created" from "STATE.md exists but
// could not be read" — this is a REAL gap in the current 15-field
// `PlanningSnapshot` shape, not something this rule can work around without
// extending that snapshot (out of this batch's scope per the brief). This
// rule is therefore a best-effort port: it fires E004 ("STATE.md not found")
// for both causes, exactly mirroring what `snapshot.currentPhaseLabel.scope`
// can express today.
//
// Remedy is `regenerateState`, one of the two DESTRUCTIVE-risk actions (loses
// session history, design doc "Risk assignment" section) — per §8.3 rule 3
// `--repair` will refuse to auto-apply it once `applyRepairs`'s dispatch
// wires this rule in; the remedy is still described (ADVISE-shaped for
// display, per `applyRepairs`'s own contract) but never executed.

function checkE004(snapshot: PlanningSnapshot): Diagnostic[] {
  if (snapshot.currentPhaseLabel.scope !== SCOPE.UNREADABLE) return [];
  return [
    {
      code: 'E004',
      severity: SEVERITY.ERROR,
      message: 'STATE.md not found',
      remedy: {
        action: REMEDY_ACTION.REGENERATE_STATE,
        risk: REMEDY_RISK.DESTRUCTIVE,
        args: {},
      },
    },
  ];
}

// ─── W001 — PROJECT.md missing a required section (verify.cts:1684-1690) ──
//
// `REQUIRED_SECTIONS` carries the exact `## `-prefixed strings
// `verify.cts:1685` uses in its message text; membership is tested against
// `snapshot.projectSections.value`, which `buildProjectSectionsField`
// (`src/planning-snapshot.cts:367-381`) stores WITHOUT the `##` prefix (its
// `/^##\s+(.+)$/gm` capture group), so each required string's own `## `
// prefix is stripped before the membership check. `projectSections.value ===
// null` (PROJECT.md absent OR unreadable) emits zero diagnostics — E002
// already reports absence; this rule does not double-report it.

const REQUIRED_SECTIONS = ['## What This Is', '## Core Value', '## Requirements'];

function checkW001(snapshot: PlanningSnapshot): Diagnostic[] {
  const { value } = snapshot.projectSections;
  if (value === null) return [];

  const diagnostics: Diagnostic[] = [];
  for (const required of REQUIRED_SECTIONS) {
    const heading = required.replace(/^##\s+/, '');
    if (!value.includes(heading)) {
      diagnostics.push({
        code: 'W001',
        severity: SEVERITY.WARNING,
        message: `PROJECT.md missing section: ${required}`,
        remedy: adviseRemedy('Add section manually'),
      });
    }
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { code: 'E002', severity: SEVERITY.ERROR, description: 'PROJECT.md not found', repairable: false, check: checkE002 },
  { code: 'E003', severity: SEVERITY.ERROR, description: 'ROADMAP.md not found', repairable: false, check: checkE003 },
  { code: 'E004', severity: SEVERITY.ERROR, description: 'STATE.md not found', repairable: false, check: checkE004 },
  {
    code: 'W001',
    severity: SEVERITY.WARNING,
    description: 'PROJECT.md missing required section',
    repairable: false,
    check: checkW001,
  },
];

export = { RULES };
