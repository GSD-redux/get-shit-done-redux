/**
 * Health Diagnostic — Milestone archive + root hygiene rules (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "Milestone archive + root hygiene" (design doc, "Rule table
 * organization" table) — W018, W019.
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:2301-2354`), the exact call sites for W018/W019.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/milestone-archive-hygiene.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/milestone-archive-hygiene.cjs
 * (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

import { isCanonicalPlanningFile } from '../artifacts.cjs';

// ─── W018 — MILESTONES.md missing archived milestone(s) (verify.cts:2301-2335) ──
//
// Condition: `snapshot.milestoneArchiveStatus.value.archivedVersions` (list of
// versions with a `.planning/milestones/<ver>-ROADMAP.md` snapshot file) minus
// `.documentedVersions` (list of `## <version>` headings already present in
// MILESTONES.md) — versions present in the archive but not documented in the
// registry. ONE aggregate `Diagnostic` listing every missing version, exactly
// mirroring the original's single `addIssue` call
// (`verify.cts:2321-2330`, `` `MILESTONES.md missing ${missingFromRegistry.length}
// archived milestone(s): ${missingFromRegistry.join(', ')}` ``) — the original
// computes the FULL list first (`missingFromRegistry`), then fires exactly one
// `addIssue` after the loop, not once per version. No diagnostic at all if the
// archive dir has zero recognized `-ROADMAP.md` snapshots (mirrors the
// original's `if (archivedVersions.length > 0)` guard) or if nothing is
// missing.

function checkW018(snapshot: PlanningSnapshot): Diagnostic[] {
  const { archivedVersions, documentedVersions } = snapshot.milestoneArchiveStatus.value;
  if (archivedVersions.length === 0) return [];

  const documented = new Set(documentedVersions);
  const missingFromRegistry = archivedVersions.filter((ver) => !documented.has(ver));
  if (missingFromRegistry.length === 0) return [];

  return [
    {
      code: 'W018',
      severity: SEVERITY.WARNING,
      message: `MILESTONES.md missing ${missingFromRegistry.length} archived milestone(s): ${missingFromRegistry.join(', ')}`,
      remedy: {
        action: REMEDY_ACTION.BACKFILL_MILESTONES,
        risk: REMEDY_RISK.NONE,
        args: {},
      },
    },
  ];
}

// ─── W019 — Unrecognized .planning/ root file (verify.cts:2337-2354) ───────
//
// Condition: for each filename in `snapshot.planningRootFiles.value` ending in
// `.md`, call `isCanonicalPlanningFile(filename)` (bare basename, not a path —
// `src/artifacts.cts:43`); flag any that return false. One `Diagnostic` PER
// unrecognized file (array return), mirroring the original's `addIssue` call
// INSIDE the `for` loop (`verify.cts:2343-2349`) — unlike W018 this is not an
// aggregate. Fix text copied verbatim from `verify.cts:2347`.

function checkW019(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const filename of snapshot.planningRootFiles.value) {
    if (!filename.endsWith('.md')) continue;
    if (isCanonicalPlanningFile(filename)) continue;
    diagnostics.push({
      code: 'W019',
      severity: SEVERITY.WARNING,
      message: `Unrecognized .planning/ file: ${filename} — not a canonical GSD artifact`,
      remedy: adviseRemedy(
        'Move to .planning/milestones/ archive subdir or delete if stale. See templates/README.md for the canonical artifact list.',
      ),
    });
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    code: 'W018',
    severity: SEVERITY.WARNING,
    description: 'MILESTONES.md missing entry for archived milestone snapshot',
    repairable: true,
    check: checkW018,
  },
  {
    code: 'W019',
    severity: SEVERITY.WARNING,
    description: 'Unrecognized .planning/ root file — not a canonical GSD artifact',
    repairable: false,
    check: checkW019,
  },
];

export = { RULES };
