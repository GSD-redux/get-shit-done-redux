/**
 * Planning Snapshot — a parsed projection of `.planning/` (Phase 10, #3308,
 * ADR-3180 §8.1).
 *
 * Composed EXCLUSIVELY from the already-consolidated §7 owners
 * (`getMilestoneInfo`, `listMilestonePhaseDirs`, `isPhaseComplete`,
 * `scanPhasePlans`, `stateFieldValue`, `planningPaths`) plus the frozen
 * `SCOPE` enum. This module introduces no new semantic derivation — it
 * introduces exactly one new thing: `worstScope`, a way to combine several
 * independently-scoped owner answers into one composite record without
 * letting a caller treat a non-answer as data.
 *
 * `buildPlanningSnapshot(cwd)` is the sole export consumers reach for;
 * `worstScope` is exported alongside it for direct unit coverage.
 *
 * Design: .gsd/phase/refactor-3308-planning-snapshot-parsed-projection/40-design.md
 *
 * ADR-457 build-at-publish: source in src/planning-snapshot.cts, compiled to
 * gsd-core/bin/lib/planning-snapshot.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo, extractCurrentMilestone } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningRoot } = planningWorkspace;
import { platformReadSync, execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { findOrphanSummaries } = coreUtilsMod;
import { stateFieldValue, stateCurrentPositionSlice } from './state-document.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
import { resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheckMod = require('./agent-install-check.cjs');
const { checkAgentsInstalled } = agentInstallCheckMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
import worktreeSafetyMod = require('./worktree-safety.cjs');
const { inspectWorktreeHealth } = worktreeSafetyMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE, OPTIONAL_PHASE_TAG_SOURCE, stripProjectCodePrefix, scopeToPhase } = phaseIdMod;
import { buildRoadmapPhaseVariants, PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE } from './validate.cjs';

// ─── worstScope — the one new piece of coordination logic ───────────────────

/**
 * Severity ordering (`UNREADABLE` worst, `COMPLETE` best) is a genuine design
 * choice, not inherited from anywhere — see the design doc's "Scope
 * combination" section. `TRUNCATED` vs `UNSCOPED` are not ranked against each
 * other by any upstream decision; this ordering exists only so a future
 * diagnostic rule can name which failure was worse when several compound.
 */
const SCOPE_SEVERITY: Record<Scope, number> = {
  [SCOPE.COMPLETE]: 0,
  [SCOPE.TRUNCATED]: 1,
  [SCOPE.UNSCOPED]: 2,
  [SCOPE.UNREADABLE]: 3,
};

/**
 * Combine several independently-scoped owner answers into the single worst
 * (most severe) `Scope` among them. Pure, no I/O. Not a re-derivation of any
 * §7 owner — it folds together already-final `scope` outputs, which is new
 * coordination logic no single owner has visibility to express itself.
 */
function worstScope(...scopes: Scope[]): Scope {
  return scopes.reduce((worst, s) => (SCOPE_SEVERITY[s] > SCOPE_SEVERITY[worst] ? s : worst));
}

// ─── Snapshot shape ───────────────────────────────────────────────────────────

interface PhaseSnapshot {
  dir: string;
  complete: boolean;
  verificationStatus: string;
  planCount: number;
  summaryCount: number;
  scope: Scope;
}

interface PlanningSnapshot {
  // The resolved absolute `cwd` this snapshot was built for — `cwd` is
  // already `buildPlanningSnapshot`'s own input, not a new ambient read, so
  // exposing it is a "parsed value" per §8.1 rule 2, not §8.1 rule 1 ambient
  // I/O. Backs W027's active-worktree exclusion
  // (`src/health-diagnostic-rules/worktree-health.cts`), the one pre-migration
  // behavior (`verify.cts:2233-2242`) that genuinely needed the caller's cwd.
  cwd: string;
  milestone: ReturnType<typeof getMilestoneInfo>;
  phaseDirs: ReturnType<typeof listMilestonePhaseDirs>;
  phases: { value: PhaseSnapshot[]; scope: Scope };
  currentPhaseLabel: { value: string | null; scope: Scope };
  // ─── Phase 11 (#3309, ADR-3180 §8.2/§8.3/§8.5) additions ───────────────────
  // Additive-only — see the design doc's "The subject-surface gap" section.
  // `config` genuinely lives under `.planning/`; `agentInstall` and
  // `worktreeHealth` do not (named as such so a future reader does not
  // mistake them for §7 derivations) but are exposed here anyway so every
  // rule's `check(snapshot)` signature stays the single object §8.1 rule 1
  // names, "the snapshot".
  config: { value: Record<string, unknown> | null; scope: Scope; exists: boolean };
  agentInstall: { value: ReturnType<typeof checkAgentsInstalled>; scope: Scope };
  worktreeHealth: { value: ReturnType<typeof inspectWorktreeHealth>['findings']; scope: Scope; reason: string };
  // ─── Phase 11 (#3309) "Rule table organization" additions ─────────────────
  // The design doc's own "Rule table organization" table and prose disagree
  // on the count: the table lists EIGHT rows (through `planningRootFiles`,
  // W019) but the prose says "7 more fields" / "14 fields after this batch".
  // This implementation follows the table (and the task brief, which
  // separately enumerates all eight) — every field a reused owner or a
  // small, relocated (not new-algorithm) derivation. `PlanningSnapshot`
  // therefore totals 15 fields after this batch, not 14; flagged here rather
  // than silently reconciled, since correcting the design doc's prose is
  // outside this diff's scope.
  projectSections: { value: string[] | null; scope: Scope; exists: boolean };
  statePhaseTokens: { value: string[]; scope: Scope };
  stateStatus: { value: string | null; scope: Scope };
  roadmapDeclaredPhases: { value: { phaseId: string; milestone: string | null }[]; scope: Scope };
  roadmapPhaseCheckboxes: { value: Record<string, boolean>; scope: Scope };
  researchValidationStatus: {
    value: { dir: string; hasValidationArchitecture: boolean; hasValidationMd: boolean }[];
    scope: Scope;
  };
  milestoneArchiveStatus: {
    value: { archivedVersions: string[]; documentedVersions: string[] };
    scope: Scope;
  };
  planningRootFiles: { value: string[]; scope: Scope };
  // W006/W007 (ROADMAP/disk consistency group) fidelity fix, found while
  // implementing `src/health-diagnostic-rules/roadmap-disk-consistency.cts`:
  // `phaseDirs` (Phase 10) is deliberately WINDOWED to the phases
  // `listMilestonePhaseDirs`'s `inWindow` filter (`getMilestonePhaseFilter`,
  // `src/roadmap-parser.cts:1220`) resolves as belonging to the CURRENT
  // milestone window — a directory whose phase id is NOT declared anywhere
  // in ROADMAP.md is EXCLUDED from `phaseDirs.value` by construction
  // (`isDirInMilestone` membership test). That is exactly the directory
  // W007 exists to find ("an on-disk phase dir has no matching ROADMAP
  // entry"), so sourcing W007 from `phaseDirs.value` would make it
  // structurally unable to fire on the very case it names: an orphan
  // directory can never be a member of the set that is itself defined as
  // "directories the roadmap already declares." `allPhaseDirNames` is the
  // un-windowed twin — every directory actually present under the active
  // `phases/` root, unfiltered by roadmap declaration (sentinel-id
  // exclusion is left to the RULE, mirroring `verify.cts:2091`'s own
  // per-entry `isSentinelPhaseId` guard rather than baking it into the
  // field). Archived-milestone directories are out of scope here exactly as
  // they already are for `phaseDirs` (see this batch's own disclosed
  // fidelity reduction for that).
  allPhaseDirNames: { value: string[]; scope: Scope };
  // W002 (STATE.md-consistency group) fidelity fix, found while implementing
  // `src/health-diagnostic-rules/state-consistency.cts`. The original
  // `cmdValidateHealth` W002 check unions THREE sources into its "valid
  // phase" set — disk dirs, ROADMAP headings, and
  // `forEachArchivedPhaseToken(planBase, ...)` (`verify.cts:1748`, every
  // phase-token-shaped subdirectory under `.planning/milestones/*-phases/`,
  // via the same `MILESTONE_ARCHIVE_DIR_RE`/`PHASE_TOKEN_FROM_DIR_RE`
  // `listMilestoneArchiveDirs`/`forEachArchivedPhaseToken` use, both already
  // exported from `validate.cjs` — no new regex derivation here). Without the
  // third source, a STATE.md reference to a phase whose only directory lives
  // in a shipped-milestone archive reads as an undeclared phase (#3652).
  // Additive-only per this batch's own field-table constraint. Also now reused
  // by `src/health-diagnostic-rules/roadmap-disk-consistency.cts`'s `checkW006`
  // (Bug 1, #3309 W006/W007 migration cluster) for the same "was this token
  // archived" question a ROADMAP *entry* needs answered, not just a STATE.md
  // *reference* — same token set, two independent consumers, no re-derivation.
  archivedPhaseTokens: { value: string[]; scope: Scope };
  // W026 (STATE.md-consistency group) fidelity fix, found while implementing
  // `src/health-diagnostic-rules/state-consistency.cts`. W026's original
  // logic (`verify.cts:2356-2399`, the second `addIssue('warning', 'W021',
  // ...)` call site before the #3309 code split) scopes ROADMAP.md to the
  // CURRENT milestone via `extractCurrentMilestone(roadmapRaw, cwd)` — the
  // same shared, `<details>`/`<summary>`-tolerant scoping owner every other
  // milestone-aware consumer uses (`roadmap-parser.cts`) — then scans
  // `#{2,4}\s*Phase\s+(TOKEN)...` headings within that scoped slice.
  // `roadmapDeclaredPhases`'s `milestone` attribution (above) is NOT a fit
  // here even though it looks adjacent: it exists to relocate
  // `checkMilestonePrefixMismatches`'s OWN narrower `sectionRx`
  // (`verify.cts:1429-1459`, `^#{1,3}\s+...vX.Y`, no `<details>` support) —
  // faithful for W021 (which never supported `<details>` either), but
  // reusing it for W026 would regress W026's ALREADY-`<details>`-tolerant
  // original behavior. This field is W026's own, independently-scoped
  // phase-id list — additive-only, no change to `roadmapDeclaredPhases`.
  currentMilestoneRoadmapPhaseIds: { value: string[]; scope: Scope };
  // ─── Phase 12 (#3310, ADR-3180 §8.4) additions ─────────────────────────────
  // Backs C002/C003/C004 (`src/health-diagnostic-rules/consistency.cts`,
  // `cmdValidateConsistency`'s migration target). All three relocate
  // `verify.cts:1556-1603`'s per-phase-directory plan scan verbatim; see
  // `buildPerPhasePlanScanFields`'s own doc comment for why the three share
  // one builder and one enumeration base (`allPhaseDirNames`, NOT the
  // current-milestone-windowed `phaseDirs`).
  perPhasePlanNumbering: { value: { phaseDir: string; planNums: number[] }[]; scope: Scope };
  perPhaseOrphanSummaries: { value: { phaseDir: string; orphanSummary: string }[]; scope: Scope };
  perPhaseWaveMissingPlans: { value: { phaseDir: string; plan: string }[]; scope: Scope };
}

/**
 * Build one `PhaseSnapshot` for a single already-enumerated phase directory
 * name. `isPhaseComplete` and `scanPhasePlans` each perform their own raw
 * `readdirSync` against `fullPhaseDir` and can independently degrade — see
 * the design doc's "Scope combination" section for why the two are genuinely
 * uncorrelated (isPhaseComplete's readability check never re-derives or
 * requires scanPhasePlans, and vice versa).
 */
function buildPhaseSnapshot(phasesDir: string, dir: string): PhaseSnapshot {
  const fullPhaseDir = path.join(phasesDir, dir);
  const completionResult = isPhaseComplete(fullPhaseDir);
  const scanResult = scanPhasePlans(fullPhaseDir);
  return {
    dir,
    complete: completionResult.value.complete,
    verificationStatus: completionResult.value.verification.status,
    planCount: scanResult.planCount,
    summaryCount: scanResult.summaryCount,
    scope: worstScope(completionResult.scope, scanResult.scope),
  };
}

interface StateFields {
  currentPhaseLabel: { value: string | null; scope: Scope };
  statePhaseTokens: { value: string[]; scope: Scope };
  stateStatus: { value: string | null; scope: Scope };
}

/**
 * Resolve every STATE.md-sourced field in one place: `currentPhaseLabel` (the
 * raw `Phase:` field under `## Current Position`, e.g. `"3 of 8 (User
 * Auth)"`, not a normalized phase-directory id — see the design doc's Known
 * limits), `statePhaseTokens` (Phase 11, #3309 — every phase-number-shaped
 * token found anywhere in STATE.md's raw text, backs W002), and `stateStatus`
 * (Phase 11, #3309 — the `status`/`Status` field, backs W011).
 *
 * Phase 10 shipped `currentPhaseLabel` as its own single-purpose reader
 * (`buildCurrentPhaseLabel(statePath)`); this phase folds two more STATE.md
 * derivations in rather than reading and parsing the same file three times
 * per `buildPlanningSnapshot` call — the read, `extractFrontmatter`, and
 * `stripFrontmatter` are genuinely shared inputs for all three, and sharing
 * them means `warnUnusableInput(STATE_UNREADABLE)` also stays a single call
 * site instead of a risk of tripling on one degraded read.
 *
 * This module performs the one STATE.md read no §7 owner does, mirroring
 * every existing STATE.md caller (`cmdStateSnapshot`, `cmdStatePrune`):
 * `platformReadSync` + `extractFrontmatter` + `stripFrontmatter`.
 *
 * - STATE.md absent (ENOENT, `platformReadSync` returns `null`) is a real
 *   non-answer, NOT corruption — a project that never ran `state.init`
 *   legitimately has no STATE.md yet. `warnUnusableInput` is NOT called.
 * - STATE.md present but unreadable (any other read error, e.g. EISDIR) is
 *   corruption — `warnUnusableInput(STATE_UNREADABLE)` fires exactly once,
 *   and all three fields degrade to their UNREADABLE non-answer together.
 * - An unterminated frontmatter fence is reported by `extractFrontmatter`
 *   itself (`FRONTMATTER_UNTERMINATED`) — this function does not duplicate
 *   that diagnostic; it still attempts a body-only field read on whatever
 *   `stripFrontmatter` leaves behind.
 * - `currentPhaseLabel`/`stateStatus` both live under `## Current Position`
 *   (`gsd-core/templates/state.md`) and both use `stateFieldValue`
 *   (`state-document.cts:296`) the exact way `smart-entry.cts:448`/
 *   `state.cts:1561,3273` already call it for `'status'`/`'Status'` — so a
 *   missing `## Current Position` section degrades BOTH to `TRUNCATED` with
 *   a whole-body fallback, together.
 * - `statePhaseTokens` scans the WHOLE document (`verify.cts`'s exact
 *   `PHASE_NUMBER_TOKEN_SOURCE` regex, relocated verbatim from
 *   `verify.cts:1731-1735`), not just the Current Position section, so it is
 *   NOT degraded to `TRUNCATED` by a missing section header — it stays
 *   `COMPLETE` whenever the file itself was read successfully.
 */
function buildStateFields(statePath: string): StateFields {
  let content: string | null;
  try {
    content = platformReadSync(statePath);
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.STATE_UNREADABLE, source: statePath });
    return {
      currentPhaseLabel: { value: null, scope: SCOPE.UNREADABLE },
      statePhaseTokens: { value: [], scope: SCOPE.UNREADABLE },
      stateStatus: { value: null, scope: SCOPE.UNREADABLE },
    };
  }
  if (content === null) {
    return {
      currentPhaseLabel: { value: null, scope: SCOPE.UNREADABLE },
      statePhaseTokens: { value: [], scope: SCOPE.UNREADABLE },
      stateStatus: { value: null, scope: SCOPE.UNREADABLE },
    };
  }

  const frontmatter = extractFrontmatter(content, statePath);
  const body = stripFrontmatter(content);
  const section = stateCurrentPositionSlice(body);
  const currentPositionScope = section === null ? SCOPE.TRUNCATED : SCOPE.COMPLETE;

  // #1760 fallback ladder — now a full mirror of `state.cts`'s
  // `resolveStatePhase` (its three-source ladder at `state.cts:1494-1516`),
  // including the frontmatter step that ladder leads with:
  //   1. frontmatter `current_phase` scalar — the machine-readable key
  //      `gsd-tools state update` / `state begin-phase` persist via
  //      `syncStateFrontmatter` (`state.cts:2023`), so it takes PRIORITY over
  //      any body field (#3280: a body-only ladder left W011 structurally
  //      blind to the one format the product itself writes — a stale body
  //      `Phase:` remnant even SHADOWED the current frontmatter value).
  //   2. the legacy bold `**Current Phase:**` field (what `verify.cts:2109-
  //      2111` originally matched, and what pre-template-migration STATE.md
  //      fixtures still use).
  //   3. the current template's bare `Phase: [X] of [Y]` field.
  // A document carrying several is read the same way `resolveStatePhase`
  // reads it elsewhere — frontmatter first, then body, in that order.
  const frontmatterCurrentPhase = stateFieldValue(frontmatter, body, 'current_phase', null);
  const legacyCurrentPhaseLabel = stateFieldValue(frontmatter, section ?? body, null, 'Current Phase', {
    scope: currentPositionScope,
  });
  const templateCurrentPhaseLabel = stateFieldValue(frontmatter, section ?? body, null, 'Phase', {
    scope: currentPositionScope,
  });
  const currentPhaseLabel = {
    value:
      frontmatterCurrentPhase.value ?? legacyCurrentPhaseLabel.value ?? templateCurrentPhaseLabel.value,
    scope:
      frontmatterCurrentPhase.value !== null
        ? frontmatterCurrentPhase.scope
        : legacyCurrentPhaseLabel.value !== null
          ? legacyCurrentPhaseLabel.scope
          : templateCurrentPhaseLabel.scope,
  };
  const stateStatus = stateFieldValue(frontmatter, section ?? body, 'status', 'Status', {
    scope: currentPositionScope,
  });
  const statePhaseTokens = {
    value: [...content.matchAll(new RegExp(`[Pp]hase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`, 'g'))].map(
      (m) => m[1],
    ),
    scope: SCOPE.COMPLETE,
  };

  return { currentPhaseLabel, statePhaseTokens, stateStatus };
}

/**
 * Resolve `config` — the parsed `.planning/config.json`, preserving the same
 * three-way distinction `cmdValidateHealth` (`src/verify.cts` W003/E005)
 * already makes without going through `loadConfig` (which collapses that
 * distinction): absent is a real non-answer — `{value: null, scope:
 * UNREADABLE, exists: false}`, no `warnUnusableInput` call, mirrors
 * `buildCurrentPhaseLabel`'s treatment of an absent STATE.md; present but
 * unparseable JSON IS corruption — `{value: null, scope: UNREADABLE, exists:
 * true}`, `warnUnusableInput(CONFIG_UNREADABLE)` fires exactly once, so a
 * later health-diagnostic rule can tell "config.json not found" (W003,
 * repairable via `createConfig`) apart from "config.json: JSON parse error"
 * (E005, repairable via `resetConfig`) — the `exists` flag is exactly that
 * discriminator. `config.json` is root-scoped (`planningRoot`), NOT
 * workstream-scoped (`planningPaths(cwd).config` would resolve under
 * `.planning/workstreams/<ws>/` instead) — see verify.cts's own
 * rootBase-vs-wsBase split at cmdValidateHealth's top.
 */
function buildConfigField(cwd: string): { value: Record<string, unknown> | null; scope: Scope; exists: boolean } {
  const configPath = path.join(planningRoot(cwd), 'config.json');
  if (!fs.existsSync(configPath)) {
    return { value: null, scope: SCOPE.UNREADABLE, exists: false };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { value: parsed, scope: SCOPE.COMPLETE, exists: true };
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.CONFIG_UNREADABLE, source: configPath });
    return { value: null, scope: SCOPE.UNREADABLE, exists: true };
  }
}

/**
 * Resolve `agentInstall` — wraps `checkAgentsInstalled(runtime, cwd)` with
 * the same `runtime` `cmdValidateHealth` resolves (`resolveRuntime(cwd)`,
 * its `_slashRuntime`). Not `.planning/`-sourced (see design doc). `scope`
 * is `COMPLETE` whenever the scan itself ran, even when it reports missing
 * or incomplete agents — that is a real answer, not a non-answer.
 * `UNREADABLE` only if the scan itself throws, mirroring cmdValidateHealth's
 * own try/catch around this same call (there, the exception is swallowed as
 * "non-blocking"; here it is surfaced via `scope` instead of silently
 * dropped, since a snapshot field has nowhere else to carry that fact).
 */
function buildAgentInstallField(cwd: string): { value: ReturnType<typeof checkAgentsInstalled>; scope: Scope } {
  const runtime = resolveRuntime(cwd);
  try {
    return { value: checkAgentsInstalled(runtime, cwd), scope: SCOPE.COMPLETE };
  } catch {
    return {
      value: {
        agents_installed: false,
        missing_agents: [],
        installed_agents: [],
        incomplete_agents: [],
        agents_dir: '',
        agent_runtime: runtime,
      },
      scope: SCOPE.UNREADABLE,
    };
  }
}

/**
 * Resolve `worktreeHealth` — wraps `inspectWorktreeHealth(cwd, { staleAfterMs
 * }, deps)` with the exact same arguments `cmdValidateHealth` passes
 * (`src/verify.cts` W017/W020/W027 call sites): a 1-hour staleness window,
 * and the raw `execGit`/`fs.existsSync`/`fs.statSync` seam (not
 * `worktree-safety.cts`'s own `execGitDefault` wrapper). Not
 * `.planning/`-sourced (see design doc). `scope` is `COMPLETE` only when the
 * underlying `git worktree list` scan itself succeeded (`ok: true`) — a
 * timed-out or failed scan (`ok: false`, mirroring W020's degraded-check
 * report) or a thrown exception (mirrors cmdValidateHealth's own
 * "git worktree not available or not a git repo — skip silently" catch)
 * both degrade to `UNREADABLE` with an empty findings array, since neither
 * case has real per-worktree data to report. `reason` carries
 * `inspectWorktreeHealth`'s own discriminator ('ok' | 'git_timed_out' |
 * 'git_list_failed' | 'not_a_git_repo') straight through — NOT discarded —
 * so `checkW020` (`src/health-diagnostic-rules/worktree-health.cts`) can
 * reproduce `verify.cts:2202-2217`'s exact branching: it warns on
 * 'git_timed_out' or 'git_list_failed' but stays silent on 'not_a_git_repo'
 * (a `.planning/`-only fixture/tmp dir with no git repo at all is not a
 * degraded scan). A thrown exception reports 'exception', which also stays
 * silent, matching the original's catch-all "skip silently" comment.
 */
function buildWorktreeHealthField(cwd: string): { value: ReturnType<typeof inspectWorktreeHealth>['findings']; scope: Scope; reason: string } {
  try {
    const result = inspectWorktreeHealth(
      cwd,
      { staleAfterMs: 60 * 60 * 1000 },
      { execGit, existsSync: fs.existsSync, statSync: fs.statSync },
    );
    if (!result.ok) {
      return { value: [], scope: SCOPE.UNREADABLE, reason: result.reason };
    }
    return { value: result.findings, scope: SCOPE.COMPLETE, reason: result.reason };
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE, reason: 'exception' };
  }
}

// ─── Phase 11 (#3309) "Rule table organization" builders ────────────────────
// Each relocates (not reinvents) an existing `verify.cts` derivation. See the
// design doc's "Rule table organization" table for the exact source lines.

/**
 * Resolve `projectSections` — the `##`-level section headings actually
 * present in `.planning/PROJECT.md`, as a plain list (NOT filtered against a
 * required-sections list — the caller, the future W001/E002 rules, do that
 * comparison). Relocates the read+parse half of `verify.cts:1681-1691`
 * (E002/W001), generalized from "does the file include these three fixed
 * strings" to "what headings does the file actually have."
 *
 * PROJECT.md is root-scoped (`planningRoot(cwd)`), NOT workstream-scoped —
 * mirrors `cmdValidateHealth`'s own `projectPath = path.join(rootBase,
 * 'PROJECT.md')` (`verify.cts:1649`), the same root-vs-workstream split
 * `buildConfigField` already documents for config.json.
 *
 * Same `exists`-discriminator shape as `config`: absent file is a real
 * non-answer (`{value: null, scope: UNREADABLE, exists: false}`, no
 * `warnUnusableInput`); present but unreadable IS corruption —
 * `{value: null, scope: UNREADABLE, exists: true}`,
 * `warnUnusableInput(PROJECT_UNREADABLE)` fires exactly once, mirroring
 * `buildConfigField`'s treatment of a present-but-unparseable config.json.
 */
function buildProjectSectionsField(cwd: string): { value: string[] | null; scope: Scope; exists: boolean } {
  const projectPath = path.join(planningRoot(cwd), 'PROJECT.md');
  if (!fs.existsSync(projectPath)) {
    return { value: null, scope: SCOPE.UNREADABLE, exists: false };
  }
  let content: string;
  try {
    content = fs.readFileSync(projectPath, 'utf-8');
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.PROJECT_UNREADABLE, source: projectPath });
    return { value: null, scope: SCOPE.UNREADABLE, exists: true };
  }
  const value = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  return { value, scope: SCOPE.COMPLETE, exists: true };
}

/**
 * Resolve `roadmapDeclaredPhases` — every phase id ROADMAP.md declares
 * (heading-style AND checklist-style, not filtered to disk presence), each
 * paired with the milestone-version section it was found under (`null` when
 * found outside any versioned section). Backs W006/W007 (declared-phase
 * half) and W021(2288)/W026(2392) (milestone-attribution half).
 *
 * The declared-phase-id half reuses `buildRoadmapPhaseVariants`
 * (`validate.cts:136`, already imported by `verify.cts:12` — genuine existing
 * reuse). The milestone-attribution half relocates
 * `checkMilestonePrefixMismatches`'s `sectionRx`-based section walk
 * (`verify.cts:1429-1459`, local/unexported there), generalized from "record
 * only the mismatches" to "record every attribution" — this field exposes
 * the parsed fact; the future W021/W026 rules make the mismatch judgment.
 */
function buildRoadmapDeclaredPhasesField(
  roadmapPath: string,
): { value: { phaseId: string; milestone: string | null }[]; scope: Scope } {
  if (!fs.existsSync(roadmapPath)) {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }

  const { roadmapPhases } = buildRoadmapPhaseVariants(content);

  const milestoneByPhase = new Map<string, string>();
  const sectionRx = /^#{1,3}\s+(?:\[[^\]]{1,200}\]\s*)?.*v(\d+\.\d+)/gim;
  const sections: { version: string; start: number; end: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRx.exec(content)) !== null) {
    if (sections.length > 0) sections[sections.length - 1].end = sm.index;
    sections.push({ version: `v${sm[1]}`, start: sm.index, end: content.length });
  }
  const phaseRx = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
  for (const section of sections) {
    const sectionContent = content.slice(section.start, section.end);
    phaseRx.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRx.exec(sectionContent)) !== null) {
      if (!milestoneByPhase.has(pm[1])) milestoneByPhase.set(pm[1], section.version);
    }
  }

  const value = [...roadmapPhases].map((phaseId) => ({
    phaseId,
    milestone: milestoneByPhase.get(phaseId) ?? null,
  }));
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `roadmapPhaseCheckboxes` — parsed `[x]`/`[ ]` checkbox state per
 * phase from ROADMAP.md's progress-table region, keyed by phase id. Backs
 * W011.
 *
 * Relocates and generalizes `verify.cts`'s W011 block (`verify.cts:2104-
 * 2134`): that call site builds ONE hardcoded `phaseCheckboxRe` testing a
 * single target phase id (STATE's current phase) for a `[x]` match. This
 * builder is the same regex shape, generalized to CAPTURE both the check
 * character and the phase id instead of interpolating one fixed target, so
 * every declared checkbox is recorded, not just one.
 *
 * NOT a re-derivation of `isPhaseComplete` (`verification.cts:557`, ADR-3180
 * §7.4, disk-strict): that owner explicitly refuses to consult the ROADMAP
 * checkbox at all when DECIDING phase completion (`verification.cts:536-
 * 537`). This field only exposes what the checkbox literally says, for a
 * diagnostic (W011) whose entire purpose is flagging when the two DISAGREE —
 * reading the data is not re-litigating who is authoritative.
 */
function buildRoadmapPhaseCheckboxesField(
  roadmapPath: string,
): { value: Record<string, boolean>; scope: Scope } {
  if (!fs.existsSync(roadmapPath)) {
    return { value: {}, scope: SCOPE.UNREADABLE };
  }
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return { value: {}, scope: SCOPE.UNREADABLE };
  }

  const checkboxRe = new RegExp(
    `-\\s*\\[([xX ])\\].*?Phase\\s+0*(${PHASE_NUMBER_TOKEN_SOURCE})${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
    'gi',
  );
  const value: Record<string, boolean> = {};
  let m: RegExpExecArray | null;
  while ((m = checkboxRe.exec(content)) !== null) {
    value[m[2]] = m[1].toLowerCase() === 'x';
  }
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `researchValidationStatus` — per phase directory, whether its
 * `*-RESEARCH.md` contains the literal heading `## Validation Architecture`,
 * and whether a `*-VALIDATION.md` file exists in the same directory. Backs
 * W009.
 *
 * Relocates the file-naming convention `verify.cts:1967-1990` (W009) uses to
 * find "the" RESEARCH.md / VALIDATION.md in a phase dir: a flat,
 * non-recursive `readdirSync` of the phase dir, then the first entry whose
 * name ends `-RESEARCH.md` / any entry ending `-VALIDATION.md`. Computed for
 * EVERY phase dir unconditionally (verify.cts's W009 only reads RESEARCH.md
 * when `hasResearch && !hasValidation`; this field exposes both booleans
 * regardless, so the future W009 rule does its own `hasResearch &&
 * hasValidationArchitecture && !hasValidationMd` check against parsed data,
 * not raw text).
 *
 * `scope` mirrors `phaseDirs.scope` (the caller-supplied enumeration): a
 * per-directory read failure degrades that single entry's booleans to
 * `false` and is silently skipped, mirroring `verify.cts`'s own
 * `catch { intentionally empty }` around this exact read — this is a
 * deliberate fail-open match to the pre-migration behavior, not a scope
 * degradation, since the original never surfaced these failures either.
 */
function buildResearchValidationStatusField(
  phasesDir: string,
  phaseDirNames: string[],
  enumerationScope: Scope,
): {
  value: { dir: string; hasValidationArchitecture: boolean; hasValidationMd: boolean }[];
  scope: Scope;
} {
  const value = phaseDirNames.map((dir) => {
    const fullPhaseDir = path.join(phasesDir, dir);
    let files: string[];
    try {
      files = fs.readdirSync(fullPhaseDir);
    } catch {
      return { dir, hasValidationArchitecture: false, hasValidationMd: false };
    }
    // #3511: scope the raw listing to this phase dir before the two
    // phase-numbered-artifact predicates, so a stray cross-phase
    // -RESEARCH.md/-VALIDATION.md sitting in the wrong directory cannot flip
    // this phase's flags — mirrors core-utils.cts's getPhaseFileStats.
    const scopedFiles = scopeToPhase(files, dir);
    const researchFile = scopedFiles.find((f) => f.endsWith('-RESEARCH.md'));
    const hasValidationMd = scopedFiles.some((f) => f.endsWith('-VALIDATION.md'));
    let hasValidationArchitecture = false;
    if (researchFile) {
      try {
        const researchContent = fs.readFileSync(path.join(fullPhaseDir, researchFile), 'utf-8');
        hasValidationArchitecture = researchContent.includes('## Validation Architecture');
      } catch {
        /* intentionally empty — mirrors verify.cts:1986-1988's own silent skip */
      }
    }
    return { dir, hasValidationArchitecture, hasValidationMd };
  });
  return { value, scope: enumerationScope };
}

/**
 * Resolve `milestoneArchiveStatus` — `archivedVersions` (versions with a
 * `milestones/<ver>-ROADMAP.md` snapshot file present) and `documentedVersions`
 * (`## <version>` headings already present in MILESTONES.md). Backs W018.
 *
 * Relocates `verify.cts:2301-2335` (W018)'s directory-scan glob
 * (`^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$` against a flat, non-recursive
 * `readdirSync` of `.planning/milestones/`) and its MILESTONES.md
 * heading-membership check, generalized from "is THIS archived version's
 * heading present" to "list every `## <version>` heading MILESTONES.md has."
 *
 * Confirmed NOT a fit for `listArchiveVersionDirs`
 * (`phase-locator.cts:127`): that function scans `milestones/*-phases/`
 * DIRECTORIES, a different target than this field's `milestones/*-ROADMAP.md`
 * FILES — reusing it here would silently answer the wrong question.
 *
 * Root-scoped (`planningRoot(cwd)`), matching `verify.cts`'s own
 * `rootBase`-based `milestonesPath`/`milestonesArchiveDir`.
 */
function buildMilestoneArchiveStatusField(
  cwd: string,
): { value: { archivedVersions: string[]; documentedVersions: string[] }; scope: Scope } {
  const rootBase = planningRoot(cwd);
  const milestonesArchiveDir = path.join(rootBase, 'milestones');
  const milestonesPath = path.join(rootBase, 'MILESTONES.md');

  let archivedVersions: string[] = [];
  let scope: Scope = SCOPE.COMPLETE;
  if (fs.existsSync(milestonesArchiveDir)) {
    try {
      const archiveFiles = fs.readdirSync(milestonesArchiveDir);
      archivedVersions = archiveFiles
        .map((f) => f.match(/^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
    } catch {
      scope = SCOPE.UNREADABLE;
    }
  }

  let documentedVersions: string[] = [];
  if (fs.existsSync(milestonesPath)) {
    try {
      const registryContent = fs.readFileSync(milestonesPath, 'utf-8');
      documentedVersions = [...registryContent.matchAll(/^##\s+(v\d+\.\d+(?:\.\d+)?)/gm)].map(
        (m) => m[1],
      );
    } catch {
      scope = worstScope(scope, SCOPE.UNREADABLE);
    }
  }

  return { value: { archivedVersions, documentedVersions }, scope };
}

/**
 * Resolve `planningRootFiles` — plain listing of file (not directory) names
 * directly under `.planning/` root. Backs W019.
 *
 * Pairs with the existing exported `isCanonicalPlanningFile` predicate
 * (`artifacts.cts:43`) — but per the design doc, that predicate is called by
 * the future W019 RULE per filename, not by this builder; this field only
 * needs to BE the raw filename list.
 */
function buildPlanningRootFilesField(cwd: string): { value: string[]; scope: Scope } {
  try {
    const entries = fs.readdirSync(planningRoot(cwd), { withFileTypes: true });
    return { value: entries.filter((e) => e.isFile()).map((e) => e.name), scope: SCOPE.COMPLETE };
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
}

/**
 * Resolve `allPhaseDirNames` — every directory name directly under the
 * active `phases/` root, UNFILTERED by `listMilestonePhaseDirs`'s
 * current-milestone-window membership test (unlike `phaseDirs`). Backs
 * W007 (see the field's own doc comment on `PlanningSnapshot` for why
 * `phaseDirs` cannot). An absent `phases/` root is a real empty, not a
 * failure (mirrors `listMilestonePhaseDirs`'s own treatment); a present but
 * unreadable root degrades to `UNREADABLE` with an empty list.
 */
function buildAllPhaseDirNamesField(phasesDir: string): { value: string[]; scope: Scope } {
  if (!fs.existsSync(phasesDir)) return { value: [], scope: SCOPE.COMPLETE };
  try {
    const value = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return { value, scope: SCOPE.COMPLETE };
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
}

/**
 * Resolve `archivedPhaseTokens` — every phase-number token belonging to a
 * directory directly under any `.planning/milestones/*-phases/` archive.
 * Backs W002's archived-phase exemption (#3652); see the field's own doc
 * comment on `PlanningSnapshot`. Mirrors `verify.cts`'s
 * `forEachArchivedPhaseToken` + `listMilestoneArchiveDirs` exactly — same
 * `MILESTONE_ARCHIVE_DIR_RE` archive-dir filter, same `PHASE_TOKEN_FROM_DIR_RE`
 * per-entry match, same `stripProjectCodePrefix` normalization — just
 * collecting into a value array instead of an `onPhase` callback. An absent
 * `milestones/` dir is a real empty (no archives yet), not a failure; a
 * present-but-unreadable per-archive-dir entry is silently skipped, mirroring
 * `forEachArchivedPhaseToken`'s own per-directory `catch { /* absent/unreadable *\/ }`.
 */
function buildArchivedPhaseTokensField(planBase: string): { value: string[]; scope: Scope } {
  const milestonesDir = path.join(planBase, 'milestones');
  let archiveDirs: string[];
  try {
    archiveDirs = fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && MILESTONE_ARCHIVE_DIR_RE.test(e.name))
      .map((e) => path.join(milestonesDir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { value: [], scope: SCOPE.COMPLETE };
    return { value: [], scope: SCOPE.UNREADABLE };
  }

  const value: string[] = [];
  for (const archiveDir of archiveDirs) {
    try {
      const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(PHASE_TOKEN_FROM_DIR_RE);
        if (m) value.push(stripProjectCodePrefix(m[1]));
      }
    } catch {
      /* archive dir absent/unreadable — mirrors forEachArchivedPhaseToken */
    }
  }
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `currentMilestoneRoadmapPhaseIds` — every phase-number token found
 * in ROADMAP.md's content once scoped to the CURRENT milestone via
 * `extractCurrentMilestone(content, cwd)`. Backs W026's archive-tolerant
 * unstarted-phase scan; see the field's own doc comment on `PlanningSnapshot`
 * for why `roadmapDeclaredPhases` cannot serve this. An absent/unreadable
 * ROADMAP.md degrades to an empty list, mirroring every other
 * ROADMAP-sourced field's absent-file handling.
 */
function buildCurrentMilestoneRoadmapPhaseIdsField(
  cwd: string,
  roadmapPath: string,
): { value: string[]; scope: Scope } {
  if (!fs.existsSync(roadmapPath)) return { value: [], scope: SCOPE.UNREADABLE };
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
  const scoped = extractCurrentMilestone(content, cwd);
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal
  // mirror of OPTIONAL_PHASE_TAG_SOURCE) — verbatim from `verify.cts:2366`.
  const phasePattern = new RegExp(
    `#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`,
    'gi',
  );
  const value = [...scoped.matchAll(phasePattern)].map((m) => m[1]);
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `perPhasePlanNumbering`/`perPhaseOrphanSummaries`/
 * `perPhaseWaveMissingPlans` — Phase 12 (#3310, ADR-3180 §8.4), backing
 * C002/C003/C004. One shared per-phase-directory scan serves all three
 * fields (mirrors `buildStateFields`'s "one builder, several named outputs"
 * convention above): each of the three questions below reads the exact same
 * `scanPhasePlans(fullPhaseDir)` result, so scanning each phase directory
 * three separate times (one function per field) would triple the
 * `readdirSync`/frontmatter-read cost for zero behavioral gain — the three
 * subjects are independent QUESTIONS, not independent SCANS.
 *
 * Enumerated over `allPhaseDirNames`, NOT `phaseDirs` (the
 * current-milestone-windowed twin): the pre-migration `cmdValidateConsistency`
 * (`verify.cts:1521-1608`) walks `collectPhaseRoots(planBase)`'s flat
 * `phases/` root via a plain, unfiltered `readdirSync` — every phase
 * directory on disk, not just the ones the current milestone window
 * resolves as "in scope" — exactly the un-windowed shape `allPhaseDirNames`
 * already exposes for W007 (see that field's own doc comment). Using the
 * windowed `phaseDirs` here would silently narrow C002/C003/C004's coverage
 * relative to the behavior being relocated. Disclosed fidelity note: this
 * does NOT walk `collectPhaseRoots`'s second root (an active archived
 * milestone's `<ver>-phases/` directory) — `allPhaseDirNames` is scoped to
 * the flat `phases/` root only, the same scope every other
 * `allPhaseDirNames`-sourced field already carries.
 *
 * QUESTION 1 — `perPhasePlanNumbering`: the sorted list of `-NN-PLAN.md`
 * sequence numbers physically present (superseded or not — a retired plan
 * still occupied a number), from `allPlanFiles` via the exact
 * `/-(\d{2})-PLAN\.md$/` regex `verify.cts:1558` already uses. This field
 * exposes the raw per-phase number list only; the future C002 rule computes
 * the gap itself.
 *
 * QUESTION 2 — `perPhaseOrphanSummaries`: every SUMMARY.md with no matching
 * LIVE PLAN.md, via `findOrphanSummaries(planFiles, summaryFiles)`
 * (`core-utils.cjs`, `verify.cts:1584` — the same owner
 * `src/health-diagnostic-rules/phase-structure.cts`'s I001 rule already
 * consumes indirectly via `PhaseSnapshot.planCount`/`summaryCount`, for the
 * INVERSE question). Uses the live (superseded-excluded) `planFiles`, not
 * `allPlanFiles` — a superseded plan's summary is still an orphan.
 *
 * QUESTION 3 — `perPhaseWaveMissingPlans`: every LIVE plan (`planFiles`,
 * same live set as Question 2 — a superseded plan legitimately carries no
 * `wave`) whose frontmatter has no `wave` key, via `extractFrontmatter`,
 * mirroring `verify.cts:1596-1603` exactly. A plan file that cannot be read
 * is silently skipped, mirroring `cmdValidateConsistency`'s own outer
 * `catch { intentionally empty }` (`verify.cts:1605-1607`) around this exact
 * loop — a fail-open match to the pre-migration behavior, not a new scope
 * degradation.
 */
function buildPerPhasePlanScanFields(
  phasesDir: string,
  phaseDirNames: string[],
  enumerationScope: Scope,
): {
  perPhasePlanNumbering: { value: { phaseDir: string; planNums: number[] }[]; scope: Scope };
  perPhaseOrphanSummaries: { value: { phaseDir: string; orphanSummary: string }[]; scope: Scope };
  perPhaseWaveMissingPlans: { value: { phaseDir: string; plan: string }[]; scope: Scope };
} {
  const planNumbering: { phaseDir: string; planNums: number[] }[] = [];
  const orphanSummaries: { phaseDir: string; orphanSummary: string }[] = [];
  const waveMissingPlans: { phaseDir: string; plan: string }[] = [];

  for (const phaseDir of phaseDirNames) {
    const fullPhaseDir = path.join(phasesDir, phaseDir);
    const { allPlanFiles, planFiles, summaryFiles } = scanPhasePlans(fullPhaseDir);

    const planNums = allPlanFiles
      .map((p) => {
        const m = p.match(/-(\d{2})-PLAN\.md$/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    planNumbering.push({ phaseDir, planNums });

    for (const orphan of findOrphanSummaries(planFiles, summaryFiles)) {
      orphanSummaries.push({ phaseDir, orphanSummary: orphan });
    }

    for (const plan of planFiles) {
      try {
        const planFilePath = path.join(fullPhaseDir, plan);
        const content = fs.readFileSync(planFilePath, 'utf-8');
        const fmData = extractFrontmatter(content, planFilePath);
        if (!fmData['wave']) waveMissingPlans.push({ phaseDir, plan });
      } catch {
        /* unreadable plan file — mirrors verify.cts:1605-1607's own silent skip */
      }
    }
  }

  return {
    perPhasePlanNumbering: { value: planNumbering, scope: enumerationScope },
    perPhaseOrphanSummaries: { value: orphanSummaries, scope: enumerationScope },
    perPhaseWaveMissingPlans: { value: waveMissingPlans, scope: enumerationScope },
  };
}

/**
 * Build the full `.planning/` projection for `cwd`. Composes the six §7
 * owners named in the design doc's "Owners consumed" table, plus (Phase 11,
 * #3309) the three additive subject-surface fields `config`/`agentInstall`/
 * `worktreeHealth` — no re-derivation, no new semantic answer beyond what
 * their respective owners already compute. See the design doc for the
 * behavior table and rejected alternatives.
 */
function buildPlanningSnapshot(cwd: string): PlanningSnapshot {
  const paths = planningPaths(cwd);
  const milestone = getMilestoneInfo(cwd);
  const phaseDirs = listMilestonePhaseDirs(paths.phases, { cwd });

  const phasesValue = phaseDirs.value.map((dir) => buildPhaseSnapshot(paths.phases, dir));
  const stateFields = buildStateFields(paths.state);
  const allPhaseDirNames = buildAllPhaseDirNamesField(paths.phases);
  const perPhasePlanScanFields = buildPerPhasePlanScanFields(
    paths.phases,
    allPhaseDirNames.value,
    allPhaseDirNames.scope,
  );

  return {
    cwd: path.resolve(cwd),
    milestone,
    phaseDirs,
    phases: {
      value: phasesValue,
      scope: worstScope(phaseDirs.scope, ...phasesValue.map((p) => p.scope)),
    },
    currentPhaseLabel: stateFields.currentPhaseLabel,
    config: buildConfigField(cwd),
    agentInstall: buildAgentInstallField(cwd),
    worktreeHealth: buildWorktreeHealthField(cwd),
    projectSections: buildProjectSectionsField(cwd),
    statePhaseTokens: stateFields.statePhaseTokens,
    stateStatus: stateFields.stateStatus,
    roadmapDeclaredPhases: buildRoadmapDeclaredPhasesField(paths.roadmap),
    roadmapPhaseCheckboxes: buildRoadmapPhaseCheckboxesField(paths.roadmap),
    researchValidationStatus: buildResearchValidationStatusField(paths.phases, phaseDirs.value, phaseDirs.scope),
    milestoneArchiveStatus: buildMilestoneArchiveStatusField(cwd),
    planningRootFiles: buildPlanningRootFilesField(cwd),
    allPhaseDirNames,
    archivedPhaseTokens: buildArchivedPhaseTokensField(paths.planning),
    currentMilestoneRoadmapPhaseIds: buildCurrentMilestoneRoadmapPhaseIdsField(cwd, paths.roadmap),
    perPhasePlanNumbering: perPhasePlanScanFields.perPhasePlanNumbering,
    perPhaseOrphanSummaries: perPhasePlanScanFields.perPhaseOrphanSummaries,
    perPhaseWaveMissingPlans: perPhasePlanScanFields.perPhaseWaveMissingPlans,
  };
}

export = {
  buildPlanningSnapshot,
  worstScope,
};
