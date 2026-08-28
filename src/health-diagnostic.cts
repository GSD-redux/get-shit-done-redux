/**
 * Health Diagnostic — frozen rule-table types, enums, and evaluator for
 * `validate health` (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Establishes the exact contract every extracted rule builds onto: the
 * frozen `SEVERITY`/`REMEDY_ACTION`/`REMEDY_RISK` enums, the
 * `Diagnostic`/`Remedy`/`Rule` shapes, the `RULES` container (the 32 rules
 * extracted from `cmdValidateHealth`, `src/verify.cts:1616-2577`, are
 * concatenated in from each rule-group file under
 * `src/health-diagnostic-rules/`), the `evaluateRules` evaluator, and the
 * `applyRepairs` `--repair`/`--backfill` dispatcher — whose per-action
 * handlers are REAL here (ported behavior-preserving from
 * `verify.cts:2405-2553`'s repair switch), not stubs.
 *
 * `applyRepairs` does not receive a `PlanningSnapshot` (its call-site
 * signature, `(cwd, diagnostics, repair, backfill)`, is a locked contract —
 * see `tests/health-diagnostic.test.cjs`) — so, like `cmdValidateHealth`
 * itself before this migration, it performs its own bounded filesystem I/O
 * to apply a repair. This is not a §8.1 rule 1 violation: that rule
 * constrains a RULE's `check(snapshot)` signature (no ambient I/O), not the
 * evaluator/dispatcher, which the design doc's "subject-surface gap" section
 * already establishes performs I/O once, up front, on the rules' behalf.
 *
 * `PlanningSnapshot` is deliberately NOT re-exported as a type from
 * `planning-snapshot.cts` here (see the design doc's "Known limits" and this
 * phase's brief): `ReturnType<typeof buildPlanningSnapshot>` is used inline
 * instead, via a type-only `import ... = require(...)` that is fully erased
 * at compile time — zero changes to the already-shipped, already-tested
 * `planning-snapshot.cts`.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('./planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// Runtime values (SEVERITY/REMEDY_ACTION/REMEDY_RISK) are needed here — not
// just types — for `applyRepairs`'s comparisons, so this is a normal
// (non type-only) `import ... = require(...)`. `health-diagnostic-types.cjs`
// is the leaf module these enums/types were extracted to, so that this file
// can `require()` every rule-group file below without a circular dependency
// (see that module's file-level comment for the full explanation).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticTypesMod = require('./health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = healthDiagnosticTypesMod;
type Severity = healthDiagnosticTypesMod.Severity;
type RemedyAction = healthDiagnosticTypesMod.RemedyAction;
type RemedyRisk = healthDiagnosticTypesMod.RemedyRisk;
type Remedy = healthDiagnosticTypesMod.Remedy;
type Diagnostic = healthDiagnosticTypesMod.Diagnostic;
type Rule = healthDiagnosticTypesMod.Rule;

// ─── Rule table ─────────────────────────────────────────────────────────────

// Populated by concatenating each rule group's exported `RULES` array (design
// doc, "Rule table organization" section) — the 32 rule functions extracted
// from `cmdValidateHealth`, `src/verify.cts:1616-2577`.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import rootExistenceMod = require('./health-diagnostic-rules/root-existence.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateConsistencyMod = require('./health-diagnostic-rules/state-consistency.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configValidationMod = require('./health-diagnostic-rules/config-validation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseStructureMod = require('./health-diagnostic-rules/phase-structure.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import agentInstallMod = require('./health-diagnostic-rules/agent-install.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapDiskConsistencyMod = require('./health-diagnostic-rules/roadmap-disk-consistency.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeHealthMod = require('./health-diagnostic-rules/worktree-health.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import milestoneArchiveHygieneMod = require('./health-diagnostic-rules/milestone-archive-hygiene.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import consistencyMod = require('./health-diagnostic-rules/consistency.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installSurfaceShadowingMod = require('./health-diagnostic-rules/install-surface-shadowing.cjs');

const RULES: Rule[] = [
  ...rootExistenceMod.RULES,
  ...stateConsistencyMod.RULES,
  ...configValidationMod.RULES,
  ...phaseStructureMod.RULES,
  ...agentInstallMod.RULES,
  ...roadmapDiskConsistencyMod.RULES,
  ...worktreeHealthMod.RULES,
  ...milestoneArchiveHygieneMod.RULES,
  ...installSurfaceShadowingMod.RULES,
];

/**
 * `validate.consistency`'s own rule set (Phase 12, #3310, ADR-3180 §8.4,
 * design doc "Which rules run where") — W006/W007 REUSED (the exact same
 * `Rule` objects `RULES` above already carries, not new copies) plus the
 * four new C0NN rules from `consistency.cts`. Deliberately NOT the full
 * `RULES` table: running `validate.health`'s config/state/worktree rules
 * under `validate.consistency` would be scope creep the issue never asked
 * for.
 */
const CONSISTENCY_RULES: Rule[] = [
  ...roadmapDiskConsistencyMod.RULES.filter((r) => ['W006', 'W007'].includes(r.code)),
  ...consistencyMod.RULES,
];

// ─── Repair-handler runtime dependencies ───────────────────────────────────
//
// Same owners `cmdValidateHealth`'s pre-migration repair switch used
// (`verify.cts:2405-2553`) — ported verbatim, not reinvented.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { CONFIG_DEFAULTS } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateMod = require('./state.cjs');
const { writeStateMd } = stateMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateTransitionMod = require('./state-transition.cjs');
const { rebuildStateTransaction } = stateTransitionMod;
import { realClock } from './clock.cjs';
import { platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';

// ─── Evaluator ──────────────────────────────────────────────────────────────

/**
 * Evaluate an explicit `rules` array against `snapshot`, throwing if any two
 * entries share a `code` (defense in depth beside the static lint guard,
 * §8.2 rule 1, `scripts/lint-health-diagnostic-rule-table.cjs`). Separated
 * from `evaluateRules` so the duplicate-code guard is unit-testable against
 * a small, locally-constructed fake rule array, independent of the real
 * `RULES` table.
 */
function evaluateRuleTable(rules: Rule[], snapshot: PlanningSnapshot): Diagnostic[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.code)) {
      throw new Error(`health-diagnostic: duplicate rule code "${rule.code}" in rule table`);
    }
    seen.add(rule.code);
  }
  return rules.flatMap((rule) => rule.check(snapshot));
}

/**
 * Evaluate every rule in `RULES` against `snapshot`, flattening each rule's
 * `Diagnostic[]` into one array.
 */
function evaluateRules(snapshot: PlanningSnapshot): Diagnostic[] {
  return evaluateRuleTable(RULES, snapshot);
}

/**
 * Evaluate `CONSISTENCY_RULES` (W006/W007 + C001-C004) against `snapshot` —
 * `validate.consistency`'s evaluator entry point, mirroring `evaluateRules`
 * exactly but over the smaller, command-specific rule subset.
 */
function evaluateConsistencyRules(snapshot: PlanningSnapshot): Diagnostic[] {
  return evaluateRuleTable(CONSISTENCY_RULES, snapshot);
}

// ─── Repair dispatcher ──────────────────────────────────────────────────────
// Repair-handler bodies (real, ported from verify.cts:2405-2553).

/**
 * One `repairs_performed`-shaped entry (legacy `cmdValidateHealth` output
 * shape), tagged with the diagnostic `code` it came from so
 * `applyRepairs`'s caller can build BOTH the code-keyed `applied`/`refused`
 * arrays this module's own tests lock (`tests/health-diagnostic.test.cjs`)
 * AND the action-keyed `repairs_performed` array `cmdValidateHealth` still
 * emits. `code` is stripped by the caller before the entry reaches JSON
 * output — the legacy shape never carried it.
 */
interface RepairDetail {
  code: string;
  action: string;
  success: boolean;
  path?: string;
  detail?: string;
  error?: string;
}

interface RepairPaths {
  rootBase: string;
  configPath: string;
  statePath: string;
  milestonesPath: string;
  milestonesArchiveDir: string;
}

/**
 * Derive every filesystem path a repair handler needs, from `cwd` alone —
 * exactly how `cmdValidateHealth` derived them pre-migration
 * (`verify.cts:1644-1652`/`2301-2302`). `config.json`/`MILESTONES.md`/
 * `milestones/` are root-scoped (`planningRoot`); `STATE.md` is
 * workstream-scoped (`planningDir`) — the same root-vs-workstream split
 * `buildConfigField`/`buildStateFields` (`planning-snapshot.cts`) already
 * document for the read side.
 */
function repairPaths(cwd: string): RepairPaths {
  // #3749: the project root is PROJECT-aware but deliberately NOT workstream-
  // scoped — under GSD_PROJECT, config.json/MILESTONES.md/milestones belong to
  // `.planning/<project>/` (the same base init.new-project's config_path
  // names); under GSD_WORKSTREAM they stay at the workstream PARENT, keeping
  // the documented root-vs-workstream split. planningDir(cwd, null) is exactly
  // that base: project env honored, ws env suppressed.
  const rootBase = planningDir(cwd, null);
  const wsBase = planningDir(cwd);
  return {
    rootBase,
    configPath: path.join(rootBase, 'config.json'),
    statePath: path.join(wsBase, 'STATE.md'),
    milestonesPath: path.join(rootBase, 'MILESTONES.md'),
    milestonesArchiveDir: path.join(rootBase, 'milestones'),
  };
}

/** `verify.cts:2413-2429`'s default config.json payload, ported verbatim. */
function defaultConfigPayload(): Record<string, unknown> {
  return {
    model_profile: CONFIG_DEFAULTS.model_profile,
    commit_docs: CONFIG_DEFAULTS.commit_docs,
    search_gitignored: CONFIG_DEFAULTS.search_gitignored,
    branching_strategy: CONFIG_DEFAULTS.branching_strategy,
    phase_branch_template: CONFIG_DEFAULTS.phase_branch_template,
    milestone_branch_template: CONFIG_DEFAULTS.milestone_branch_template,
    quick_branch_template: CONFIG_DEFAULTS.quick_branch_template,
    workflow: {
      research: CONFIG_DEFAULTS.research,
      plan_check: CONFIG_DEFAULTS.plan_checker,
      verifier: CONFIG_DEFAULTS.verifier,
      nyquist_validation: CONFIG_DEFAULTS.nyquist_validation,
    },
    parallelization: CONFIG_DEFAULTS.parallelization,
    brave_search: CONFIG_DEFAULTS.brave_search,
  };
}

/**
 * `verify.cts:2301-2335`'s W018 archived-vs-documented-versions diff,
 * relocated verbatim (same two regexes, same two-file read) so
 * `backfillMilestones` can recompute exactly which versions are missing
 * without a `PlanningSnapshot` (`applyRepairs` is not a `Rule` and is not
 * handed one — see this file's header comment). This is the same
 * derivation `buildMilestoneArchiveStatusField`
 * (`src/planning-snapshot.cts`) already performs for the W018 RULE's read
 * side; recomputed here, not re-invented, because the rule's own
 * `Diagnostic.remedy.args` carries no version list (confirmed by direct
 * read of `src/health-diagnostic-rules/milestone-archive-hygiene.cts`).
 */
function computeMissingMilestoneVersions(milestonesArchiveDir: string, milestonesPath: string): string[] {
  let archivedVersions: string[] = [];
  try {
    if (fs.existsSync(milestonesArchiveDir)) {
      const archiveFiles = fs.readdirSync(milestonesArchiveDir);
      archivedVersions = archiveFiles
        .map((f) => f.match(/^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
    }
  } catch {
    /* intentionally empty — mirrors the original's advisory try/catch */
  }

  let documentedVersions: string[] = [];
  try {
    if (fs.existsSync(milestonesPath)) {
      const registryContent = fs.readFileSync(milestonesPath, 'utf-8');
      documentedVersions = [...registryContent.matchAll(/^##\s+(v\d+\.\d+(?:\.\d+)?)/gm)].map((m) => m[1]);
    }
  } catch {
    /* intentionally empty */
  }

  const documented = new Set(documentedVersions);
  return archivedVersions.filter((v) => !documented.has(v));
}

interface RepairOutcome {
  success: boolean;
  path?: string;
  detail?: string;
  error?: string;
  // regenerateState's original backup step (verify.cts:2435-2440) pushed its
  // own SEPARATE `repairActions` entry before the main one — preserved here
  // as extra, prepended detail rows. Unreachable in practice today
  // (regenerateState is DESTRUCTIVE and `applyRepairs`'s dispatcher below
  // refuses it before this handler is ever invoked), but the handler stays
  // complete rather than partially ported, per this batch's brief.
  extraDetails?: { action: string; success: boolean; path?: string }[];
}

/**
 * Execute exactly one real repair action, ported behavior-preserving from
 * `verify.cts:2405-2553`'s `switch (repair)`. Throws are the caller's
 * responsibility to catch (mirrors the original's per-action try/catch
 * shape, collapsed to one seam here since every case now shares one
 * caller).
 */
function runRepairAction(cwd: string, action: RemedyAction, paths: RepairPaths): RepairOutcome {
  const { rootBase, configPath, statePath, milestonesPath, milestonesArchiveDir } = paths;

  switch (action) {
    case REMEDY_ACTION.CREATE_CONFIG:
    case REMEDY_ACTION.RESET_CONFIG: {
      platformWriteSync(configPath, JSON.stringify(defaultConfigPayload(), null, 2));
      return { success: true, path: 'config.json' };
    }

    case REMEDY_ACTION.REGENERATE_STATE: {
      const extraDetails: { action: string; success: boolean; path?: string }[] = [];
      if (fs.existsSync(statePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = `${statePath}.bak-${timestamp}`;
        fs.copyFileSync(statePath, backupPath);
        extraDetails.push({ action: 'backupState', success: true, path: backupPath });
      }
      const milestone = getMilestoneInfo(cwd).value;
      const projectRef = path
        .relative(cwd, path.join(rootBase, 'PROJECT.md'))
        .split(path.sep)
        .join('/');
      const slashRuntime = resolveRuntime(cwd);
      const slash = (name: string) => formatGsdSlash(name, slashRuntime) as string;
      let stateContent = `# Session State\n\n`;
      stateContent += `## Project Reference\n\n`;
      stateContent += `See: ${projectRef}\n\n`;
      stateContent += `## Position\n\n`;
      stateContent += `**Milestone:** ${milestone?.version ?? ''} ${milestone?.name ?? ''}\n`;
      stateContent += `**Current phase:** (determining...)\n`;
      stateContent += `**Status:** Resuming\n\n`;
      stateContent += `## Session Log\n\n`;
      stateContent += `- ${realClock.localToday()}: STATE.md regenerated by ${slash('health')} --repair\n`;
      // ADR-3473 §8.6: `/gsd-health --repair` is a factory reset, so
      // preservation must not run; the snapshot of the file being replaced is
      // still captured, and `{}` is the correct, legal snapshot of a
      // STATE.md that had no parseable frontmatter — which is the usual
      // reason this repair fires.
      const priorState = fs.existsSync(statePath) ? (safeReadFile(statePath) ?? '') : '';
      writeStateMd(statePath, stateContent, rebuildStateTransaction({
        snapshot: extractFrontmatter(priorState, statePath),
      }), cwd);
      return { success: true, path: 'STATE.md', extraDetails };
    }

    case REMEDY_ACTION.ADD_NYQUIST_KEY:
    case REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY: {
      const key = action === REMEDY_ACTION.ADD_NYQUIST_KEY ? 'nyquist_validation' : 'ai_integration_phase';
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
      if (!configParsed['workflow']) configParsed['workflow'] = {};
      const wf = configParsed['workflow'] as Record<string, unknown>;
      if (wf[key] === undefined) {
        wf[key] = true;
        platformWriteSync(configPath, JSON.stringify(configParsed, null, 2));
      }
      return { success: true, path: 'config.json' };
    }

    case REMEDY_ACTION.BACKFILL_MILESTONES: {
      const missing = computeMissingMilestoneVersions(milestonesArchiveDir, milestonesPath);
      const today = realClock.localToday();
      const slashRuntime = resolveRuntime(cwd);
      const slash = (name: string) => formatGsdSlash(name, slashRuntime) as string;
      let backfilled = 0;
      for (const ver of missing) {
        try {
          const snapshotPath = path.join(milestonesArchiveDir, `${ver}-ROADMAP.md`);
          const snapshot = safeReadFile(snapshotPath);
          const titleMatch = snapshot && snapshot.match(/^#\s+(.+)$/m);
          const milestoneName = titleMatch
            ? titleMatch[1].replace(/^Milestone\s+/i, '').replace(/^v[\d.]+\s*/, '').trim()
            : ver;
          const entry =
            `## ${ver}${milestoneName && milestoneName !== ver ? ` ${milestoneName}` : ''} (Backfilled: ${today})\n\n**Note:** Synthesized from archive snapshot by \`${slash('health')} --backfill\`. Original completion date unknown.\n\n---\n\n`;
          const milestonesContent = fs.existsSync(milestonesPath)
            ? fs.readFileSync(milestonesPath, 'utf-8')
            : '';
          if (!milestonesContent.trim()) {
            platformWriteSync(milestonesPath, `# Milestones\n\n${entry}`);
          } else {
            const headerMatch = milestonesContent.match(/^(#{1,3}\s+[^\n]*\n\n?)/);
            if (headerMatch) {
              const header = headerMatch[1];
              const rest = milestonesContent.slice(header.length);
              platformWriteSync(milestonesPath, header + entry + rest);
            } else {
              platformWriteSync(milestonesPath, entry + milestonesContent);
            }
          }
          backfilled++;
        } catch {
          /* intentionally empty — partial backfill is acceptable */
        }
      }
      return { success: true, detail: `Backfilled ${backfilled} milestone(s) into MILESTONES.md` };
    }

    default:
      return { success: false, error: `no repair handler registered for action "${action}"` };
  }
}

/**
 * `--repair`/`--backfill` dispatcher (design doc "`--repair` behavior
 * change" section; §8.3 rule 3). For each diagnostic whose remedy is not
 * `ADVISE`:
 *
 * - Not requested — `repair` is false, and for `backfillMilestones`
 *   specifically `backfill` is also false (mirrors `cmdValidateHealth`'s
 *   existing `backfillMilestones` gate, `verify.cts:2504`:
 *   `if (!options['backfill'] && !options['repair']) break;`) — skipped
 *   entirely, recorded in neither `applied` nor `refused`.
 * - Requested and `remedy.risk === DESTRUCTIVE` — pushed onto `refused`,
 *   handler never invoked. This is the §8.3 rule 3 breaking-change
 *   enforcement point: a DESTRUCTIVE remedy is describable but is never
 *   applied by `--repair`. A `details` row is still recorded, so the
 *   refusal is VISIBLE in `cmdValidateHealth`'s `repairs_performed` output,
 *   not silently dropped.
 * - Requested and `remedy.risk === NONE` — the real handler is invoked,
 *   pushed onto `applied`.
 *
 * `applied`/`refused` are unchanged in shape from the pre-existing skeleton
 * (locked by `tests/health-diagnostic.test.cjs`, rows 11-12): arrays of
 * diagnostic `code`s. `details` is ADDITIVE — every real action maps 1:1 to
 * exactly one code in this rule table (confirmed: no `REMEDY_ACTION` other
 * than `ADVISE` is used by more than one rule), so `cmdValidateHealth` can
 * rebuild the legacy action-keyed `repairs_performed` shape directly from
 * it.
 */
function applyRepairs(
  cwd: string,
  diagnostics: Diagnostic[],
  repair: boolean,
  backfill: boolean,
): { applied: string[]; refused: string[]; details: RepairDetail[] } {
  const applied: string[] = [];
  const refused: string[] = [];
  const details: RepairDetail[] = [];
  const paths = repairPaths(cwd);

  for (const diagnostic of diagnostics) {
    const { remedy, code } = diagnostic;
    if (remedy.action === REMEDY_ACTION.ADVISE) continue;

    const requested =
      remedy.action === REMEDY_ACTION.BACKFILL_MILESTONES ? repair || backfill : repair;
    if (!requested) continue;

    if (remedy.risk === REMEDY_RISK.DESTRUCTIVE) {
      refused.push(code);
      details.push({
        code,
        action: remedy.action,
        success: false,
        error: `refused: '${remedy.action}' is a destructive remedy and is not auto-applied by --repair`,
      });
      continue;
    }

    try {
      const outcome = runRepairAction(cwd, remedy.action, paths);
      if (outcome.extraDetails) {
        for (const extra of outcome.extraDetails) {
          details.push({ code, action: extra.action, success: extra.success, ...(extra.path ? { path: extra.path } : {}) });
        }
      }
      details.push({
        code,
        action: remedy.action,
        success: outcome.success,
        ...(outcome.path ? { path: outcome.path } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      // `applied` means "the repair actually succeeded", not "was attempted"
      // — a handler that returns `{success: false}` (or throws, caught
      // below) is recorded in `details` with its failure, but must not be
      // reported as applied. `refused` is reserved for the DESTRUCTIVE-risk
      // gate above; a failed attempt is neither applied nor refused.
      if (outcome.success) applied.push(code);
    } catch (err) {
      details.push({
        code,
        action: remedy.action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { applied, refused, details };
}

// ─── Exports ────────────────────────────────────────────────────────────────

const healthDiagnostic = {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  RULES,
  evaluateRules,
  // Additive beyond the phase's required-exports list — exposed so the
  // duplicate-code guard (row 13) is directly unit-testable against a fake
  // rule array without mutating the real, still-empty `RULES` export.
  evaluateRuleTable,
  applyRepairs,
  // Phase 12 (#3310) — `validate.consistency`'s own rule subset + evaluator.
  CONSISTENCY_RULES,
  evaluateConsistencyRules,
};

// Namespace merge (same binding name as the value above) is how a CommonJS
// `export =` module exposes a type alongside its runtime export — `export
// type` is rejected by TS2309 ("An export assignment cannot be used in a
// module with other exported elements") when combined with `export =`, so
// these types ride along on the exported object via declaration merging
// instead. Mirrors `src/planning-scope.cts`'s exact mechanism. Consumers
// doing `import x = require('./health-diagnostic.cjs')` can reference the
// types as `x.Severity`, `x.RemedyAction`, etc.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace healthDiagnostic {
  export { Severity, RemedyAction, RemedyRisk, Remedy, Diagnostic, Rule };
}

export = healthDiagnostic;
