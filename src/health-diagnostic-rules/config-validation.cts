/**
 * Health Diagnostic — config.json validation rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "config.json validation" (design doc, "Rule table organization"
 * table) — W003, W004, W022 (one rule, three internal conditions), E005,
 * W008, W016, W012, W013, W014, W015.
 *
 * Ported behavior-preserving from `cmdValidateHealth`'s config.json blocks
 * (`src/verify.cts:1777-1835` for W003/W004/W022/E005,
 * `src/verify.cts:1837-1865` for W008/W016,
 * `src/verify.cts:2136-2191` for W012/W013/W014/W015). Every rule here reads
 * ONLY `snapshot.config` (`{value, scope, exists}`, `src/planning-snapshot.cts`'s
 * `buildConfigField`).
 *
 * W022 stays a SINGLE code across its three call sites per the design doc's
 * "Rejected alternatives" §3: all three are variations on one question ("is
 * `models` well-formed"), not a genuine multi-subject conflation. This rule's
 * `checkW022` mirrors the original's exact if / else-if control flow
 * (`verify.cts:1799-1824`): the object-shaped branch loops every `models`
 * entry (0-N diagnostics, one per malformed entry); the non-object branch
 * fires independently and ONLY when the object-shaped branch did not run —
 * `models` is never checked against both.
 *
 * Two disclosed fidelity reductions, forced by `snapshot.config`'s shape
 * (neither is available without violating §8.1 rule 1's "no ambient I/O in a
 * rule's `check`"):
 *
 * - E005's original message interpolates the live `JSON.parse` error text
 *   (`config.json: JSON parse error - ${err.message}`, `verify.cts:1829`).
 *   `buildConfigField` (`src/planning-snapshot.cts:268-281`) catches and
 *   discards that error, collapsing an unparseable config.json to
 *   `{value: null, scope: UNREADABLE, exists: true}` with no error text
 *   anywhere in the snapshot. This rule's message drops the interpolated
 *   suffix rather than fabricate error text the snapshot never carried.
 * - W016's original message interpolates `${slash('ai-integration-phase')}`
 *   (`verify.cts:1856`), a per-project runtime-resolved value
 *   (`formatGsdSlash`, `src/runtime-slash.cts`) this rule's `(snapshot) =>
 *   Diagnostic[]` signature has no access to. Hardcodes the canonical
 *   `/gsd-ai-integration-phase` hyphen form instead, mirroring the sibling
 *   "Phase directory structure" group's W009 rule
 *   (`src/health-diagnostic-rules/phase-structure.cts`), which hardcodes
 *   `/gsd-plan-phase` the same way for the identical reason.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/config-validation.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/config-validation.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- health-diagnostic-types.cjs is an export= CommonJS module
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

import { VALID_PROFILES, VALID_TIERS, VALID_PHASE_TYPES } from '../model-catalog.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// verify.cts:2141 — inlined literal, not exported from anywhere; same list.
const VALID_BRANCHING_STRATEGIES = ['none', 'phase', 'milestone'];

// ─── W003 — config.json not found (verify.cts:1777-1785) ───────────────────

function checkW003(snapshot: PlanningSnapshot): Diagnostic[] {
  if (snapshot.config.exists) return [];
  return [
    {
      code: 'W003',
      severity: SEVERITY.WARNING,
      message: 'config.json not found',
      remedy: { action: REMEDY_ACTION.CREATE_CONFIG, risk: REMEDY_RISK.NONE, args: {} },
    },
  ];
}

// ─── E005 — config.json JSON parse error (verify.cts:1825-1834) ────────────
//
// `exists: true, value: null` is exactly `buildConfigField`'s "present but
// unparseable" contract (planning-snapshot.cts:268-281) — the same
// discriminator that separates this from W003's "absent" case.

function checkE005(snapshot: PlanningSnapshot): Diagnostic[] {
  if (!snapshot.config.exists || snapshot.config.value !== null) return [];
  return [
    {
      code: 'E005',
      severity: SEVERITY.ERROR,
      message: 'config.json: JSON parse error',
      remedy: { action: REMEDY_ACTION.RESET_CONFIG, risk: REMEDY_RISK.DESTRUCTIVE, args: {} },
    },
  ];
}

// ─── W004 — invalid model_profile (verify.cts:1790-1797) ───────────────────

function checkW004(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const profile = value['model_profile'];
  if (profile && !VALID_PROFILES.includes(profile as string)) {
    return [
      {
        code: 'W004',
        severity: SEVERITY.WARNING,
        message: `config.json: invalid model_profile "${profile as string}"`,
        remedy: adviseRemedy(`Valid values: ${VALID_PROFILES.join(', ')}`),
      },
    ];
  }
  return [];
}

// ─── W008 — workflow.nyquist_validation absent (verify.cts:1841-1851) ──────

function checkW008(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  const workflow = value ? (value['workflow'] as Record<string, unknown> | undefined) : undefined;
  if (workflow && workflow['nyquist_validation'] === undefined) {
    return [
      {
        code: 'W008',
        severity: SEVERITY.WARNING,
        message: 'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
        remedy: { action: REMEDY_ACTION.ADD_NYQUIST_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ];
  }
  return [];
}

// ─── W016 — workflow.ai_integration_phase absent (verify.cts:1852-1861) ────

function checkW016(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  const workflow = value ? (value['workflow'] as Record<string, unknown> | undefined) : undefined;
  if (workflow && workflow['ai_integration_phase'] === undefined) {
    return [
      {
        code: 'W016',
        severity: SEVERITY.WARNING,
        message:
          'config.json: workflow.ai_integration_phase absent (defaults to enabled — run /gsd-ai-integration-phase before planning AI system phases)',
        remedy: { action: REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ];
  }
  return [];
}

// ─── W012 — invalid branching_strategy (verify.cts:2141-2152) ──────────────

function checkW012(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const strategy = value['branching_strategy'];
  if (strategy && !VALID_BRANCHING_STRATEGIES.includes(strategy as string)) {
    return [
      {
        code: 'W012',
        severity: SEVERITY.WARNING,
        message: `config.json: invalid branching_strategy "${strategy as string}"`,
        remedy: adviseRemedy(`Valid values: ${VALID_BRANCHING_STRATEGIES.join(', ')}`),
      },
    ];
  }
  return [];
}

// ─── W013 — context_window not a positive integer (verify.cts:2154-2164) ───

function checkW013(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const cw = value['context_window'];
  if (cw !== undefined && (typeof cw !== 'number' || cw <= 0 || !Number.isInteger(cw))) {
    return [
      {
        code: 'W013',
        severity: SEVERITY.WARNING,
        message: `config.json: context_window should be a positive integer, got "${cw as string}"`,
        remedy: adviseRemedy('Set to 200000 (default) or 1000000 (for 1M models)'),
      },
    ];
  }
  return [];
}

// ─── W014 — phase_branch_template missing {phase} (verify.cts:2166-2176) ───

function checkW014(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const tmpl = value['phase_branch_template'];
  if (tmpl && !(tmpl as string).includes('{phase}')) {
    return [
      {
        code: 'W014',
        severity: SEVERITY.WARNING,
        message: 'config.json: phase_branch_template missing {phase} placeholder',
        remedy: adviseRemedy('Template must include {phase} for phase number substitution'),
      },
    ];
  }
  return [];
}

// ─── W015 — milestone_branch_template missing {milestone} (verify.cts:2177-2187) ─

function checkW015(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const tmpl = value['milestone_branch_template'];
  if (tmpl && !(tmpl as string).includes('{milestone}')) {
    return [
      {
        code: 'W015',
        severity: SEVERITY.WARNING,
        message: 'config.json: milestone_branch_template missing {milestone} placeholder',
        remedy: adviseRemedy('Template must include {milestone} for version substitution'),
      },
    ];
  }
  return [];
}

// ─── W022 — models malformed, 3 internal conditions (verify.cts:1798-1824) ─
//
// Mirrors the original if / else-if chain exactly: the object-shaped branch
// (a: unknown phase type, b: invalid tier value) loops every `models` entry,
// pushing 0-N diagnostics; the non-object branch (c) is an ELSE-IF, so it
// only runs when `models` is truthy but did NOT satisfy "object, not array" —
// (a)/(b) are never evaluated against a non-object `models`.

function checkW022(snapshot: PlanningSnapshot): Diagnostic[] {
  const value = snapshot.config.value;
  if (!value) return [];
  const diagnostics: Diagnostic[] = [];
  const configModels = value['models'];

  if (configModels && typeof configModels === 'object' && !Array.isArray(configModels)) {
    for (const [phaseType, tierValue] of Object.entries(configModels as Record<string, unknown>)) {
      if (!VALID_PHASE_TYPES.has(phaseType)) {
        diagnostics.push({
          code: 'W022',
          severity: SEVERITY.WARNING,
          message: `config.json: models has an unknown phase type "${phaseType}" which will be ignored`,
          remedy: adviseRemedy(`Valid phase types: ${[...VALID_PHASE_TYPES].join(', ')}`),
        });
      } else if (typeof tierValue !== 'string' || !VALID_TIERS.has(tierValue)) {
        diagnostics.push({
          code: 'W022',
          severity: SEVERITY.WARNING,
          message: `config.json: models.${phaseType} has an invalid tier value ${JSON.stringify(tierValue)} which will be ignored`,
          remedy: adviseRemedy(`Valid tiers: ${[...VALID_TIERS].join(', ')}`),
        });
      }
    }
  } else if (configModels !== undefined && configModels !== null) {
    diagnostics.push({
      code: 'W022',
      severity: SEVERITY.WARNING,
      message: `config.json: models is set to ${JSON.stringify(configModels)}, but must be an object mapping phase types to tiers — this value will be ignored`,
      remedy: adviseRemedy('Set models to an object like {"planning": "sonnet"}, or remove the key to use profile defaults'),
    });
  }

  return diagnostics;
}

// ─── W029 — `.planning/` ignored but still tracked (#3586, epic #2292) ─────
//
// Not a config.json-sourced check (unlike every other rule in this file) —
// registered here per the phase brief rather than in a new file, reading
// only `snapshot.planningTracked` (`src/planning-snapshot.cts`'s
// `buildPlanningTrackedField`). Fires ONLY when the probe's scope is
// COMPLETE and both `ignored` and `tracked` are true: `.gitignore` has no
// effect on files git already tracks, so a project that committed
// `.planning/` before ignoring it keeps staging those files forever even
// though `commit_docs` correctly auto-resolves `false`. Any other COMPLETE
// combination (most importantly `ignored: false, tracked: true` — the
// default, healthy state of every normal project) is silent; a degraded
// (non-COMPLETE) scope is ALSO silent — a probe that could not run must
// never manufacture a finding. ADVISE-only: auto-untracking is destructive
// and outside this phase's stated boundary (design doc, "Rejected" #3).

function checkW029(snapshot: PlanningSnapshot): Diagnostic[] {
  const field = snapshot.planningTracked;
  if (!field || field.scope !== SCOPE.COMPLETE) return [];
  if (!field.value.ignored || !field.value.tracked) return [];
  return [
    {
      code: 'W029',
      severity: SEVERITY.WARNING,
      message:
        '.planning/ matches a gitignore rule but is still tracked by git — .gitignore has no effect on already-tracked files, so staging keeps picking them up',
      remedy: adviseRemedy(
        'Run `git rm -r --cached .planning/` to untrack it (the ignore rule then takes effect); this does not delete the files on disk',
      ),
    },
  ];
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { code: 'W003', severity: SEVERITY.WARNING, description: 'config.json not found', repairable: true, check: checkW003 },
  { code: 'E005', severity: SEVERITY.ERROR, description: 'config.json parse error', repairable: false, check: checkE005 },
  { code: 'W004', severity: SEVERITY.WARNING, description: 'config.json invalid field value', repairable: false, check: checkW004 },
  {
    code: 'W008',
    severity: SEVERITY.WARNING,
    description: 'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
    repairable: true,
    check: checkW008,
  },
  {
    code: 'W016',
    severity: SEVERITY.WARNING,
    description:
      'config.json: workflow.ai_integration_phase absent (defaults to enabled but agents may skip AI-integration-phase planning)',
    repairable: true,
    check: checkW016,
  },
  {
    code: 'W012',
    severity: SEVERITY.WARNING,
    description: 'config.json invalid branching_strategy value',
    repairable: false,
    check: checkW012,
  },
  {
    code: 'W013',
    severity: SEVERITY.WARNING,
    description: 'config.json context_window not a positive integer',
    repairable: false,
    check: checkW013,
  },
  {
    code: 'W014',
    severity: SEVERITY.WARNING,
    description: 'config.json phase_branch_template missing {phase} placeholder',
    repairable: false,
    check: checkW014,
  },
  {
    code: 'W015',
    severity: SEVERITY.WARNING,
    description: 'config.json milestone_branch_template missing {milestone} placeholder',
    repairable: false,
    check: checkW015,
  },
  {
    code: 'W022',
    severity: SEVERITY.WARNING,
    description: 'config.json models entry malformed (unknown phase type, invalid tier, or non-object value)',
    repairable: false,
    check: checkW022,
  },
  {
    code: 'W029',
    severity: SEVERITY.WARNING,
    description: '.planning/ matches a gitignore rule but is still tracked by git (gitignore has no effect on already-tracked files)',
    repairable: false,
    check: checkW029,
  },
];

export = { RULES };
