/**
 * Init — Compound init commands for workflow bootstrapping
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/init.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execGit, platformWriteSync, platformReadSync, toNativePath, posixNormalize } from './shell-command-projection.cjs';
import { realClock } from './clock.cjs';
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoader = require('./config-loader.cjs');
import { findProjectRoot } from './project-root.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-resolver.cjs is an export= CommonJS module
import modelResolver = require('./model-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocator = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParser = require('./roadmap-parser.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtils = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseId = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
import worktreeSafety = require('./worktree-safety.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
import { maskIfSecret } from './secrets.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import scanPhasePlans = require('./plan-scan.cjs');
import { stateExtractField } from './state-document.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { resolveReportedRuntime } from './host-runtime-detection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- commands.cjs is an export= CommonJS module
import commandsMod = require('./commands.cjs');
import { validatePath, loadTrustedGlobalRoots } from './security.cjs';
import { getGlobalSkillDir, getGlobalSkillDisplayPath, getGlobalSkillsBase, getGlobalConfigDir } from './runtime-homes.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat-predicate.cjs is an export= CommonJS module
import uatPredicateMod = require('./uat-predicate.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheck = require('./agent-install-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- section-manifest.cjs is compiled from section-manifest.cts's named exports; imported as a namespace to read selectSections/SelectableSection/InvocationFacts off module.exports directly (#2932).
import sectionManifest = require('./section-manifest.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loop-resolver.cjs is an export= CommonJS module
import loopResolverMod = require('./loop-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- capability-loader.cjs is compiled from capability-loader.cts's named exports; imported as a namespace to read loadRegistry off module.exports directly.
import capabilityLoaderMod = require('./capability-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- capability-state.cjs is an export= CommonJS module
import capabilityStateMod = require('./capability-state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- docs.cjs is an export= CommonJS module
import docsMod = require('./docs.cjs');
const { detectMonorepoWorkspaces } = docsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- workstream-inventory.cjs is an export= CommonJS module
import workstreamInventoryMod = require('./workstream-inventory.cjs');
const { getOtherActiveWorkstreamInventories } = workstreamInventoryMod;
const { checkAgentsInstalled } = agentInstallCheck;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- git-base-branch.cjs is an export= CommonJS module
import gitBaseBranch = require('./git-base-branch.cjs');
const { gitWorktreeInfoInternal } = gitBaseBranch;
import { makeResolution } from './resolution.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- onboard-projection.cjs is an export= CommonJS module
import onboardProjection = require('./onboard-projection.cjs');
const {
  REQUIRED_CODEBASE_MAP_FILES,
  buildOnboardProjection,
  hasCodeFilesInternal,
  hasPackageFileInternal,
  listCodebaseMapFiles,
} = onboardProjection;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-command-grounding.cjs is an export= CommonJS module
import verifyCommandGrounding = require('./verify-command-grounding.cjs');
const { harvestPriorVerifyCommands } = verifyCommandGrounding;

const { output, error, ERROR_REASON, formatDiagnosticToken } = io;
const { loadConfig, loadConfigResolved } = configLoader;
const { resolveModelInternal, resolveGranularityInternal, assertValidGranularityOverride } = modelResolver;
const { findPhaseInternal, listMilestonePhaseDirs, listAllPhaseDirs } = phaseLocator;
const {
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  stripShippedMilestones,
  extractCurrentMilestone,
} = roadmapParser;
const { pathExistsInternal, generateSlugInternal, toPosixPath } = coreUtils;
const {
  comparePhaseNum,
  normalizePhaseName,
  matchPhaseDirs,
  stripProjectCodePrefix,
  PHASE_NUMBER_TOKEN_SOURCE,
  isForeignPrefixedPhaseQuery,
  isSentinelPhaseId,
  extractPhaseToken,
  scopeToPhase,
  parsePhaseId,
  renderPhaseId,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
} = phaseId;
const { pruneOrphanedWorktrees } = worktreeSafety;

const {
  planningPaths,
  planningDir,
  planningRoot,
  listAvailableWorkstreams,
  peekActiveWorkstream,
  diagnoseUnresolvedActiveWorkstream,
  describeUnresolvedWorkstreamReason,
  findContextMdIn,
  resolvePhaseIdConvention,
} = planningWorkspace;

const { determinePhaseStatus } = commandsMod;
const { extractFrontmatter } = frontmatterMod;
const { isPhaseComplete, resolveVerificationFile, resolveUatFile } = verificationMod;
const { evaluateUatPassed } = uatPredicateMod;
const { resolveLoopHooks } = loopResolverMod;
const { loadRegistry } = capabilityLoaderMod;
const { resolveCapabilityRuntimeState } = capabilityStateMod;

// Unused but imported for structural parity
void stripShippedMilestones;

// Accept all bold/colon variants of the Requirements header (#2769)
const REQUIREMENTS_HEADER_RE = /^\*\*Requirements:?\*\*[^\S\n]*:?[^\S\n]*([^\n]*)$/m;

// #2056/#2104: isForeignPrefixedPhaseQuery is imported from phase-id.cts
// (the canonical predicate). parsePhasePrefix is no longer needed locally.
// phaseInfoMatchesExactPrefix and roadmapPhaseMatchesExactPrefix are local
// helpers that post-filter the lookup results for foreign-prefix queries.

function phaseInfoMatchesExactPrefix(
  phaseInfo: Record<string, unknown> | null,
  phase: string,
): boolean {
  const num = phaseInfo?.['phase_number'];
  const numStr = typeof num === 'string' ? num : (typeof num === 'number' ? String(num) : '');
  return numStr.toUpperCase() === phase.toUpperCase();
}

function roadmapPhaseMatchesExactPrefix(
  roadmapPhase: Record<string, unknown> | null,
  phase: string,
): boolean {
  const sectionRaw = roadmapPhase?.['section'];
  const section = typeof sectionRaw === 'string' ? sectionRaw : '';
  return new RegExp(`^#{2,4}\\s*Phase\\s+${escapeRegex(phase)}(?:\\b|\\s|:)`, 'i').test(section);
}

// #2104: shared helpers that wrap findPhaseInternal / getRoadmapPhaseInternal
// with the #2056 foreign-prefix guard, so every init command gets the same
// protection without duplicating the guard logic at each call site.
function guardedFindPhase(
  cwd: string,
  phase: string,
  projectCode: unknown,
): Record<string, unknown> | null {
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
  if (isForeignPrefixedPhaseQuery(phase, projectCode) && !phaseInfoMatchesExactPrefix(phaseInfo, phase)) {
    phaseInfo = null;
  }
  return phaseInfo;
}

function guardedGetRoadmapPhase(
  cwd: string,
  phase: string,
  projectCode: unknown,
): Record<string, unknown> | null {
  let roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
  if (isForeignPrefixedPhaseQuery(phase, projectCode) && !roadmapPhaseMatchesExactPrefix(roadmapPhase, phase)) {
    roadmapPhase = null;
  }
  return roadmapPhase;
}

// #2994: `phase_slug` is re-derived from a roadmap-only `phase_name` (no disk
// directory exists yet) identically at every synthetic-fallback call site
// below — factored out once so the slugification formula itself cannot drift.
function slugifyPhaseName(phaseName: string | null): string | null {
  // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
  // (generateSlugInternal, core-utils.cts) rather than re-implementing it.
  // `maxLen: null` preserves this site's pre-migration untruncated contract —
  // the 60-char default would collapse two distinct >60-char phase names onto
  // the same reported phase_slug.
  return phaseName ? coreUtils.generateSlugInternal(phaseName, null) : null;
}

/**
 * #2994 (review finding, DEFECT.GENERATIVE-FIX): shared archived/not-found
 * fallback applied identically by `cmdInitExecutePhase`, `cmdInitPlanPhase`,
 * `cmdInitVerifyWork`, `cmdInitCodeReview`, `cmdInitReview`, and
 * `cmdInitDiscussPhaseAssumptions` — 6 call sites previously reproducing the
 * exact same two-branch control flow verbatim (only the synthetic
 * replacement object's field set differs per caller, supplied here via
 * `buildFallback`). `cmdInitPhaseOp` is deliberately left untouched (CRITICAL
 * blast radius, 179 dependents) even though it follows the same shape, since
 * its own fallback object differs by one field (`has_reviews` absent) and is
 * not a byte-identical copy.
 *
 * Behavior-preserving by construction: every original call site either (a)
 * unconditionally computed `roadmapPhase` once up front and then applied
 * `phaseInfo?.archived && roadmapPhase?.found -> null` followed by
 * `!phaseInfo && roadmapPhase?.found -> fallback`, or (b) computed
 * `roadmapPhase` lazily inside each of those same two conditions. Because
 * `guardedGetRoadmapPhase` is a pure, side-effect-free read for a given
 * `(cwd, phase, projectCode)` within one command invocation, both shapes
 * return identical results for identical inputs — so passing one
 * unconditionally-resolved `roadmapPhase` in here (mirroring shape (a))
 * reproduces shape (b)'s output exactly, just without the redundant second
 * disk read shape (b) performed when the first branch already resolved it.
 */
function applyRoadmapFallback(
  phaseInfo: Record<string, unknown> | null,
  roadmapPhase: Record<string, unknown> | null,
  buildFallback: (roadmapPhase: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> | null {
  if (phaseInfo?.['archived'] && roadmapPhase?.['found']) {
    phaseInfo = null;
  }
  if (!phaseInfo && roadmapPhase?.['found']) {
    phaseInfo = buildFallback(roadmapPhase);
  }
  return phaseInfo;
}

function listPhaseSummaryFiles(phaseDir: string): string[] {
  return (scanPhasePlans(phaseDir) as unknown as Record<string, string[]>)['summaryFiles'];
}

function listPhasePlanFiles(phaseDir: string): string[] {
  return (scanPhasePlans(phaseDir) as unknown as Record<string, string[]>)['planFiles'];
}

interface PhaseCompletionProjection {
  implementation_complete: boolean;
  verification_status: string;
  verification_passed: boolean;
  phase_complete: boolean;
  completion_status: string;
  verification_next_action: string;
  verification_next_command: string;
  /**
   * #3057 B3: true when readVerificationStatus's internal staleness check could
   * NOT run to completion (an fs / scanPhasePlans / clock failure) — routing
   * above is unaffected (the pre-existing fail-open contract), but this lets a
   * workflow step distinguish "checked; nothing is stale" from "could not
   * check" instead of silently treating both as the same "not stale" answer.
   * Always present (unlike verification.cts's own optional field) so this
   * projection's shape stays uniform with its sibling boolean fields; false
   * when the staleness check was never reached (e.g. implementation not yet
   * complete) or ran to completion.
   */
  verification_stale_check_indeterminate: boolean;
}


function projectCompletionStatus(
  implementationComplete: boolean,
  phaseComplete: boolean,
): string {
  if (phaseComplete) return 'complete';
  if (implementationComplete) return 'executed';
  return 'incomplete';
}

function buildPhaseCompletionProjection(
  cwd: string,
  phaseNumber: string,
  phaseDir: string | null,
  planCount: number,
  summaryCount: number,
  slashRuntime: string,
): PhaseCompletionProjection {
  // ADR-3180 §7.4 (issue #3186) / DO-NOT-MIGRATE exemption
  // (scripts/lint-completion-predicate-drift.cjs FUNCTION_SCOPED_EXEMPTIONS,
  // declared deviation): `implementation_complete` answers "are the plans
  // done" (a `scanPhasePlans`-shaped different question, per the design's
  // 0.x-split), NOT "is the phase complete" — it is kept for the
  // 'executed'-vs-'planned' disk_status distinction downstream consumers
  // still rely on, which `isPhaseComplete`'s locked `{ complete, verification
  // }` return shape does not carry.
  const implementationComplete = planCount > 0 && summaryCount >= planCount;
  const phaseFullDir = phaseDir ? path.join(cwd, phaseDir) : '';
  // #3168 / ADR-3180 §7.4 (disk-strict, #2957): route through the canonical
  // owner (`src/verification.cts` · `isPhaseComplete`), which calls
  // readVerificationStatus UNCONDITIONALLY — plan count is NOT a
  // precondition. A zero-plan phase with a passing `*-VERIFICATION.md` is
  // complete; init used to gate the read on `implementationComplete` and
  // synthesize a `not_required` sentinel instead, which is the #3168 defect.
  // #2617: the router still owns both the message content and the runtime
  // projection; init passes the phase number it already knows (its phaseDir
  // is unresolved in some branches, where the router could not derive one).
  const completionResult = isPhaseComplete(phaseFullDir, { runtime: slashRuntime, phaseNumber });
  const verificationStatus = completionResult.value.verification;
  const projectedVerificationStatus = verificationStatus.status;
  const projectedVerificationAction = verificationStatus.next_action;
  const verificationPassed = projectedVerificationStatus === 'passed';
  const phaseComplete = completionResult.value.complete;

  return {
    implementation_complete: implementationComplete,
    verification_status: projectedVerificationStatus,
    verification_passed: verificationPassed,
    phase_complete: phaseComplete,
    completion_status: projectCompletionStatus(implementationComplete, phaseComplete),
    verification_next_action: projectedVerificationAction,
    verification_next_command: verificationStatus.next_command,
    // #3057 B3: readVerificationStatus's result carries this flag when its
    // internal staleness check could not run to completion.
    verification_stale_check_indeterminate: 'staleCheckIndeterminate' in verificationStatus
      && verificationStatus.staleCheckIndeterminate === true,
  };
}

function getLatestCompletedMilestone(cwd: string): { version: string; name: string } | null {
  const milestonesPath = path.join(planningRoot(cwd), 'MILESTONES.md');
  const content = platformReadSync(milestonesPath);
  if (content === null) return null;

  const match = content.match(/^##\s+(v[\d.]+)\s+(.+?)\s+\(Shipped:/m);
  if (!match) return null;
  return {
    version: match[1],
    name: match[2].trim(),
  };
}

function withProjectRoot(cwd: string, result: Record<string, unknown>): Record<string, unknown> {
  result['project_root'] = cwd;
  // #3245: the reported agent_runtime gets a host-detection rung below the two explicit sources; every other resolveRuntime caller keeps the old ladder (ADR-2313 scope boundary).
  const activeRuntime = resolveReportedRuntime(cwd);
  const agentStatus = checkAgentsInstalled(activeRuntime, cwd);
  result['agents_installed'] = agentStatus.agents_installed;
  result['missing_agents'] = agentStatus.missing_agents;
  result['agents_dir'] = agentStatus.agents_dir;
  result['agent_runtime'] = agentStatus.agent_runtime;
  const config = loadConfig(cwd);
  if (config.response_language) {
    result['response_language'] = config.response_language;
  }
  if (config.project_code) {
    result['project_code'] = config.project_code;
  }
  const projectMdPath = path.join(planningDir(cwd), 'PROJECT.md');
  const content = platformReadSync(projectMdPath);
  if (content) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      result['project_title'] = h1Match[1].trim();
    }
  }
  return result;
}

interface GitState {
  has_git: boolean;
  git_worktree_root: string | null;
  in_nested_subdir: boolean;
}

function getInitGitState(cwd: string): GitState {
  const info = gitWorktreeInfoInternal(cwd) as unknown as Record<string, unknown>;
  const worktreeRoot = info['worktreeRoot'] as string | null;
  const normalizeForCompare = (p: string): string | null => {
    if (typeof p !== 'string' || p.length === 0) return null;
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(p);
    } catch {
      resolved = path.resolve(p);
    }
    resolved = path.resolve(resolved);
    if (process.platform === 'win32') {
      return toNativePath(resolved).toLowerCase();
    }
    return resolved;
  };

  let inNestedSubdir = false;
  if (info['inside']) {
    let resolvedByGitPrefix = false;
    try {
      const prefixResult = execGit(['rev-parse', '--show-prefix'], { cwd, timeout: 5000 }) as unknown as Record<string, unknown>;
      if (prefixResult['exitCode'] === 0) {
        const prefix = posixNormalize((typeof prefixResult['stdout'] === 'string' ? prefixResult['stdout'] : '').trim());
        inNestedSubdir = prefix.length > 0 && prefix !== '.' && prefix !== './';
        resolvedByGitPrefix = true;
      }
    } catch {
      /* intentionally empty */
    }

    if (!resolvedByGitPrefix) {
      const rootNorm = normalizeForCompare(worktreeRoot!);
      const cwdNorm = normalizeForCompare(cwd);
      if (rootNorm && cwdNorm) {
        if (rootNorm === cwdNorm) {
          inNestedSubdir = false;
        } else {
          const rel = path.relative(rootNorm, cwdNorm);
          const relNorm = toNativePath(rel);
          inNestedSubdir =
            relNorm !== '' &&
            relNorm !== '.' &&
            !relNorm.startsWith('..') &&
            !path.isAbsolute(relNorm);
        }
      } else {
        inNestedSubdir = worktreeRoot !== null;
      }
    }
  }

  if (inNestedSubdir && typeof worktreeRoot === 'string') {
    const toComparableRaw = (p: string) => posixNormalize(p).replace(/\/+$/g, '').toLowerCase();
    if (toComparableRaw(worktreeRoot) === toComparableRaw(String(cwd))) {
      inNestedSubdir = false;
    }
  }

  return {
    has_git: info['inside'] as boolean,
    git_worktree_root: worktreeRoot,
    in_nested_subdir: inNestedSubdir,
  };
}

// #2932 (Phase 5, ADR-1671): shipped, generated artifact — see
// scripts/gen-section-manifest.cjs and gsd-core/workflows/section-manifest.json.
// Resolved the same way model-catalog.cts resolves model-catalog.json: relative
// to the compiled module's own directory (gsd-core/bin/lib -> gsd-core/workflows),
// with a GSD_SECTION_MANIFEST env override so tests can point at a temp fixture
// (missing/malformed-JSON degraded-path coverage) without mutating the shipped
// artifact — the shipped file is a shared, concurrently-read resource across
// parallel test runs and must never be moved/corrupted in place.
const _sectionManifestCandidatePath = (): string =>
  process.env['GSD_SECTION_MANIFEST']
    ? path.resolve(process.env['GSD_SECTION_MANIFEST'])
    : path.resolve(__dirname, '..', '..', 'workflows', 'section-manifest.json');

/** A manifest entry as shipped on disk: {@link sectionManifest.SelectableSection} plus the `read` step-file path. */
interface ManifestSection extends sectionManifest.SelectableSection {
  readonly read: string;
}

/**
 * Defense-in-depth shape check for a manifest entry's `read` field, which is
 * documented as a POSIX-normalized, repo-root-RELATIVE path (never a
 * filesystem escape). Rejects any absolute path (POSIX leading `/`, a
 * Windows drive prefix like `C:\`/`C:/`, or a Windows UNC/rooted path
 * starting with `\`) and any path containing a `..` segment (checked on
 * BOTH separators — the artifact is generated as POSIX-normalized, but this
 * validates the raw field defensively rather than trusting that invariant).
 * `false` here is the only accept path in {@link loadSectionManifestSections};
 * a `true` degrades the WHOLE load to `null`, same as every other shape
 * violation — never throws, never partially loads.
 */
function isUnsafeManifestReadPath(readPath: string): boolean {
  if (readPath.startsWith('/') || readPath.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(readPath)) return true;
  return readPath.split(/[\\/]/).includes('..');
}

/**
 * Loads and shape-validates the generated section manifest, then returns the
 * document-order section array for exactly one named `workflow` (#2992 Phase
 * 6.1: the artifact is now `{ workflows: { <name>: [...] } }`, keyed by
 * `.md` basename — see `scripts/gen-section-manifest.cjs`). Returns `null`
 * — never throws — when the artifact is missing, unreadable, malformed
 * JSON, valid JSON of the wrong shape (INCLUDING the pre-6.1 flat
 * `{sections:[...]}` shape, which must never be mis-attributed to any
 * workflow — design row C4), or when `workflow` has no key in `workflows`.
 * `Object.hasOwn` guards the key lookup so a hostile workflow name
 * (`constructor`, `toString`, `__proto__`) can never resolve via the
 * prototype chain instead of a genuine own key. Each entry's `read` field is
 * additionally validated by {@link isUnsafeManifestReadPath} (rejects an
 * absolute path or a `..` segment) — a single unsafe entry degrades the
 * WHOLE load to `null`, all-or-nothing like every other shape violation.
 */
function loadSectionManifestSections(workflow: string): ManifestSection[] | null {
  try {
    const raw = fs.readFileSync(_sectionManifestCandidatePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const workflows = (parsed as Record<string, unknown>)['workflows'];
    if (workflows === null || typeof workflows !== 'object' || Array.isArray(workflows)) return null;
    if (!Object.hasOwn(workflows, workflow)) return null;
    const sections = (workflows as Record<string, unknown>)[workflow];
    if (!Array.isArray(sections)) return null;
    for (const section of sections) {
      const readValue = (section as Record<string, unknown> | null)?.['read'];
      if (
        !section ||
        typeof section !== 'object' ||
        typeof (section as Record<string, unknown>)['id'] !== 'string' ||
        typeof (section as Record<string, unknown>)['when'] !== 'string' ||
        typeof readValue !== 'string' ||
        isUnsafeManifestReadPath(readValue)
      ) {
        return null;
      }
    }
    return sections as ManifestSection[];
  } catch {
    return null;
  }
}

/**
 * `state:has-prior-phases` ground truth (design doc §Behavior table, regression-gate
 * body: "Skip if: this is the first phase (no prior phases)"): TRUE when at least
 * one OTHER phase directory under `.planning/phases/` contains a `*-VERIFICATION.md`
 * file. Bounded, non-throwing — an unreadable phases directory degrades to `false`
 * rather than surfacing an error from an init query.
 */
function detectHasPriorPhases(cwd: string, phaseInfo: Record<string, unknown> | null): boolean {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const currentDirName = phaseInfo?.['directory']
    ? path.basename(phaseInfo['directory'] as string)
    : null;
  try {
    if (!fs.existsSync(phasesDir)) return false;
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentDirName) continue;
      let files: string[];
      try {
        files = fs.readdirSync(path.join(phasesDir, entry.name));
      } catch {
        continue;
      }
      // #3511-class: scope the raw listing to THIS entry's own phase artifacts
      // before the bare `.some()` predicate runs, so a stray `07-VERIFICATION.md`
      // physically sitting in another phase's directory cannot make that
      // directory appear to have its own verification report.
      const scopedFiles = scopeToPhase(files, entry.name);
      if (scopedFiles.some((f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Strict-boolean, bounded, non-throwing read of a dotted key path from
 * `.planning/config.json` (design rows D7-D10): absent file, unreadable
 * file (fs error), malformed JSON, a non-object intermediate segment, or a
 * present-but-non-boolean value (e.g. the string `"true"`) all degrade to
 * `false` — strict `=== true`, never coerced, mirrors `detectHasPriorPhases`'s
 * degrade-to-false discipline. `keyPath` is always a fixed literal supplied
 * by this module, never attacker/user input, so a plain bracket traversal
 * carries no prototype hazard here.
 */
function readConfigJsonBoolean(cwd: string, keyPath: readonly string[]): boolean {
  try {
    const raw = fs.readFileSync(path.join(planningDir(cwd), 'config.json'), 'utf8');
    let cursor: unknown = JSON.parse(raw);
    for (const segment of keyPath) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor === true;
  } catch {
    return false;
  }
}

/**
 * Bounded, non-throwing read of a dotted key path from `.planning/config.json`,
 * returning the raw resolved value (any JSON type) or `undefined` on any
 * degraded condition (absent file, unreadable file, malformed JSON, or a
 * non-object intermediate segment) — the generic sibling of
 * {@link readConfigJsonBoolean} for callers that need the actual value
 * (a string like `code_quality.fallow.profile`) rather than a strict
 * boolean coercion. `keyPath` is always a fixed literal supplied by this
 * module, never attacker/user input, so a plain bracket traversal carries
 * no prototype hazard here (same discipline as `readConfigJsonBoolean`).
 */
function readConfigJsonValue(cwd: string, keyPath: readonly string[]): unknown {
  try {
    const raw = fs.readFileSync(path.join(planningDir(cwd), 'config.json'), 'utf8');
    let cursor: unknown = JSON.parse(raw);
    for (const segment of keyPath) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  } catch {
    return undefined;
  }
}

/**
 * `state:fallow-enabled` ground truth (#2994): resolves `code-review.md`'s
 * `structural_pre_pass` fallow config gate — previously re-derived INSIDE the
 * gated section body itself (`gsd_run query config-get code_quality.fallow.*`),
 * which is circular/self-disabling the moment a section is gated on a fact
 * its own body computes (the same hazard `state:chunked-mode` /
 * `state:ui-phase-active` document for a compound condition). Fail-closed
 * default `false` for `enabled`/`mcp`, matching the pre-hoist bash resolver's
 * `2>/dev/null || echo "false"` fallback; `scope`/`profile` default to
 * `"phase"`/`"standard"` matching that same resolver's `|| echo` fallbacks.
 * `maxCrap` mirrors the step body's profile->threshold mapping (minimal=50,
 * strict=15, else standard=30) so the step file never has to re-derive it.
 */
function detectFallowConfig(cwd: string): {
  enabled: boolean;
  scope: string;
  profile: string;
  mcp: boolean;
  maxCrap: number;
} {
  const enabled = readConfigJsonValue(cwd, ['code_quality', 'fallow', 'enabled']) === true;
  const rawScope = readConfigJsonValue(cwd, ['code_quality', 'fallow', 'scope']);
  const scope = typeof rawScope === 'string' && rawScope ? rawScope : 'phase';
  const rawProfile = readConfigJsonValue(cwd, ['code_quality', 'fallow', 'profile']);
  const profile = typeof rawProfile === 'string' && rawProfile ? rawProfile : 'standard';
  const mcp = readConfigJsonValue(cwd, ['code_quality', 'fallow', 'mcp']) === true;
  const maxCrap = profile === 'minimal' ? 50 : profile === 'strict' ? 15 : 30;
  return { enabled, scope, profile, mcp, maxCrap };
}

/**
 * `state:git-create-tag` ground truth (#2994): resolves `complete-milestone.md`'s
 * `git_tag` step config gate — previously re-derived INSIDE a `<config-check>`
 * sub-tag at the top of the step itself (`gsd-tools.cjs query config-get
 * git.create_tag 2>/dev/null || echo "true"`), gating the step's OWN inclusion
 * on a fact only that same step computed. Fail-OPEN default `true` (an unset
 * or missing `git.create_tag` key means "create the tag"), matching the
 * pre-hoist resolver's `|| echo "true"` fallback exactly — this is
 * deliberately the inverse polarity of `detectFallowConfig`'s fail-closed
 * default, mirroring the two source resolvers' own opposite defaults.
 */
function detectGitCreateTag(cwd: string): boolean {
  return readConfigJsonValue(cwd, ['git', 'create_tag']) !== false;
}

/**
 * `state:phase-mvp-mode` ground truth (design doc §Behavior table: ROADMAP.md
 * `**Mode:** mvp` for the CURRENT phase). Bounded, non-throwing — an absent
 * `phaseNumber`, an absent ROADMAP.md, an absent phase heading, or a phase
 * section with no `**Mode:**` line (or a `**Mode:**` value other than the
 * literal `mvp` token, case-insensitively) all degrade to `false` (D11; "a
 * phase with no `**Mode:**` line and an absent ROADMAP are both false, but
 * neither may throw"). Self-contained rather than reusing `phase.cts`'s
 * private `getRoadmapModeForPhase` (unexported, and importing it here would
 * be a cross-module surface change outside this task's scope) — but derived
 * from the SAME extraction primitives (`extractCurrentMilestone`,
 * `PHASE_NUMBER_TOKEN_SOURCE`-adjacent `escapeRegex`) already used by this
 * file's own `cmdInitProgress` MVP-heading scan, so it is not a second
 * ROADMAP-heading parser invented from scratch.
 */
function detectPhaseMvpMode(cwd: string, phaseNumber: string | null): boolean {
  if (!phaseNumber) return false;
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (!fs.existsSync(roadmapPath)) return false;
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);
    const escapedPhase = escapeRegex(phaseNumber);
    const phaseHeader = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'i');
    const headerMatch = content.match(phaseHeader);
    if (!headerMatch || headerMatch.index === undefined) return false;
    const sectionStart = headerMatch.index;
    const rest = content.slice(sectionStart + headerMatch[0].length);
    const nextHeaderMatch = rest.match(/\n#{2,4}\s+Phase\s+\S/i);
    const sectionEnd = nextHeaderMatch
      ? sectionStart + headerMatch[0].length + (nextHeaderMatch.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const modeMatch = section.match(/\*\*Mode:\*\*\s*([^\n]+)/i);
    return modeMatch ? modeMatch[1].trim().toLowerCase() === 'mvp' : false;
  } catch {
    return false;
  }
}

/**
 * `state:ui-phase-active` ground truth (#2994): whether the phase's active
 * `plan:pre` loop hooks include the `ui-phase` step (`capabilities/ui/
 * capability.json`'s `plan:pre` step, `ref.skill: "ui-phase"`, gated on
 * config `workflow.ui_phase`), OR the phase directory already contains a
 * `*-UI-SPEC.md` file. The disjunction is resolved to ONE boolean here —
 * same discipline as `chunkedMode` above — so the `when=` grammar never
 * sees an OR. Mirrors `cmdLoopRenderHooks`'s own registry/capability-state
 * setup (`src/loop-resolver.cts`) rather than reinventing a second loop-hook
 * resolution path. Bounded, non-throwing: any failure in loop-hook /
 * registry / capability-state resolution degrades that half of the OR to
 * `false`, never throws; the UI-SPEC file check is independently bounded.
 */
function detectUiPhaseActive(cwd: string, phaseInfo: Record<string, unknown> | null): boolean {
  let hasActiveUiStep = false;
  try {
    const config = loadConfig(cwd);
    const state = resolveCapabilityRuntimeState(cwd, undefined, config) as {
      capabilities: Array<{ id: string; enabled?: boolean; active: boolean }>;
    };
    const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] });
    const capabilityStatesById = new Map<string, { enabled?: boolean; active: boolean }>();
    for (const cap of state.capabilities || []) {
      capabilityStatesById.set(cap.id, cap);
    }
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config, cwd, capabilityStatesById }) as {
      activeHooks: Array<{ kind?: string; ref?: { skill?: string } }>;
    };
    hasActiveUiStep = resolved.activeHooks.some(
      (h) => h.kind === 'step' && h.ref?.skill === 'ui-phase',
    );
  } catch {
    hasActiveUiStep = false;
  }

  let hasUiSpecFile = false;
  const rawDir = phaseInfo?.['directory'];
  if (typeof rawDir === 'string' && rawDir) {
    try {
      // Re-derive under planningDir(cwd)/phases/<basename> rather than trusting
      // rawDir's own absolute/relative-ness (callers mix both — see the #2376
      // comments elsewhere in this file), same technique as detectHasPriorPhases above.
      const dirName = path.basename(rawDir);
      const files = fs.readdirSync(path.join(planningDir(cwd), 'phases', dirName));
      // #3511-class: scope the raw listing to this phase dir before the
      // phase-numbered -UI-SPEC.md predicate, so a stray cross-phase
      // UI-SPEC file cannot flip this phase's ui-phase-active flag.
      const scopedFiles = scopeToPhase(files, dirName);
      hasUiSpecFile = scopedFiles.some((f) => f.endsWith('-UI-SPEC.md') || f === 'UI-SPEC.md');
    } catch {
      hasUiSpecFile = false;
    }
  }

  return hasActiveUiStep || hasUiSpecFile;
}

/**
 * Builds the `section_manifest` init-bundle field (#2932 Deliverable 2): resolves
 * {@link sectionManifest.InvocationFacts} from this invocation, loads the generated
 * manifest, and partitions it via the pure {@link sectionManifest.selectSections}
 * evaluator. Returns `null` on any degraded condition (missing/malformed artifact,
 * or an unexpected throw from the evaluator itself) — this field is additive and
 * optional, never load-bearing for dispatch (Hyrum's Law: 22 direct init-bundle
 * dependents must be unaffected by its absence).
 *
 * `flags` (D1-D5): built from `options`'s OWN keys, gated on VALUE TRUTHINESS
 * — not merely `!== undefined`. `parseNamedArgs` (src/command-arg-projection.cts)
 * never yields `undefined` for an absent flag of either kind: a value-flag's
 * absence is `null`, a booleanFlag's absence is `false`. An `undefined`-only
 * absence check therefore lets BOTH kinds of absent flag leak into `flags` as
 * present. A present value-flag is always a non-empty string, and a present
 * booleanFlag is always `true` — so skipping any falsy value (`undefined`,
 * `null`, `false`, `''`, `0`) is a safe, single-rule absence test for both
 * flag kinds; `--wave 0` still resolves to `true` via `booleanFlags`, so
 * truthiness never misclassifies a real invocation as absent. `Object.keys`
 * + a plain `new Set()` so a hostile option key (e.g. `constructor`) can
 * never leak via the prototype chain.
 *
 * `needsCodebaseMap` is not computed in this shared facts-assembly scope —
 * `isBrownfield && !hasCodebaseMap` is only meaningful for `new-project`
 * (`cmdInitNewProject` already computes both operands for its own result
 * object). Rather than recomputing it here (a second, divergence-prone
 * codebase-map scan) or widening every call site's positional signature,
 * callers that HAVE the fact pass it via the optional `overrides` param;
 * every other caller passes nothing and gets `undefined` (falsy per
 * `WHEN_PREDICATES`, never invented, never throws).
 */
function buildSectionManifestField(
  cwd: string,
  phaseInfo: Record<string, unknown> | null,
  options: Record<string, unknown>,
  workflow: string,
  overrides: {
    needsCodebaseMap?: boolean;
    fallowEnabled?: boolean;
    gitCreateTag?: boolean;
    planStrategyConverge?: boolean;
    reviewerInstancesConfigured?: boolean;
    autoAdvanceActive?: boolean;
    isMonorepo?: boolean;
    nextChannel?: boolean;
    workstreamActive?: boolean;
    flatMode?: boolean;
    uiPhaseActive?: boolean;
  } = {},
): Record<string, unknown> | null {
  const sections = loadSectionManifestSections(workflow);
  if (!sections) return null;

  const rawPhaseNumber = phaseInfo?.['phase_number'];
  const phaseNumber =
    typeof rawPhaseNumber === 'string'
      ? rawPhaseNumber
      : typeof rawPhaseNumber === 'number'
        ? String(rawPhaseNumber)
        : null;

  const flags = new Set<string>();
  for (const key of Object.keys(options)) {
    if (!options[key]) continue;
    flags.add(`--${key}`);
  }

  // `state:chunked-mode` (#2993) is a disjunction — `--chunked` flag OR
  // `.planning/config.json` `workflow.plan_chunked` — resolved to ONE
  // boolean HERE, in fact computation, never in the `when=` grammar itself
  // (WHEN_PREDICATES['state:chunked-mode'] reads only `facts.chunkedMode`).
  // That separation is what keeps ADR-1671:69's Greenspun guard intact: the
  // grammar still sees exactly one atom with no operator.
  const chunkedMode = flags.has('--chunked') || readConfigJsonBoolean(cwd, ['workflow', 'plan_chunked']);

  const facts: sectionManifest.InvocationFacts = {
    flags,
    phaseNumber,
    hasPriorPhases: detectHasPriorPhases(cwd, phaseInfo),
    worktreesEnabled: readConfigJsonBoolean(cwd, ['workflow', 'use_worktrees']),
    phaseMvpMode: detectPhaseMvpMode(cwd, phaseNumber),
    needsCodebaseMap: overrides.needsCodebaseMap,
    chunkedMode,
    uiPhaseActive: overrides.uiPhaseActive,
    fallowEnabled: overrides.fallowEnabled,
    gitCreateTag: overrides.gitCreateTag,
    planStrategyConverge: overrides.planStrategyConverge,
    reviewerInstancesConfigured: overrides.reviewerInstancesConfigured,
    autoAdvanceActive: overrides.autoAdvanceActive,
    isMonorepo: overrides.isMonorepo,
    nextChannel: overrides.nextChannel,
    workstreamActive: overrides.workstreamActive,
    flatMode: overrides.flatMode,
  };

  try {
    const selection = sectionManifest.selectSections(sections, facts);
    const readById = new Map(sections.map((s) => [s.id, s.read]));
    return {
      workflow,
      included: selection.included,
      excluded: selection.excluded,
      read: selection.included
        .map((id) => readById.get(id))
        .filter((p): p is string => typeof p === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * #3216 review Finding 1: `getMilestoneInfo(cwd).value` unwrap-and-cast was
 * repeated identically (comment included) at five init call sites — factored
 * out once so the cast and its `?? {}` "no milestone resolved" fallback live
 * in exactly one place. Behavior-preserving: same call, same fallback, same
 * cast, for every caller.
 */
function milestoneRecord(cwd: string): Record<string, unknown> {
  return (getMilestoneInfo(cwd).value ?? {}) as unknown as Record<string, unknown>;
}

function cmdInitExecutePhase(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!phase) {
    error('phase required for init execute-phase');
  }

  const config = loadConfig(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  // #3216: getMilestoneInfo now returns a ScopedResult — `.value` carries the
  // MilestoneInfo (or null on any non-COMPLETE scope). NOT display-only: when
  // `branching_strategy === 'milestone'`, `milestone['version']`/`['name']`
  // below feed `branch_name` construction (see the milestone_branch_template
  // branch below), so an unresolved milestone changes the constructed branch
  // name, not merely what gets printed. bracket-access below naturally reads
  // `undefined` when unresolved; the `milestone_version`/`milestone_name`
  // output fields below coerce that to an explicit `null` (#3216 review
  // Finding 2) so the key is never silently omitted from the JSON bundle.
  const milestone = milestoneRecord(cwd);

  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => {
    const phaseName = rp['phase_name'] as string | null;
    return {
      found: true,
      directory: null,
      phase_number: rp['phase_number'],
      phase_name: phaseName,
      phase_slug: slugifyPhaseName(phaseName),
      plans: [],
      summaries: [],
      incomplete_plans: [],
      halted_plans: [],
      blocked_by: {},
      runnable_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
      has_reviews: false,
    };
  });
  const reqMatch = (roadmapPhase?.['section'] as string | undefined)?.match(REQUIREMENTS_HEADER_RE);
  const reqExtracted = reqMatch
    ? reqMatch[1].replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean).join(', ')
    : null;
  const phase_req_ids = reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const wf = (config.workflow ?? {}) as Record<string, unknown>;

  // #3188: these paths are null when the file is absent, matching the contract
  // the conditional sibling fields (context_path, patterns_path, ...) already
  // honour and that ultraplan-phase.md / execute-phase.md gate on. Hoisted so
  // the existence check and the emitted path share one source of truth.
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const requirementsPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');

  const result: Record<string, unknown> = {
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),

    tdd_mode: options['tdd'] || Boolean(wf['tdd_mode']) || false,
    commit_docs: config.commit_docs,
    sub_repos: config.sub_repos,
    parallelization: config.parallelization,
    context_window: config.context_window,
    branching_strategy: config.branching_strategy,
    phase_branch_template: config.phase_branch_template,
    milestone_branch_template: config.milestone_branch_template,
    verifier_enabled: config.verifier,

    phase_found: !!phaseInfo,
    // #2376: absolute (anchored on cwd/project_root), not orchestrator-cwd-relative —
    // a spawned subagent's own cwd may differ from the orchestrator's.
    phase_dir: phaseInfo?.['directory']
      ? toPosixPath(path.join(cwd, phaseInfo['directory'] as string))
      : null,
    phase_number: phaseInfo?.['phase_number'] || null,
    // #3171: prefer the ROADMAP's curated display name for `phase_name`. When
    // the phase directory already exists on disk, the disk-lookup path
    // (searchPhaseInDir) derives phase_name from the directory-name remainder
    // — itself an already-slugified value (`phase.add` writes `${num}-${slug}`
    // dirs), so phase_name and phase_slug come out byte-identical. An
    // orchestrator wiring this field into `state begin-phase --name` then
    // lands a raw slug in STATE.md's current_phase_name. The ROADMAP carries
    // the human-curated display name (`### Phase N: <Name>`); prefer it,
    // matching the no-disk fallback above. phase_slug stays disk-derived — it
    // correctly feeds branch-name construction below and is unchanged here.
    phase_name: (roadmapPhase?.['phase_name']) || (phaseInfo?.['phase_name']) || null,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    phase_req_ids,

    plans: phaseInfo?.['plans'] || [],
    summaries: phaseInfo?.['summaries'] || [],
    incomplete_plans: phaseInfo?.['incomplete_plans'] || [],
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,
    incomplete_count: (phaseInfo?.['incomplete_plans'] as unknown[] | undefined)?.length || 0,

    // #2830: the halt-aware view, forwarded from the shared computation in
    // phase-locator. Additive — `incomplete_plans`/`incomplete_count` above keep
    // their exact name, type and semantics. Without this passthrough the shared
    // truth is computed and then dropped at this consumer, which is the path the
    // issue reports as regressed.
    halted_plans: phaseInfo?.['halted_plans'] || [],
    blocked_by: phaseInfo?.['blocked_by'] || {},
    runnable_plans: phaseInfo?.['runnable_plans'] || [],
    runnable_count: (phaseInfo?.['runnable_plans'] as unknown[] | undefined)?.length || 0,

    branch_name:
      config.branching_strategy === 'phase' && phaseInfo
        ? (config.phase_branch_template as string)
            .replace('{project}', (config.project_code as string) || '')
            .replace('{phase}', normalizePhaseName(phaseInfo['phase_number']))
            .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase')
        : config.branching_strategy === 'milestone'
          ? (config.milestone_branch_template as string)
              .replace('{milestone}', (milestone['version'] as string | undefined) ?? '')
              .replace(
                '{slug}',
                generateSlugInternal(milestone['name'] as string | undefined) || 'milestone',
              )
          : null,

    milestone_version: milestone['version'] ?? null,
    milestone_name: milestone['name'] ?? null,
    milestone_slug: generateSlugInternal(milestone['name'] as string | undefined),

    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    config_exists: fs.existsSync(path.join(planningDir(cwd), 'config.json')),
    // #2376: emit absolute paths — see comment above on phase_dir.
    // #3188: null when the file is absent (parity with patterns_path/context_path).
    state_path: fs.existsSync(statePath) ? toPosixPath(statePath) : null,
    roadmap_path: fs.existsSync(roadmapPath) ? toPosixPath(roadmapPath) : null,
    config_path: toPosixPath(path.join(planningDir(cwd), 'config.json')),
    // #2376: execute-phase.md's verify_phase_goal step reads this instead of
    // hardcoding '.planning/REQUIREMENTS.md' into the gsd-verifier spawn prompt.
    requirements_path: fs.existsSync(requirementsPath) ? toPosixPath(requirementsPath) : null,
  };

  if (options['validate']) {
    try {
      const statePath = path.join(planningDir(cwd), 'STATE.md');
      const stateContent = platformReadSync(statePath);
      if (stateContent !== null) {
        result['state_validation_ran'] = true;
        const stateWarnings: string[] = [];
        if (phaseInfo?.['directory'] && fs.existsSync(path.join(cwd, phaseInfo['directory'] as string))) {
          const diskPlans = listPhasePlanFiles(path.join(cwd, phaseInfo['directory'] as string)).length;
          const totalPlansRaw = stateExtractField(stateContent, 'Total Plans in Phase');
          const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
          if (totalPlansInPhase !== null && diskPlans !== totalPlansInPhase) {
            stateWarnings.push(
              `Plan count mismatch: STATE.md says ${totalPlansInPhase}, disk has ${diskPlans}`,
            );
          }
        }
        result['state_warnings'] = stateWarnings;
      }
    } catch {
      /* intentionally empty */
    }
  }

  // #2932/#2992 (Phase 5/6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, options, 'execute-phase');

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitPlanPhase(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!phase) {
    error('phase required for init plan-phase');
  }

  const config = loadConfig(cwd);
  // #2056/#2104: foreign-prefixed queries must not collapse to numeric phases.
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => {
    const phaseName = rp['phase_name'] as string | null;
    return {
      found: true,
      directory: null,
      phase_number: rp['phase_number'],
      phase_name: phaseName,
      phase_slug: slugifyPhaseName(phaseName),
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
      has_reviews: false,
    };
  });
  const reqMatch = (roadmapPhase?.['section'] as string | undefined)?.match(REQUIREMENTS_HEADER_RE);
  const reqExtracted = reqMatch
    ? reqMatch[1].replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean).join(', ')
    : null;
  const phase_req_ids = reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const phaseDirPlan = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumberPlan = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseNamePlan = (phaseInfo?.['phase_name'] as string | undefined) || null;
  const rawProjectCodePlan = (config.project_code as string) || '';
  let expectedPhaseDirPlan: string | null = null;
  if (!phaseDirPlan && phaseNumberPlan && phaseNamePlan) {
    const paddedNum = normalizePhaseName(phaseNumberPlan);
    const slug = (generateSlugInternal(phaseNamePlan) || '').substring(0, 60);
    if (slug) {
      const prefix = rawProjectCodePlan ? `${rawProjectCodePlan}-` : '';
      const dirName = `${prefix}${paddedNum}-${slug}`;
      // #2376: absolute — see comment on phase_dir below.
      expectedPhaseDirPlan = toPosixPath(path.join(planningPaths(cwd).phases, dirName));
    }
  }

  const granularityOverride = options['granularity'] as string | undefined;
  assertValidGranularityOverride(granularityOverride, error);
  const granularity = resolveGranularityInternal(cwd, 'planning', granularityOverride || undefined);

  const wf = (config.workflow ?? {}) as Record<string, unknown>;

  // #3188: see cmdInitExecutePhase — null when absent, parity with the
  // conditional sibling fields in this same result object.
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const requirementsPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-phase-researcher'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    tdd_mode: options['tdd'] || Boolean(wf['tdd_mode']) || false,
    granularity,
    research_enabled: wf['research'],
    plan_checker_enabled: config.plan_checker,
    nyquist_validation_enabled: wf['nyquist_validation'],
    commit_docs: config.commit_docs,
    text_mode: config.text_mode,
    auto_advance: !!(config.auto_advance),
    auto_chain_active: !!(config._auto_chain_active),
    mode: config.mode || 'interactive',

    phase_found: !!phaseInfo,
    // #2376: absolute (anchored on cwd/project_root) — path.join(cwd, phaseDirPlan)
    // handed to a spawned subagent must resolve regardless of that subagent's own cwd.
    // phaseDirPlan itself stays relative — phase_status below still joins it against cwd.
    phase_dir: phaseDirPlan ? toPosixPath(path.join(cwd, phaseDirPlan)) : null,
    expected_phase_dir: expectedPhaseDirPlan,
    phase_number: phaseNumberPlan,
    phase_name: phaseNamePlan,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    padded_phase: phaseNumberPlan ? normalizePhaseName(phaseNumberPlan) : null,
    phase_req_ids,

    phase_status: phaseDirPlan
      ? determinePhaseStatus(
          (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,
          (phaseInfo?.['summaries'] as unknown[] | undefined)?.length || 0,
          path.join(cwd, phaseDirPlan),
          'Pending',
        )
      : 'Pending',

    has_research: phaseInfo?.['has_research'] || false,
    has_context: phaseInfo?.['has_context'] || false,
    // #4014 (epic #3473 B4-unreadable): additive scope signal adjacent to
    // has_context — SCOPE.COMPLETE by default (no phase directory to read is
    // a genuine, not-unreadable answer), overwritten below to whatever
    // findContextMdIn(phaseDirFull) reports once a directory is known.
    context_scope: SCOPE.COMPLETE,
    has_reviews: phaseInfo?.['has_reviews'] || false,
    has_plans: ((phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0) > 0,
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,

    planning_exists: fs.existsSync(planningDir(cwd)),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),

    // #2376: absolute — see comment on phase_dir above.
    // #3188: null when the file is absent (parity with patterns_path below).
    state_path: fs.existsSync(statePath) ? toPosixPath(statePath) : null,
    roadmap_path: fs.existsSync(roadmapPath) ? toPosixPath(roadmapPath) : null,
    requirements_path: fs.existsSync(requirementsPath) ? toPosixPath(requirementsPath) : null,

    patterns_path: null,
  };

  if (phaseInfo?.['directory']) {
    const phaseDirFull = path.join(cwd, phaseInfo['directory'] as string);
    // #4014 (epic #3473 B4-unreadable): findContextMdIn's directory-string
    // form never throws, so this can record the real scope BEFORE the
    // pre-existing `fs.readdirSync(phaseDirFull)` immediately below
    // (unchanged) throws on the same unreadable directory and is caught
    // exactly as before — additive only, the failure control-flow for
    // context_path/research_path/etc. is untouched.
    result['context_scope'] = findContextMdIn(phaseDirFull).scope;
    try {
      const files = fs.readdirSync(phaseDirFull);
      const phaseDirName = path.basename(phaseDirFull);
      // #3511 BLOCKER-3: scope the raw listing to THIS phase's own artifacts
      // before any bare `.find()` predicate runs, so a `04-UAT.md` (or
      // `04-RESEARCH.md`/`04-REVIEWS.md`/`04-PATTERNS.md`) sitting in phase
      // 03's directory cannot win a phase-03 lookup — the same
      // `isPhaseArtifact` membership rule `resolveVerificationFile` already
      // applies via `phaseDirName` below. `findContextMdIn` is passed the
      // scoped array (rather than the raw directory path) so this call site
      // alone is scoped; its other call sites are unaffected.
      const scopedFiles = scopeToPhase(files, phaseDirName);
      const contextFile = findContextMdIn(scopedFiles);
      if (contextFile) {
        result['context_path'] = toPosixPath(path.join(phaseDirFull, contextFile));
      }
      const researchFile = scopedFiles.find(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );
      if (researchFile) {
        result['research_path'] = toPosixPath(path.join(phaseDirFull, researchFile));
      }
      // #3473 F2: routed through the shared resolver — readdir order is
      // filesystem-dependent, so the prior hand-rolled `.find()` could pick
      // either file when a phase held both a canonical report and an ad-hoc
      // `-CORRECTION-VERIFICATION.md` worksheet (#3357).
      // #3492: pin selection to THIS phase's own token so a stray cross-phase
      // or sentinel-numbered canonically-shaped file cannot outrank this
      // phase's own (possibly non-canonical) report.
      const phaseToken = extractPhaseToken(phaseDirName);
      const verificationFile = resolveVerificationFile(files, {
        allowBare: true,
        phaseToken,
        phaseDirName,
      });
      if (verificationFile) {
        result['verification_path'] = toPosixPath(path.join(phaseDirFull, verificationFile));
      }
      // #3518: routed through the shared UAT resolver — the prior hand-rolled
      // `.find()` over unsorted readdir order had no phase check and no
      // ordering, so a stray cross-phase 02-UAT.md could become this phase's
      // uat_path, filesystem-dependently. Pinned to this phase's own token
      // (same rule as verification_path above), and phase-scoped via
      // phaseDirName (#3511) so the alphabetically-first fallback tier also
      // excludes cross-phase strays.
      const uatFile = resolveUatFile(files, {
        allowBare: true,
        phaseToken,
        phaseDirName,
      });
      if (uatFile) {
        result['uat_path'] = toPosixPath(path.join(phaseDirFull, uatFile));
      }
      const reviewsFile = scopedFiles.find(
        (f) => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md',
      );
      if (reviewsFile) {
        result['reviews_path'] = toPosixPath(path.join(phaseDirFull, reviewsFile));
      }
      const patternsFile = scopedFiles.find(
        (f) => f.endsWith('-PATTERNS.md') || f === 'PATTERNS.md',
      );
      if (patternsFile) {
        result['patterns_path'] = toPosixPath(path.join(phaseDirFull, patternsFile));
      }
    } catch (err) {
      // #3885 (ADR-3473 §8.5): this branch means `phaseInfo['directory']` was
      // set (the phase was already resolved to an on-disk directory) yet
      // `readdirSync` still failed — ENOENT here would be a genuine race
      // (the directory vanished between resolution and this read) and stays
      // a silent degrade like the prior behavior; any other errno
      // (EACCES/EIO/...) is an unreadable-not-absent directory and must be
      // named, or every conditional field this block sets (context_path,
      // research_path, verification_path, uat_path, reviews_path,
      // patterns_path) silently reads as "none of these exist".
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        result['context_read_error'] =
          `Could not read phase directory ${formatDiagnosticToken(phaseDirFull)}: ${formatDiagnosticToken((err as Error)?.message ?? String(err))}`;
      }
    }
  }

  if (options['validate']) {
    try {
      const statePath = path.join(planningDir(cwd), 'STATE.md');
      const stateContent = platformReadSync(statePath);
      if (stateContent !== null) {
        const stateWarnings: string[] = [];
        result['state_validation_ran'] = true;
        const totalPlansRaw = stateExtractField(stateContent, 'Total Plans in Phase');
        const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
        if (
          totalPlansInPhase !== null &&
          phaseInfo &&
          totalPlansInPhase !==
            ((phaseInfo['plans'] as unknown[] | undefined)?.length || 0)
        ) {
          stateWarnings.push(
            `Plan count mismatch: STATE.md says ${totalPlansInPhase}, disk has ${(phaseInfo['plans'] as unknown[] | undefined)?.length || 0}`,
          );
        }
        result['state_warnings'] = stateWarnings;
      }
    } catch {
      /* intentionally empty */
    }
  }

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, options, 'plan-phase');

  // #2401: prior-phase verify commands, surfaced UNGATED — additive field, never
  // conditioned on context_window. Before this, the planner only inherited
  // prior-phase verify-command context when context_window >= 500000, so at
  // lower context windows it re-invented (and mis-resolved) the command. The
  // harvest already degrades to `{commands: [], readError}` rather than
  // throwing; the try/catch is defense-in-depth so init never breaks on this.
  let priorVerifyCommands: unknown[] = [];
  try {
    // #2401 review fix: harvestPriorVerifyCommands accepts a phase-id token
    // (string) directly, so a decimal phase like '2.1' is no longer silently
    // dropped by `Number('2.1')` producing a value the old `number`-only
    // parameter mishandled for lettered/decimal tokens.
    if (phaseNumberPlan !== null) {
      priorVerifyCommands = harvestPriorVerifyCommands({
        planningDir: planningPaths(cwd).phases,
        beforePhase: phaseNumberPlan,
      }).commands;
    }
  } catch {
    priorVerifyCommands = [];
  }
  result['prior_verify_commands'] = priorVerifyCommands;

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitNewProject(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  const config = loadConfig(cwd);

  const homedir = os.homedir();
  const braveKeyFile = path.join(homedir, '.gsd', 'brave_api_key');
  const hasBraveSearch = !!(process.env['BRAVE_API_KEY'] || fs.existsSync(braveKeyFile));

  const firecrawlKeyFile = path.join(homedir, '.gsd', 'firecrawl_api_key');
  const hasFirecrawl = !!(process.env['FIRECRAWL_API_KEY'] || fs.existsSync(firecrawlKeyFile));

  const exaKeyFile = path.join(homedir, '.gsd', 'exa_api_key');
  const hasExaSearch = !!(process.env['EXA_API_KEY'] || fs.existsSync(exaKeyFile));

  const hasCode = hasCodeFilesInternal(cwd);
  const hasPackageFile = hasPackageFileInternal(cwd);
  const isBrownfield = hasCode || hasPackageFile;
  const codebaseMapFiles = listCodebaseMapFiles(cwd);
  const hasCodebaseMap = codebaseMapFiles.length === REQUIRED_CODEBASE_MAP_FILES.length;

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    commit_docs: config.commit_docs,

    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    has_codebase_map: hasCodebaseMap,
    planning_exists: pathExistsInternal(cwd, '.planning'),

    has_existing_code: hasCode,
    has_package_file: hasPackageFile,
    is_brownfield: isBrownfield,
    needs_codebase_map: isBrownfield && !hasCodebaseMap,

    ...getInitGitState(cwd),

    brave_search_available: hasBraveSearch,
    firecrawl_available: hasFirecrawl,
    exa_search_available: hasExaSearch,

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    project_path: toPosixPath(path.join(planningDir(cwd), 'PROJECT.md')),
    // #2376: new-project.md's research-synthesizer/roadmapper spawn prompts
    // read these instead of hardcoding '.planning/...' literals.
    requirements_path: toPosixPath(path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    config_path: toPosixPath(path.join(planningDir(cwd), 'config.json')),
    research_dir: toPosixPath(path.join(planningRoot(cwd), 'research')),
  };

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  // needsCodebaseMap is threaded from this scope's own isBrownfield/hasCodebaseMap
  // computation (see `needs_codebase_map` above) so `state:needs-codebase-map` is
  // genuinely computed for this workflow, not left permanently false.
  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'new-project', {
    needsCodebaseMap: isBrownfield && !hasCodebaseMap,
  });

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitNewMilestone(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  const config = loadConfig(cwd);
  const milestone = milestoneRecord(cwd);
  const latestCompleted = getLatestCompletedMilestone(cwd);
  const phasesDir = path.join(planningDir(cwd), 'phases');
  // #3185 (ADR-3180 Decision 1): "how many phase directories belong to the
  // CURRENT milestone" is exactly the scoped question listMilestonePhaseDirs
  // owns — routed through it instead of a local readdirSync + hand-rolled
  // window filter (which also never excluded sentinels, unlike the owner).
  const phaseDirCount = listMilestonePhaseDirs(phasesDir, { cwd }).value.length;

  const wf = (config.workflow ?? {}) as Record<string, unknown>;

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    commit_docs: config.commit_docs,
    research_enabled: wf['research'],

    // #3216 review Finding 2: `?? null` so an unresolved milestone still emits
    // the key with an explicit `null` rather than letting JSON.stringify drop
    // it — an omitted key reaches the prompt layer's `{current_milestone}`
    // placeholder as literal, un-substituted text.
    current_milestone: milestone['version'] ?? null,
    current_milestone_name: milestone['name'] ?? null,
    latest_completed_milestone: latestCompleted?.version || null,
    latest_completed_milestone_name: latestCompleted?.name || null,
    phase_dir_count: phaseDirCount,
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    phase_archive_path: latestCompleted
      ? toPosixPath(
          path.join(planningRoot(cwd), 'milestones', `${latestCompleted.version}-phases`),
        )
      : null,

    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),

    project_path: toPosixPath(path.join(planningDir(cwd), 'PROJECT.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    // #2376: new-milestone.md's research-synthesizer/roadmapper spawn prompts
    // read these instead of hardcoding '.planning/...' literals.
    requirements_path: toPosixPath(path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    config_path: toPosixPath(path.join(planningDir(cwd), 'config.json')),
    research_dir: toPosixPath(path.join(planningRoot(cwd), 'research')),
    milestones_path: toPosixPath(path.join(planningDir(cwd), 'MILESTONES.md')),
  };

  // `state:flat-mode` (#2994): whether NO workstream is active — the inverse
  // of `state:workstream-active` (introduced for `cmdInitTransition` below).
  // `new-milestone.md`'s Step 4 Part A (milestone-state write) runs ONLY in
  // flat mode; a workstream's own `.planning/workstreams/<name>/STATE.md`/
  // `ROADMAP.md`/`REQUIREMENTS.md` already carry the milestone state, so
  // writing the shared `## Current Milestone` heading here would clobber it
  // (#2308). The `when=` grammar has no negation operator (ADR-1671:69), so
  // Part A's condition — "skip when a workstream IS active" — cannot be
  // expressed by negating `state:workstream-active` in the marker; a
  // SEPARATE, positively-phrased atom whose fact is the inverse is the
  // sanctioned resolution (same discipline as `state:chunked-mode` folding
  // an OR — never an operator in the grammar itself). Same authoritative
  // source as `cmdInitTransition`: `GSD_WORKSTREAM` env, falling back to the
  // stored active-workstream pointer (mirrors `cmdInitProgress`'s own
  // resolution above).
  //
  // #3579 root-cause fix: this is a read-only informational field (no write
  // follows), so use the non-mutating peek — getActiveWorkstream's self-heal
  // would otherwise silently delete a stale/invalid pointer as a side effect
  // of building a JSON report field, and (per #3579) could change what a
  // LATER resolution in the same process observes.
  const resolvedWorkstream = process.env['GSD_WORKSTREAM'] || peekActiveWorkstream(cwd);
  const workstreamActive = !!resolvedWorkstream;
  const flatMode = !workstreamActive;

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'new-milestone', {
    workstreamActive,
    flatMode,
  });

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitQuick(
  cwd: string,
  description: string | undefined,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);
  const now = new Date(realClock.now());
  const slug = description ? generateSlugInternal(description)?.substring(0, 40) : null;

  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = yy + mm + dd;
  const secondsSinceMidnight =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const timeBlocks = Math.floor(secondsSinceMidnight / 2);
  const timeEncoded = timeBlocks.toString(36).padStart(3, '0');
  const quickId = dateStr + '-' + timeEncoded;
  const branchSlug = slug || 'quick';
  const quickBranchName = config.quick_branch_template
    ? (config.quick_branch_template as string)
        .replace('{num}', quickId)
        .replace('{quick}', quickId)
        .replace('{slug}', branchSlug)
    : null;

  const result: Record<string, unknown> = {
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),
    // #3936: Step 4.75 dispatches gsd-phase-researcher; resolve its own tier
    // (parity with cmdInitPlanPhase) so the research spawn stops pinning
    // planner_model.
    researcher_model: resolveModelInternal(cwd, 'gsd-phase-researcher'),
    // #2072: the quick review step spawns gsd-code-reviewer; resolve its own model
    // so model_overrides / models.verification apply (was reusing executor_model).
    reviewer_model: resolveModelInternal(cwd, 'gsd-code-reviewer'),

    commit_docs: config.commit_docs,
    branch_name: quickBranchName,

    quick_id: quickId,
    slug: slug,
    description: description || null,

    date: realClock.localToday(),
    timestamp: realClock.nowIso(),

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    quick_dir: toPosixPath(path.join(planningDir(cwd), 'quick')),
    task_dir: slug
      ? toPosixPath(path.join(planningDir(cwd), 'quick', `${quickId}-${slug}`))
      : null,

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningRoot(cwd)),
  };

  // #2994: `--full` IMPLIES `--discuss`/`--research`/`--validate` — resolved to
  // ONE set of facts HERE, in fact computation, never in the `when=` grammar
  // itself (mirrors `state:chunked-mode`'s disjunction fold at
  // `buildSectionManifestField`'s `chunkedMode` computation above). The three
  // implied tokens are folded into the flags BEFORE `buildSectionManifestField`
  // builds its `InvocationFacts.flags` Set, so `discussion-phase`/`research-phase`/
  // `plan-checker-loop`/`quick-verification` (all gated on their own single
  // `flag:--discuss`/`flag:--research`/`flag:--validate` atom) include correctly
  // for a bare `/gsd:quick --full` invocation that never passed the individual
  // tokens — the grammar still sees exactly one atom per marker, no OR.
  const sectionManifestOptions: Record<string, unknown> = options['full']
    ? { ...options, discuss: true, research: true, validate: true }
    : options;

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(cwd, null, sectionManifestOptions, 'quick');

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `init.quick-batch` (#3676, Phase 4 of epic #3344, ADR-1239 "Quick-batch
 * binding"). Unlike `cmdInitQuick`, this init bundle does NOT allocate a
 * quick id / slug / task directory itself — batch-level id allocation and
 * `BATCH.json` creation is the job of the `quick-batch create` CLI verb
 * (`src/quick-batch-command-router.cts`, wrapping `createBatch` in
 * `src/quick-batch.cts`). This bundle supplies the per-role model profiles,
 * `commit_docs`, the roadmap/planning existence checks `quick-batch.md`'s
 * ROADMAP.md gate needs (same check `cmdInitQuick` runs), the `.planning/quick`
 * directory path, and the `section_manifest` field gating the optional
 * `--research`/`--validate` step fragments — the same `flag:--research`/
 * `flag:--validate` atoms `quick`'s own section manifest already uses
 * (`WHEN_VOCABULARY` is workflow-agnostic; no new atom is needed). `--discuss`/
 * `--full` are rejected by `quick-batch-dispatch.cts`'s `parseQuickBatchArgs`
 * before this init bundle is ever reached, so no `discuss`/`full` flag key is
 * accepted here (unlike `cmdInitQuick`, which still supports both).
 */
function cmdInitQuickBatch(
  cwd: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);

  const result: Record<string, unknown> = {
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),
    researcher_model: resolveModelInternal(cwd, 'gsd-phase-researcher'),
    reviewer_model: resolveModelInternal(cwd, 'gsd-code-reviewer'),

    commit_docs: config.commit_docs,

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase; a
    // per-item task_dir is re-derived by the workflow itself (quick_id +
    // generate-slug over that item's description), never allocated here.
    quick_dir: toPosixPath(path.join(planningDir(cwd), 'quick')),
    quick_batches_dir: toPosixPath(path.join(planningDir(cwd), 'quick-batches')),

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningRoot(cwd)),
  };

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'quick-batch');

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitIngestDocs(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const result: Record<string, unknown> = {
    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    planning_exists: fs.existsSync(planningRoot(cwd)),
    ...getInitGitState(cwd),
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase. The
    // classify_parallel/synthesize/route_new_mode spawns in ingest-docs.md
    // (gsd-doc-classifier, gsd-doc-synthesizer, gsd-roadmapper) previously
    // hardcoded bare '.planning/intel/...', '.planning/PROJECT.md', etc.
    // literals into their Agent(prompt=...) blocks; those now interpolate
    // these fields instead.
    project_path: toPosixPath(path.join(planningDir(cwd), 'PROJECT.md')),
    requirements_path: toPosixPath(path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    intel_dir: toPosixPath(path.join(planningDir(cwd), 'intel')),
    conflicts_path: toPosixPath(path.join(planningDir(cwd), 'INGEST-CONFLICTS.md')),
    commit_docs: config.commit_docs,
  };
  output(withProjectRoot(cwd, result), raw);
}

function cmdInitOnboard(
  cwd: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);
  const workflowConfig = (config.workflow ?? {}) as Record<string, unknown>;
  const result = {
    ...buildOnboardProjection(cwd, {
      commitDocs: !!config.commit_docs,
      fast: options['fast'] === true,
      textMode: options['text'] === true || !!config.text_mode || !!workflowConfig['text_mode'],
    }),
    ...getInitGitState(cwd),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitResume(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  let interruptedAgentId: string | null = null;
  const agentIdRaw = platformReadSync(
    path.join(planningRoot(cwd), 'current-agent-id.txt'),
  );
  if (agentIdRaw !== null) interruptedAgentId = agentIdRaw.trim();

  const result: Record<string, unknown> = {
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    planning_exists: fs.existsSync(planningRoot(cwd)),

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    project_path: toPosixPath(path.join(planningDir(cwd), 'PROJECT.md')),

    has_interrupted_agent: !!interruptedAgentId,
    interrupted_agent_id: interruptedAgentId,

    commit_docs: config.commit_docs,
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitVerifyWork(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for init verify-work');
  }

  const config = loadConfig(cwd);
  const _slashRuntime = resolveRuntime(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => {
    const phaseName = rp['phase_name'] as string | null;
    return {
      found: true,
      directory: null,
      phase_number: rp['phase_number'],
      phase_name: phaseName,
      phase_slug: slugifyPhaseName(phaseName),
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
    };
  });

  const phaseDir = (phaseInfo?.['directory'] as string | null | undefined) || null;
  const planCount = (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0;
  const summaryCount = (phaseInfo?.['summaries'] as unknown[] | undefined)?.length || 0;
  const completion = buildPhaseCompletionProjection(
    cwd,
    (phaseInfo?.['phase_number'] as string | undefined) || phase,
    phaseDir,
    planCount,
    summaryCount,
    _slashRuntime,
  );
  const uatReport = phaseDir
    ? evaluateUatPassed(path.join(cwd, phaseDir), {
        policy: { requireVerification: true },
      })
    : null;
  const uiPhaseActive = detectUiPhaseActive(cwd, phaseInfo);

  const result: Record<string, unknown> = {
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    commit_docs: config.commit_docs,

    phase_found: !!phaseInfo,
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase. phaseDir
    // itself stays relative — evaluateUatPassed above still joins it against cwd.
    phase_dir: phaseDir ? toPosixPath(path.join(cwd, phaseDir)) : null,
    phase_number: phaseInfo?.['phase_number'] || null,
    phase_name: phaseInfo?.['phase_name'] || null,

    // #2376: verify-work.md's plan_gap_closure step reads these instead of
    // hardcoding '.planning/STATE.md' / '.planning/ROADMAP.md' literals.
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),

    has_verification: phaseInfo?.['has_verification'] || false,
    phase_completion: {
      ...completion,
      uat_passed: uatReport?.passed ?? false,
      uat_blockers: uatReport?.blockers ?? [],
      ready_to_transition: completion.phase_complete && (uatReport?.passed ?? false),
    },

    // #2994 (resolver-hoist-guard G5): hoisted `state:ui-phase-active` ground
    // truth (previously re-derived inline inside the automated_ui_verification
    // step body via its own `gsd_run loop render-hooks plan:pre --raw` call —
    // a circular, self-disabling resolver, since the section is only read
    // when this same fact is already true). Resolved once here, exposed so
    // the step body can consume it directly instead of recomputing it.
    ui_phase_active: uiPhaseActive,
  };

  // #2994 (Phase 6.3): additive, optional field — degrades to null, never throws.
  // phaseInfo is passed through directly (mirrors cmdInitExecutePhase / cmdInitPlanPhase)
  // so buildSectionManifestField's internal detectPhaseMvpMode call gets a real
  // phase_number/directory rather than permanently-false facts. uiPhaseActive is
  // computed once above (not re-derived here) and threaded through via overrides,
  // mirroring the fallow/git-create-tag hoist pattern.
  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, {}, 'verify-work', {
    uiPhaseActive,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `code-review.md`'s dedicated init entry point (#2994, epic #1671 Phase
 * 6.3). `code-review.md` previously routed through the shared, 20+-caller
 * `init.phase-op` (`cmdInitPhaseOp` below), reading only 6 of its fields
 * (`phase_found`, `phase_dir`, `phase_number`, `phase_name`, `padded_phase`,
 * `commit_docs` — verified against the workflow's own "Parse from init
 * JSON" line). `cmdInitPhaseOp` is CRITICAL blast radius (179 dependents
 * across 24 processes per the #2994 dispatch) and is never modified for
 * this — this function resolves phase info itself via the SAME shared
 * primitives `cmdInitPhaseOp` calls (`guardedFindPhase`/
 * `guardedGetRoadmapPhase`, plus the shared `applyRoadmapFallback` archived/
 * not-found fallback also used by execute-phase, plan-phase, verify-work
 * and review — see `applyRoadmapFallback`'s own doc comment; `cmdInitPhaseOp`
 * is deliberately excluded from that shared helper), producing the identical
 * 6-field shape rather than a second, hand-maintained copy of
 * `cmdInitPhaseOp`'s full ~60-field bundle. See
 * `tests/init-code-review-parity.test.cjs` for the DEFECT.GENERATIVE-FIX
 * parity guard between the two.
 *
 * Two further facts are resolved and exposed here that `init.phase-op`
 * never carried: the fallow structural-pre-pass config gate
 * (`detectFallowConfig`, `state:fallow-enabled`) and the `--fix` flag
 * (folded into `options` so `buildSectionManifestField` picks it up as
 * `flag:--fix`).
 */
function cmdInitCodeReview(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => {
    const rpName = rp['phase_name'] as string | null;
    return {
      found: true,
      directory: null,
      phase_number: rp['phase_number'],
      phase_name: rpName,
      phase_slug: slugifyPhaseName(rpName),
    };
  });

  const phaseDir = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumber = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseName = (phaseInfo?.['phase_name'] as string | undefined) || null;

  const fallow = detectFallowConfig(cwd);

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    phase_found: !!phaseInfo,
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    phase_dir: phaseDir ? toPosixPath(path.join(cwd, phaseDir)) : null,
    phase_number: phaseNumber,
    phase_name: phaseName,
    padded_phase: phaseNumber ? normalizePhaseName(phaseNumber) : null,

    // #2994: hoisted fallow config-gate resolution (previously re-derived
    // inline inside code-review.md's structural_pre_pass step body — a
    // circular self-disabling gate now resolved once here at init time).
    fallow_enabled: fallow.enabled,
    fallow_scope: fallow.scope,
    fallow_profile: fallow.profile,
    fallow_mcp: fallow.mcp,
    fallow_max_crap: fallow.maxCrap,
  };

  // #2994 (Phase 6.3): additive, optional field — degrades to null, never throws.
  const sectionManifestOptions: Record<string, unknown> = {
    ...options,
    fix: options['fix'] || undefined,
  };
  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, sectionManifestOptions, 'code-review', {
    fallowEnabled: fallow.enabled,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `review.md`'s dedicated init entry point (#2994, epic #1671 Phase 6.3
 * amendment). `review.md` previously routed through the shared, 20+-caller
 * `init.phase-op` (`cmdInitPhaseOp` below), reading only 3 of its fields
 * (`phase_dir`, `phase_number`, `padded_phase` — verified against the
 * workflow's own "Read from init" line in `gather_context`). `cmdInitPhaseOp`
 * is CRITICAL blast radius (179 dependents across 24 processes) and is never
 * modified for this — this function resolves phase info itself via the SAME
 * shared primitives `cmdInitPhaseOp` calls (`guardedFindPhase`/
 * `guardedGetRoadmapPhase`), plus the shared `applyRoadmapFallback`
 * archived/not-found fallback (see its own doc comment), producing the
 * identical 3-field shape rather than a second, hand-maintained copy of
 * `cmdInitPhaseOp`'s full ~60-field bundle.
 *
 * One further fact is resolved and exposed here that `init.phase-op` never
 * carried: whether reviewer instances are configured
 * (`.planning/config.json`'s `review.reviewer_instances`, present AND
 * non-empty — `state:reviewer-instances-configured`), reusing
 * `readConfigJsonValue` (added for `detectFallowConfig`) rather than a
 * second, divergence-prone config reader (DEFECT.GENERATIVE-FIX).
 */
function cmdInitReview(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => ({
    found: true,
    directory: null,
    phase_number: rp['phase_number'],
    phase_name: rp['phase_name'],
  }));

  const phaseDir = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumber = (phaseInfo?.['phase_number'] as string | undefined) || null;

  // #2994: `state:reviewer-instances-configured` ground truth — present AND
  // non-empty `review.reviewer_instances` object. A missing key, a non-object
  // value, or an empty object all resolve to `false` (fail-closed, matching
  // the workflow's own pre-hoist prose gate — "Unconfigured -> default path
  // unchanged").
  const rawReviewerInstances = readConfigJsonValue(cwd, ['review', 'reviewer_instances']);
  const reviewerInstancesConfigured =
    rawReviewerInstances !== null &&
    typeof rawReviewerInstances === 'object' &&
    !Array.isArray(rawReviewerInstances) &&
    Object.keys(rawReviewerInstances).length > 0;

  const result: Record<string, unknown> = {
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    phase_dir: phaseDir ? toPosixPath(path.join(cwd, phaseDir)) : null,
    phase_number: phaseNumber,
    padded_phase: phaseNumber ? normalizePhaseName(phaseNumber) : null,
  };

  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, options, 'review', {
    reviewerInstancesConfigured,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `discuss-phase-assumptions.md`'s dedicated init entry point (#2994, epic
 * #1671 Phase 6.3 amendment). Previously routed through the shared,
 * 20+-caller `init.phase-op` (`cmdInitPhaseOp` below), reading 14 of its
 * fields (`commit_docs`, `phase_found`, `phase_dir`, `phase_number`,
 * `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`,
 * `has_plans`, `has_verification`, `plan_count`, `roadmap_exists`,
 * `planning_exists` — verified against the workflow's own "Parse JSON for"
 * line). `cmdInitPhaseOp` is CRITICAL blast radius (179 dependents across 24
 * processes) and is never modified for this — this function resolves phase
 * info itself via the SAME shared primitives `cmdInitPhaseOp` calls
 * (`guardedFindPhase`/`guardedGetRoadmapPhase`), plus the shared
 * `applyRoadmapFallback` archived/not-found fallback (see its own doc
 * comment) producing the identical fallback shape (`plans: []`,
 * `has_research: false`, `has_context: false`, `has_verification: false`)
 * rather than a second, hand-maintained copy of `cmdInitPhaseOp`'s full
 * ~60-field bundle.
 *
 * One further fact is resolved and exposed here that `init.phase-op` never
 * carried: `state:auto-advance-active` — the workflow's own `auto_advance`
 * step resolves `--auto` OR a consolidated `check auto-mode --pick active`
 * fact (itself `workflow._auto_chain_active` OR `workflow.auto_advance`) via
 * a runtime `gsd_run` call; that identical disjunction is folded into ONE
 * boolean FACT here (same discipline as `state:chunked-mode` /
 * `state:plan-strategy-converge`), exposed as `auto_advance_active`.
 */
function cmdInitDiscussPhaseAssumptions(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const config = loadConfig(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);
  const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
  phaseInfo = applyRoadmapFallback(phaseInfo, roadmapPhase, (rp) => {
    const rpName = rp['phase_name'] as string | null;
    return {
      found: true,
      directory: null,
      phase_number: rp['phase_number'],
      phase_name: rpName,
      phase_slug: slugifyPhaseName(rpName),
      plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
    };
  });

  const phaseDir = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumber = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseName = (phaseInfo?.['phase_name'] as string | undefined) || null;

  // #2994: mirrors discuss-phase-assumptions.md's own auto_advance step
  // resolver — `--auto` flag OR the consolidated `check auto-mode --pick
  // active` fact (workflow._auto_chain_active OR workflow.auto_advance).
  const autoAdvanceActive =
    options['auto'] === true ||
    readConfigJsonBoolean(cwd, ['workflow', '_auto_chain_active']) ||
    readConfigJsonBoolean(cwd, ['workflow', 'auto_advance']);

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    phase_found: !!phaseInfo,
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    phase_dir: phaseDir ? toPosixPath(path.join(cwd, phaseDir)) : null,
    phase_number: phaseNumber,
    phase_name: phaseName,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    padded_phase: phaseNumber ? normalizePhaseName(phaseNumber) : null,

    has_research: phaseInfo?.['has_research'] || false,
    has_context: phaseInfo?.['has_context'] || false,
    has_plans: ((phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0) > 0,
    has_verification: phaseInfo?.['has_verification'] || false,
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningDir(cwd)),
  };

  // #2994 (Phase 6.3): additive, optional field — degrades to null, never throws.
  const sectionManifestOptions: Record<string, unknown> = {
    ...options,
    auto: options['auto'] || undefined,
  };
  result['section_manifest'] = buildSectionManifestField(cwd, phaseInfo, sectionManifestOptions, 'discuss-phase-assumptions', {
    autoAdvanceActive,
  });

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitPhaseOp(cwd: string, phase: string, raw: boolean): void {
  const config = loadConfig(cwd);
  let phaseInfo = guardedFindPhase(cwd, phase, config.project_code);

  // #2237: surface ambiguous phase-directory collisions instead of silently
  // taking the first match when unrelated projects share a .planning/phases/ tree.
  if (phaseInfo?.['ambiguous_matches']) {
    const matches = phaseInfo['ambiguous_matches'] as string[];
    const result: Record<string, unknown> = {
      phase_found: false,
      phase_dir: null,
      phase_number: null,
      phase_name: null,
      ambiguous_matches: matches,
      warning: `Phase ${phase} is ambiguous: ${matches.length} directories match (${matches.map((m: string) => `"${m}"`).join(', ')}). Set a distinct project_code in .planning/config.json to scope resolution.`,
    };
    output(withProjectRoot(cwd, result), raw);
    return;
  }

  if (phaseInfo?.['archived']) {
    const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
    if (roadmapPhase?.['found']) {
      const phaseName = roadmapPhase['phase_name'] as string | null;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase['phase_number'],
        phase_name: phaseName,
        // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
        // (generateSlugInternal, core-utils.cts) rather than re-implementing
        // it. `maxLen: null` preserves this site's pre-migration untruncated
        // contract.
        phase_slug: phaseName ? coreUtils.generateSlugInternal(phaseName, null) : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  if (!phaseInfo) {
    const roadmapPhase = guardedGetRoadmapPhase(cwd, phase, config.project_code);
    if (roadmapPhase?.['found']) {
      const phaseName = roadmapPhase['phase_name'] as string | null;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase['phase_number'],
        phase_name: phaseName,
        // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
        // (generateSlugInternal, core-utils.cts) rather than re-implementing
        // it. `maxLen: null` preserves this site's pre-migration untruncated
        // contract.
        phase_slug: phaseName ? coreUtils.generateSlugInternal(phaseName, null) : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const phaseDir = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumber = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseName = (phaseInfo?.['phase_name'] as string | undefined) || null;
  const rawProjectCode = (config.project_code as string) || '';
  let expectedPhaseDir: string | null = null;
  if (!phaseDir && phaseNumber && phaseName) {
    const paddedNum = normalizePhaseName(phaseNumber);
    const slug = (generateSlugInternal(phaseName) || '').substring(0, 60);
    if (slug) {
      const prefix = rawProjectCode ? `${rawProjectCode}-` : '';
      const dirName = `${prefix}${paddedNum}-${slug}`;
      // #2376: absolute — see comment on phase_dir below.
      expectedPhaseDir = toPosixPath(path.join(planningPaths(cwd).phases, dirName));
    }
  }

  // #3188: see cmdInitExecutePhase — null when absent, parity with the
  // conditional sibling fields in this same result object.
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const requirementsPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,
    brave_search:
      typeof config.brave_search === 'string'
        ? maskIfSecret('brave_search', config.brave_search)
        : config.brave_search,
    firecrawl:
      typeof config.firecrawl === 'string'
        ? maskIfSecret('firecrawl', config.firecrawl)
        : config.firecrawl,
    exa_search:
      typeof config.exa_search === 'string'
        ? maskIfSecret('exa_search', config.exa_search)
        : config.exa_search,

    phase_found: !!phaseInfo,
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    phase_dir: phaseDir ? toPosixPath(path.join(cwd, phaseDir)) : null,
    expected_phase_dir: expectedPhaseDir,
    phase_number: phaseNumber,
    phase_name: phaseName,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    padded_phase: phaseNumber ? normalizePhaseName(phaseNumber) : null,

    has_research: phaseInfo?.['has_research'] || false,
    has_context: phaseInfo?.['has_context'] || false,
    // #4014 (epic #3473 B4-unreadable): see the parallel field in
    // cmdInitPlanPhase — additive scope signal adjacent to has_context.
    context_scope: SCOPE.COMPLETE,
    has_plans: ((phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0) > 0,
    has_verification: phaseInfo?.['has_verification'] || false,
    has_reviews: phaseInfo?.['has_reviews'] || false,
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningDir(cwd)),

    // #2376: absolute — see comment on phase_dir above.
    // #3188: null when the file is absent (parity with context_path/research_path).
    state_path: fs.existsSync(statePath) ? toPosixPath(statePath) : null,
    roadmap_path: fs.existsSync(roadmapPath) ? toPosixPath(roadmapPath) : null,
    requirements_path: fs.existsSync(requirementsPath) ? toPosixPath(requirementsPath) : null,
  };

  if (phaseInfo?.['directory']) {
    const phaseDirFull = path.join(cwd, phaseInfo['directory'] as string);
    // #4014 (epic #3473 B4-unreadable): see the parallel site in
    // cmdInitPlanPhase — additive only, failure control-flow below unchanged.
    result['context_scope'] = findContextMdIn(phaseDirFull).scope;
    try {
      const files = fs.readdirSync(phaseDirFull);
      const phaseDirName = path.basename(phaseDirFull);
      // #3511 BLOCKER-3: see the parallel site above — scope before any bare
      // `.find()` predicate so a misfiled cross-phase artifact cannot win.
      const scopedFiles = scopeToPhase(files, phaseDirName);
      const contextFile = findContextMdIn(scopedFiles);
      if (contextFile) {
        result['context_path'] = toPosixPath(path.join(phaseDirFull, contextFile));
      }
      const researchFile = scopedFiles.find(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );
      if (researchFile) {
        result['research_path'] = toPosixPath(path.join(phaseDirFull, researchFile));
      }
      // #3473 F2: routed through the shared resolver — readdir order is
      // filesystem-dependent, so the prior hand-rolled `.find()` could pick
      // either file when a phase held both a canonical report and an ad-hoc
      // `-CORRECTION-VERIFICATION.md` worksheet (#3357).
      // #3492: pin selection to THIS phase's own token so a stray cross-phase
      // or sentinel-numbered canonically-shaped file cannot outrank this
      // phase's own (possibly non-canonical) report.
      const phaseToken = extractPhaseToken(phaseDirName);
      const verificationFile = resolveVerificationFile(files, {
        allowBare: true,
        phaseToken,
        phaseDirName,
      });
      if (verificationFile) {
        result['verification_path'] = toPosixPath(path.join(phaseDirFull, verificationFile));
      }
      // #3518: routed through the shared UAT resolver — the prior hand-rolled
      // `.find()` over unsorted readdir order had no phase check and no
      // ordering, so a stray cross-phase 02-UAT.md could become this phase's
      // uat_path, filesystem-dependently. Pinned to this phase's own token
      // (same rule as verification_path above), and phase-scoped via
      // phaseDirName (#3511) so the alphabetically-first fallback tier also
      // excludes cross-phase strays.
      const uatFile = resolveUatFile(files, {
        allowBare: true,
        phaseToken,
        phaseDirName,
      });
      if (uatFile) {
        result['uat_path'] = toPosixPath(path.join(phaseDirFull, uatFile));
      }
      const reviewsFile = scopedFiles.find(
        (f) => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md',
      );
      if (reviewsFile) {
        result['reviews_path'] = toPosixPath(path.join(phaseDirFull, reviewsFile));
      }
    } catch (err) {
      // #3885 (ADR-3473 §8.5): see the parallel site in cmdInitPlanPhase —
      // ENOENT here is a genuine race (directory vanished after resolution)
      // and stays a silent degrade; any other errno (EACCES/EIO/...) means
      // the directory exists but could not be read, and must be named rather
      // than silently reported the same as "none of context_path/
      // research_path/verification_path/uat_path/reviews_path exist".
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        result['context_read_error'] =
          `Could not read phase directory ${formatDiagnosticToken(phaseDirFull)}: ${formatDiagnosticToken((err as Error)?.message ?? String(err))}`;
      }
    }
  }

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitTodos(cwd: string, area: string | undefined, raw: boolean): void {
  const config = loadConfig(cwd);

  const pendingDir = path.join(planningDir(cwd), 'todos', 'pending');
  let count = 0;
  const todos: Record<string, unknown>[] = [];

  try {
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = platformReadSync(path.join(pendingDir, file));
      if (content === null) continue;
      try {
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);
        // #2337: kept in parity with cmdListTodos — surface severity when
        // present, omit the key entirely for todos with no severity line.
        const severityMatch = content.match(/^severity:\s*(.+)$/m);
        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
          path: toPosixPath(path.join(planningDir(cwd), 'todos', 'pending', file)),
          ...(severityMatch ? { severity: severityMatch[1].trim() } : {}),
        });
      } catch {
        /* intentionally empty */
      }
    }
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    date: realClock.localToday(),
    timestamp: realClock.nowIso(),

    todo_count: count,
    todos,
    area_filter: area || null,

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    pending_dir: toPosixPath(path.join(planningDir(cwd), 'todos', 'pending')),
    completed_dir: toPosixPath(path.join(planningDir(cwd), 'todos', 'completed')),

    planning_exists: fs.existsSync(planningDir(cwd)),
    todos_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'todos')),
    pending_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'todos', 'pending')),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitMilestoneOp(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const milestone = milestoneRecord(cwd);

  let phaseCount = 0;
  let completedPhases = 0;
  const phasesDir = path.join(planningDir(cwd), 'phases');

  const roadmapPhaseNumbers: string[] = [];
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
    const currentSection = extractCurrentMilestone(roadmapRaw, cwd);
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = phasePattern.exec(currentSection)) !== null) {
      // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
      if (isSentinelPhaseId(m[1])) continue;
      roadmapPhaseNumbers.push(m[1]);
    }
  } catch {
    /* intentionally empty */
  }

  const canonicalizePhase = (tok: string): string => {
    const m = tok.match(/^(\d+)([A-Z]?(?:\.\d+)*)$/);
    return m ? String(parseInt(m[1], 10)) + m[2] : tok;
  };
  // #3882 (ADR-3473 §8.2): this used to hand-roll a readdirSync over the
  // phases directory (a heading->directory LOOKUP INDEX, same role as
  // cmdRoadmapAnalyze's `_phaseDirNames` — `roadmapPhaseNumbers` above is
  // already scoped/sentinel-excluded, so this map must see the PHYSICAL set
  // to resolve each heading's phase number to its actual directory name;
  // scoping it again would look up inside an already-scoped set for no
  // benefit). Routed through the named "physical set, sentinels included"
  // axis instead: every `num` looked up below came from `roadmapPhaseNumbers`
  // (sentinels already excluded there), so a sentinel entry surviving in
  // this map is never read — inclusion is output-invariant, this only
  // removes the re-derivation.
  const diskPhaseDirs = new Map<string, string>();
  for (const name of listAllPhaseDirs(phasesDir, { includeSentinels: true }).value) {
    const m = stripProjectCodePrefix(name).match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`));
    if (!m) continue;
    diskPhaseDirs.set(canonicalizePhase(m[1]), name);
  }

  if (roadmapPhaseNumbers.length > 0) {
    phaseCount = roadmapPhaseNumbers.length;
    for (const num of roadmapPhaseNumbers) {
      const dirName = diskPhaseDirs.get(canonicalizePhase(num));
      if (!dirName) continue;
      try {
        const hasSummary = listPhaseSummaryFiles(path.join(phasesDir, dirName)).length > 0;
        if (hasSummary) completedPhases++;
      } catch {
        /* intentionally empty */
      }
    }
  } else {
    try {
      // #3185 (ADR-3180 Decision 1): the ROADMAP heading scan above found no
      // current-milestone phase headings — fall back to asking the canonical
      // owner "which phase directories belong to the current milestone"
      // directly, instead of a hand-rolled readdirSync over every directory
      // on disk (which also never excluded sentinels, unlike the owner).
      const dirs = listMilestonePhaseDirs(phasesDir, { cwd }).value;
      phaseCount = dirs.length;
      for (const dir of dirs) {
        try {
          const hasSummary = listPhaseSummaryFiles(path.join(phasesDir, dir)).length > 0;
          if (hasSummary) completedPhases++;
        } catch {
          /* intentionally empty */
        }
      }
    } catch {
      /* intentionally empty */
    }
  }

  const archiveDir = path.join(planningRoot(cwd), 'archive');
  let archivedMilestones: string[] = [];
  try {
    archivedMilestones = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    // #3216 review Finding 2: `?? null` so an unresolved milestone still emits
    // the key with an explicit `null` rather than letting JSON.stringify drop
    // it — an omitted key reaches the prompt layer's `{milestone_version}`
    // placeholder as literal, un-substituted text.
    milestone_version: milestone['version'] ?? null,
    milestone_name: milestone['name'] ?? null,
    milestone_slug: generateSlugInternal(milestone['name'] as string | undefined),

    phase_count: phaseCount,
    completed_phases: completedPhases,
    all_phases_complete: phaseCount > 0 && phaseCount === completedPhases,

    archived_milestones: archivedMilestones,
    archive_count: archivedMilestones.length,

    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    archive_exists: fs.existsSync(path.join(planningRoot(cwd), 'archive')),
    phases_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'phases')),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitMapCodebase(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  // #3964: scoped like the payload's own codebase_dir/codebase_dir_exists
  // below (and verify.cts's codebase drift check) — has_maps/existing_maps
  // reading the flat root made the same payload claim a scoped codebase dir
  // exists while reporting zero maps, so map-codebase's Refresh/Skip gate
  // always forced a re-map under GSD_PROJECT.
  const codebaseDir = path.join(planningDir(cwd), 'codebase');
  let existingMaps: string[] = [];
  try {
    existingMaps = fs.readdirSync(codebaseDir).filter((f) => f.endsWith('.md'));
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    mapper_model: resolveModelInternal(cwd, 'gsd-codebase-mapper'),

    commit_docs: config.commit_docs,
    search_gitignored: config.search_gitignored,
    parallelization: config.parallelization,
    subagent_timeout: config.subagent_timeout,

    date: realClock.localToday(),
    timestamp: realClock.nowIso(),

    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    // #3964: scoped like verify.cts's codebase drift check (planningDir, not
    // the flat planningRoot) so the two surfaces cannot disagree under
    // GSD_PROJECT.
    codebase_dir: toPosixPath(path.join(planningDir(cwd), 'codebase')),

    existing_maps: existingMaps,
    has_maps: existingMaps.length > 0,

    planning_exists: pathExistsInternal(cwd, '.planning'),
    codebase_dir_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'codebase')))),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitManager(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const milestone = milestoneRecord(cwd);
  const _slashRuntime = resolveRuntime(cwd);
  const phaseIdConvention = resolvePhaseIdConvention(cwd);
  const capturesBracketId = phaseIdConvention === 'bracket';
  const phaseHeadingPrefix = phaseHeadingPrefixSrcFor(
    PHASE_HEADING_BASELINE.LABEL_ONLY,
    phaseIdConvention,
    capturesBracketId,
  );
  const phaseHeadingPrefixNoCapture = phaseHeadingPrefixSrcFor(
    PHASE_HEADING_BASELINE.LABEL_ONLY,
    phaseIdConvention,
  );

  const paths = planningPaths(cwd);

  if (!fs.existsSync(paths.roadmap)) {
    error(`No ROADMAP.md found. Run ${formatGsdSlash('new-milestone', _slashRuntime) as string} first.`);
  }
  if (!fs.existsSync(paths.state)) {
    error(`No STATE.md found. Run ${formatGsdSlash('new-milestone', _slashRuntime) as string} first.`);
  }
  const rawContent = fs.readFileSync(paths.roadmap, 'utf-8');
  const content = extractCurrentMilestone(rawContent, cwd);
  const phasesDir = paths.phases;

  // #3185 (ADR-3180 Decision 1): "which phase directories belong to the
  // CURRENT milestone" is the scoped question listMilestonePhaseDirs owns —
  // routed through it instead of a hand-rolled readdirSync + a separate
  // getMilestonePhaseFilter window check (which also never excluded
  // sentinels, unlike the owner).
  const _phaseDirEntries = listMilestonePhaseDirs(phasesDir, {
    cwd,
    phaseIdConvention,
  }).value;

  const _checkboxStates = new Map<string, boolean>();
  const _cbPattern = new RegExp(
    `-\\s*\\[(x| )\\]\\s*.*${phaseHeadingPrefix}(${PHASE_NUMBER_TOKEN_SOURCE})[:\\s]`,
    'gi',
  );
  let _cbMatch: RegExpExecArray | null;
  while ((_cbMatch = _cbPattern.exec(content)) !== null) {
    const phaseGroup = capturesBracketId ? 3 : 2;
    _checkboxStates.set(_cbMatch[phaseGroup], _cbMatch[1].toLowerCase() === 'x');
  }

  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  const phasePattern = new RegExp(
    `#{2,4}\\s*${phaseHeadingPrefix}(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`,
    'gi',
  );
  const phases: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;

  while ((match = phasePattern.exec(content)) !== null) {
    const bracketId = capturesBracketId ? match[1] : undefined;
    const phaseNum = capturesBracketId ? match[2] : match[1];
    const phaseName = (capturesBracketId ? match[3] : match[2])
      .replace(/\(INSERTED\)/i, '')
      .trim();
    let displayId: string | undefined;
    if (bracketId) {
      try {
        displayId = renderPhaseId(parsePhaseId(`${bracketId}-${phaseNum}`));
      } catch {
        // The bracket selector is deliberately read-tolerant. If a heading is
        // non-canonical, retain the manager row without fabricating display_id.
      }
    }

    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    const nextHeader = restOfContent.match(new RegExp(
      `\\n#{2,4}\\s+${phaseHeadingPrefixNoCapture}\\d[\\d.]*`,
      'i',
    ));
    const sectionEnd = nextHeader
      ? sectionStart + (nextHeader.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;
    let lastActivity: string | null = null;
    let isActive = false;
    // #4014 (epic #3473 B4-unreadable): default COMPLETE — no directory at
    // all (dirMatch not found) is a genuine, not-unreadable answer.
    let contextScope: Scope = SCOPE.COMPLETE;
    let completion = buildPhaseCompletionProjection(
      cwd,
      phaseNum,
      null,
      planCount,
      summaryCount,
      _slashRuntime,
    );

    try {
      // #3185 (ADR-3180 Decision 2) moved this lookup off the
      // milestone-scoped set and onto the physical one; that scope choice is
      // kept. Only the matcher is this PR's: matchPhaseDirs resolves
      // digit-leading directory names the token predicate cannot (#2528).
      const dirMatch = matchPhaseDirs(
        _phaseDirEntries,
        normalized,
        phaseIdConvention,
      ).matches[0];

      if (dirMatch) {
        const fullDir = path.join(phasesDir, dirMatch);
        const phaseDirRel = toPosixPath(path.relative(cwd, fullDir));
        // #4014 (epic #3473 B4-unreadable): this whole block used to swallow
        // ANY readdirSync failure below into the bare `catch { /* empty */ }`
        // at the bottom — an unreadable phase directory reported the exact
        // same `has_context: false` / `disk_status: 'no_directory'` as a
        // directory that never existed. findContextMdIn's directory-string
        // form never throws, so it can record the real scope (COMPLETE vs
        // UNREADABLE) here, BEFORE the pre-existing `fs.readdirSync(fullDir)`
        // immediately below (unchanged) throws on the exact same unreadable
        // directory and is caught exactly as before — this line is additive
        // only, the failure control-flow is untouched.
        contextScope = findContextMdIn(fullDir).scope;
        const phaseFiles = fs.readdirSync(fullDir);
        planCount = listPhasePlanFiles(fullDir).length;
        summaryCount = listPhaseSummaryFiles(fullDir).length;
        // #3511-class: scope the raw listing to THIS phase's own artifacts
        // before the hasContext/hasResearch predicates run, so a stray
        // cross-phase `-CONTEXT.md`/`-RESEARCH.md` sitting in this directory
        // cannot win this phase's lookup.
        const scopedFiles = scopeToPhase(phaseFiles, dirMatch);
        hasContext = findContextMdIn(scopedFiles) !== null;
        hasResearch = scopedFiles.some(
          (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
        );
        completion = buildPhaseCompletionProjection(
          cwd,
          phaseNum,
          phaseDirRel,
          planCount,
          summaryCount,
          _slashRuntime,
        );

        if (completion.phase_complete) diskStatus = 'complete';
        else if (completion.implementation_complete) diskStatus = 'executed';
        else if (summaryCount > 0) diskStatus = 'partial';
        else if (planCount > 0) diskStatus = 'planned';
        else if (hasResearch) diskStatus = 'researched';
        else if (hasContext) diskStatus = 'discussed';
        else diskStatus = 'empty';

        const nowMs = realClock.now();
        let newestMtime = 0;
        for (const f of phaseFiles) {
          try {
            const stat = fs.statSync(path.join(fullDir, f));
            if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs;
          } catch {
            /* intentionally empty */
          }
        }
        if (newestMtime > 0) {
          lastActivity = new Date(newestMtime).toISOString();
          isActive = nowMs - newestMtime < 300000;
        }
      }
    } catch {
      /* intentionally empty */
    }

    // ADR-3180 §7.4 (disk-strict, #2957, maintainer decision 2026-08-08):
    // `roadmapComplete` is reported below as metadata only — it carries NO
    // machine authority over `diskStatus`. The #3033 checkbox override that
    // used to live here (treating a zero-plan phase as complete whenever the
    // ROADMAP checkbox was ticked, layered on top of
    // buildPhaseCompletionProjection's own output) is DELETED, not
    // generalized: `diskStatus` now comes entirely from `completion`, which
    // already routes through the canonical owner (`isPhaseComplete`) and
    // itself resolves a zero-plan phase as complete whenever a passing
    // `*-VERIFICATION.md` exists (#3168) — with no dependency on the
    // checkbox. A zero-plan phase whose completion previously relied SOLELY
    // on a ticked checkbox (no passing verification) now reports incomplete;
    // this is the deliberate Tier-2 break (ADR-3180 §7.4 Decision 3).
    const roadmapComplete = _checkboxStates.get(phaseNum) || false;

    phases.push({
      number: phaseNum,
      ...(displayId ? { display_id: displayId } : {}),
      name: phaseName,
      goal,
      depends_on,
      disk_status: diskStatus,
      has_context: hasContext,
      has_research: hasResearch,
      plan_count: planCount,
      summary_count: summaryCount,
      roadmap_complete: roadmapComplete,
      ...completion,
      last_activity: lastActivity,
      is_active: isActive,
      context_scope: contextScope,
    });
  }

  const MAX_NAME_WIDTH = 20;
  for (const phase of phases) {
    const name = phase['name'] as string;
    if (name.length > MAX_NAME_WIDTH) {
      phase['display_name'] = name.slice(0, MAX_NAME_WIDTH - 1) + '…';
    } else {
      phase['display_name'] = name;
    }
  }

  function normalizePhaseNumber(value: string): string {
    return value
      .split('.')
      .map((part) => {
        const match = /^(\d+)([A-Z]?)$/i.exec(part);
        if (!match) return part;
        return `${Number(match[1])}${match[2].toUpperCase()}`;
      })
      .join('.');
  }

  const completedNums = new Set(
    phases
      .filter((p) => p['phase_complete'] === true)
      .map((p) => normalizePhaseNumber(p['number'] as string)),
  );
  const phaseMap = new Map(phases.map((p) => [normalizePhaseNumber(p['number'] as string), p]));

  const _allCompletedPattern = new RegExp(
    `-\\s*\\[x\\]\\s*.*${phaseHeadingPrefixNoCapture}(${PHASE_NUMBER_TOKEN_SOURCE})[:\\s]`,
    'gi',
  );
  let _allMatch: RegExpExecArray | null;
  while ((_allMatch = _allCompletedPattern.exec(rawContent)) !== null) {
    const phaseNum = normalizePhaseNumber(_allMatch[1]);
    const phase = phaseMap.get(phaseNum);
    if (!phase || phase['phase_complete'] === true) {
      completedNums.add(phaseNum);
    }
  }

  function reaches(from: string, to: string, visited = new Set<string>()): boolean {
    const normalizedFrom = normalizePhaseNumber(from);
    const normalizedTo = normalizePhaseNumber(to);
    if (visited.has(normalizedFrom)) return false;
    visited.add(normalizedFrom);
    const p = phaseMap.get(normalizedFrom);
    if (!p || !p['dep_phases'] || (p['dep_phases'] as string[]).length === 0) return false;
    if ((p['dep_phases'] as string[]).some((dep) => normalizePhaseNumber(dep) === normalizedTo)) {
      return true;
    }
    return (p['dep_phases'] as string[]).some((dep) => reaches(dep, to, visited));
  }

  function hasDepRelationship(numA: string, numB: string): boolean {
    return reaches(numA, numB) || reaches(numB, numA);
  }

  for (const phase of phases) {
    if (
      !phase['depends_on'] ||
      /^none$/i.test((phase['depends_on'] as string).trim())
    ) {
      phase['deps_satisfied'] = true;
    } else {
      const depNums = (phase['depends_on'] as string).match(new RegExp(`${PHASE_NUMBER_TOKEN_SOURCE}`, 'gi')) || [];
      phase['deps_satisfied'] = depNums.every((n) => completedNums.has(normalizePhaseNumber(n)));
      phase['dep_phases'] = depNums;
    }
  }

  for (const phase of phases) {
    phase['deps_display'] =
      phase['dep_phases'] && (phase['dep_phases'] as string[]).length > 0
        ? (phase['dep_phases'] as string[]).join(',')
        : '—';
  }

  for (const phase of phases) {
    phase['is_next_to_discuss'] =
      (phase['disk_status'] === 'empty' || phase['disk_status'] === 'no_directory') &&
      phase['deps_satisfied'];
  }

  let waitingSignal: unknown = null;
  try {
    // #3964: mirror cmdSignalWaiting's write locations exactly — `.gsd/`
    // first when it exists, else the project-aware planning dir — so the
    // signal is read from the project (and location) it is written to.
    const gsdWaiting = path.join(cwd, '.gsd', 'WAITING.json');
    const waitingPath = fs.existsSync(path.join(cwd, '.gsd'))
      ? gsdWaiting
      : path.join(planningDir(cwd), 'WAITING.json');
    const waitingRaw = platformReadSync(waitingPath);
    if (waitingRaw !== null) {
      waitingSignal = JSON.parse(waitingRaw);
    }
  } catch {
    /* intentionally empty */
  }

  const recommendedActions: Record<string, unknown>[] = [];
  for (const phase of phases) {
    if (phase['disk_status'] === 'complete') continue;
    // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
    if (isSentinelPhaseId(phase['number'])) continue;

    if (phase['disk_status'] === 'executed') {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'verify',
        reason: `Implementation complete; verification ${phase['verification_status'] as string}`,
        command: phase['verification_next_command'],
      });
    } else if (phase['disk_status'] === 'planned' && phase['deps_satisfied']) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'execute',
        reason: `${phase['plan_count'] as number} plans ready, dependencies met`,
        command: `${formatGsdSlash('execute-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    } else if (
      phase['disk_status'] === 'discussed' ||
      phase['disk_status'] === 'researched'
    ) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'plan',
        reason: 'Context gathered, ready for planning',
        command: `${formatGsdSlash('plan-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    } else if (
      (phase['disk_status'] === 'empty' || phase['disk_status'] === 'no_directory') &&
      phase['is_next_to_discuss']
    ) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'discuss',
        reason: 'Unblocked, ready to gather context',
        command: `${formatGsdSlash('discuss-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    }
  }

  const activeExecuting = phases.filter(
    (p) =>
      p['disk_status'] === 'partial' ||
      (p['disk_status'] === 'planned' && p['is_active']),
  );
  const activePlanning = phases.filter(
    (p) =>
      p['is_active'] &&
      (p['disk_status'] === 'discussed' || p['disk_status'] === 'researched'),
  );

  const filteredActions = recommendedActions.filter((action) => {
    if (action['action'] === 'execute' && activeExecuting.length > 0) {
      return activeExecuting.every(
        (active) => !hasDepRelationship(action['phase'] as string, active['number'] as string),
      );
    }
    if (action['action'] === 'plan' && activePlanning.length > 0) {
      return activePlanning.every(
        (active) => !hasDepRelationship(action['phase'] as string, active['number'] as string),
      );
    }
    return true;
  });

  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  const nonBacklogPhases = phases.filter((p) => !isSentinelPhaseId(p['number'] as string));
  const completedCount = nonBacklogPhases.filter((p) => p['phase_complete'] === true).length;

  const sanitizeFlags = (rawVal: unknown): string => {
    const val = typeof rawVal === 'string' ? rawVal : '';
    if (!val) return '';
    const tokens = val.split(/\s+/).filter(Boolean);
    const safe = tokens.every(
      (t) =>
        /^--[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(t) ||
        /^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/.test(t),
    );
    if (!safe) {
      process.stderr.write(
        `gsd-tools: warning: manager.flags contains invalid tokens, ignoring: ${val}\n`,
      );
      return '';
    }
    return val;
  };
  const mgr = config.manager as Record<string, unknown> | undefined;
  const mgrFlags = mgr?.['flags'] as Record<string, unknown> | undefined;
  const managerFlags = {
    discuss: sanitizeFlags(mgrFlags?.['discuss']),
    plan: sanitizeFlags(mgrFlags?.['plan']),
    execute: sanitizeFlags(mgrFlags?.['execute']),
  };

  const result: Record<string, unknown> = {
    // #3216 review Finding 2: `?? null` so an unresolved milestone still emits
    // the key with an explicit `null` rather than letting JSON.stringify drop
    // it — an omitted key reaches the prompt layer's `{milestone_version}`
    // placeholder as literal, un-substituted text.
    milestone_version: milestone['version'] ?? null,
    milestone_name: milestone['name'] ?? null,
    phases,
    phase_count: phases.length,
    completed_count: completedCount,
    in_progress_count: phases.filter((p) =>
      ['executed', 'partial', 'planned', 'discussed', 'researched'].includes(p['disk_status'] as string),
    ).length,
    recommended_actions: filteredActions,
    waiting_signal: waitingSignal,
    all_complete:
      completedCount === nonBacklogPhases.length && nonBacklogPhases.length > 0,
    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    roadmap_exists: true,
    state_exists: true,
    manager_flags: managerFlags,
  };

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `complete-milestone.md`'s dedicated init entry point (#2994, epic #1671
 * Phase 6.3). Additive alongside the workflow's existing `init.manager`
 * (readiness/phase-projection, `cmdInitManager` above — CRITICAL blast
 * radius, never modified) and `init.execute-phase` (branching-strategy
 * fields) calls; `cmdInitCompleteMilestone` carries NO phase-listing logic
 * of its own to delegate — its only job is the `git.create_tag` config-gate
 * fact the `git_tag` step's `<config-check>` sub-tag used to re-derive
 * inline (gating the step's own inclusion on a fact only that step
 * computed), now hoisted here and exposed as `git_create_tag`, plus the
 * `section_manifest` field neither `init.manager` nor `init.execute-phase`
 * carries.
 */
function cmdInitCompleteMilestone(
  cwd: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const gitCreateTag = detectGitCreateTag(cwd);

  const result: Record<string, unknown> = {
    // #2994: hoisted from complete-milestone.md's git_tag step
    // <config-check> resolver (git.create_tag, fail-open default true).
    git_create_tag: gitCreateTag,
  };

  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'complete-milestone', {
    gitCreateTag,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `autonomous.md`'s dedicated init entry point (#2994, epic #1671 Phase
 * 6.3). Additive alongside the workflow's existing `init.milestone-op`
 * (`cmdInitMilestoneOp`), `init.manager` (`cmdInitManager`), and
 * `init.phase-op` (`cmdInitPhaseOp`) calls — all three are CRITICAL blast
 * radius (179 dependents across 24 processes) and are never modified for
 * this; `autonomous.md` keeps every one of those calls exactly as it had
 * them. `cmdInitAutonomous` carries NO phase-listing logic of its own to
 * delegate — its only job is the `PLAN_STRATEGY` disjunction the workflow's
 * own bash resolver (`PLAN_STRATEGY="converge"` on `--converge` OR
 * `--cross-ai`) already computes at the top of the `initialize` step, now
 * mirrored here as a single boolean FACT (same discipline as
 * `state:chunked-mode`/`state:ui-phase-active`: the disjunction is resolved
 * ONCE, in fact computation, never in the `when=` grammar), exposed as
 * `plan_strategy_converge`, plus the `section_manifest` field none of the
 * three existing calls carries.
 */
function cmdInitAutonomous(
  cwd: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  const planStrategyConverge = options['converge'] === true || options['cross-ai'] === true;

  const result: Record<string, unknown> = {
    // #2994: mirrors autonomous.md's own PLAN_STRATEGY resolver
    // (--converge OR its documented alias --cross-ai).
    plan_strategy_converge: planStrategyConverge,
  };

  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'autonomous', {
    planStrategyConverge,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `docs-update.md`'s dedicated init entry point (#2994, epic #1671 Phase
 * 6.3 — final slice). `docs-update.md` previously carried NO `gsd_run query
 * init.*` call at all: its own `docs-init` command (`cmdDocsInit`,
 * src/docs.cts) is a SEPARATE, pre-existing entry point outside this
 * `init.*` family and is left untouched here. This function's only job is
 * the `section_manifest` field neither `docs-init` nor any other call
 * carries, gating `docs-update.md`'s `dispatch-monorepo-packages` section.
 *
 * `state:is-monorepo` ground truth: the project's monorepo workspaces list
 * is non-empty — reuses `detectMonorepoWorkspaces` (src/docs.cts, exported
 * for this purpose) rather than a second, divergence-prone workspace-glob
 * scan (DEFECT.GENERATIVE-FIX dual surface); this is the SAME detector that
 * already backs `docs-init`'s own `monorepo_workspaces` field.
 */
function cmdInitDocsUpdate(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  const isMonorepo = detectMonorepoWorkspaces(cwd).length > 0;

  const result: Record<string, unknown> = {};

  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'docs-update', {
    isMonorepo,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `update.md`'s dedicated init entry point (#2994, epic #1671 Phase 6.3 —
 * final slice). `update.md` previously carried NO `gsd_run query init.*`
 * call at all: it resolves `gsd-tools.cjs` itself (its own bespoke
 * `PREFERRED_CONFIG_DIR`/`PREFERRED_RUNTIME`-aware `$GSD_TOOLS` cascade,
 * `update.md` ~lines 13-45) because the update workflow must run BEFORE any
 * install can be assumed resolvable — the canonical launcher preamble's
 * fixed candidate list is not a substitute for that cascade, and both
 * resolutions assign the identical `$GSD_TOOLS` shell variable, so copying
 * the canonical preamble in ADDITION to the existing cascade would silently
 * clobber the value `backup_custom_files`/`restore_custom_files` (later
 * steps) still depend on. This function is invoked via that ALREADY
 * resolved `$GSD_TOOLS`, not a redundant `gsd_run()` shell function.
 *
 * `state:next-channel` ground truth: `--next` OR its documented alias
 * `--rc` (same disjunction-to-one-boolean discipline as
 * `state:chunked-mode`/`state:plan-strategy-converge`). This DELIBERATELY
 * does not replace `update.md`'s own `parse_update_channel` case-statement
 * (`TAG="next"`/`TAG="latest"`) — issue #815's regression test
 * (`tests/update-workflow.test.cjs`) asserts that literal
 * case-statement text stays in `update.md` verbatim (the npm dist-tag
 * selection has to run in the workflow's own shell before any `gsd_run`
 * round-trip), so `next_channel` exists purely to gate the `channel-banner`
 * section's admission — a parallel, consistent-but-not-replacing
 * resolution of the same flags.
 */
function cmdInitUpdate(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  const nextChannel = options['next'] === true || options['rc'] === true;

  const result: Record<string, unknown> = {
    next_channel: nextChannel,
  };

  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'update', {
    nextChannel,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `transition.md`'s dedicated init entry point (#2994, epic #1671 Phase
 * 6.3 — final slice). `transition.md` is an internal workflow (no
 * user-facing `/gsd-transition` command) that previously carried NO
 * `gsd_run query init.*` call at all; it already establishes `gsd_run()`
 * via the canonical launcher preamble in its `update_roadmap_and_state`
 * step (before this call's insertion point in `offer_next_phase`), so no
 * second preamble copy is needed in the host file.
 *
 * `state:workstream-active` ground truth: a workstream is active — resolved
 * via `GSD_WORKSTREAM` env, falling back to the stored active-workstream
 * pointer (mirrors `cmdInitProgress`'s own `_resolvedWorkstream` resolution
 * above, the established authoritative source for "is a workstream active"
 * in this file).
 *
 * `other_active_workstreams` hoists the resolver-in-body hazard out of
 * `transition.md`'s `workstream-collision-check` step: that step's body
 * previously re-derived this via an inline `gsd_run query workstream.list
 * --raw` call gated on the identical `if [ -n "$GSD_WORKSTREAM" ]`
 * condition that now backs this section's OWN admission — resolving it here
 * instead reuses `getOtherActiveWorkstreamInventories` (src/workstream-
 * inventory.cts), the SAME primitive `workstream.list` itself calls
 * (`cmdWorkstreamList`, src/workstream.cts), pre-filtered exactly as the
 * step's own prose described (excludes the current workstream and any
 * workstream whose status contains "milestone complete" or "archived",
 * case-insensitively — `isCompletedInventory`), so the step body becomes a
 * pure JSON consumer with no `gsd_run` call of its own.
 */
function cmdInitTransition(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  // #3579 root-cause fix: read-only informational field — peek, don't
  // self-heal (see cmdInitNewMilestone's identical rationale above).
  const resolvedWorkstream = process.env['GSD_WORKSTREAM'] || peekActiveWorkstream(cwd);
  const workstreamActive = !!resolvedWorkstream;

  const result: Record<string, unknown> = {
    other_active_workstreams: workstreamActive
      ? getOtherActiveWorkstreamInventories(cwd, resolvedWorkstream).map((inv) => ({
          name: inv.name,
          status: inv.status,
        }))
      : [],
  };

  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'transition', {
    workstreamActive,
  });

  output(withProjectRoot(cwd, result), raw);
}

/**
 * `debug.md`'s dedicated init entry point (#3149; prerequisite for #3128).
 * `debug.md` previously carried NO `gsd_run query init.*` call at all — it made
 * THREE separate round-trips instead: `state.load` (for `commit_docs`,
 * `config.response_language` and `debug_dir`), `resolve-model gsd-debugger
 * --pick model`, and `config-get workflow.tdd_mode --raw`. Because no
 * debug-scoped fact was computed at any entry point, a `when=` atom naming one
 * would have evaluated FALSE forever — ADR-1671's admission gate (2) and the
 * silent-exclusion bug it exists to prevent (`docs/adr/1671-…:122-131`).
 *
 * Every field is resolved through the SAME primitive the call it replaces used,
 * never a second hand-maintained copy (DEFECT.GENERATIVE-FIX):
 *
 * - `commit_docs` — `loadConfig`, the same loader `cmdStateLoad` calls.
 * - `response_language` — NOT read here: `withProjectRoot` already injects it
 *   when configured (#2402), which is also the shape sibling init bundles use.
 *   It is absent, not null, when unset.
 * - `debug_dir` — `planningPaths(cwd).debug`, the SAME expression `cmdStateLoad`
 *   now uses; the `debug` field was added to `PlanningPaths` (#3149) so the
 *   location has one source instead of two kept in sync by hand.
 * - `debugger_model` — `resolveModelInternal`, which IS what `query
 *   resolve-model --pick model` returns (`cmdResolveModel`, src/commands.cts).
 * - `tdd_mode` — the `Boolean(wf['tdd_mode'])` idiom `cmdInitExecutePhase` and
 *   `cmdInitPlanPhase` already use. `/gsd:debug` has no `--tdd` flag, so the
 *   sibling handlers' `options['tdd'] ||` disjunct is deliberately omitted
 *   rather than carried as a phantom.
 *
 * `state.load` is deliberately NOT narrowed — see the note beside its own
 * `debug_dir` field. This handler is purely additive alongside it.
 *
 * `diagnose` is the one flag `/gsd:debug` already documents. Exposing it as a
 * top-level fact follows `cmdInitUpdate`'s `next_channel` and
 * `cmdInitAutonomous`'s `plan_strategy_converge` precedent, and is what makes
 * the router's flag forwarding observable. No `when=` atom consumes it yet:
 * admission gate (1) — a consuming section of at least 400 bytes — is #3128's
 * to satisfy, and shipping the atom before its section is the same
 * silent-exclusion bug from the other direction.
 */
function cmdInitDebug(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  const config = loadConfig(cwd);
  const wf = (config.workflow ?? {}) as Record<string, unknown>;

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,
    // #2376: absolute — debug.md builds `debug_file_path` as
    // `{debug_dir}/{slug}.md` for its gsd-debug-session-manager spawns, whose
    // own cwd may differ from the orchestrator's.
    debug_dir: toPosixPath(planningPaths(cwd).debug),
    debugger_model: resolveModelInternal(cwd, 'gsd-debugger'),
    tdd_mode: Boolean(wf['tdd_mode']),
    diagnose: options['diagnose'] === true,
  };

  // Additive, optional field — degrades to null while `debug` has no key in
  // `gsd-core/workflows/section-manifest.json` (it has no `gsd:section` markers
  // until #3128). null means "read everything", which is NOT the same as a
  // computed empty selection.
  result['section_manifest'] = buildSectionManifestField(cwd, null, options, 'debug', {});

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitProgress(cwd: string, raw: boolean, options: Record<string, unknown> = {}): void {
  try {
    (pruneOrphanedWorktrees as (cwd: string) => void)(cwd);
  } catch {
    /* intentionally empty */
  }
  const config = loadConfig(cwd);
  const milestone = milestoneRecord(cwd);
  const _slashRuntime = resolveRuntime(cwd);

  // #1912: fail safe in workstream mode with no active workstream. With no active
  // workstream and no --ws, planningDir(cwd) resolves to root .planning — silently
  // reporting a stale root milestone. Require an explicit workstream instead.
  // Mirror planningDir's resolution (GSD_WORKSTREAM env > stored active pointer) so
  // an explicit --ws (which sets GSD_WORKSTREAM) satisfies the check.
  const _availableWorkstreams = listAvailableWorkstreams(cwd);
  // #3579 root-cause fix: this is a check, not a consuming read — use the
  // non-mutating peek so an unresolvable pointer isn't self-healed (cleared)
  // here and then found "absent" by diagnoseUnresolvedActiveWorkstream below,
  // which would misreport a present-but-bad marker as no marker at all.
  const _resolvedWorkstream = process.env['GSD_WORKSTREAM'] || peekActiveWorkstream(cwd);
  if (_availableWorkstreams.length > 0 && !_resolvedWorkstream) {
    // #3579: getActiveWorkstream now inherits a pointer-less session's read
    // from the shared .planning/active-workstream marker, so reaching this
    // branch with a marker actually present means the marker EXISTED but
    // didn't resolve (invalid name, or its workstream dir is gone) — a
    // materially different situation from "nothing was ever set" and one
    // that deserves its own diagnostic instead of the generic message below.
    const _diagnosis = diagnoseUnresolvedActiveWorkstream(cwd);
    if (_diagnosis.present) {
      error(
        `init.progress requires a workstream in workstream mode — the active-workstream marker names '${_diagnosis.value}', but it did not resolve: ${describeUnresolvedWorkstreamReason(_diagnosis.reason)}. Root STATE.md (likely stale) would be reported otherwise. ` +
          `Pass --ws <name> or run ${formatGsdSlash('workstream set', _slashRuntime) as string} to point it at an existing workstream. ` +
          `Available workstreams: ${_availableWorkstreams.join(', ')}`,
        ERROR_REASON.WORKSTREAM_MODE_MARKER_UNRESOLVED,
        { marker_value: _diagnosis.value, marker_reason: _diagnosis.reason },
      );
    }
    error(
      `init.progress requires a workstream in workstream mode — no active workstream is set, so root STATE.md (likely stale) would be reported. ` +
        `Pass --ws <name> or run ${formatGsdSlash('workstream set', _slashRuntime) as string} first. ` +
        `Available workstreams: ${_availableWorkstreams.join(', ')}`,
      ERROR_REASON.WORKSTREAM_MODE_NONE_ACTIVE,
    );
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const phases: Record<string, unknown>[] = [];
  let currentPhase: Record<string, unknown> | null = null;
  let nextPhase: Record<string, unknown> | null = null;

  const roadmapPhaseNums = new Set<string>();
  const roadmapPhaseNames = new Map<string, string>();
  const roadmapCheckboxStates = new Map<string, boolean>();
  try {
    const roadmapContent = extractCurrentMilestone(
      fs.readFileSync(path.join(planningDir(cwd), 'ROADMAP.md'), 'utf-8'),
      cwd,
    );
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    const headingPattern = new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gi');
    let hm: RegExpExecArray | null;
    while ((hm = headingPattern.exec(roadmapContent)) !== null) {
      roadmapPhaseNums.add(hm[1]);
      roadmapPhaseNames.set(hm[1], hm[2].replace(/\(INSERTED\)/i, '').trim());
    }
    const cbPattern = new RegExp(`-\\s*\\[(x| )\\]\\s*.*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})[:\\s]`, 'gi');
    let cbm: RegExpExecArray | null;
    while ((cbm = cbPattern.exec(roadmapContent)) !== null) {
      roadmapCheckboxStates.set(cbm[2], cbm[1].toLowerCase() === 'x');
    }
  } catch {
    /* intentionally empty */
  }

  const seenPhaseNums = new Set<string>();

  try {
    // #3185 (ADR-3180 Decision 1): "which phase directories belong to the
    // CURRENT milestone" — routed through the canonical owner instead of a
    // hand-rolled readdirSync + isDirInMilestone filter + local sort (which
    // also never excluded sentinels, unlike the owner; the final `phases`
    // array is re-sorted below anyway, so dropping the local sort here is
    // behavior-preserving).
    const dirs = listMilestonePhaseDirs(phasesDir, { cwd }).value;

    for (const dir of dirs) {
      const dirMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
      const phaseNumber = dirMatch ? dirMatch[1] : dir;
      const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
      seenPhaseNums.add(phaseNumber.replace(/^0+/, '') || '0');

      const phasePath = path.join(phasesDir, dir);
      const phaseFiles = fs.readdirSync(phasePath);

      const plans = listPhasePlanFiles(phasePath);
      const summaries = listPhaseSummaryFiles(phasePath);
      // #3511-class: scope the raw listing to THIS phase's own artifacts
      // before the hasResearch predicate runs, so a stray cross-phase
      // `-RESEARCH.md` sitting in this directory cannot win this phase's
      // lookup.
      const scopedPhaseFiles = scopeToPhase(phaseFiles, dir);
      const hasResearch = scopedPhaseFiles.some(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );
      const phaseDirRel = toPosixPath(
        path.relative(cwd, path.join(planningDir(cwd), 'phases', dir)),
      );
      const completion = buildPhaseCompletionProjection(
        cwd,
        phaseNumber,
        phaseDirRel,
        plans.length,
        summaries.length,
        _slashRuntime,
      );

      const status =
        completion.phase_complete
          ? 'complete'
          : completion.implementation_complete
            ? 'executed'
            : plans.length > 0
              ? 'in_progress'
              : hasResearch
                ? 'researched'
                : 'pending';

      const phaseInfo: Record<string, unknown> = {
        number: phaseNumber,
        name: phaseName,
        // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
        // phaseDirRel itself stays relative — buildPhaseCompletionProjection
        // above still joins it against cwd.
        directory: toPosixPath(path.join(cwd, phaseDirRel)),
        status,
        plan_count: plans.length,
        summary_count: summaries.length,
        has_research: hasResearch,
        ...completion,
      };

      phases.push(phaseInfo);

      if (!currentPhase && (status === 'executed' || status === 'in_progress' || status === 'researched')) {
        currentPhase = phaseInfo;
      }
      if (!nextPhase && status === 'pending') {
        nextPhase = phaseInfo;
      }
    }
  } catch {
    /* intentionally empty */
  }

  for (const [num, name] of roadmapPhaseNames) {
    const stripped = num.replace(/^0+/, '') || '0';
    if (!seenPhaseNums.has(stripped)) {
      const checkboxComplete =
        roadmapCheckboxStates.get(num) === true ||
        roadmapCheckboxStates.get(stripped) === true;
      const completion = buildPhaseCompletionProjection(
        cwd,
        num,
        null,
        0,
        0,
        _slashRuntime,
      );
      const status = 'not_started';
      const phaseInfo: Record<string, unknown> = {
        number: num,
        // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
        // (generateSlugInternal, core-utils.cts) rather than re-implementing
        // it. `maxLen: null` preserves this site's pre-migration untruncated
        // contract.
        name: coreUtils.generateSlugInternal(name, null) ?? '',
        directory: null,
        status,
        plan_count: 0,
        summary_count: 0,
        has_research: false,
        roadmap_complete: checkboxComplete,
        ...completion,
      };
      phases.push(phaseInfo);
      if (!nextPhase && !currentPhase && !checkboxComplete) {
        nextPhase = phaseInfo;
      }
    }
  }

  phases.sort((a, b) => comparePhaseNum(a['number'], b['number']));

  // #3581: the frontier is ROADMAP ORDER, not artifact presence. The disk loop
  // above could claim nextPhase from a stray out-of-order artifact directory
  // (a phase-9 UAT evidence dir while roadmap phase 8 was pending and
  // unscaffolded), silently skipping 8 — and init.progress then disagreed with
  // roadmap.analyze on the same tree. Re-derive from the sorted union: the
  // first phase that has not begun ('pending' | 'not_started') and is not
  // roadmap-complete wins; artifacts still feed each entry's status and
  // completion (corroborating evidence) but no longer outrank the ordering.
  // Aligned trees derive the identical frontier as the loops above; an
  // all-complete milestone finds none and keeps nextPhase null for the
  // completion flow.
  {
    const frontier = phases.find((p) => {
      const st = p['status'];
      return (st === 'pending' || st === 'not_started') && p['roadmap_complete'] !== true;
    });
    if (frontier) nextPhase = frontier;
  }

  let pausedAt: string | null = null;
  const state = platformReadSync(path.join(planningDir(cwd), 'STATE.md'));
  if (state !== null) {
    const pauseMatch = state.match(/\*\*Paused At:\*\*\s*(.+)/);
    if (pauseMatch) pausedAt = pauseMatch[1].trim();
  }

  // #2994: the CURRENT phase's number, used both to expose `phase_mvp_mode`
  // at the top level (so the `mvp-display` step body can consume an
  // already-resolved fact instead of re-invoking `gsd_run query
  // phase.mvp-mode` itself — that inline resolver would otherwise gate a
  // section on a fact the section's own body recomputes, which is circular
  // and self-disabling) and to thread a real `phase_number` into
  // `buildSectionManifestField` below so `state:phase-mvp-mode` is genuinely
  // computed for this workflow rather than permanently false (the previous
  // `buildSectionManifestField(cwd, null, ...)` call passed no phase info at
  // all, so `detectPhaseMvpMode` always short-circuited on the `!phaseNumber`
  // guard).
  const currentPhaseNumber = (currentPhase?.['number'] as string | undefined) ?? null;
  const phaseMvpMode = detectPhaseMvpMode(cwd, currentPhaseNumber);

  const result: Record<string, unknown> = {
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),

    commit_docs: config.commit_docs,

    // #3216 review Finding 2: `?? null` so an unresolved milestone still emits
    // the key with an explicit `null` rather than letting JSON.stringify drop
    // it — an omitted key reaches the prompt layer's `{milestone_version}`
    // placeholder as literal, un-substituted text.
    milestone_version: milestone['version'] ?? null,
    milestone_name: milestone['name'] ?? null,

    phases,
    phase_count: phases.length,
    completed_count: phases.filter((p) => p['status'] === 'complete').length,
    in_progress_count: phases.filter((p) =>
      ['executed', 'in_progress'].includes(p['status'] as string),
    ).length,

    current_phase: currentPhase,
    next_phase: nextPhase,
    paused_at: pausedAt,
    has_work_in_progress: !!currentPhase,
    phase_mvp_mode: phaseMvpMode,

    project_exists: pathExistsInternal(cwd, toPosixPath(path.relative(cwd, path.join(planningDir(cwd), 'PROJECT.md')))),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    // #2376: absolute — see comment on phase_dir in cmdInitExecutePhase.
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    project_path: toPosixPath(path.join(planningDir(cwd), 'PROJECT.md')),
    config_path: toPosixPath(path.join(planningDir(cwd), 'config.json')),
  };

  // #2992 (Phase 6.1): additive, optional field — degrades to null, never throws.
  result['section_manifest'] = buildSectionManifestField(
    cwd,
    currentPhaseNumber ? { phase_number: currentPhaseNumber } : null,
    options,
    'progress',
  );

  output(withProjectRoot(cwd, result), raw);
}

function detectChildRepos(dir: string): { name: string; path: string; has_uncommitted: boolean }[] {
  const repos: { name: string; path: string; has_uncommitted: boolean }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const gitDir = path.join(fullPath, '.git');
    if (fs.existsSync(gitDir)) {
      const statusResult = execGit(['status', '--porcelain'], {
        cwd: fullPath,
        timeout: 5000,
      }) as unknown as Record<string, unknown>;
      const hasUncommitted =
        statusResult['exitCode'] === 0 &&
        (statusResult['stdout'] as string).length > 0;
      repos.push({ name: entry.name, path: fullPath, has_uncommitted: hasUncommitted });
    }
  }
  return repos;
}

function cmdInitNewWorkspace(cwd: string, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  const childRepos = detectChildRepos(cwd);

  const gitVersion = execGit(['--version'], { timeout: 5000 }) as unknown as Record<string, unknown>;
  const worktreeAvailable = gitVersion['exitCode'] === 0;

  const result: Record<string, unknown> = {
    default_workspace_base: defaultBase,
    child_repos: childRepos,
    child_repo_count: childRepos.length,
    worktree_available: worktreeAvailable,
    is_git_repo: pathExistsInternal(cwd, '.git'),
    cwd_repo_name: path.basename(cwd),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitListWorkspaces(cwd: string, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  const workspaces: Record<string, unknown>[] = [];
  if (fs.existsSync(defaultBase)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(defaultBase, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(defaultBase, entry.name);
      const manifestPath = path.join(wsPath, 'WORKSPACE.md');
      if (!fs.existsSync(manifestPath)) continue;

      let repoCount = 0;
      let hasProject = false;
      let strategy = 'unknown';
      const manifest = platformReadSync(manifestPath);
      if (manifest !== null) {
        const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
        if (strategyMatch) strategy = strategyMatch[1].trim();
        const tableRows = manifest
          .split('\n')
          .filter(
            (l) =>
              l.match(/^\|\s*\w/) && !l.includes('Repo') && !l.includes('---'),
          );
        repoCount = tableRows.length;
      }
      hasProject = fs.existsSync(path.join(wsPath, '.planning', 'PROJECT.md'));

      workspaces.push({
        name: entry.name,
        path: wsPath,
        repo_count: repoCount,
        strategy,
        has_project: hasProject,
      });
    }
  }

  const result: Record<string, unknown> = {
    workspace_base: defaultBase,
    workspaces,
    workspace_count: workspaces.length,
  };

  output(result, raw);
}

function cmdInitRemoveWorkspace(cwd: string, name: string | undefined, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  if (!name) {
    error('workspace name required for init remove-workspace');
  }

  const wsPath = path.join(defaultBase, name!);
  const manifestPath = path.join(wsPath, 'WORKSPACE.md');

  if (!fs.existsSync(wsPath)) {
    error(`Workspace not found: ${wsPath}`);
  }

  const repos: { name: string; source: string; branch: string; strategy: string }[] = [];
  let strategy = 'unknown';
  const manifestContent = platformReadSync(manifestPath);
  if (manifestContent !== null) {
    try {
      const manifest = manifestContent;
      const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
      if (strategyMatch) strategy = strategyMatch[1].trim();

      const lines = manifest.split('\n');
      for (const line of lines) {
        const lineMatch = line.match(
          /^\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|$/,
        );
        if (lineMatch && lineMatch[1] !== 'Repo' && !lineMatch[1].includes('---')) {
          repos.push({
            name: lineMatch[1],
            source: lineMatch[2],
            branch: lineMatch[3],
            strategy: lineMatch[4],
          });
        }
      }
    } catch {
      /* best-effort */
    }
  }

  const dirtyRepos: string[] = [];
  for (const repo of repos) {
    const repoPath = path.join(wsPath, repo.name);
    if (!fs.existsSync(repoPath)) continue;
    const statusResult = execGit(['status', '--porcelain'], {
      cwd: repoPath,
      timeout: 5000,
    }) as unknown as Record<string, unknown>;
    if (
      statusResult['exitCode'] === 0 &&
      (statusResult['stdout'] as string).length > 0
    ) {
      dirtyRepos.push(repo.name);
    }
  }

  const result: Record<string, unknown> = {
    workspace_name: name,
    workspace_path: wsPath,
    has_manifest: fs.existsSync(manifestPath),
    strategy,
    repos,
    repo_count: repos.length,
    dirty_repos: dirtyRepos,
    has_dirty_repos: dirtyRepos.length > 0,
  };

  // #2402: sibling init commands route through withProjectRoot so response_language
  // (and project_root/agents_installed) reach the workflow; this one didn't.
  output(withProjectRoot(cwd, result), raw);
}

function buildAgentSkillsBlock(
  config: Record<string, unknown>,
  agentType: string,
  projectRoot: string,
  diagnostics?: { warnings: string[] },
): string {
  const warn = (message: string): void => {
    process.stderr.write(message);
    if (diagnostics) diagnostics.warnings.push(message.replace(/\n+$/, ''));
  };

  const runtime = (config && (config['runtime'] as string)) || 'claude';
  const globalSkillsBase = getGlobalSkillsBase(runtime);

  if (!config || !config['agent_skills'] || !agentType) return '';

  let skillPaths = (config['agent_skills'] as Record<string, unknown>)[agentType];
  if (!skillPaths) return '';

  if (typeof skillPaths === 'string') skillPaths = [skillPaths];
  if (!Array.isArray(skillPaths)) {
    warn(
      `[agent-skills] WARNING: Agent "${agentType}" has a malformed agent_skills value (expected string or array, got ${typeof skillPaths}) — ignoring\n`,
    );
    return '';
  }
  if (skillPaths.length === 0) return '';

  // Hoist trusted roots computation before the loop: loadTrustedGlobalRoots does
  // realpathSync I/O and should run at most once per call, not once per failing skill.
  // It returns [] cheaply when no roots are configured, so the realpath cost only
  // occurs when the caller has actually set trusted_global_roots.
  const trustedGlobalRoots = loadTrustedGlobalRoots(config);

  // Each entry is either a filesystem include ({ kind: 'include', ref, display }) or a
  // Skill-tool directive ({ kind: 'directive', name }) for plugin-provided namespaced skills.
  const validEntries: Array<{ kind: 'include'; ref: string; display: string } | { kind: 'directive'; name: string }> = [];
  for (const skillPath of skillPaths) {
    if (typeof skillPath !== 'string') {
      warn(`[agent-skills] WARNING: Ignoring non-string skill entry (${typeof skillPath}) — skipping\n`);
      continue;
    }

    if (skillPath.startsWith('global:')) {
      const skillName = skillPath.slice(7);
      if (!skillName) {
        warn(
          `[agent-skills] WARNING: "global:" prefix with empty skill name — skipping\n`,
        );
        continue;
      }
      // Accept: one or more [A-Za-z0-9_-]+ segments joined by single colons.
      // Rejects: empty segments (::), leading/trailing colon, dots, slashes, backslashes.
      if (!/^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/.test(skillName)) {
        warn(
          `[agent-skills] WARNING: Invalid global skill name "${skillName}" — skipping\n`,
        );
        continue;
      }
      const isNamespaced = skillName.includes(':');
      if (isNamespaced) {
        // Plugin-provided namespaced skill: no filesystem path exists locally.
        if (runtime === 'claude') {
          // Emit a natural-language Skill-tool directive (not a @-include).
          validEntries.push({ kind: 'directive', name: skillName });
        } else {
          warn(
            `[agent-skills] WARNING: Plugin-namespaced skill "global:${skillName}" requires a Skill-tool-capable runtime (claude) — skipping on runtime "${runtime}"\n`,
          );
        }
        continue;
      }
      // Non-namespaced bare name: attempt filesystem resolution as before.
      if (globalSkillsBase === null) {
        warn(
          `[agent-skills] WARNING: Runtime "${runtime}" does not use a skills directory — "global:${skillName}" is not supported on this runtime\n`,
        );
        continue;
      }
      const globalSkillDir = getGlobalSkillDir(runtime, skillName) as string;
      const globalSkillMd = path.join(globalSkillDir, 'SKILL.md');
      const displayPath = getGlobalSkillDisplayPath(runtime, skillName);
      if (!fs.existsSync(globalSkillMd)) {
        warn(
          `[agent-skills] WARNING: Global skill not found at "${displayPath}/SKILL.md" — skipping\n`,
        );
        continue;
      }
      const pathCheck = validatePath(globalSkillMd, globalSkillsBase, { allowAbsolute: true }) as unknown as Record<string, unknown>;
      if (!pathCheck['safe']) {
        const acceptedViaTrustedRoot = trustedGlobalRoots.some((root) => {
          const rootCheck = validatePath(globalSkillMd, root, { allowAbsolute: true }) as unknown as Record<string, unknown>;
          return Boolean(rootCheck['safe']);
        });
        if (!acceptedViaTrustedRoot) {
          warn(
            `[agent-skills] WARNING: Global skill "${skillName}" failed path check (symlink escape?) — skipping\n`,
          );
          continue;
        }
        // Intentionally a direct stderr write, NOT warn(): this is an acceptance
        // trace, not a skip, so it must not land in the diagnostics warnings[].
        process.stderr.write(`[agent-skills] NOTE: Global skill "${skillName}" accepted via trusted_global_roots (resolves outside the default skills dir)\n`);
      }
      validEntries.push({ kind: 'include', ref: `${globalSkillDir}/SKILL.md`, display: displayPath });
      continue;
    }

    const pathCheck = validatePath(skillPath, projectRoot) as unknown as Record<string, unknown>;
    if (!pathCheck['safe']) {
      warn(
        `[agent-skills] WARNING: Skipping unsafe path "${skillPath}": ${pathCheck['error'] as string}\n`,
      );
      continue;
    }

    const skillMdPath = path.join(projectRoot, skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      // #2941: if the bare name matches a global skill, hint at the global: prefix.
      // The bare name resolves as project-relative (which doesn't exist), but the
      // user likely meant to reference a global skill. getGlobalSkillDir is already
      // imported for the global: branch above; guard on globalSkillsBase being non-null
      // since runtimes without a skills directory don't support the prefix.
      let hint = '';
      if (globalSkillsBase !== null) {
        const baseName = path.basename(skillPath);
        const globalDir = getGlobalSkillDir(runtime, baseName) as string;
        if (globalDir && fs.existsSync(path.join(globalDir, 'SKILL.md'))) {
          hint = ` — a global skill named "${baseName}" exists; use "global:${baseName}" to reference it`;
        }
      }
      warn(
        `[agent-skills] WARNING: Skill not found at "${skillPath}/SKILL.md"${hint} — skipping\n`,
      );
      continue;
    }

    validEntries.push({ kind: 'include', ref: `${skillPath}/SKILL.md`, display: skillPath });
  }

  if (validEntries.length === 0) {
    warn(
      `[agent-skills] WARNING: Agent "${agentType}" has ${skillPaths.length} configured skill path(s) but none resolved to a valid skill — all were skipped (see warnings above)\n`,
    );
    return '';
  }

  const lines = validEntries.map((entry) => {
    if (entry.kind === 'directive') {
      return `- Load the \`${entry.name}\` skill via the Skill tool before proceeding (plugin-provided).`;
    }
    return `- @${posixNormalize(String(entry.ref))}`;
  }).join('\n');
  return `<agent_skills>\nRead these user-configured skills:\n${lines}\n</agent_skills>`;
}

/** Reason enum for agent-skills diagnostic (#1415, ADR-1411 P2). */
type AgentSkillsReason = 'resolved' | 'not_configured' | 'configured_empty' | 'configured_unresolved';

function cmdAgentSkills(
  cwd: string,
  agentType: string | undefined,
  raw: boolean,
  jsonMode: boolean,
): void {
  if (!agentType) {
    output('', raw, '');
    return;
  }

  // Anchor to project root before loading config (#1415/#1366 cwd-drift fix).
  const projectRoot = findProjectRoot(cwd);
  const { config, source, degraded } = loadConfigResolved(projectRoot);
  const diagnostics = { warnings: [] as string[] };
  let block = buildAgentSkillsBlock(
    config,
    agentType,
    projectRoot,
    diagnostics,
  );

  // #2454: Agent prompt fallback for AGENTS-native runtimes where named
  // subagents are NOT dispatchable (kimi-code, kimi, opencode, kilo, etc.).
  // On these runtimes, workflows inject ${AGENT_SKILLS_*} into the dispatch
  // prompt of a built-in subagent (coder/explore/plan). If no
  // model_profile_overrides or agent_skills config entry exists, the block
  // is empty — but the agent's prompt CONTENT is installed on disk at the
  // runtime's agents directory. Read it as a fallback so the persona survives
  // the dispatch even without explicit config opt-in.
  //
  // GATED to non-claude runtimes: Claude Code supports named subagent dispatch
  // and its ${AGENT_SKILLS_*} contract is a skills-injection path, not a
  // persona fallback. Triggering the fallback for claude would change the
  // documented "unconfigured → empty block" contract that agent-skills tests
  // pin.
  if (!block) {
    const runtime = (config && (config['runtime'] as string)) || process.env['GSD_RUNTIME'] || 'claude';
    if (runtime !== 'claude') {
      const agentCheck = checkAgentsInstalled(runtime, projectRoot) as unknown as { agents_dir?: string } | null;
      const agentsDir = agentCheck?.agents_dir;
      if (typeof agentsDir === 'string' && agentsDir.length > 0) {
        const agentFile = path.join(agentsDir, `${agentType}.md`);
        try {
          const content = platformReadSync(agentFile);
          if (content && content.length > 0) {
            block = content;
          }
        } catch { /* agent file not found — fall through to empty block */ }
      }
    }
  }

  // Compute configured + reason for diagnostic output.
  const agentSkillsMap = (config && config['agent_skills'] && typeof config['agent_skills'] === 'object')
    ? config['agent_skills'] as Record<string, unknown>
    : {};
  const configured = Object.prototype.hasOwnProperty.call(agentSkillsMap, agentType);

  let reason: AgentSkillsReason;
  let skillPaths: unknown = configured ? agentSkillsMap[agentType] : [];
  if (!configured) {
    reason = 'not_configured';
    skillPaths = [];
  } else {
    // Normalize paths to array
    if (typeof skillPaths === 'string') skillPaths = [skillPaths];
    if (!Array.isArray(skillPaths)) skillPaths = [];
    const pathsArr = skillPaths as unknown[];
    // Fix 3: treat "" (empty string) as configured_empty — all-blank entries = no meaningful paths.
    // An array of all empty/blank strings has length > 0 but zero meaningful paths.
    const nonBlankPaths = pathsArr.filter(p => typeof p === 'string' && p.trim().length > 0);
    if (pathsArr.length === 0 || nonBlankPaths.length === 0) {
      // configured with empty array / "" / all-blank entries
      reason = 'configured_empty';
      // Reflect zero meaningful paths in the normalized array used for skills_count
      skillPaths = [];
      try {
        process.stderr.write(
          `[agent-skills] WARNING: Agent "${agentType}" is configured in agent_skills but has no skill paths — skills_count will be 0\n`
        );
      } catch { /* stderr might be closed */ }
    } else if (!block) {
      // configured with paths but all failed to resolve (warnings already emitted by buildAgentSkillsBlock)
      reason = 'configured_unresolved';
    } else {
      reason = 'resolved';
    }
  }

  const normalizedPaths = Array.isArray(skillPaths) ? skillPaths : [];

  if (jsonMode) {
    // Build the Resolution<AgentSkillsValue> envelope and embed .value additively.
    // Flat fields are retained unchanged for back-compat; value formalises the
    // Resolution convention (ADR-1411 P3, #1416). source/degraded remain
    // config-provenance extras, outside the Resolution<T> envelope.
    const resolution = makeResolution(
      { block: block || '', skills_count: normalizedPaths.length },
      { configured, reason, warnings: diagnostics.warnings },
    );
    output({
      agent_type: agentType,
      block: block || '',
      skills_count: normalizedPaths.length,
      warnings: diagnostics.warnings,
      configured,
      reason,
      source,
      degraded,
      value: resolution.value,
    }, raw);
    return;
  }

  // #1400: emit the raw block via the synchronous-flush output() helper (the same
  // one the --json branch uses) rather than process.stdout.write + process.exit(0).
  // When stdout is a pipe/file (how workflows consume this via command
  // substitution) the async stdout buffer is torn down by process.exit() before
  // it drains — on Windows this reliably truncates the write to 0 bytes, so every
  // ${AGENT_SKILLS_*} substitution expands empty. output() writes every byte with
  // writeAllSync and returns, letting the event loop drain naturally.
  output(block || '', true, block || '');
}

interface SkillEntry {
  name: string;
  description: string;
  triggers: string[];
  path: string;
  file_path: string;
  root: string;
  scope: string;
  installed: boolean;
  deprecated: boolean;
}

interface RootSummary {
  root: string;
  path: string;
  scope: string;
  present: boolean;
  deprecated: boolean;
  skill_count?: number;
  command_count?: number;
}

interface SkillManifest {
  skills: SkillEntry[];
  roots: RootSummary[];
  installation: {
    gsd_skills_installed: boolean;
    legacy_claude_commands_installed: boolean;
  };
  counts: {
    skills: number;
    roots: number;
  };
}

function buildSkillManifest(cwd: string, skillsDir: string | null = null): SkillManifest {
  interface CanonicalRoot {
    root: string;
    path: string;
    scope: string;
    kind: string;
    present?: boolean;
    deprecated?: boolean;
  }

  const canonicalRoots: CanonicalRoot[] = skillsDir
    ? [
        {
          root: path.resolve(skillsDir),
          path: path.resolve(skillsDir),
          scope: 'custom',
          present: fs.existsSync(skillsDir),
          kind: 'skills',
        },
      ]
    : [
        {
          root: '.claude/skills',
          path: path.join(cwd, '.claude', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.agents/skills',
          path: path.join(cwd, '.agents', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.cursor/skills',
          path: path.join(cwd, '.cursor', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.github/skills',
          path: path.join(cwd, '.github', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.codex/skills',
          path: path.join(cwd, '.codex', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '~/.claude/skills',
          path: getGlobalSkillsBase('claude') as string,
          scope: 'global',
          kind: 'skills',
        },
        {
          // ADR-1239 upgrade 3 (#2088): Codex's canonical skill root is
          // $HOME/.agents/skills (per codex core-skills loader.rs), resolved via
          // the skills-kind `home` override in getGlobalSkillsBase.
          root: '~/.agents/skills',
          path: getGlobalSkillsBase('codex') as string,
          scope: 'global',
          kind: 'skills',
        },
        {
          // Codex's deprecated fallback skill root ($CODEX_HOME/skills). Kept as a
          // discovery-only legacy root so pre-move installs remain inventoried;
          // GSD no longer installs here (#2088).
          root: '~/.codex/skills',
          path: path.join(getGlobalConfigDir('codex'), 'skills'),
          scope: 'global',
          kind: 'skills',
          deprecated: true,
        },
        {
          root: '.claude/gsd-core/skills',
          path: path.join(os.homedir(), '.claude', 'gsd-core', 'skills'),
          scope: 'import-only',
          kind: 'skills',
          deprecated: true,
        },
        {
          root: '.claude/commands/gsd',
          path: path.join(os.homedir(), '.claude', 'commands', 'gsd'),
          scope: 'legacy-commands',
          kind: 'commands',
          deprecated: true,
        },
      ];

  const skills: SkillEntry[] = [];
  const roots: RootSummary[] = [];
  let legacyClaudeCommandsInstalled = false;
  for (const rootInfo of canonicalRoots) {
    const rootPath = rootInfo.path;
    const rootSummary: RootSummary = {
      root: rootInfo.root,
      path: rootPath,
      scope: rootInfo.scope,
      present: fs.existsSync(rootPath),
      deprecated: !!rootInfo.deprecated,
    };

    if (!rootSummary.present) {
      roots.push(rootSummary);
      continue;
    }

    if (rootInfo.kind === 'commands') {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(rootPath, { withFileTypes: true });
      } catch {
        roots.push(rootSummary);
        continue;
      }

      const commandFiles = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith('.md'),
      );
      rootSummary.command_count = commandFiles.length;
      if (rootSummary.command_count > 0) legacyClaudeCommandsInstalled = true;
      roots.push(rootSummary);
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      roots.push(rootSummary);
      continue;
    }

    // Track skill names seen within this root to deduplicate dual-routed concretes
    // (e.g. spec-phase nested under both gsd-ns-workflow and gsd-ns-manage).
    const seenNamesInRoot = new Set<string>();

    function pushSkillEntry(
      // relPath must use forward slashes on all platforms (manifest paths are
      // posix-style for cross-platform stability; flat entries use template
      // literals that always produce '/'; nested entries are joined below
      // with explicit '/' separators rather than path.join).
      relPath: string,
      content: string,
      sourcePath?: string,
    ): boolean {
      const frontmatter = extractFrontmatter(content, sourcePath);
      const dirPart = relPath.replace(/\/SKILL\.md$/, '');
      const stem = dirPart.includes('/') ? dirPart.split('/').pop()! : dirPart;
      const name = (frontmatter['name'] as string) || stem;
      if (seenNamesInRoot.has(name)) return false; // dedupe dual-routed concretes
      seenNamesInRoot.add(name);

      const description = (frontmatter['description'] as string) || '';
      const triggers: string[] = [];
      const bodyMatch = content.match(/^---[\s\S]*?---\s*\r?\n([\s\S]*)$/);
      if (bodyMatch) {
        const body = bodyMatch[1];
        const triggerLines = body.match(/^TRIGGER\s+when:\s*(.+)$/gmi);
        if (triggerLines) {
          for (const line of triggerLines) {
            const m = line.match(/^TRIGGER\s+when:\s*(.+)$/i);
            if (m) triggers.push(m[1].trim());
          }
        }
      }

      skills.push({
        name,
        description,
        triggers,
        path: dirPart,
        file_path: relPath,
        root: rootInfo.root,
        scope: rootInfo.scope,
        installed: rootInfo.scope !== 'import-only',
        deprecated: !!rootInfo.deprecated,
      });
      return true;
    }

    let skillCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = path.join(rootPath, entry.name, 'SKILL.md');
      const content = platformReadSync(skillMdPath);
      if (content !== null) {
        if (pushSkillEntry(`${entry.name}/SKILL.md`, content, skillMdPath)) skillCount++;
      }

      // Nested layout: <entry>/skills/<stem>/SKILL.md
      // Used by cline, qwen, hermes, augment, trae, antigravity (#69 nested=true).
      // Descend exactly one level into <entry>/skills/ — no deeper recursion.
      // Scope to gsd-ns-* routers only: never vacuum up an unrelated user skill
      // that happens to have its own `skills/` subdirectory.
      if (!entry.name.startsWith('gsd-ns-')) continue;
      const nestedSkillsDir = path.join(rootPath, entry.name, 'skills');
      let nestedEntries: fs.Dirent[] = [];
      try {
        nestedEntries = fs.readdirSync(nestedSkillsDir, { withFileTypes: true });
      } catch {
        // No skills/ subdir — flat layout or unreadable; nothing to do.
        nestedEntries = [];
      }
      for (const nested of nestedEntries) {
        if (!nested.isDirectory()) continue;
        const nestedSkillMd = path.join(nestedSkillsDir, nested.name, 'SKILL.md');
        const nestedContent = platformReadSync(nestedSkillMd);
        if (nestedContent === null) continue;
        // Use forward-slash separator explicitly so manifest paths are posix-style
        // on all platforms, matching the flat-layout behaviour above.
        const relPath = `${entry.name}/skills/${nested.name}/SKILL.md`;
        if (pushSkillEntry(relPath, nestedContent, nestedSkillMd)) skillCount++;
      }
    }

    rootSummary.skill_count = skillCount;
    roots.push(rootSummary);
  }

  skills.sort((a, b) => {
    const rootCmp = a.root.localeCompare(b.root);
    return rootCmp !== 0 ? rootCmp : a.name.localeCompare(b.name);
  });

  const gsdSkillsInstalled = skills.some((skill) => skill.name.startsWith('gsd-'));

  return {
    skills,
    roots,
    installation: {
      gsd_skills_installed: gsdSkillsInstalled,
      legacy_claude_commands_installed: legacyClaudeCommandsInstalled,
    },
    counts: {
      skills: skills.length,
      roots: roots.length,
    },
  };
}

function cmdSkillManifest(cwd: string, args: string[], raw: boolean): void {
  const skillsDirIdx = args.indexOf('--skills-dir');
  const skillsDir =
    skillsDirIdx >= 0 && args[skillsDirIdx + 1] ? args[skillsDirIdx + 1] : null;

  const manifest = buildSkillManifest(cwd, skillsDir);

  if (args.includes('--write')) {
    // #3964: write beside the project's own artifacts (planningDir is
    // project- and workstream-aware), not the flat root.
    const planDir = planningDir(cwd);
    if (fs.existsSync(planDir)) {
      const manifestPath = path.join(planDir, 'skill-manifest.json');
      platformWriteSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  output(manifest, raw);
}

export = {
  cmdInitExecutePhase,
  cmdInitPlanPhase,
  cmdInitNewProject,
  cmdInitNewMilestone,
  cmdInitQuick,
  cmdInitQuickBatch,
  cmdInitIngestDocs,
  cmdInitOnboard,
  cmdInitResume,
  cmdInitVerifyWork,
  cmdInitPhaseOp,
  cmdInitCodeReview,
  cmdInitReview,
  cmdInitDiscussPhaseAssumptions,
  cmdInitTodos,
  cmdInitMilestoneOp,
  cmdInitMapCodebase,
  cmdInitProgress,
  cmdInitManager,
  cmdInitCompleteMilestone,
  cmdInitAutonomous,
  cmdInitDocsUpdate,
  cmdInitUpdate,
  cmdInitTransition,
  cmdInitDebug,
  cmdInitNewWorkspace,
  cmdInitListWorkspaces,
  cmdInitRemoveWorkspace,
  detectChildRepos,
  buildAgentSkillsBlock,
  cmdAgentSkills,
  buildSkillManifest,
  cmdSkillManifest,
};
