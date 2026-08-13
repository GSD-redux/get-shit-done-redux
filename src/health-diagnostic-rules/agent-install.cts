/**
 * Agent Install rule (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * One code, W010, ported behavior-preserving from `cmdValidateHealth`'s
 * agent-install block (`src/verify.cts:1992-2027`). That block wraps a
 * single `checkAgentsInstalled(_slashRuntime, cwd)` call in a try/catch that
 * swallows any thrown exception silently ("agent check is non-blocking",
 * `verify.cts:2025-2027`) and then branches on the SAME subject —
 * "agent installation is incomplete" — across four mutually exclusive
 * combinations of `missing_agents`/`incomplete_agents`, firing at most one
 * `addIssue('warning', 'W010', ...)` per call. Per this phase's design doc
 * ("Rejected alternatives" §3), these four sites are confirmed to be one
 * subject varying only in trigger detail, not four subjects — W010 stays a
 * single code.
 *
 * `snapshot.agentInstall` (`src/planning-snapshot.cts`'s `buildAgentInstallField`)
 * already performs the try/catch this rule used to need: `scope` is
 * `UNREADABLE` only when the scan itself threw, mirroring
 * `cmdValidateHealth`'s silent catch — this rule reproduces that silence by
 * returning no diagnostic for `UNREADABLE`, rather than inventing a new,
 * more severe 5th case the original never had.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *         ("Rule table organization" — Agent installation group)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- health-diagnostic-types.cjs is an export= CommonJS module
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Rule = healthDiagnosticMod.Rule;
type Diagnostic = healthDiagnosticMod.Diagnostic;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');
type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

import { PACKAGE_NAME } from '../package-identity.cjs';

/**
 * `check(snapshot)` for W010 — see module header for the exact 4-way
 * branching this ports from `verify.cts:1992-2027`, and its message/fix
 * templates copied verbatim (only the interpolated `agentStatus.*` values
 * differ per call).
 */
function checkAgentInstall(snapshot: PlanningSnapshot): Diagnostic[] {
  const { value: status, scope } = snapshot.agentInstall;

  // Mirrors verify.cts:2025-2027's try/catch around the checkAgentsInstalled
  // call itself — a thrown scan is swallowed, not reported. `scope` here is
  // UNREADABLE only in that same case (buildAgentInstallField's own catch).
  if (scope === SCOPE.UNREADABLE) return [];

  if (status.agents_installed) return [];

  // verify.cts:1995 — zero agents installed at all.
  if (status.installed_agents.length === 0) {
    return [
      {
        code: 'W010',
        severity: SEVERITY.WARNING,
        message: `No GSD agents found in ${status.agents_dir} — Task(subagent_type="gsd-*") will fall back to general-purpose`,
        remedy: adviseRemedy(`Run the GSD installer: npx ${PACKAGE_NAME}@latest`),
      },
    ];
  }

  // verify.cts:2002 — some agents incomplete (missing a generated file), zero fully missing.
  if (status.incomplete_agents.length > 0 && status.missing_agents.length === 0) {
    return [
      {
        code: 'W010',
        severity: SEVERITY.WARNING,
        message: `Incomplete agent installs (missing generated file): ${status.incomplete_agents.join(', ')} — affected workflows may fall back to general-purpose`,
        remedy: adviseRemedy(`Re-run the GSD installer to complete the install: npx ${PACKAGE_NAME}@latest`),
      },
    ];
  }

  // verify.cts:2009 — both missing AND incomplete agents present.
  if (status.incomplete_agents.length > 0) {
    return [
      {
        code: 'W010',
        severity: SEVERITY.WARNING,
        message: `Missing ${status.missing_agents.length} GSD agents: ${status.missing_agents.join(', ')}; incomplete agent installs (missing generated file): ${status.incomplete_agents.join(', ')} — affected workflows will fall back to general-purpose`,
        remedy: adviseRemedy(`Run the GSD installer: npx ${PACKAGE_NAME}@latest`),
      },
    ];
  }

  // verify.cts:2017 — agents missing only (no incomplete).
  return [
    {
      code: 'W010',
      severity: SEVERITY.WARNING,
      message: `Missing ${status.missing_agents.length} GSD agents: ${status.missing_agents.join(', ')} — affected workflows will fall back to general-purpose`,
      remedy: adviseRemedy(`Run the GSD installer: npx ${PACKAGE_NAME}@latest`),
    },
  ];
}

const RULES: Rule[] = [
  {
    code: 'W010',
    severity: SEVERITY.WARNING,
    description: 'GSD agent installation missing or incomplete',
    repairable: false,
    check: checkAgentInstall,
  },
];

export = { RULES };
