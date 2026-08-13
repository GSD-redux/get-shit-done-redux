/**
 * Health Diagnostic Types — shared, dependency-free rule-table types (Phase
 * 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Split out from `src/health-diagnostic.cts` to break a CJS circular
 * dependency between the evaluator and its own rule-group files
 * (`src/health-diagnostic-rules/*.cts`): those files need the frozen
 * `SEVERITY`/`REMEDY_ACTION`/`REMEDY_RISK` enums and the `Diagnostic`/
 * `Remedy`/`Rule` shapes, but the evaluator (`health-diagnostic.cts`) also
 * needs to `require()` every rule-group file to populate its `RULES` array —
 * a rule-group file requiring `health-diagnostic.cjs` back, mid-load, reads
 * `module.exports` before it is assigned, so the destructured enums come
 * back `undefined`. This leaf has NO runtime dependency on anything in that
 * cycle, so both sides can depend on it directly.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic-types.cts,
 * compiled to gsd-core/bin/lib/health-diagnostic-types.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('./planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// ─── Severity ───────────────────────────────────────────────────────────────

const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});
type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

// ─── Remedy action / risk ───────────────────────────────────────────────────

// Harvested from health.md's published table + the corrected 6-action
// implementation (`src/verify.cts:2405-2553`) — not 5; `addAiIntegrationPhaseKey`
// (verify.cts:1860/2481-2502) was live in code, missing from docs (design
// doc, "Ground truth vs. issue #3309's claims" section).
const REMEDY_ACTION = Object.freeze({
  CREATE_CONFIG: 'createConfig',
  RESET_CONFIG: 'resetConfig',
  REGENERATE_STATE: 'regenerateState',
  ADD_NYQUIST_KEY: 'addNyquistKey',
  ADD_AI_INTEGRATION_PHASE_KEY: 'addAiIntegrationPhaseKey',
  BACKFILL_MILESTONES: 'backfillMilestones',
  // §8.3 rule 5 — every non-repairable finding's `fix` string becomes an
  // ADVISE payload; ADVISE never acts, only describes.
  ADVISE: 'advise',
});
type RemedyAction = (typeof REMEDY_ACTION)[keyof typeof REMEDY_ACTION];

const REMEDY_RISK = Object.freeze({
  NONE: 'none',
  DESTRUCTIVE: 'destructive',
});
type RemedyRisk = (typeof REMEDY_RISK)[keyof typeof REMEDY_RISK];

// ─── Diagnostic / Rule shapes ───────────────────────────────────────────────

interface Remedy {
  action: RemedyAction;
  risk: RemedyRisk;
  args: Record<string, unknown>;
}

interface Diagnostic {
  code: string; // e.g. 'W010' — append-only, never renumbered (§8.2 rule 2)
  severity: Severity; // property of the RULE, never the emit call (§8.2 rule 3)
  message: string;
  remedy: Remedy;
}

interface Rule {
  code: string;
  severity: Severity;
  /**
   * Short, static, human-readable summary of what this rule checks — the
   * source of `gsd-core/workflows/health.md`'s generated `<error_codes>`
   * table (`scripts/gen-health-docs.cjs`). Deliberately distinct from a
   * fired `Diagnostic`'s `message`, which is dynamic/per-instance (e.g.
   * W001's message names the specific PROJECT.md section that is missing);
   * `description` is exactly one fixed sentence per code, matching the
   * hand-written table's pre-existing style for the codes it already
   * documented (E001-E005, W001-W009, W018, W019, W024, I001).
   */
  description: string;
  /**
   * Whether `--repair` will actually apply this rule's remedy (`true`) or
   * never will (`false`) — the source of the generated table's "Repairable"
   * column. This MUST match `diagnosticToIssueEntry`'s (`src/verify.cts`)
   * per-diagnostic semantics: `remedy.action !== ADVISE && remedy.risk !==
   * REMEDY_RISK.DESTRUCTIVE`. `false` covers TWO distinct cases, and both
   * must map to `false` here:
   *
   * 1. ADVISE-only rules — no real `REMEDY_ACTION` exists to apply.
   * 2. DESTRUCTIVE-risk rules (`regenerateState`, `resetConfig`) — a real
   *    action exists and is described, but `applyRepairs`'s dispatcher
   *    (`src/health-diagnostic.cts`) refuses to auto-apply any
   *    DESTRUCTIVE-risk remedy (§8.3 rule 3), so `--repair` never applies it
   *    either. "A remedy exists to describe" is NOT sufficient for `true` —
   *    only "an unattended `--repair` run will actually apply it" is.
   *
   * STATIC field, not derived by executing `check` against a fixture at
   * doc-gen time: confirmed by direct read of all 8
   * `src/health-diagnostic-rules/*.cts` files that every rule in this
   * codebase uses exactly ONE `remedy.action` (and therefore one
   * `remedy.risk`) across every `Diagnostic` it can ever emit — no rule mixes
   * ADVISE with a real action, or NONE-risk with DESTRUCTIVE-risk, depending
   * on the triggering condition (the design doc's "primary remedy" ambiguity
   * this field's doc comment was asked to consider does not arise in
   * practice). A single static boolean is therefore a faithful,
   * execution-free summary, and cheaper/simpler than adding a second
   * `primaryRemedyAction` field or having the generator import and execute
   * every rule against a synthetic snapshot.
   */
  repairable: boolean;
  check: (snapshot: PlanningSnapshot) => Diagnostic[]; // §8.1 rule 1 signature, verbatim
}

// ─── adviseRemedy — shared ADVISE-remedy builder ───────────────────────────

/**
 * Every rule-group file needs the same `{action: ADVISE, risk: NONE, args:
 * {command}}` shape for a non-repairable finding's `fix` string (§8.3 rule
 * 5). Was defined identically in `config-validation.cts` and
 * `agent-install.cts`, and repeated inline elsewhere — moved to this shared,
 * dependency-free leaf so every rule-group file imports one implementation
 * instead of duplicating it.
 */
function adviseRemedy(command: string): Remedy {
  return { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: { command } };
}

// ─── Exports ────────────────────────────────────────────────────────────────

const healthDiagnosticTypes = {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  adviseRemedy,
};

// Namespace merge (same binding name as the value above) is how a CommonJS
// `export =` module exposes a type alongside its runtime export — `export
// type` is rejected by TS2309 ("An export assignment cannot be used in a
// module with other exported elements") when combined with `export =`, so
// these types ride along on the exported object via declaration merging
// instead. Mirrors `src/planning-scope.cts`'s exact mechanism. Consumers
// doing `import x = require('./health-diagnostic-types.cjs')` can reference
// the types as `x.Severity`, `x.RemedyAction`, etc.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace healthDiagnosticTypes {
  export { Severity, RemedyAction, RemedyRisk, Remedy, Diagnostic, Rule };
}

export = healthDiagnosticTypes;
