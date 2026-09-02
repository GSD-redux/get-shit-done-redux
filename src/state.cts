/**
 * State — STATE.md operations and progression engine
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, declineNoOp, formatDiagnosticToken } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const { ExitError } = cliExitModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateContract = require('./state-contract.cjs');
const { publishStateContract } = stateContract;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const {
  parsePhaseFromProse,
  PHASE_NUMBER_TOKEN_SOURCE,
  phaseKeyFromToken,
  phaseKeyFromDir,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
  isSentinelPhaseId,
  scopeToPhase,
  // #2761 M3: owns the bracket milestone intro and canonical pad2 spelling.
  bracketMilestoneIntroSrcFor,
} = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
// #3642: hasMilestoneSectioning no longer consumed here — its >=2 semantics answered sibling conflation, but this branch asks asserted-vs-section (>=1). It stays exported from roadmap-parser.cjs for its unit pins.
const { getMilestoneInfo, extractCurrentMilestone, isMilestoneBoundedInRoadmap, hasAnyMilestoneSection } = roadmapParserMod;
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync, toPosixPath, execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningPaths, resolvePhaseIdConvention } = planningWorkspace;
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, reconstructFrontmatter, stripFrontmatter, propagateCommentChannel, FRONTMATTER_UNPARSEABLE } = frontmatter;

/**
 * ADR-3473 §8.1 (#3881, consequence 2 wiring): does `existingFm` carry the
 * `FRONTMATTER_UNPARSEABLE` marker `extractFrontmatter` sets when a frontmatter-fenced region
 * exists but failed to parse (malformed YAML, or a refused anchor/alias/merge key)? Mirrors
 * `state-transition.cts`'s private helper of the same name/shape — kept local rather than
 * exported+imported because the two modules' `existingFm` values come from independent
 * `extractFrontmatter` calls and this predicate is a two-line symbol read, not shared state.
 */
function isUnparseableFrontmatter(existingFm: Record<string, unknown>): boolean {
  return (existingFm as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateTransitionMod = require('./state-transition.cjs');
// #3873 (ADR-3473 §8.8): FRONTMATTER_KEY_TO_BODY_LABEL below is now a
// projection of this leaf schema rather than a hand-maintained literal.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateMdSchemaMod = require('./state-md-schema.cjs');

// #2573 D5: used to pin `git rev-parse` to the project's own repo. Imports only
// node builtins, so it introduces no cycle on this path.
import { findProjectRoot } from './project-root.cjs';
// #3311: advisory (phase, session) claim over the single Current Position slot.
// Imports only node builtins + planning-workspace + active-workstream-store, so
// it introduces no cycle on this path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import milestoneLockMod = require('./milestone-lock.cjs');
const { transitionCore, applyStatePreservation, sliceCurrentPositionSection } = stateTransitionMod;
// #3699: the frontmatter-key <-> body-field routing behind `state update`'s
// failure explanation, and the classification table it falls back to.
const { getFieldClassification, getFrontmatterBodySource, frontmatterKeyForBodyField } = stateTransitionMod;
// ADR-3473 §8.7 (#3872): the declared dotted-leaf enumeration `reconcileReportedFields`
// diffs against — see `declaredLeavesOf` below.
const { FIELD_CLASSIFICATION } = stateTransitionMod;
type StateTransitionIntent = stateTransitionMod.StateTransitionIntent;
type StateTransitionDeps = stateTransitionMod.StateTransitionDeps;
type PhaseInventoryRecord = stateTransitionMod.PhaseInventoryRecord;
type PhaseInventoryResult = stateTransitionMod.PhaseInventoryResult;
// ADR-3473 §8.6: the state transaction type (see openStateTransaction /
// rebuildStateTransaction in state-transition.cts).
type StateTransaction = stateTransitionMod.StateTransaction;
import {
  computeProgressPercent,
  normalizeProgressNumbers,
  normalizeStateStatus,
  shouldPreserveExistingProgress,
  stateExtractField,
  stateFieldValue,
  // #3696: the `last_activity` invariant that `state validate` (S008/S009) now
  // asserts. Both live in the field-semantics owner, not here, so `smart-entry`
  // and `state validate` cannot drift apart about the same field.
  // `leadingCalendarDate` wraps `isRealCalendarDate`, which smart-entry calls
  // directly — one predicate, two callers, no copies.
  isUnfilledFieldValue,
  leadingCalendarDate,
  stateFieldContinuation,
  stateReplaceField,
  KNOWN_TEMPLATE_DEFAULTS,
  stateReplaceFieldIfTemplate,
  stateCurrentPositionSlice,
} from './state-document.cjs';
import { tokenizeHeadings, collectSection, replaceSection, stripFencedCode } from './markdown-sectionizer.cjs';
import type { HeadingToken } from './markdown-sectionizer.cjs';
import { parseMarkdownTable, updateTableCell, deleteTableRow, insertTableRow, splitTableRow, isDelimiterRow } from './markdown-table.cjs';
import { textEncodingError } from './validate.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticTypesMod = require('./health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticTypesMod;
type Severity = healthDiagnosticTypesMod.Severity;
type Diagnostic = healthDiagnosticTypesMod.Diagnostic;

// ─── Types ────────────────────────────────────────────────────────────────────

// Local frontmatter type alias matching frontmatter.cts so we can call reconstructFrontmatter
type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

interface StateLockClock {
  now(): number;
  sleep(ms: number): void;
}

/**
 * ADR-3473 §8.7 (#3872): the transaction's pre-write snapshot, threaded from
 * `applyPostSyncPreservation` to `reconcileReportedFields` via
 * `ReadModifyWriteOptions.preWriteState` (see that field's own docstring for
 * the out-param idiom). `bodyDeltas` is the SAME pre/post body-source map
 * `applyPostSyncPreservation` builds for preservation — reused (not
 * re-derived) as the "did THIS write's own transform actually change the
 * body source" signal for every `FRONTMATTER_BODY_SOURCE` key, since those
 * keys are re-derived into frontmatter from the body on EVERY write
 * regardless of whether this write touched them (see
 * `computeChangedFrontmatterFields`'s docstring for why a raw frontmatter
 * diff over-reports for this key set).
 */
interface StatePreWriteSnapshot {
  fm?: Record<string, unknown>;
  body?: string;
  bodyDeltas?: Record<string, { pre: string | null; post: string | null }>;
}

interface ReadModifyWriteOptions {
  resync?: boolean;
  /** #2440: when true, total_plans/total_phases take derived values even under !resync. */
  deriveProgressKeys?: boolean;
  /**
   * #2736: intent-first frontmatter values forwarded to syncStateFrontmatter.
   * Transition adapters that already hold the exact value (e.g. beginPhase's
   * display name) pass it here so the lossy body-prose re-derivation can never
   * destroy information the transition just resolved.
   */
  authoritativeFm?: Record<string, unknown>;
  /**
   * ADR-3408 §8.5 (D4): out-param, forwarded straight through to
   * `syncAndPreserveStateMd` — every frontmatter field name whose value
   * preservation restored over a disagreeing freshly-derived one during THIS
   * write. Callers that supply an array here can fold it into their own
   * report (see `reconcileReportedFields`) so a preserved field the caller's
   * transform never named is still visible (#3345's direction). Omit for
   * callers that do not report per-field arrays; costs nothing extra.
   */
  divergedFields?: string[];
  /**
   * ADR-3473 §8.6 (found while diagnosing a regression against the
   * pre-existing #3242 "resyncs progress frontmatter from the updated body"
   * spec): true ONLY when `resync` was set to true BECAUSE the caller
   * explicitly named a progress-affecting field (`Progress`, `Total Plans in
   * Phase`, `Total Phases` — see `shouldResyncStateProgress`), as opposed to
   * `resync` defaulting true for an unrelated write (e.g. `state
   * add-decision`, `state advance-plan`). The `preserve-always` /
   * `progress-ratchet` unmeasured-scan guard (`applyPreserveAlways`,
   * state-transition.cts) exists to stop an INCIDENTAL resync from dropping a
   * real curated block when the disk scan measured nothing (#3756, an
   * archived-milestone side effect nobody asked for). It must NOT also block
   * a write the user pointed AT `progress` on purpose — `preserve-always`'s
   * own contract is "never overwrite unless the caller explicitly names this
   * field" (FIELD_CLASSIFICATION doc comment), and `state update Progress` /
   * `state patch Progress=...` are exactly that explicit naming. Set only by
   * `cmdStateUpdate` / `cmdStatePatch`, the only two call sites where
   * `resync` is driven by `shouldResyncStateProgress` rather than defaulting.
   */
  explicitProgressField?: boolean;
  /**
   * ADR-3473 §8.7 (issue #3872): caller-allocated out-param, following the
   * SAME idiom as `divergedFields` above (caller allocates an empty box,
   * the pipeline fills it) — `applyPostSyncPreservation` populates `.fm`
   * with the transaction's OWN pre-write snapshot (`transaction.snapshot`,
   * the exact object `openStateTransaction`/`rebuildStateTransaction` was
   * constructed with — never a second `extractFrontmatter` derivation of
   * `originalContent`, which is the divergence this epic exists to remove)
   * and `.body` with the pre-write BODY (`stripFrontmatter(originalContent)`)
   * that the body-label comparison in `reconcileReportedFields` needs and
   * the frontmatter snapshot does not carry. Left entirely `undefined` when
   * `readModifyWriteStateMd`'s own #948 no-op guard fires (the transform's
   * raw output was byte-identical to the input, so nothing was ever
   * synced/preserved/written) — a consumer must treat "unset" as "nothing
   * changed", never coerce it to an empty snapshot (an empty `{}` would
   * make every already-persisted key look newly ADDED per §8.7's diff).
   */
  preWriteState?: StatePreWriteSnapshot;
}

/**
 * #3408 review (close-known-limits): options for `applyPostSyncPreservation`
 * and `syncAndPreserveStateMd` — replaces the 8-positional-parameter
 * signatures (a Data Clump / out-param smell flagged in review and deferred
 * pending "a third consumer"; `cmdMilestoneComplete` is that third consumer).
 * Same shape as `ReadModifyWriteOptions` minus `resync` being required here
 * (every existing call site already passes it explicitly) — derived below
 * so the two interfaces cannot drift out of hand-sync.
 *
 * `divergedFields` (ADR-3408 §8.5 D4) stays an out-param (not a return
 * value) deliberately: converting it ripples into every caller's control
 * flow for no behavior change.
 */
type StatePreservationOptions = Omit<ReadModifyWriteOptions, 'resync'> & { resync: boolean };

interface StateRecordMetricOptions {
  phase: string;
  plan: string;
  duration: string;
  tasks?: string | number;
  files?: string | number;
}

interface StateAddDecisionOptions {
  phase?: string;
  summary?: string;
  summary_file?: string;
  rationale?: string;
  rationale_file?: string;
}

interface StateAddBlockerOptions {
  text?: string;
  text_file?: string;
}

interface StateAddRoadmapEvolutionOptions {
  phase?: string;
  action?: string;
  after?: string;
  note?: string;
  note_file?: string;
  urgent?: boolean;
}

interface StateRecordSessionOptions {
  stopped_at?: string;
  resume_file?: string | null;
}

interface StateSnapshotSession {
  last_date: string | null;
  stopped_at: string | null;
  resume_file: string | null;
}

interface StatePruneOptions {
  keepRecent?: number | string;
  dryRun?: boolean;
  silent?: boolean;
}

interface StateRebuildOptions {
  dryRun?: boolean;
  verbose?: boolean;
  silent?: boolean;
}

interface StateSyncOptions {
  verify?: boolean;
}

interface PrunedSection {
  section: string;
  count: number;
  lines: string[];
}

const STATE_PROGRESS_RESYNC_FIELDS = new Set([
  'Progress',
  'Total Plans in Phase',
  'Total Phases',
]);

function shouldResyncStateProgress(fields: Iterable<string>): boolean {
  for (const field of fields) {
    if (STATE_PROGRESS_RESYNC_FIELDS.has(field)) {
      return true;
    }
  }
  return false;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

// Cache disk scan results from buildStateFrontmatter per cwd per process (#1967).
// Avoids re-reading N+1 directories on every state write when the phase structure
// hasn't changed within the same gsd-tools invocation.
const _diskScanCache = new Map<string, {
  // #3354: null is the milestoned-but-unbounded WITHHOLD sentinel — the scan
  // refused to substitute the on-disk dir count for a rejected whole-document
  // ROADMAP total, so the caller must keep the pre-existing value (stored
  // frontmatter, body annotation) or omit the key. Never a scan result.
  totalPhases: number | null;
  completedPhases: number;
  totalPlans: number;
  completedPlans: number;
  milestoneBounded: boolean;
  // #3217 (ADR-3180 §7.6 rule 4, finding 1): the real `listMilestonePhaseDirs`
  // scope for `allMatchingDirs` below, threaded through the cache so the
  // percent computation at the bottom of buildStateFrontmatter can gate on it
  // instead of hardcoding SCOPE.COMPLETE. Distinct from `milestoneBounded`
  // (a heading-existence guard, #1761) — this one is disk-readability.
  phaseDirScope: Scope;
}>();

// Track all lock files held by this process so they can be removed on exit.
// process.on('exit') fires even on process.exit(1), unlike try/finally which is
// skipped when error() calls process.exit(1) inside a locked region (#1916).
const _heldStateLocks = new Set<string>();
process.on('exit', () => {
  for (const lockPath of _heldStateLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------------
// Lock liveness probe (test seam) — audit M1
//
// mtime is a LEAKY proxy for "the holder is still alive": a live-but-slow writer
// whose critical section runs past staleThresholdMs ages out and a waiter would
// steal its lock → two writers in STATE.md's read-modify-write window → lost
// update / corruption (the recurring #500/#905/#1230 family). The real signal —
// process.kill(pid, 0) — is already used by capability-lock.cts. We backport it
// here. The indirection lets unit tests inject a deterministic isPidAlive without
// real pids (mirrors capability-lock's _lockProbes / _setLockProbes seam).
// ---------------------------------------------------------------------------

/** Is `pid` a live process? process.kill(pid, 0) succeeds for a live (signalable) process. */
function _realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    // EPERM = process exists but we cannot signal it (still ALIVE). ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const _stateLockProbes: { isPidAlive: (pid: number) => boolean } = { isPidAlive: _realIsPidAlive };

// ---------------------------------------------------------------------------
// State-lock test hooks (test seam) — audit M8 / M9
//
// Both M8 (scan-before-lock TOCTOU in writeStateMd) and M9 (orphan empty lock +
// fd leak on a recoverable writeSync/closeSync error in acquireStateLock) are
// concurrency / resource-safety issues a single-threaded test cannot otherwise
// observe. These purpose-built hooks make the failure windows deterministic
// (mirrors the M1 _setLockProbes seam above):
//
//   afterAcquire(lockPath)  — fired inside writeStateMd immediately AFTER the lock
//     is acquired. A test can mutate the disk here (simulate a concurrent writer
//     landing in the scan→lock window) to prove the disk scan runs INSIDE the lock.
//   simulateWriteError      — a ONE-SHOT errno string. When set, the next writeSync
//     inside acquireStateLock throws it (and the hook self-clears), forcing the
//     openSync-succeeds-then-write-fails cleanup path without an OS-level fault.
//   onLoopIteration(ctx)    — fired at the TOP of each acquireStateLock retry
//     iteration so a test can snapshot whether an orphan lock is stranded.
//   beforeSteal(ctx)        — fired AFTER the steal decision but BEFORE the identity
//     re-confirm + atomic rename-steal. A test can recreate a fresh lock here to
//     simulate a racer winning the steal in the decision→steal gap, proving the
//     identity re-confirm aborts a double-steal (PR #1532 review window b).
//
// All hooks default to no-ops; real callers are byte-for-behaviour unchanged.
// ---------------------------------------------------------------------------
interface StateLockTestHooks {
  afterAcquire?: (lockPath: string) => void;
  simulateWriteError?: string | null;
  onLoopIteration?: (ctx: { iteration: number }) => void;
  beforeSteal?: (ctx: { lockPath: string }) => void;
}
const _stateLockTestHooks: StateLockTestHooks = {};

/**
 * Consume the one-shot simulateWriteError errno, if set. Returns an Error with the
 * configured `.code` and self-clears so only the NEXT writeSync throws (the retry
 * then succeeds). Returns null when no injection is pending.
 */
function _consumeSimulatedWriteError(): NodeJS.ErrnoException | null {
  const code = _stateLockTestHooks.simulateWriteError;
  if (!code) return null;
  _stateLockTestHooks.simulateWriteError = null; // one-shot
  const e = new Error('simulated writeSync failure (' + code + ')') as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function _stateLockIsPidAlive(pid: number): boolean {
  return _stateLockProbes.isPidAlive(pid);
}

/**
 * Is the holder recorded in the lock body VERIFIED-LIVE? The STATE.md lock body is
 * a bare pid (written at acquire time). Returns true ONLY when the body parses to a
 * positive integer pid AND that pid signals alive. A garbage / non-numeric / legacy
 * body (or a dead pid) is NOT verified-live, so the lock stays stealable — corrupt
 * locks never block forever, and a live holder is never stolen.
 */
function _stateHolderVerifiedLive(lockPath: string): boolean {
  const pid = _stateLockBodyPid(lockPath);
  return pid !== null && _stateLockIsPidAlive(pid);
}

/**
 * Three-way classification of a lock body read (issue #3057 B2): a pid that
 * parses cleanly, a body that reads but is empty/garbage/non-numeric, or a
 * body that could not be READ at all (I/O fault — permission error, transient
 * NFS/overlay-fs hiccup, mid-rename, etc.). The third case is NOT the same as
 * the second: an unreadable body tells us nothing about whether the lock is
 * fresh, stale, or actively held mid-write by a live process whose file the
 * fault merely prevented us from reading. Collapsing it into "empty" would
 * make it eligible for the short fresh-create-floor steal window, which can
 * rob an active holder purely because of a transient read fault.
 */
type LockBodyStatus =
  | { kind: 'pid'; pid: number }
  | { kind: 'empty' }
  | { kind: 'unreadable' };

/**
 * Read + classify the lock body at `lockPath`. See `LockBodyStatus` for the
 * three-way distinction the steal decision in `acquireStateLock` relies on.
 */
function _stateLockBodyStatus(lockPath: string): LockBodyStatus {
  let body: string;
  try {
    body = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return { kind: 'unreadable' };
  }
  const trimmed = body.trim();
  const pid = parseInt(trimmed, 10);
  if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== trimmed) return { kind: 'empty' };
  return { kind: 'pid', pid };
}

/**
 * Parse the lock body to its recorded pid, or null when the body is empty / non-numeric
 * / unreadable (legacy or mid-creation). Distinguishing a COMPLETE dead-pid body (steal
 * promptly) from an EMPTY/unparseable one (the create→write window — do not steal while
 * fresh) is what `_stateHolderVerifiedLive` alone cannot express, so the steal decision
 * in acquireStateLock reads the pid directly (PR #1532 review, window a).
 *
 * NOTE: this collapses "genuinely empty" and "unreadable" to the same `null` —
 * that is fine for `_stateHolderVerifiedLive` (both mean "not verified-live"
 * either way), but the STEAL-TIMING decision must not make that same
 * collapse (#3057 B2) and reads `_stateLockBodyStatus` directly instead.
 */
function _stateLockBodyPid(lockPath: string): number | null {
  const status = _stateLockBodyStatus(lockPath);
  return status.kind === 'pid' ? status.pid : null;
}

// Monotonic sequence for unique stale-steal rename targets (no crypto dependency).
let _stateStealSeq = 0;

// The `byPhaseTablePattern` regex hoisted here for #320 (canonical-column-
// ORDER-only By-Phase table match) is retired (#2245 audit): its last caller
// — updatePerformanceMetricsSection's row-INSERT branch — now locates the
// table via findTableStartOffset/insertTableRow, name-addressed and
// header-order-agnostic like the update/sum halves of the same function.

// ─── ADR-1372 T6: seam-based section splice helper ───────────────────────────

// Shared stop predicates corresponding to the regex lookaheads used in state.cts:
//   STOP_H2_PLUS : (?=\n##|$)            — stops at any heading with level ≥ 2
//   STOP_H2_H3   : (?=\n###?|\n##[^#]|$) — stops at level 2 or 3
//   STOP_H2_ONLY : (?=\n##[^#]|$)        — stops at level 2 only
const STOP_H2_PLUS = (lv: number): boolean => lv >= 2;
const STOP_H2_H3 = (lv: number): boolean => lv === 2 || lv === 3;
const STOP_H2_ONLY = (lv: number): boolean => lv === 2;

function cmdStateLoad(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const paths = planningPaths(cwd);
  const planDir = paths.planning;

  const stateRaw = platformReadSync(path.join(planDir, 'STATE.md')) || '';

  const configExists = fs.existsSync(path.join(planDir, 'config.json'));
  const roadmapExists = fs.existsSync(path.join(planDir, 'ROADMAP.md'));
  const stateExists = stateRaw.length > 0;

  const result = {
    config,
    state_raw: stateRaw,
    state_exists: stateExists,
    roadmap_exists: roadmapExists,
    config_exists: configExists,
    // #2376: absolute (anchored on cwd), not orchestrator-cwd-relative — a
    // spawned subagent's own cwd may differ from the orchestrator's.
    // #3149: debug.md now has its own `init.debug` entry point and reads this
    // field from there, not from `state load`. This stays on the state.load
    // bundle regardless: it is a shipped query surface with its own test anchor
    // (tests/state.test.cjs), so narrowing it would break unseen consumers for
    // no gain (Hyrum's Law). Both emit the SAME `planningPaths(cwd).debug`.
    debug_dir: toPosixPath(paths.debug),
  };

  // For --raw, output a condensed key=value format
  if (raw) {
    const c = config as Record<string, string | boolean | undefined>;
    const lines = [
      `model_profile=${c['model_profile']}`,
      `commit_docs=${c['commit_docs']}`,
      `branching_strategy=${c['branching_strategy']}`,
      `phase_branch_template=${c['phase_branch_template']}`,
      `milestone_branch_template=${c['milestone_branch_template']}`,
      `parallelization=${c['parallelization']}`,
      `research=${c['research']}`,
      `plan_checker=${c['plan_checker']}`,
      `verifier=${c['verifier']}`,
      `config_exists=${configExists}`,
      `roadmap_exists=${roadmapExists}`,
      `state_exists=${stateExists}`,
    ];
    process.stdout.write(lines.join('\n'));
    throw new ExitError(0);
  }

  output(result, false, undefined);
}

function cmdStateGet(cwd: string, section: string | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  const content = platformReadSync(statePath);
  if (content === null) {
    error('STATE.md not found');
    return;
  }
  {

    if (!section) {
      output({ content }, raw, content);
      return;
    }

    // Try to find markdown section or field
    const fieldEscaped = escapeRegex(section);

    // Check for **field:** value (bold format)
    const boldPattern = new RegExp(`\\*\\*${fieldEscaped}:\\*\\*\\s*(.*)`, 'i');
    const boldMatch = content.match(boldPattern);
    if (boldMatch) {
      output({ [section]: boldMatch[1].trim() }, raw, boldMatch[1].trim());
      return;
    }

    // Check for field: value (plain format)
    const plainPattern = new RegExp(`^${fieldEscaped}:\\s*(.*)`, 'im');
    const plainMatch = content.match(plainPattern);
    if (plainMatch) {
      output({ [section]: plainMatch[1].trim() }, raw, plainMatch[1].trim());
      return;
    }

    // Check for ## Section
    const sectionPattern = new RegExp(`##\\s*${fieldEscaped}\\s*\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const sectionMatch = content.match(sectionPattern);
    if (sectionMatch) {
      output({ [section]: sectionMatch[1].trim() }, raw, sectionMatch[1].trim());
      return;
    }

    output({ error: `Section or field "${section}" not found` }, raw, '');
  }
}

function readTextArgOrFile(cwd: string, value: string | undefined, filePath: string | undefined, label: string): string | undefined {
  if (!filePath) return value;

  // Path traversal guard: ensure file resolves within project directory
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validatePath } = require('./security.cjs') as { validatePath(filePath: unknown, baseDir: unknown, opts?: { allowAbsolute?: boolean }): { safe: boolean; resolved: string; error?: string } };
  const pathCheck = validatePath(filePath, cwd, { allowAbsolute: true });
  if (!pathCheck.safe) {
    throw new Error(`${label} path rejected: ${pathCheck.error as string}`);
  }

  try {
    return fs.readFileSync(pathCheck.resolved, 'utf-8').trimEnd();
  } catch {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function cmdStatePatch(cwd: string, patches: Record<string, string>, raw: boolean): void {
  // Validate all field names before processing
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validateFieldName } = require('./security.cjs') as { validateFieldName(field: unknown): { valid: boolean; error?: string } };
  for (const field of Object.keys(patches)) {
    const fieldCheck = validateFieldName(field);
    if (!fieldCheck.valid) {
      error(`state patch: ${fieldCheck.error as string}`);
    }
  }

  const statePath = planningPaths(cwd).state;
  try {
    const shouldResync = shouldResyncStateProgress(Object.keys(patches));

    // ADR-1769 Phase 6: dispatches to the STATE.md Transition Module. The
    // per-patch stateReplaceField loop is the pure `patchCore` in
    // src/state-transition.cts. readModifyWriteStateMd still owns the lock, the
    // #1230/#1264 post-sync preservation, AND the #1695 curated-current_phase_name
    // delta (table-driven) that this phase adds. Field-name validation (security)
    // and the resync-progress decision stay in this adapter.
    let precomputed: { updated: string[]; failed: string[] } = { updated: [], failed: [] };
    const divergedFields: string[] = [];
    // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
    // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
    const preWriteState: StatePreWriteSnapshot = {};
    readModifyWriteStateMd(statePath, (content) => {
      const result = transitionCore(content, { kind: 'patch', patches }, { clock: realClock });
      precomputed = (result.data as { updated: string[]; failed: string[] }) ?? precomputed;
      return result.content;
    }, cwd, { resync: shouldResync, divergedFields, explicitProgressField: shouldResync, preWriteState });

    // ADR-3408 §8.4 (D4, fix(#3351) generalized — see `reconcileReportedFields`):
    // patchCore's bookkeeping says whether the stateReplaceField text-replace
    // MATCHED — but its plain-line pattern (`m` flag over the full document)
    // can match the YAML frontmatter line for a lower-cased key, and the write
    // pipeline (syncStateFrontmatter re-derivation + the FIELD_CLASSIFICATION
    // preservation rows) then discards or restores that text before the file is
    // saved. A field is only reported `updated` when its post-write on-disk
    // value equals what THIS transform actually wrote (the frontmatter key
    // when present, else the body field — the legitimate working case for
    // state.patch is display-cased BODY fields — Status, Current Plan, Phase —
    // which are never frontmatter keys). Also folds in any field
    // `applyStatePreservation` restored that this patch never named at all
    // (#3345's direction), a case the pre-#3471 version of this command never
    // covered.
    const updated = reconcileReportedFields(statePath, preWriteState, precomputed.updated, divergedFields);
    const updatedSet = new Set(updated);
    const failed = Object.keys(patches).filter((field) => !updatedSet.has(field));
    const results = { updated, failed };

    output(results, raw, results.updated.length > 0 ? 'true' : 'false');
  } catch {
    error('STATE.md not found');
  }
}

/**
 * Why did `state update <field>` not write anything?
 *
 * #3699: this used to be one sentence — `Field "X" not found in STATE.md` — for
 * every falsy outcome, so a PRESENT-but-derived frontmatter key and a genuinely
 * absent field produced byte-identical output apart from the name. The classifier
 * already knew the difference; the message threw it away, and worse, pointed away
 * from the route that works.
 *
 * Four distinct answers, because there are four distinct situations:
 *   1. a body-derived frontmatter key whose body source EXISTS  → name that source
 *   2. a frontmatter key with no body source at all (disk/external/clock-derived)
 *      → say what derives it, and do not invent a body field to blame
 *   3. a body field that feeds a frontmatter key still carrying a value
 *      → name the key, so case D is diagnosable rather than a bare absence
 *   4. genuinely unknown                                         → unchanged
 */
function explainUpdateFailure(field: string): string {
  const bodySource = getFrontmatterBodySource(field);
  if (bodySource) {
    // (1) The fallback in `updateCore` did not fire, so a body source line
    // exists — that is the writable route.
    const [primary] = bodySource;
    return `Field "${field}" is a body-derived frontmatter key and is not directly writable. `
      + `Update its body source instead: state update "${primary}" <value>.`;
  }
  const classification = getFieldClassification(field);
  if (classification) {
    // (2) Known key, no body source: disk/external/free-derived.
    const derivedFrom: Record<string, string> = {
      disk: 'derived from a scan of .planning/phases/ and is not directly writable',
      external: 'derived from ROADMAP.md and is not directly writable',
      free: 'recomputed on every write and is not directly writable',
      curated: 'maintained by the write path and is not directly writable through this command',
      body: 'body-derived and is not directly writable',
    };
    return `Field "${field}" is a frontmatter key that is ${derivedFrom[classification.source]}.`;
  }
  const owningKey = frontmatterKeyForBodyField(field);
  if (owningKey) {
    // (3) Case D from the body-field side.
    return `Field "${field}" not found in STATE.md. It is the body source for frontmatter key `
      + `"${owningKey}" — add the "${field}:" line to the body, or update "${owningKey}" directly `
      + `to repair a document whose body source is missing.`;
  }
  return `Field "${field}" not found in STATE.md`; // (4) genuinely unknown
}

function cmdStateUpdate(cwd: string, field: string | undefined, value: string | undefined): void {
  if (!field || value === undefined) {
    error('field and value required for state update');
  }

  // Validate field name to prevent regex injection via crafted field names
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validateFieldName } = require('./security.cjs') as { validateFieldName(field: unknown): { valid: boolean; error?: string } };
  const fieldCheck = validateFieldName(field);
  if (!fieldCheck.valid) {
    error(`state update: ${fieldCheck.error as string}`);
  }

  const statePath = planningPaths(cwd).state;
  try {
    let updated = false;
    // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
    // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
    const preWriteState: StatePreWriteSnapshot = {};
    let transitionData: Record<string, unknown> | undefined;
    // #3699 case D: when `updateCore` falls back to writing the frontmatter key
    // directly, the value must survive the post-sync pass — otherwise the write
    // is silently undone. `buildStateFrontmatter` re-derives `stopped_at` from
    // the body, finds no source, and emits nothing; `applyPreserveWhenUnchanged`
    // then sees an unchanged (absent) body source and restores the PRE-write
    // snapshot over the value just written. Verified: without this the command
    // reported `updated:false` with `preserved:["Stopped At"]` and the old value
    // stood.
    //
    // `authoritativeFm` is the seam built for exactly this (#2736 — "intent-first
    // frontmatter values … so the lossy body-prose re-derivation can never
    // destroy information the transition just resolved"), and it is re-applied
    // AFTER preservation (`applyPostSyncPreservation`), so it wins the restore.
    //
    // Populated by the transform below rather than up front, because only the
    // transition knows whether the fallback fired. Safe: `readModifyWriteStateMd`
    // dereferences `options.authoritativeFm` after running the transform. Left
    // empty when the fallback does not fire — an empty object iterates zero
    // entries and is a no-op at both application sites.
    const authoritativeFm: Record<string, unknown> = {};
    const divergedFields: string[] = [];
    const shouldResync = shouldResyncStateProgress([field as string]);
    // ADR-1769 Phase 7: dispatches to the STATE.md Transition Module. The
    // body-strip/reassemble single-field update is the pure `updateCore` in
    // src/state-transition.cts. readModifyWriteStateMd still owns the lock, the
    // #1230/#1264/#1695 post-sync preservation, and the no-op write guard.
    // Preserve curated progress for body-only updates, but allow fields that
    // directly project into progress.* frontmatter to rebuild after mutation.
    readModifyWriteStateMd(statePath, (content) => {
      const result = transitionCore(
        content,
        { kind: 'update', field: field as string, value: value as string },
        { clock: realClock },
      );
      updated = (result.data as { updated: boolean } | undefined)?.updated === true;
      transitionData = result.data;
      if (transitionData?.wroteFrontmatter === true) {
        authoritativeFm[field as string] = value;
      }
      return result.content;
    }, cwd, { resync: shouldResync, divergedFields, authoritativeFm, explicitProgressField: shouldResync, preWriteState });

    // ADR-3408 §8.4 (D4): reconcile against the bytes actually persisted —
    // `updateCore`'s own match does not know whether sync/preservation later
    // discarded the value it wrote (#3351's direction, generalized from
    // `cmdStatePatch`). `preserved` folds in any OTHER field preservation
    // restored during this write that this command never touched at all
    // (#3345's direction) — reported separately from `updated` because this
    // command's contract is a single-field boolean, not a per-field array.
    const reconciled = reconcileReportedFields(statePath, preWriteState, updated ? [field as string] : [], divergedFields);
    updated = reconciled.includes(field as string);
    const preserved = reconciled.filter((f) => f !== field);

    if (updated) {
      // #3699 case D: surfaced so a caller can tell "wrote the body source" from
      // "wrote the frontmatter key because no body source existed" — the second
      // is a repair, and silently reporting it as an ordinary update is the same
      // class of unfalsifiable success this issue is about.
      const wroteFrontmatter = (transitionData as { wroteFrontmatter?: boolean } | undefined)?.wroteFrontmatter === true;
      if (!wroteFrontmatter) {
        output({ updated: true, preserved }, false, undefined);
      } else {
        // `preserved` reports the BODY LABEL of each field preservation restored
        // (`bodyLabelFor`, the #3345 direction). In the case-D fallback that
        // reading is stale by one step: preservation DID restore this field's
        // snapshot, and `authoritativeFm` then overrode it, so the value on disk
        // is the one just written. Reporting it as preserved would claim a
        // restore that did not survive — the same unfalsifiable-success shape
        // #3699 is about, one field over. Drop this field's own labels; other
        // fields' preservation is untouched and still reported.
        const ownLabels = new Set((getFrontmatterBodySource(field as string) ?? []).map((l) => l.toLowerCase()));
        output({
          updated: true,
          wrote: 'frontmatter',
          preserved: preserved.filter((p) => !ownLabels.has(p.toLowerCase())),
        }, false, undefined);
      }
    } else {
      output({ updated: false, reason: explainUpdateFailure(field as string), preserved }, false, undefined);
    }
  } catch {
    output({ updated: false, reason: 'STATE.md not found' }, false, undefined);
  }
}

// ─── State Progression Engine ────────────────────────────────────────────────

/**
 * The "I could not read the plan position" message, DERIVED from
 * `STATE_FIELD_SCHEMA.current_plan.acceptedShapes` rather than transcribed
 * beside it.
 *
 * The accepted-shape set had two owners: the parser branches in
 * `advancePlanCore` and an English list hand-written here. Nothing coupled
 * them, so adding a branch left this message stale and removing one left it
 * advertising a shape that errors — and no test could see either. ADR-3473
 * §8.3 is "one implementation per rule"; the schema row is that one owner, and
 * rows 23/24/25 already hold the parser to it.
 *
 * `Plan: N of M` is spelled out separately because there is no schema row for
 * the body-only `Plan` field: `buildStateFrontmatter` never reads it into
 * frontmatter, so it has no `current_*` key to hang a row on. That asymmetry is
 * the schema's, not this function's.
 */
function advancePlanShapeError(): string {
  const shapes = stateMdSchemaMod.STATE_FIELD_SCHEMA['current_plan']?.acceptedShapes ?? [];
  const spellings = shapes.map((shape) => (
    shape === 'N'
      ? '`Current Plan: N` with `Total Plans in Phase: M`'
      : `\`Current Plan: ${shape}\``
  ));
  // The body-only `Plan` field has no schema row to derive from:
  // `buildStateFrontmatter` never reads it into frontmatter, so there is no
  // `current_*` key to hang a row on. Its ONE accepted spelling is named here.
  //
  // `Plan: N` with a `Total Plans in Phase: M` sibling is deliberately NOT
  // listed (#3791 review round 6, M2): the parser does not accept it. A
  // revision of this PR added both the branch and this spelling together, on
  // the reasoning that the message must advertise exactly what the parser
  // accepts. That reasoning still holds — which is why removing the branch
  // removes the spelling in the same commit. The invariant is the lockstep,
  // not the length of the list.
  spellings.push('`Plan: N of M`');
  return `Cannot read the plan position from STATE.md. Expected one of: ${spellings.join(', ')}.`;
}

/**
 * Replace a STATE.md field with fallback field name support.
 * Tries `primary` first, then `fallback` (if provided), returns content unchanged
 * if neither matches. This consolidates the replaceWithFallback pattern that was
 * previously duplicated inline across phase.cjs, milestone.cjs, and state.cjs.
 */
function stateReplaceFieldWithFallback(content: string, primary: string, fallback: string | null | undefined, value: string): string {
  let result = stateReplaceField(content, primary, value);
  if (result) return result;
  if (fallback) {
    result = stateReplaceField(content, fallback, value);
    if (result) return result;
  }
  // Neither pattern matched — field may have been reformatted or removed.
  // Log diagnostic so template drift is detected early rather than silently swallowed.
  process.stderr.write(
    `[gsd-tools] WARNING: STATE.md field "${primary}"${fallback ? ` (fallback: "${fallback}")` : ''} not found — update skipped. ` +
    `This may indicate STATE.md was externally modified or uses an unexpected format.\n`
  );
  return content;
}

function cmdStateAdvancePlan(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  // ADR-1769 Phase 2: dispatches to the STATE.md Transition Module. The
  // ~80-line RMW callback that used to live here (plan parsing, advance vs
  // phase-complete branching, template-default-aware field replacement,
  // Current Position section mutation) is now the pure `advancePlanCore`
  // function in src/state-transition.cts.
  const intent: StateTransitionIntent = { kind: 'advancePlan' };
  const deps: StateTransitionDeps = {
    clock: realClock,
    sourcePath: statePath,
  };

  let resultData: Record<string, unknown> | undefined;
  let precomputedUpdated: string[] = [];
  const divergedFields: string[] = [];
  // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
  // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
  const preWriteState: StatePreWriteSnapshot = {};
  // #3311: the milestone (phase + session) claim is consulted INSIDE the
  // STATE.md lock, so the position read and the claim read cannot interleave
  // with another session's Current Position write.
  let milestoneConflict: milestoneLockMod.MilestoneConflict | null = null;
  const wrote = readModifyWriteStateMd(statePath, (content) => {
    // advance-plan has no phase argument of its own — the phase it advances is
    // whatever ## Current Position names. Compare that against the milestone
    // claim: a mismatch means another session moved the single-slot position
    // away from the claimed phase (the #3311 flip) and must be surfaced, not
    // silently absorbed.
    const body = stripFrontmatter(content);
    const positionScope = matchCurrentPositionSection(body) ?? body;
    const positionPhase = parseProsePhaseField(stateExtractField(positionScope, 'Phase')).phase;
    if (positionPhase !== null) {
      milestoneConflict = milestoneLockMod.checkMilestonePosition(cwd, positionPhase);
      if (milestoneConflict) {
        milestoneLockMod.warnMilestoneConflict(milestoneConflict, 'state.advance-plan');
      }
    }
    const result = transitionCore(content, intent, deps);
    resultData = result.data;
    precomputedUpdated = result.updated;
    return result.content;
  }, cwd, { divergedFields, preWriteState });

  // `!resultData` is a type guard, not a second failure mode: the callback
  // above assigns it unconditionally and only runs once STATE.md is known to
  // exist (the missing-file case returns "STATE.md not found" earlier), and
  // every `advancePlanCore` return path sets `data`. So the message below is
  // the one a caller can actually receive.
  if (!resultData || resultData['error']) {
    // #3807: a multi-`Phase:` Current Position section carries its own cause
    // and its own remedy (name the candidates; the caller resolves them).
    if (resultData && resultData['reason'] === 'ambiguous_position_phase') {
      output({
        error: 'Current Position section contains more than one Phase: entry — refusing to silently advance the first. Resolve the section to a single current entry and re-run.',
        reason: resultData['reason'],
        phase_candidates: resultData['phase_candidates'],
      }, raw, undefined);
      return;
    }
    // #3791 review round 6 (B1): the document carries both plan-position
    // spellings with DIFFERENT numbers. Same posture as the case above — name
    // the candidates and let the caller resolve them. Advancing either one
    // would write a number into the other that nothing derived for it.
    if (resultData && resultData['reason'] === 'ambiguous_plan_position') {
      output({
        error: 'STATE.md carries two plan positions with different numbers — refusing to advance either. Resolve them to a single current plan and re-run.',
        reason: resultData['reason'],
        plan_candidates: resultData['plan_candidates'],
      }, raw, undefined);
      return;
    }
    output({ error: advancePlanShapeError() }, raw, undefined);
    return;
  }

  // ADR-3408 §8.4 (D4): reconcile `advancePlanCore`'s own success list against
  // the bytes actually persisted — this command previously reported none of
  // its per-field writes at all (`updated` never left `advancePlanCore`).
  // Generalizes fix(#3351) (closes #3351's direction) and folds in any field
  // preservation restored that this transform never touched (#3345's
  // direction).
  const updated = reconcileReportedFields(statePath, preWriteState, precomputedUpdated, divergedFields);

  if (resultData['advanced'] === false) {
    output({ ...resultData, updated, milestone_conflict: milestoneConflict }, raw, 'false');
  } else {
    output({ ...resultData, updated, milestone_conflict: milestoneConflict }, raw, 'true');
  }
  // #3227 (design doc §40 row 26 / "Not-corruption" rule): a refreshed
  // state.json `updated_at` must always mean something on disk actually
  // moved, in EITHER branch above — so gate on `wrote`
  // (readModifyWriteStateMd's own return value) rather than assuming both
  // branches are unconditional mutations. They are not: re-running
  // advance-plan on a phase already parked in its post-advance state (e.g.
  // two same-day calls once a phase is "ready for verification") reproduces
  // byte-identical content, the #948 no-op guard skips the write, and
  // `resultData`/`updated` still populate normally from the transform's OWN
  // (unwritten) output — so those are not safe publish signals here either.
  if (wrote) publishStateContract(cwd);
}

function cmdStateRecordMetric(cwd: string, options: StateRecordMetricOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, plan, duration, tasks, files } = options;

  if (!phase || !plan || !duration) {
    output({ error: 'phase, plan, and duration required' }, raw, undefined);
    return;
  }

  let _recorded = false;
  let created = false;
  readModifyWriteStateMd(statePath, (content) => {
    const newRow = `| Phase ${phase} P${plan} | ${duration} | ${tasks || '-'} tasks | ${files || '-'} files |`;

    // Find the "## Performance Metrics" section via the markdown-sectionizer
    // seam (ADR-2143 §7) — supersedes the prior hand-rolled section+table
    // regex.
    const metricsSection = collectSection(content, (h) => /^performance metrics$/i.test(h.text.trim()));

    const eol = metricsSection && /\r\n/.test(metricsSection.body) ? '\r\n' : '\n';
    const lines = metricsSection ? metricsSection.body.split(/\r?\n/) : [];

    // Locate THIS command's OWN metrics table by its HEADER shape, using the
    // exact same splitTableRow/isDelimiterRow header/delimiter-shape checks
    // `parseMarkdownTable` uses. A live "## Performance Metrics" section
    // (gsd-core/templates/state.md:39-56) also carries the "By Phase"
    // velocity table (`| Phase | Plans | Total | Avg/Plan |`) — the prior
    // "first table in the section" targeting spliced every per-plan row into
    // THAT table instead, polluting it on EVERY plan completion
    // (execute-plan.md:414 calls record-metric per-plan) (#2245/#2143).
    // Matching the header cells to this command's own canonical
    // `Plan | Duration | Tasks | Files` shape (case-insensitive/trimmed)
    // finds the right table regardless of what else shares the section, and
    // deliberately does NOT require `parseMarkdownTable(...).ok` (which
    // additionally requires every DATA row's cell count to match the
    // header) — a single ragged sibling row (a hand-edited stray/extra pipe)
    // must not blind this scan (#2245 Blocker 2 parity with the other
    // Phase-4 ragged-tolerance fixes: updateTableCell / findTableStartOffset).
    const METRICS_HEADER = ['plan', 'duration', 'tasks', 'files'];
    let headerIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('|') || trimmed.indexOf('|', 1) === -1) continue;
      const delimiterLine = lines[i + 1];
      if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) continue;
      const headerCells = splitTableRow(lines[i]);
      const delimiterCells = splitTableRow(delimiterLine);
      if (!isDelimiterRow(delimiterCells) || delimiterCells.length !== headerCells.length) continue;
      const normalized = headerCells.map((cell) => cell.trim().toLowerCase());
      const isMetricsHeader = normalized.length === METRICS_HEADER.length
        && normalized.every((cell, idx) => cell === METRICS_HEADER[idx]);
      if (isMetricsHeader) { headerIdx = i; break; }
    }
    const hasTable = headerIdx !== -1;

    if (metricsSection && hasTable) {
      const delimiterIdx = headerIdx + 1;
      const prefixLines = lines.slice(0, delimiterIdx + 1);

      // Ragged-tolerant row scan: every consecutive `|`-prefixed line
      // following the delimiter counts as an existing row REGARDLESS of its
      // cell count matching the header — a ragged sibling row must never
      // blind this scan to the table's true last row (unlike
      // `parsedTable.value.rows.length`, which this replaces). Anchored to
      // the METRICS table's OWN header/delimiter (`headerIdx` above), never
      // the section's first table (#2245/#2143).
      let lastRowIdx = delimiterIdx;
      for (let i = delimiterIdx + 1; i < lines.length; i++) {
        if (!lines[i].trim().startsWith('|')) break;
        lastRowIdx = i;
      }
      const rowCount = lastRowIdx - delimiterIdx;

      _recorded = true;

      let newBody: string;
      if (rowCount > 0) {
        // Splice the new row immediately after the table's LAST existing data
        // row — every other byte of the section, INCLUDING any trailing prose
        // that follows the table (e.g. the default template's "**Recent
        // Trend:**" subsection + "*Updated after each plan completion*"
        // footer), is preserved verbatim. The prior implementation truncated
        // the section body to header+delimiter+rows+newRow, silently dropping
        // everything that followed the table on a live STATE.md (#2245
        // Blocker 1 — a per-plan path, run after every plan execution).
        // `lastRowIdx` (computed above by the ragged-tolerant scan) already
        // equals `delimiterIdx + rowCount` by construction.
        const before = lines.slice(0, lastRowIdx + 1);
        const after = lines.slice(lastRowIdx + 1);
        newBody = [...before, newRow, ...after].join(eol);
      } else {
        // No existing data rows (e.g. a "None yet" placeholder line instead of
        // a real row) — replace the placeholder/table-body remainder with the
        // new row, matching the section's prior (verified) collapse-to-
        // first-row behavior for an otherwise-empty table.
        // No trailing eol here: replaceSection's `content.slice(bodyEnd)`
        // already supplies the newline(s) that followed the (trimEnd()-ed)
        // section body.
        newBody = prefixLines.join(eol) + eol + newRow;
      }

      return replaceSection(content, metricsSection, newBody);
    }

    if (metricsSection) {
      // Section EXISTS but carries no metrics table of its own — e.g. a live
      // STATE.md whose "## Performance Metrics" section holds only the
      // By-Phase velocity table (gsd-core/templates/state.md:48). Self-heal
      // by appending a fresh Per-Plan Metrics table to the END of the
      // section body — every existing byte (By-Phase table, Recent Trend,
      // footer) is preserved verbatim, and no second "## Performance
      // Metrics" heading is introduced. The section already existed, so
      // `created` stays false (#2245/#2143).
      _recorded = true;
      const newBody = metricsSection.body
        + eol + '**Per-Plan Metrics:**'
        + eol + eol
        + '| Plan | Duration | Tasks | Files |'
        + eol
        + '|------|----------|-------|-------|'
        + eol
        + newRow
        + eol;
      return replaceSection(content, metricsSection, newBody);
    }

    // Section absent (or malformed) — DWIM: auto-create canonical
    // ## Performance Metrics scaffold, then append the row. Matches state
    // begin-phase / advance-plan DWIM behavior. Header corrected to this
    // command's own canonical shape (`Plan | Duration | Tasks | Files`) —
    // the prior scaffold's `| Phase | Plan | Duration | Notes |` header
    // matched neither the appended row's shape nor the canonical table
    // above (#2245/#2143).
    const scaffold = [
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      newRow,
      '',
    ].join('\n');
    _recorded = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees recorded === true; no else branch needed.
  const result: Record<string, unknown> = { recorded: true, phase, plan, duration };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

type UpdateProgressPreview =
  | { withheld: true; reason: string }
  | { withheld: false; percent: number; completedPlans: number; totalPlans: number };

/**
 * #3583: computes the write-path percent AND the completed/total plan counts
 * reported alongside it from ONE `buildStateFrontmatter` call, so
 * `cmdStateUpdateProgress`'s JSON output cannot report a `percent` that
 * disagrees with its own `completed`/`total` (`buildStateFrontmatter`'s
 * `progress.{percent,completed_plans,total_plans}` all come from the same
 * disk scan, scoped to the STORED `milestone:` frontmatter value — #3017).
 * Re-deriving completed/total from a second, differently-scoped scan (the
 * auto-derived one `cmdStateUpdateProgress` still runs for its own #3217/
 * #3233 withhold gates) is what let the two disagree when the auto-derived
 * "current" milestone differs from the stored one.
 *
 * Perf note: this duplicates buildStateFrontmatter's own `getMilestoneInfo`
 * (re-reads/re-parses ROADMAP.md) and `readGitHeadSha` (a `git rev-parse`
 * subprocess spawn) — neither is memoized, unlike the phase/plan disk scan
 * (`_diskScanCache`), which IS shared with the second `buildStateFrontmatter`
 * call `readModifyWriteStateMd` makes below. Both non-cached calls therefore
 * run twice per `state update-progress`.
 */
function computeUpdateProgressPreview(statePath: string, cwd: string): UpdateProgressPreview {
  const preContent = fs.readFileSync(statePath, 'utf-8');
  const existingFm = extractFrontmatter(preContent, statePath) as Record<string, unknown>;
  const preBody = stripFrontmatter(preContent);
  const storedMilestone = typeof existingFm['milestone'] === 'string' ? existingFm['milestone'] : null;
  const builtFm = buildStateFrontmatter(preBody, cwd, storedMilestone, readStoredTotalPhases(existingFm));
  const progress = builtFm['progress'] as Record<string, unknown> | undefined;
  const percent = progress && typeof progress['percent'] === 'number' ? progress['percent'] : null;
  const completedPlans = progress && typeof progress['completed_plans'] === 'number' ? progress['completed_plans'] : null;
  const totalPlans = progress && typeof progress['total_plans'] === 'number' ? progress['total_plans'] : null;
  // A null percent is REACHABLE beyond the #3217/#3233 withholds the caller
  // already applies — buildStateFrontmatter also nulls it via its own #1761
  // milestone-unbounded guard, evaluated from `assertedMilestoneVersion`
  // (an independent derivation, including a bare-version-token-in-prose
  // fallback) rather than from `storedMilestone`/diskScope, so a STATE.md
  // with no explicit `milestone:` field but a bare vX.Y token mentioned in
  // ROADMAP prose can pass both of the caller's guards and still land here.
  // Falling back to a locally-computed percent would reintroduce the exact
  // #3583 defect for that case, so withhold instead — same shape as the
  // caller's own no-op guards.
  if (percent === null || completedPlans === null || totalPlans === null) {
    return { withheld: true, reason: 'progress percent withheld by buildStateFrontmatter — STATE.md left unchanged' };
  }
  return { withheld: false, percent, completedPlans, totalPlans };
}

function cmdStateUpdateProgress(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  // Auto-derived scan across current-milestone phases (outside lock — read-only).
  // Gates the #3217/#3233 withholds below ONLY — the reported completed/total
  // counts come from computeUpdateProgressPreview's differently-scoped
  // (stored-milestone) scan instead, so percent and completed/total can never
  // disagree (#3583, finding 1).
  const phasesDir = planningPaths(cwd).phases;
  let totalPlans = 0;
  let phaseScope: Scope = SCOPE.UNREADABLE;

  {
    // #3185 (ADR-3180 Decision 1): "which phase directories belong to the
    // CURRENT milestone" — routed through the canonical owner instead of a
    // hand-rolled readdirSync + isDirInMilestone filter (which also never
    // excluded sentinels, unlike the owner). The owner already handles an
    // absent phasesDir as a real empty, so the fs.existsSync guard folds
    // into it.
    //
    // #2761 (round-11 BLOCKER, single-derivation hygiene): `phaseIdConvention`
    // threaded explicitly (resolved ambiently off `cwd` — this call site has
    // no `ws` of its own, same contract `resolvePhaseIdConvention` uses
    // elsewhere in this file, e.g. the `phaseConvention` ONCE-and-THREAD
    // pattern at ~:2267/:2300) rather than left `undefined`.
    //
    // This does NOT change `phaseScope` — `scope` (roadmap-parser.cts
    // `getMilestonePhaseFilter`) is assigned at :1979/:2030, both BEFORE
    // `headingConvention` resolves at ~:2048, so the #3217 withhold gate a
    // few lines below is convention-independent either way (verified
    // empirically: forcing `phaseIdConvention: null` here left every
    // `state update-progress` assertion in
    // tests/adr-612-bracket-phase-counting.test.cjs's round-11 BLOCKER block
    // unchanged). What DOES depend on convention is `phaseDirs`/`totalPlans`
    // — the enumerated `.value` these two lines feed into the #3233
    // zero-plans no-op check just below. The actual `percent` this command
    // reports/writes comes from a separate, already-correctly-threaded scan
    // (`computeUpdateProgressPreview` -> `buildStateFrontmatter`, which
    // resolves its own `phaseConvention` at :2267). Threading here removes a
    // second, silent, lazily-resolved answer for the SAME question that scan
    // already answers explicitly — the single-derivation discipline this
    // file's own :2300 comment states as a rule — rather than fixing an
    // observed defect. #2761 round-12: the #3233 gate IS the one place this
    // is observable, so it — not the reported percent — is what
    // tests/adr-612-bracket-phase-counting.test.cjs's round-12 addition to
    // the round-11 BLOCKER block pins: a bracket milestone with no plans on
    // disk versus a decoy directory outside the milestone window that must
    // not be swept in by a pass-all degrade.
    const { value: phaseDirs, scope } = listMilestonePhaseDirs(phasesDir, {
      cwd,
      phaseIdConvention: cwd ? resolvePhaseIdConvention(cwd) : null,
    });
    phaseScope = scope;
    for (const dir of phaseDirs) {
      const { planCount } = scanPhasePlans(path.join(phasesDir, dir));
      totalPlans += planCount;
    }
  }

  // #3217 (ADR-3180 §7.6 rule 4): a non-COMPLETE scope means the counts
  // above are not a trustworthy answer — do not write a percentage derived
  // from them into STATE.md at all (A7). This is the write path, so
  // "withhold" means "make no edit" rather than emitting a null value.
  if (phaseScope !== SCOPE.COMPLETE) {
    // #3217 finding 3 (decided: surface a warning, not silent-only
    // disclosure): the JSON `reason` field alone is easy for a caller to
    // never read, and STATE.md's Progress field goes stale with no
    // user-visible signal beyond it. Mirrors the established
    // `[gsd-tools] WARNING:` stderr convention this file already uses
    // (stateReplaceFieldWithFallback above) for a comparable silent no-op —
    // now routed through the shared `declineNoOp` helper (#3957) so the
    // pairing is structural rather than hand-written per arm.
    declineNoOp(
      raw,
      'updated',
      `phase scope is ${phaseScope}, not complete`,
      `state update-progress skipped — phase scope is ${phaseScope}, not complete. STATE.md's Progress field was left unchanged.`,
    );
    return;
  }

  // #3233: zero plans in the current-milestone phases means there is nothing to
  // measure — most often the milestone was just closed and its phases archived
  // (.planning/phases/ empty, but scope COMPLETE — "a real empty"). clampPercent
  // maps 0/0 to 0%, which would clobber the shipped Progress record (e.g.
  // [██████████] 100% → [░░░░░░░░░░] 0%). No-op instead, mirroring the
  // scope-withhold above and computeProgressPercent's null-for-empty contract
  // ("nothing to measure" ≠ "0% done"). The legitimate 0% case (plans exist,
  // none summarized → clampPercent(0, N>0) = 0) is unaffected: totalPlans > 0.
  if (totalPlans === 0) {
    declineNoOp(
      raw,
      'updated',
      'no plans found in current-milestone phases — STATE.md left unchanged (milestone archived?)',
      `state update-progress skipped — no plans found in current-milestone phases (0 plans). STATE.md's Progress field was left unchanged (milestone archived?).`,
    );
    return;
  }

  // #3583: percent AND the completed/total counts reported alongside it both
  // come from the SAME buildStateFrontmatter call (computeUpdateProgressPreview)
  // — never from the auto-derived scan above, which exists only to gate the
  // #3217/#3233 withholds and is scoped differently (no stored-milestone
  // override), so reusing its counts here could report a percent that
  // disagrees with its own completed/total.
  const preview = computeUpdateProgressPreview(statePath, cwd);
  if (preview.withheld) {
    declineNoOp(raw, 'updated', preview.reason, `state update-progress skipped — ${preview.reason}`);
    return;
  }
  const { percent, completedPlans: fmCompletedPlans, totalPlans: fmTotalPlans } = preview;
  const barWidth = 10;
  const filled = Math.round(percent / 100 * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const progressStr = `[${bar}] ${percent}%`;

  let updated = false;

  readModifyWriteStateMd(statePath, (content) => {
    // #2177: match against the BODY only. With /i the patterns below would
    // otherwise hit the YAML frontmatter `progress:` key first (and `\s*` would
    // eat its newline, mangling the nested block), while the body Progress: line
    // — which frontmatter `percent` is re-derived from on every write — stays
    // stale and silently reverts the update.
    const body = stripFrontmatter(content);
    const fmPrefix = content.slice(0, content.length - body.length);

    // Swap only the machine segment ("[bar] NN%" or bare "NN%"), preserving any
    // descriptive suffix an agent authored, e.g. "(2/4 plans done; blocked on…)".
    const machineSegment = /(?:\[[^\]\r\n]*\][ \t]*)?\d{1,3}%/;
    const replaceValue = (value: string) => machineSegment.test(value)
      ? value.replace(machineSegment, progressStr)
      : progressStr;

    // Try **Progress:** bold format first, then plain Progress: format.
    const boldProgressPattern = /(\*\*Progress:\*\*[ \t]*)([^\r\n]*)/i;
    const plainProgressPattern = /^(Progress:[ \t]*)([^\r\n]*)/im;
    const pattern = boldProgressPattern.test(body)
      ? boldProgressPattern
      : plainProgressPattern.test(body)
        ? plainProgressPattern
        : null;
    if (!pattern) return content;

    updated = true;
    return fmPrefix + body.replace(pattern, (_match, prefix: string, value: string) => `${prefix}${replaceValue(value)}`);
  }, cwd);

  if (updated) {
    output({ updated: true, percent, completed: fmCompletedPlans, total: fmTotalPlans, bar: progressStr }, raw, progressStr);
  } else {
    // #3957: the frontmatter progress data was already confirmed present a
    // few lines above (computeUpdateProgressPreview didn't withhold) — what's
    // actually missing here is the BODY `Progress:`/`**Progress:**` line
    // itself. The prior 'Progress field not found in STATE.md' reason named
    // the wrong layer and silently discarded percent/completed/total, which
    // the sibling success arm above reports from the same preview.
    declineNoOp(
      raw,
      'updated',
      'no Progress: line found in STATE.md body to update (frontmatter progress data is unaffected)',
      'state update-progress skipped — no Progress: line found in STATE.md body to update (frontmatter progress data is unaffected).',
      { percent, completed: fmCompletedPlans, total: fmTotalPlans },
    );
  }
}

function cmdStateAddDecision(cwd: string, options: StateAddDecisionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, summary, summary_file, rationale, rationale_file } = options;
  let summaryText: string | undefined = undefined;
  let rationaleText = '';

  try {
    summaryText = readTextArgOrFile(cwd, summary, summary_file, 'summary');
    rationaleText = readTextArgOrFile(cwd, rationale || '', rationale_file, 'rationale') || '';
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }

  if (!summaryText) { output({ error: 'summary required' }, raw, undefined); return; }

  // #3231/#3481: `--phase` omitted → resolve from the STATE.md being written, via
  // the canonical ladder `state prune` uses. A decision entry is a permanent
  // record, so a literal `[Phase ?]` written while `current_phase` sat three
  // lines above the insertion point loses that decision's provenance for good.
  // Explicit `--phase` still wins, and its path is untouched — the file is not
  // even read. When no rung resolves, `?` is still written: an unknown phase
  // stays visibly unknown rather than being guessed or defaulted to a number.
  let phaseId: string | undefined = phase;
  if (!phaseId) {
    const rawState = fs.readFileSync(statePath, 'utf-8');
    const fm = extractFrontmatter(rawState, statePath) as Record<string, unknown>;
    phaseId = resolveCurrentPhaseId(fm, stripFrontmatter(rawState)) ?? undefined;
  }

  const entry = `- [Phase ${phaseId || '?'}]: ${summaryText}${rationaleText ? ` — ${rationaleText}` : ''}`;
  let _added = false;
  let created = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Decisions section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Decisions|Decisions Made|Accumulated.*Decisions)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const decisionsPred = (lv: number, text: string): boolean =>
      (lv === 2 || lv === 3) && /^(?:Decisions|Decisions Made|Accumulated.*Decisions)$/i.test(text);
    const sectionBody = (() => {
      const hs = tokenizeHeadings(content);
      const i = hs.findIndex(h => decisionsPred(h.level, h.text));
      if (i === -1) return null;
      const h = hs[i];
      const ls = content.split('\n');
      const hl = ls[h.line - 1];
      const bs = h.offset + hl.length + 1;
      let se = content.length;
      for (let j = i + 1; j < hs.length; j++) {
        if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
      }
      return { bodyStart: bs, bodyEnd: se, body: content.slice(bs, se) };
    })();

    if (sectionBody !== null) {
      let newBody = sectionBody.body;
      // Remove placeholders
      newBody = newBody.replace(/None yet\.?\s*\n?/gi, '').replace(/No decisions yet\.?\s*\n?/gi, '');
      newBody = newBody.trimEnd() + '\n' + entry + '\n';
      _added = true;
      return content.slice(0, sectionBody.bodyStart) + newBody + content.slice(sectionBody.bodyEnd);
    }

    // Section absent — DWIM: auto-create canonical ## Decisions scaffold,
    // then append the entry. Matches state begin-phase / advance-plan DWIM behavior.
    const scaffold = [
      '',
      '## Decisions',
      '',
      entry,
      '',
    ].join('\n');
    _added = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees added === true; no else branch needed.
  const result: Record<string, unknown> = { added: true, decision: entry };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

function cmdStateAddBlocker(cwd: string, text: string | StateAddBlockerOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }
  const blockerOptions: StateAddBlockerOptions = typeof text === 'object' && text !== null ? text : { text: text };
  let blockerText: string | undefined = undefined;

  try {
    blockerText = readTextArgOrFile(cwd, blockerOptions.text, blockerOptions.text_file, 'blocker');
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }

  if (!blockerText) { output({ error: 'text required' }, raw, undefined); return; }

  const entry = `- ${blockerText}`;
  let _added = false;
  let created = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Blockers/Concerns section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const blockersPred = (lv: number, text: string): boolean =>
      (lv === 2 || lv === 3) && /^(?:Blockers|Blockers\/Concerns|Concerns)$/i.test(text);
    const sectionSpan = (() => {
      const hs = tokenizeHeadings(content);
      const i = hs.findIndex(h => blockersPred(h.level, h.text));
      if (i === -1) return null;
      const h = hs[i];
      const ls = content.split('\n');
      const hl = ls[h.line - 1];
      const bs = h.offset + hl.length + 1;
      let se = content.length;
      for (let j = i + 1; j < hs.length; j++) {
        if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
      }
      return { bodyStart: bs, bodyEnd: se, body: content.slice(bs, se) };
    })();

    if (sectionSpan !== null) {
      let sectionBody = sectionSpan.body;
      sectionBody = sectionBody.replace(/None\.?\s*\n?/gi, '').replace(/None yet\.?\s*\n?/gi, '');
      sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
      _added = true;
      return content.slice(0, sectionSpan.bodyStart) + sectionBody + content.slice(sectionSpan.bodyEnd);
    }

    // Section absent — DWIM: auto-create canonical ### Blockers scaffold.
    const scaffold = [
      '',
      '### Blockers',
      '',
      entry,
      '',
    ].join('\n');
    _added = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees added === true; no else branch needed.
  const result: Record<string, unknown> = { added: true, blocker: blockerText };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

function cmdStateAddRoadmapEvolution(cwd: string, options: StateAddRoadmapEvolutionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, action, after, note, note_file, urgent } = options;
  let noteText: string | undefined = undefined;
  try {
    noteText = readTextArgOrFile(cwd, note, note_file, 'note');
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }
  // Reject missing / empty / whitespace-only notes — an evolution entry with no
  // narrative is meaningless and would corrupt the section with a dangling bullet.
  if (!noteText || !noteText.trim()) { output({ error: 'note required' }, raw, undefined); return; }
  // Flatten line breaks so the entry is always a single Markdown bullet. The
  // dedupe + rendering contract is line-oriented; a multiline --note-file would
  // otherwise spill continuation lines outside the bullet and defeat dedupe.
  // Internal spacing (e.g. dollar columns) is preserved.
  const flatNote = noteText.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  const actionText = (action && action.trim()) || 'changed';
  const afterText = after && after.trim() ? ` after Phase ${after.trim()}` : '';
  const urgentText = urgent ? ' (URGENT)' : '';
  // #3481: same treatment as add-decision's #3231 fix — `--phase` omitted →
  // resolve from the STATE.md being written via the shared write-path ladder.
  // A roadmap-evolution entry is a permanent record of why the roadmap changed
  // shape, so a literal `Phase ?` written while `current_phase` sat in the
  // frontmatter above the insertion point makes that trail unattributable.
  // Explicit `--phase` still wins (the file is not even read on that path), and
  // `?` is still written when nothing resolves — never a guess.
  let phaseId: string | undefined = phase;
  if (!phaseId) {
    const rawState = fs.readFileSync(statePath, 'utf-8');
    const fm = extractFrontmatter(rawState, statePath) as Record<string, unknown>;
    phaseId = resolveCurrentPhaseId(fm, stripFrontmatter(rawState)) ?? undefined;
  }

  const entry = `- Phase ${phaseId || '?'} ${actionText}${afterText}: ${flatNote}${urgentText}`;

  let duplicate = false;
  let created = false;
  let subsectionCreated = false;

  // The Roadmap Evolution subsection lives under `## Accumulated Context`. Scope
  // every lookup to that section's body so a `### Roadmap Evolution` heading in an
  // unrelated h2 section (or a fenced example) can never be matched or mutated.
  // The accBody lookahead stops only at the next h2 (`\n##[^#]`), so nested h3
  // subsections stay inside the captured Accumulated Context body.
  // Section boundaries mirror the sibling handlers (add-decision/add-blocker):
  // a trailing CR on a CRLF STATE.md is absorbed by the lazy body and trimmed,
  // so following sections are preserved without data loss (see the CRLF test).
  //
  // ADR-1372 T6: accPattern and subPattern migrated to tokenizeHeadings.
  // accPattern  = /(##\s*Accumulated Context\s*\n)([\s\S]*?)(?=\n##[^#]|$)/i
  //               → stop at level 2 only (STOP_H2_ONLY)
  // subPattern  = /(###\s*Roadmap Evolution\s*\n)([\s\S]*?)(?=\n###?|$)/i
  //               → applied to accBody; stop at level 2 or 3 (STOP_H2_H3)
  readModifyWriteStateMd(statePath, (content) => {
    // Locate ## Accumulated Context and extract its untrimmed body span.
    const accHs = tokenizeHeadings(content);
    const accIdx = accHs.findIndex(h => h.level === 2 && /^accumulated\s+context$/i.test(h.text));

    if (accIdx !== -1) {
      const accH = accHs[accIdx];
      const contentLines = content.split('\n');
      const accHL = contentLines[accH.line - 1];
      const accBodyStart = accH.offset + accHL.length + 1;
      let accBodyEnd = content.length;
      for (let j = accIdx + 1; j < accHs.length; j++) {
        if (STOP_H2_ONLY(accHs[j].level)) { accBodyEnd = accHs[j].offset - 1; break; }
      }
      const accBody = content.slice(accBodyStart, accBodyEnd);

      // Find `### Roadmap Evolution` WITHIN the Accumulated Context body only.
      // tokenizeHeadings is applied to accBody to scope the search.
      // Stop predicate mirrors (?=\n###?|$): level 2 or 3.
      const subHs = tokenizeHeadings(accBody);
      const subIdx = subHs.findIndex(h => h.level === 3 && /^roadmap\s+evolution$/i.test(h.text));

      if (subIdx !== -1) {
        const subH = subHs[subIdx];
        const accLines = accBody.split('\n');
        const subHL = accLines[subH.line - 1];
        const subBodyStart = subH.offset + subHL.length + 1;
        let subBodyEnd = accBody.length;
        for (let j = subIdx + 1; j < subHs.length; j++) {
          if (STOP_H2_H3(subHs[j].level)) { subBodyEnd = subHs[j].offset - 1; break; }
        }
        let subBody = accBody.slice(subBodyStart, subBodyEnd);

        // Dedupe: exact (trimmed) line already present is a no-op replay.
        if (subBody.split('\n').some((line) => line.trim() === entry.trim())) {
          duplicate = true;
          return content;
        }
        subBody = subBody.replace(/None yet\.?\s*\n?/gi, '');
        subBody = subBody.trimEnd() + '\n' + entry + '\n';
        // Splice subBody into accBody, then splice newAccBody into content.
        const newAccBody = accBody.slice(0, subBodyStart) + subBody + accBody.slice(subBodyEnd);
        return content.slice(0, accBodyStart) + newAccBody + content.slice(accBodyEnd);
      }

      // Subsection missing — append it at the end of the Accumulated Context body.
      subsectionCreated = true;
      const trimmedAcc = accBody.trimEnd();
      const block = `${trimmedAcc ? `${trimmedAcc}\n\n` : ''}### Roadmap Evolution\n\n${entry}\n`;
      return content.slice(0, accBodyStart) + block + content.slice(accBodyEnd);
    }

    // No `## Accumulated Context` — DWIM: create both at end of file.
    // Mirrors the add-decision / add-blocker auto-create behavior.
    created = true;
    subsectionCreated = true;
    const scaffold = [
      '',
      '## Accumulated Context',
      '',
      '### Roadmap Evolution',
      '',
      entry,
      '',
    ].join('\n');
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  if (duplicate) {
    output({ added: false, reason: 'duplicate', entry }, raw, 'false');
    return;
  }
  const result: Record<string, unknown> = { added: true, entry };
  if (created) result['created'] = true;
  if (subsectionCreated) result['subsection_created'] = true;
  output(result, raw, 'true');
}

function cmdStateResolveBlocker(cwd: string, text: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }
  if (!text) { output({ error: 'text required' }, raw, undefined); return; }

  // #3957: track section-found and bullet-matched SEPARATELY. Previously
  // `resolved` was set unconditionally as soon as the heading was located —
  // before checking whether any bullet line actually matched `text` — so a
  // call naming a non-existent blocker reported `resolved: true` (a false
  // success). Only a real bullet match makes `resolved` true and the
  // rewrite happen; otherwise the transform returns `content` unchanged
  // (this repo's established no-op-return idiom).
  let sectionFound = false;
  let matched = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Blockers/Concerns section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const hs = tokenizeHeadings(content);
    const i = hs.findIndex(h => (h.level === 2 || h.level === 3) && /^(?:Blockers|Blockers\/Concerns|Concerns)$/i.test(h.text));
    if (i === -1) return content;

    sectionFound = true;
    const h = hs[i];
    const ls = content.split('\n');
    const hl = ls[h.line - 1];
    const bs = h.offset + hl.length + 1;
    let se = content.length;
    for (let j = i + 1; j < hs.length; j++) {
      if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
    }
    const sectionBody = content.slice(bs, se);
    const lines = sectionBody.split('\n');
    const filtered = lines.filter(line => {
      if (!line.startsWith('- ')) return true;
      // Case-insensitive substring match — unchanged from before the fix;
      // only whether a match occurred is now tracked accurately.
      const isMatch = line.toLowerCase().includes(text.toLowerCase());
      if (isMatch) matched = true;
      return !isMatch;
    });

    if (!matched) return content;

    let newBody = filtered.join('\n');
    // If section is now empty, add placeholder
    if (!newBody.trim() || !newBody.includes('- ')) {
      newBody = 'None\n';
    }

    return content.slice(0, bs) + newBody + content.slice(se);
  }, cwd);

  if (matched) {
    output({ resolved: true, blocker: text }, raw, 'true');
  } else if (!sectionFound) {
    declineNoOp(
      raw,
      'resolved',
      'no Blockers/Concerns section found in STATE.md',
      'state resolve-blocker skipped — no Blockers/Concerns section found in STATE.md.',
    );
  } else {
    // `formatDiagnosticToken` only guards the STDERR disclosure — the JSON
    // `reason` field can embed `text` raw since output()'s own
    // JSON.stringify serialization already escapes it correctly.
    declineNoOp(
      raw,
      'resolved',
      `no blocker matching ${text} found in the Blockers section`,
      `state resolve-blocker skipped — no blocker matching ${formatDiagnosticToken(text)} found in the Blockers section.`,
    );
  }
}

function cmdStateRecordSession(cwd: string, options: StateRecordSessionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const now = realClock.nowIso();
  const updated: string[] = [];
  let sessionCreated = false;
  const divergedFields: string[] = [];
  // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
  // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
  const preWriteState: StatePreWriteSnapshot = {};

  readModifyWriteStateMd(statePath, (content) => {
    // Update Last session / Last Date
    let result = stateReplaceField(content, 'Last session', now);
    if (result) { content = result; updated.push('Last session'); }
    result = stateReplaceField(content, 'Last Date', now);
    if (result) { content = result; updated.push('Last Date'); }

    // Update Stopped at
    // #3374 Variant B: stateReplaceField returns the replaced string on any
    // label MATCH, including when the value is already the target. Pushing
    // 'Stopped At' on match alone reported a write that never changed a byte
    // (and that the #948 no-op guard may then discard entirely), leaving a
    // stale frontmatter stopped_at undetectable to the caller. Report only on
    // real change — and track the match separately so an identical value does
    // not read as "label missing" to the #944 DWIM insertion below (whose
    // section rewrite would reset an executor-authored resume file to None).
    let stoppedAtMatched = false;
    if (options.stopped_at) {
      result = stateReplaceField(content, 'Stopped At', options.stopped_at);
      if (!result) result = stateReplaceField(content, 'Stopped at', options.stopped_at);
      if (result) {
        stoppedAtMatched = true;
        if (result !== content) { content = result; updated.push('Stopped At'); }
      }
    }

    // Update Resume File — only when the caller explicitly passed a value OR the
    // existing value is a known template default.  An executor-authored path must
    // not be silently replaced with 'None' just because --resume-file was omitted
    // (Knuth invariant: handler-owns-transition-between-known-template-defaults).
    const resumeFileDefaults = KNOWN_TEMPLATE_DEFAULTS['Resume File'];
    if (options.resume_file !== undefined && options.resume_file !== null) {
      // Caller explicitly passed a value — always honour it.
      result = stateReplaceField(content, 'Resume File', options.resume_file);
      if (!result) result = stateReplaceField(content, 'Resume file', options.resume_file);
      if (result) { content = result; updated.push('Resume File'); }
    } else {
      // No explicit value — only set 'None' when existing value is also a known default
      // (i.e. not executor-authored).
      const newRf = stateReplaceFieldIfTemplate(content, 'Resume File', resumeFileDefaults, 'None');
      if (newRf !== content) {
        content = newRf;
        updated.push('Resume File');
      } else {
        // Try alternate capitalisation
        const newRfAlt = stateReplaceFieldIfTemplate(content, 'Resume file', resumeFileDefaults, 'None');
        if (newRfAlt !== content) {
          content = newRfAlt;
          updated.push('Resume File');
        }
      }
    }

    // Bug #944: DWIM normalize/auto-create — when the caller supplied --stopped-at or
    // --resume-file but the body lacks the canonical labels (in-place replace
    // returned a miss), persist the values durably. Mirrors the DWIM pattern used
    // by add-decision, add-blocker, and record-metric. Never silently drop
    // caller-supplied values.
    //
    // Guard: only act when the caller actually supplied a value. When no
    // --stopped-at / --resume-file are given and the body already had no session
    // labels (nothing was updated), we return recorded:false — the existing
    // behaviour for a no-op call that didn't supply any values.
    //
    // Correctness invariant: both buildStateFrontmatter and cmdStateSnapshot read
    // only the FIRST `## Session` block (via a /##\s*Session\s*\n…/i regex).
    // If we blindly append a second `## Session` block when one already exists, the
    // newly-written Stopped at / Resume file end up in the second (invisible) block.
    // Fix: when a `## Session` heading already exists, normalize THAT block in place
    // (insert / replace canonical bold-label lines within the existing section).
    // A `## Session Continuity` heading (bootstrap shape) is handled additively —
    // missing canonical fields are inserted while the heading and any prose are
    // preserved (#1101). Only append a brand-new section when NEITHER heading exists.
    const callerSuppliedValues = !!(options.stopped_at || (options.resume_file !== undefined && options.resume_file !== null));
    // #3374: keyed on the label MATCH, not on updated[] — a matched-but-
    // identical value is already persisted on disk and must not trigger the
    // insertion rewrite below.
    const needsStoppedAt = options.stopped_at && !stoppedAtMatched;
    const needsResumeFile = options.resume_file !== undefined && options.resume_file !== null && !updated.includes('Resume File');
    const needsLastSession = !updated.includes('Last session') && !updated.includes('Last Date');

    if (callerSuppliedValues && (needsStoppedAt || needsResumeFile || needsLastSession)) {
      const resumeValue = (options.resume_file !== undefined && options.resume_file !== null)
        ? options.resume_file
        : 'None';
      const stoppedAtValue = options.stopped_at || 'None';

      // Determine whether a session heading already exists in the body. The
      // canonical normalized form is `## Session`; the bootstrap templates
      // (workstream.cts, gsd2-import.cts, templates/state.md) instead emit
      // `## Session Continuity`. Treat each separately so we never append a
      // duplicate section alongside an existing one.
      const existingCanonicalSession = /^## Session[ \t]*$/im.test(content);
      const existingSessionContinuity = /^## Session Continuity[ \t]*$/im.test(content);

      // Track whether the chosen branch's rewrite actually matched. The detector
      // regexes (existingCanonicalSession/existingSessionContinuity) are CRLF-
      // tolerant ($ under /m treats \r as a line terminator); the writer regexes
      // below must be too. If a writer regex silently fails to match (line-ending
      // mismatch, unexpected heading shape, ...), do NOT report success — the
      // caller would believe fields were persisted that were silently dropped
      // (#2450). The append branch always sets rewriteMatched=true (it always
      // mutates content).
      let rewriteMatched = false;

      if (existingCanonicalSession) {
        // Normalize in place: replace the ENTIRE BODY of the existing ## Session
        // section (heading + all content up to the next ## heading or EOF) with
        // canonical bold-label lines. The negative-lookahead per-line pattern
        // `(?!^## )[\s\S]` consumes every line that doesn't start with "## ",
        // which correctly stops at the next section boundary without consuming it.
        // A trailing blank line is added so the next ## heading keeps its spacing.
        //
        // CRLF-tolerant (`\r?\n` after `[ \t]*`): the prior literal `\n` could not
        // match a CRLF STATE.md (`---\r\n`), silently no-op'ing the replace while
        // updated.push(...) reported success — #2450. The detector regex on the
        // line above (`/^## Session[ \t]*$/im`) was already CRLF-tolerant, so the
        // asymmetry armed the bug.
        const canonicalReplacement = [
          '## Session',
          '',
          `**Last session:** ${now}`,
          `**Stopped at:** ${stoppedAtValue}`,
          `**Resume file:** ${resumeValue}`,
          '',
          '',
        ].join('\n');
        content = content.replace(
          /^(## Session[ \t]*\r?\n(?:(?!^## )[\s\S])*)/m,
          () => {
            rewriteMatched = true;
            return canonicalReplacement;
          },
        );
      } else if (existingSessionContinuity) {
        // #1101: a `## Session Continuity` section already exists (bootstrap
        // shape). Previously this fell through to the append branch and created
        // a SECOND `## Session` block — a duplicate. Instead, insert only the
        // canonical fields that are still missing, right after the heading,
        // preserving the `## Session Continuity` heading and ALL existing lines
        // (e.g. prose like "Next recommended action"). Fields already updated in
        // place above (needs* false) are not re-inserted. A function replacement
        // is used so `$`-bearing caller values are inserted literally (#3454).
        //
        // CRLF-tolerant (`\r?\n`): same #2450 fix as the canonical branch above.
        const linesToInsert: string[] = [];
        if (needsLastSession) linesToInsert.push(`**Last session:** ${now}`);
        if (needsStoppedAt) linesToInsert.push(`**Stopped at:** ${stoppedAtValue}`);
        if (needsResumeFile) linesToInsert.push(`**Resume file:** ${resumeValue}`);
        if (linesToInsert.length > 0) {
          // Case-insensitive to match the `existingSessionContinuity` detection
          // above (#1101 review F3) — otherwise a lowercase heading would detect
          // but no-op the insert while still reporting the fields as updated.
          content = content.replace(
            /^(## Session Continuity[ \t]*\r?\n)/im,
            (_m, heading: string) => {
              rewriteMatched = true;
              return heading + linesToInsert.join('\n') + '\n';
            },
          );
        }
        // No `else` branch: if linesToInsert.length === 0 the outer guard at
        // :1144 (callerSuppliedValues && (needsStoppedAt || needsResumeFile
        // || needsLastSession)) could not have fired, so this whole block is
        // unreachable. Leaving `rewriteMatched = false` here is the fail-loud
        // posture — a future change to the outer guard or needs* computation
        // that makes this branch reachable will surface as a missing
        // updated[] entry (silent recorded:false) rather than re-arming #2450.
      } else {
        // No session heading exists at all — append a new canonical section.
        const scaffold = [
          '',
          '## Session',
          '',
          `**Last session:** ${now}`,
          `**Stopped at:** ${stoppedAtValue}`,
          `**Resume file:** ${resumeValue}`,
          '',
        ].join('\n');
        content = content.trimEnd() + '\n' + scaffold;
        rewriteMatched = true;
      }

      // #2450 defensive invariant: only report sessionCreated/updated when the
      // chosen branch's rewrite actually mutated content. Unreachable when the
      // writer regexes above stay in sync with the CRLF-tolerant detector —
      // but unreachable-defensive is the right posture for a silent-success
      // gate. A no-op replace here means a future line-ending or shape drift
      // between detector and writer; fail to record rather than claim success.
      //
      // Scope limitation (not a regression of this fix): the gate covers only
      // the section-rewrite block. The earlier in-place stateReplaceField
      // successes at :1081/:1083/:1089/:1101/:1108/:1114 push to `updated`
      // unconditionally — those represent fields that DID land on disk via
      // same-line replace (CRLF-agnostic seam), so unconditional push is
      // correct. The class-defect防御 here is for the INSERT path only.
      if (rewriteMatched) {
        sessionCreated = true;
        if (needsLastSession) updated.push('Last session');
        if (needsStoppedAt) updated.push('Stopped At');
        if (needsResumeFile) updated.push('Resume File');
      }
    }

    return content;
  }, cwd, { divergedFields, preWriteState });

  // ADR-3408 §8.4 (D4): reconcile this command's own success list against the
  // bytes actually persisted (fix(#3351) generalized) and fold in any field
  // preservation restored that this transform never touched (#3345's
  // direction).
  const reconciledUpdated = reconcileReportedFields(statePath, preWriteState, updated, divergedFields);

  if (reconciledUpdated.length > 0) {
    const result: Record<string, unknown> = { recorded: true, updated: reconciledUpdated };
    if (sessionCreated) result['created'] = true;
    output(result, raw, 'true');
  } else if (updated.length === 0) {
    // Nothing was ever attempted — no --stopped-at/--resume-file supplied
    // and no existing Last session/Last Date/Stopped At/Resume File labels
    // to touch.
    declineNoOp(
      raw,
      'recorded',
      'no session fields found in STATE.md to update',
      'state record-session skipped — no session fields found in STATE.md to update.',
    );
  } else {
    // #3957: `updated` (pre-reconciliation) was non-empty — a rewrite
    // matched a session field and reported it as changed — but
    // `reconcileReportedFields` found the persisted bytes byte-identical to
    // what was already on disk (the matched field's supplied value equals
    // its already-recorded value), so nothing actually changed. Distinct
    // from the "nothing was ever attempted" case above: the prior single
    // reason collapsed both into 'No session fields found in STATE.md',
    // which was simply wrong for this case.
    declineNoOp(
      raw,
      'recorded',
      'the matched session field(s) already held the reported value — no bytes changed',
      'state record-session skipped — the matched session field(s) already held the reported value; no bytes changed.',
    );
  }
}

/**
 * Match the session section body from a STATE.md body. #1101: recognise the
 * bootstrap `## Session Continuity` heading but PREFER the normalized `## Session`
 * block when both exist (legacy duplicate files), so the reader agrees with the
 * writer (which updates `## Session` first). Level-2-exact heading match
 * (excludes an h3 `### Session Continuity`); the exact `'session continuity'`
 * text match still excludes `## Session Continuity Archive` (preserving the
 * #2444 scoping). Migrated onto the `collectSection` seam (#2143 audit,
 * epic #2143): CRLF-safe — the prior hand-rolled `[ \t]*\n` regex silently
 * failed to match a CRLF `## Session\r\n` heading line (the `\r` broke the
 * `[ \t]*\n` boundary); `tokenizeHeadings` strips the trailing `\r` before
 * heading-text extraction, so this now matches CRLF headings too.
 * Returns the section body, or null.
 */
function matchSessionSection(body: string): string | null {
  const isSession = (h: HeadingToken): boolean => h.level === 2 && h.text.trim().toLowerCase() === 'session';
  const isSessionContinuity = (h: HeadingToken): boolean => h.level === 2 && h.text.trim().toLowerCase() === 'session continuity';
  const section = collectSection(body, isSession, { levelBounded: true })
    ?? collectSection(body, isSessionContinuity, { levelBounded: true });
  return section ? section.body : null;
}

/**
 * Match the "Current Position" section body from a STATE.md body. #2956: this
 * is the Phase analogue of matchSessionSection. `Phase` canonically lives under
 * `## Current Position` (gsd-core/templates/state.md), so — like Stopped At /
 * Paused At under `## Session` — it must be extracted from THAT section, not
 * from the first `Phase:` / `**Phase:**` line anywhere in the body. Without the
 * scope, a historical `Phase:` line in an archive section silently overwrites
 * `current_phase` on every write, and because `current_phase` is routing input
 * for gsd-progress / --next the rewind routes work to the wrong phase.
 *
 * Level-flexible: the canonical template uses an h2 `## Current Position`, the
 * bootstrap template an h3 `### Current Position` (templates/state.md). Both
 * must match — mirroring how matchSessionSection recognises `## Session` and
 * `## Session Continuity`. Exact 'current position' text match (case-insensitive)
 * excludes unrelated headings. Built on the same `collectSection` seam as
 * matchSessionSection, so it inherits that seam's CRLF tolerance (#2444 fix).
 * Returns the section body, or null (caller falls back to full-body search).
 *
 * The scoping logic now lives in state-document.cjs's `stateCurrentPositionSlice`
 * (the module that owns STATE.md field extraction) — this is a thin alias kept
 * for call-site stability. Two copies of this scope would be exactly the kind
 * of generative-fix divergence the repo's parity rule exists to prevent.
 */
function matchCurrentPositionSection(body: string): string | null {
  return stateCurrentPositionSlice(body);
}

/**
 * #2567: prevent a stale archive "Last activity:" line from overwriting a
 * newer frontmatter value. `stateExtractField` matches the first body
 * occurrence, which may be a historical line in an archive section. Unlike
 * Stopped At / Paused At (which canonically live in `## Session`), Last
 * Activity has no single canonical section — it appears in the preamble,
 * `## Configuration`, and `## Current Position` across STATE.md layouts, so a
 * section scope cannot reliably exclude archive copies. Guard the
 * information-losing direction instead: when the body-derived date is OLDER
 * than the existing frontmatter date, keep the existing value and its
 * description. Applied at both the write seam (syncStateFrontmatter) and the
 * read seam (cmdStateJson) so they agree. Date fields only — non-date values
 * pass through unchanged.
 */
function preferNewerLastActivity(
  existingFm: Record<string, unknown> | null,
  derivedFm: Record<string, unknown>,
): void {
  if (!existingFm) return;
  const exRaw = existingFm['last_activity'];
  const derRaw = derivedFm['last_activity'];
  if (typeof exRaw !== 'string' || typeof derRaw !== 'string') return;
  const exDate = exRaw.slice(0, 10);
  const derDate = derRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate) || !/^\d{4}-\d{2}-\d{2}$/.test(derDate)) return;
  // #3258: this guard now protects only `last_activity` (a `derive` row) against
  // the stale-archive regression (#2567). `last_activity_desc` used to be
  // restored here too (both the older-date and the #3052 same-date branches),
  // but that was a date-comparison rule — a DIFFERENT policy from the
  // `preserve-when-unchanged` row its FIELD_CLASSIFICATION entry declares.
  // Keeping both was two rules that could disagree. last_activity_desc is now
  // governed by exactly one rule: its table row, enforced by
  // applyStatePreservation's #1230 delta heuristic on the RMW path (where every
  // desc-preserving transition — planned-phase / advance / complete / milestone
  // — runs). The #3052 same-date contract still holds via that delta rule.
  if (derDate < exDate) {
    derivedFm['last_activity'] = exRaw;
  }
}

function parseProsePhaseField(value: string | null): { phase: string | null; name: string | null } {
  // #2121 Phase 2 (#2125): delegate to the canonical anchored parser so this
  // module holds no independent prose phase-id regex. Drives #2111 — the
  // anchored parser returns { phase: null } for a "Milestone vX.Y complete"
  // body line (the old unanchored regex mined the minor-version digit, e.g.
  // v0.5 -> "5"), so syncStateFrontmatter's #905 guard preserves the real
  // current_phase instead of clobbering it.
  return parsePhaseFromProse(value);
}

function resolveStatePhase(fm: Record<string, unknown>, body: string): {
  phase: string | null;
  name: string | null;
  sources: {
    frontmatter: string | null;
    legacy_current_phase: string | null;
    current_position_phase: string | null;
  };
} {
  const currentPositionScope = matchCurrentPositionSection(body) ?? body;
  const frontmatterRaw = stateFieldValue(fm, body, 'current_phase', null).value;
  const legacyRaw = stateFieldValue(fm, currentPositionScope, null, 'Current Phase').value;
  const currentPositionRaw = stateFieldValue(fm, currentPositionScope, null, 'Phase').value;
  const sources = {
    frontmatter: parseProsePhaseField(frontmatterRaw).phase,
    legacy_current_phase: parseProsePhaseField(legacyRaw).phase,
    current_position_phase: parseProsePhaseField(currentPositionRaw).phase,
  };
  const prosePhase = parseProsePhaseField(currentPositionRaw);
  return {
    phase: sources.frontmatter ?? sources.legacy_current_phase ?? sources.current_position_phase,
    name: stateFieldValue(fm, body, 'current_phase_name', null).value
      ?? stateFieldValue(fm, currentPositionScope, null, 'Current Phase Name').value
      ?? prosePhase.name,
    sources,
  };
}

/**
 * Resolve a STATE.md's own current phase id from the document itself — the
 * WRITE-PATH ladder shared by `cmdStateAddDecision` (#3231) and
 * `cmdStateAddRoadmapEvolution` (#3481), extracted from the ladder
 * `cmdStatePrune` already ran (#1760).
 *
 * The rungs are the canonical ones owned by state-document.cjs's
 * `stateFieldValue` (#3187, ADR-3180 §7.7): frontmatter `current_phase` → body
 * `Current Phase` field → prose `Phase: X of Y` scoped to `## Current
 * Position`.
 *
 * #1776: the prose rung stays scoped to `## Current Position`. Over the whole
 * body, `stateExtractField`'s pipe-table fallback matches any `| Phase | N |`
 * row — e.g. a historical verification table — and would resolve a stale phase.
 * Frontmatter and the explicit `Current Phase` field are unambiguous, so they
 * stay document-wide. `cmdStateSnapshot` deliberately keeps the looser
 * whole-body fallback for its own prose rung and is not routed through here.
 *
 * Returns the id exactly as written, NOT parsed to a number: phase ids are not
 * always integers (`11-01` and `04.1` are both real). Callers needing an
 * integer parse it themselves. Returns null when no rung carries a value — a
 * genuinely absent phase is a real answer (§7.7 behavior table row 4), and
 * callers must render it as unknown rather than guess one.
 *
 * NOT the same function as `resolveStatePhase` above (#3208), and deliberately
 * not routed through it — the difference is one line and it is the whole point:
 *
 *   resolveStatePhase:     matchCurrentPositionSection(body) ?? body
 *   resolveCurrentPhaseId: null when the section is absent
 *
 * That `?? body` fallback is exactly the #1776 hazard. With no `## Current
 * Position` section, the prose rung widens to the entire document, where
 * `stateExtractField`'s pipe-table fallback matches any `| Phase | N |` row —
 * a historical verification table included — and resolves a stale phase.
 *
 * `resolveStatePhase`'s callers (`cmdStateSnapshot`, `cmdStateValidate`) READ
 * and report; a stale guess there is a wrong line in output a human is already
 * looking at. This function's callers WRITE: `cmdStateAddDecision` and
 * `cmdStateAddRoadmapEvolution` persist the result into records that outlive
 * the session, and `cmdStatePrune` decides what to delete from it. A wrong
 * phase there is durable and silent, so the write path takes the strict rung
 * and renders `?` rather than guessing.
 *
 * Reconcile the two only by giving `resolveStatePhase` an explicit scope
 * parameter — never by pointing this at it and dropping the difference.
 */
function resolveCurrentPhaseId(fm: Record<string, unknown>, body: string): string | null {
  const positionSection = sliceCurrentPositionSection(body);
  const prosePhase =
    positionSection !== null ? parseProsePhaseField(stateFieldValue(fm, positionSection, null, 'Phase').value).phase : null;
  return stateFieldValue(fm, body, 'current_phase', 'Current Phase').value ?? prosePhase;
}

function parseProseLastActivityField(value: string | null): { date: string | null; description: string | null } {
  if (!value) return { date: null, description: null };
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:\s+[—-]{1,2}\s+(.+))?$/);
  if (!match) return { date: value, description: null };
  return {
    date: match[1],
    description: match[2]?.trim() || null,
  };
}

function cmdStateSnapshot(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;

  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');

  // Bug #3265: prefer YAML frontmatter for canonical scalar fields so that a
  // body table cell containing **Status:** Y cannot shadow the authoritative
  // frontmatter value.  Mirrors the fix in sdk/src/query/state.ts.
  // Pass statePath so a truncated STATE.md is named in the #1882 diagnostic rather than
  // reported under a content digest — STATE.md is one of the artefacts epic #1879 is about.
  const fm = extractFrontmatter(content, statePath) as Record<string, unknown>;
  const body = stripFrontmatter(content);

  // #3187: frontmatter-scalar-then-body-field precedence is owned by
  // state-document.cjs's `stateFieldValue` (ADR-3180 §7.7) — this function no
  // longer holds its own fmScalar ladder.

  // Extract basic fields — frontmatter keys take precedence over body
  // #2956: scope `Phase` extraction to ## Current Position so a historical
  // Phase: / **Phase:** line in an archive section cannot overwrite the current
  // value. Phase canonically lives in ## Current Position (templates/state.md),
  // so it is scopeable exactly like Stopped At under ## Session. Fall back to
  // full-body search only when no ## Current Position section exists, so files
  // with no section heading keep their current behaviour.
  const resolvedPhase = resolveStatePhase(fm, body);
  const currentPhase = resolvedPhase.phase;
  const currentPhaseName = resolvedPhase.name;
  const totalPhasesRaw = stateFieldValue(fm, body, 'total_phases', 'Total Phases').value;
  const currentPlan = stateFieldValue(fm, body, 'current_plan', 'Current Plan').value;
  const totalPlansRaw = stateFieldValue(fm, body, 'total_plans_in_phase', 'Total Plans in Phase').value;
  const status = stateFieldValue(fm, body, 'status', 'Status').value;
  const progressRaw = stateFieldValue(fm, body, 'progress', 'Progress').value;
  const rawLastActivity = stateFieldValue(fm, body, null, 'Last Activity').value ?? stateFieldValue(fm, body, null, 'Last activity').value;
  const proseLastActivity = parseProseLastActivityField(rawLastActivity);
  const lastActivity = stateFieldValue(fm, body, 'last_activity', null).value ?? proseLastActivity.date ?? rawLastActivity;
  const lastActivityDesc = stateFieldValue(fm, body, 'last_activity_desc', 'Last Activity Description').value ?? proseLastActivity.description;
  // #2956: Paused At canonically lives in ## Session (see the comment above
  // preferNewerLastActivity and the write seam in buildStateFrontmatter). The
  // write seam already scopes it to ## Session; this read seam must agree, so a
  // stale "Paused At:" in a Session Continuity Archive cannot win here either.
  const sessionScope = matchSessionSection(body) ?? body;
  const pausedAt = stateFieldValue(fm, sessionScope, 'paused_at', 'Paused At').value;

  // Parse numeric fields
  const totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  const progressPercent = progressRaw ? parseInt(progressRaw.replace('%', ''), 10) : null;

  // Extract decisions table — via the markdown-sectionizer/markdown-table
  // seams (ADR-2143 §7), cells addressed by column NAME rather than a
  // hand-rolled section+table regex.
  const decisions: Array<{ phase: string; summary: string; rationale: string }> = [];
  const decisionsSection = collectSection(body, (h) => /^decisions made$/i.test(h.text.trim()));
  const decisionsTable = decisionsSection ? parseMarkdownTable(decisionsSection.body) : null;
  if (decisionsTable && decisionsTable.ok) {
    for (const row of decisionsTable.value.rows) {
      const cells = decisionsTable.value.columns.map((c) => (row[c] ?? '').trim()).filter(Boolean);
      if (cells.length >= 3) {
        decisions.push({
          phase: cells[0],
          summary: cells[1],
          rationale: cells[2],
        });
      }
    }
  }

  // Extract blockers list
  const blockers: string[] = [];
  const blockersSection = collectSection(body, (h) => h.level === 2 && h.text.trim().toLowerCase() === 'blockers', { levelBounded: true });
  if (blockersSection) {
    const items = blockersSection.body.match(/^-\s+(.+)$/gm) || [];
    for (const item of items) {
      blockers.push(item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract session info
  const session: StateSnapshotSession = {
    last_date: null,
    stopped_at: null,
    resume_file: null,
  };

  // #1101: prefer the canonical `## Session` block, falling back to the bootstrap
  // `## Session Continuity` heading. See matchSessionSection for the anchoring.
  const sessionMatch = matchSessionSection(body);
  if (sessionMatch !== null) {
    const sessionSection = sessionMatch;
    // Accept both `**Last Date:**` (canonical template form) and `**Last session:**`
    // (the form written by the DWIM auto-create / normalize path added for #944).
    const lastDateMatch = sessionSection.match(/\*\*Last Date:\*\*\s*(.+)/i)
      || sessionSection.match(/^Last Date:\s*(.+)/im)
      || sessionSection.match(/\*\*Last session:\*\*\s*(.+)/i)
      || sessionSection.match(/^Last session:\s*(.+)/im);
    const stoppedAtMatch = sessionSection.match(/\*\*Stopped At:\*\*\s*(.+)/i)
      || sessionSection.match(/^Stopped At:\s*(.+)/im);
    const resumeFileMatch = sessionSection.match(/\*\*Resume File:\*\*\s*(.+)/i)
      || sessionSection.match(/^Resume File:\s*(.+)/im);

    if (lastDateMatch) session.last_date = lastDateMatch[1].trim();
    if (stoppedAtMatch) session.stopped_at = stoppedAtMatch[1].trim();
    if (resumeFileMatch) session.resume_file = resumeFileMatch[1].trim();
  }

  const result = {
    current_phase: currentPhase,
    current_phase_name: currentPhaseName,
    total_phases: totalPhases,
    current_plan: currentPlan,
    total_plans_in_phase: totalPlansInPhase,
    status,
    progress_percent: progressPercent,
    last_activity: lastActivity,
    last_activity_desc: lastActivityDesc,
    decisions,
    blockers,
    paused_at: pausedAt,
    session,
  };

  output(result, raw, undefined);
}

// ─── State Frontmatter Sync ──────────────────────────────────────────────────

// `phaseKeyFromToken` / `phaseKeyFromDir` — the canonical key for matching a
// ROADMAP phase token against an on-disk phase directory — moved to the
// phase-id owner module in #2562 so every consumer derives BOTH sides of a
// phase comparison from the same function (see phase-id.cts). Imported at the
// top of this file; call sites below are unchanged. #612 threads the optional
// `convention` through that owner's `phaseKeyFromDir` (see phase-id.cts) rather
// than re-deriving a bracket-aware key here.

/**
 * #612: is the asserted milestone bounded to a heading in this ROADMAP?
 *
 * The legacy rule matches STATE's milestone STRING (`v2.0`) inside a heading.
 * The ADR-canonical bracket milestone heading is `## [GSD.02] Foundation` — a
 * name, no version — so that rule finds nothing, the milestone reads as
 * unbounded, and total_phases falls back to the on-disk directory count. Under
 * the bracket convention the milestone integer in the bracket is matched against
 * the `vN` of the milestone string instead (READING-B parity). Gated, and only
 * consulted after the legacy rule has already failed, so no non-bracket repo
 * changes answer.
 */
function isMilestoneBounded(roadmapRaw: string, milestone: string, convention?: string | null): boolean {
  // #3184: preserve roadmap-parser's canonical legacy answer and compose the
  // gated bracket extension on top of it. Re-deriving the version-heading
  // grammar here would restore the boundary drift that #3184 removed.
  if (isMilestoneBoundedInRoadmap(roadmapRaw, String(milestone).trim())) return true;
  if (convention !== 'bracket') return false;
  const vMatch = String(milestone).trim().match(/^v(\d+)/i);
  const milestoneInt = vMatch ? parseInt(vMatch[1], 10) : NaN;
  if (!Number.isSafeInteger(milestoneInt)) return false;
  // Canonical spelling only — see the note in roadmap-parser's scoping branch.
  // Accepting `0*N` here bounded a milestone whose phases were invisible, which
  // un-suppressed a progress percent computed off an unscoped disk count.
  // #2761 M3: that padding rule and the grammar both come from the owner's
  // `bracketMilestoneIntroSrcFor`. This line and roadmap-parser's selector were
  // character-identical re-typings of one pattern, so "canonical spelling only"
  // was a convention two files had to keep agreeing on by hand — and the drift
  // guard could not see either copy.
  // #612 round-4 (Major 1, F12): fence-aware via tokenizeHeadings, not a raw
  // `.test(roadmapRaw)` — a FENCED `[GSD.02]` example heading (the ONLY one
  // in the document, with no real section for the asserted milestone at
  // all) previously bounded a milestone that isn't actually in the roadmap,
  // un-suppressing a percent computed off the wrong (prior-milestone-plus-
  // whole-disk) phase set. tokenizeHeadings never produces a token for a
  // fenced line, so a fenced-only example can no longer satisfy this test.
  const bracketMilestoneHeadingRe = new RegExp(`^${bracketMilestoneIntroSrcFor(milestoneInt)}`, 'i');
  // #612 round-5 (Minor 1): skip ≤3-space-indented tokens — `h.offset` is
  // tokenizeHeadings' LINE-START offset, not the `#` character, so an
  // indented heading here would bound a milestone the line-start-anchored
  // raw predecessor never matched. Restores raw parity; see roadmap-parser's
  // matching selector-reconstruction comment for the full rationale.
  return tokenizeHeadings(roadmapRaw).some(
    (h) => h.level <= 3 && roadmapRaw[h.offset] === '#' && bracketMilestoneHeadingRe.test(h.text),
  );
}

/**
 * Extract the set of retired/folded phase keys from a ROADMAP milestone scope
 * (#1514). A retired phase is struck through with GFM strikethrough,
 * e.g. `- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired`.
 * Such a phase keeps a `[x]` mark and often a directory but ships no completion
 * artifact, so it would otherwise inflate `total_phases` (the denominator)
 * without ever satisfying the numerator, freezing a shipped milestone below
 * 100%.
 *
 * Detection is scoped to the lines that canonically mark a phase retired — a
 * checklist entry (`- [x] …`) or a phase heading (`#### Phase …`) — and within
 * those, only a struck span whose SUBJECT is the phase counts: the phase
 * reference must sit at the start of the `~~…~~` span (after optional markdown
 * emphasis), as in `~~**Phase 04: Delta**~~`, `~~Phase 04~~`, or
 * `~~Phase PROJ-42~~`. This ignores struck PROSE that merely mentions a phase
 * (a goal line `~~folded into Phase 05~~`, or `~~Phase 04 was renamed~~`) and
 * the fold target in `~~Phase 04~~ — folded into Phase 05` (outside the span).
 * The phase token shape mirrors the heading counter's `[\w][\w.-]*` so numeric,
 * decimal, and project-code IDs are detected alike. Returns canonical keys
 * (see phaseKeyFromToken).
 */
function extractRetiredPhaseNumbers(scope: string, convention?: string | null): Set<string> {
  const retired = new Set<string>();
  const isChecklistOrHeading = /^\s*(?:[-*+]\s*\[[ xX]\]|#{1,6}\s)/;
  // #612: the retirement filter has to widen with the counter it protects. The
  // canonical #1514 gesture strikes the checklist BULLET and leaves the detail
  // heading intact, so a bracket-form retirement went undetected and the phase
  // stayed in the denominator forever — a shipped bracket milestone could never
  // reach 100%. Same selection rule as the counter: a non-bracket repo compiles
  // the bare `Phase\s+` this line spelled before.
  const introSrc = phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention);
  const phaseRefRe = new RegExp(`^[\\s*_]*${introSrc}([\\w][\\w.-]*)`, 'i');
  // #612 round-5 (Major 1): fence-aware on the BRACKET path only — a fenced
  // AUTHORING EXAMPLE of the #1514 retirement gesture, spelled in bracket
  // form, must not retire a real phase. Reuses markdown-sectionizer's
  // single-owner stripFencedCode rather than a second fence parser. Legacy
  // stays the raw `scope`, byte-identical — its own fenced-example hazard is
  // pre-existing and out of scope.
  const scanScope = convention === 'bracket' ? stripFencedCode(scope).text : scope;
  for (const line of scanScope.split(/\r?\n/)) {
    if (!isChecklistOrHeading.test(line)) continue;
    const strikeSpan = /~~([^~]*?)~~/g;
    let s: RegExpExecArray | null;
    while ((s = strikeSpan.exec(line)) !== null) {
      const phaseRef = phaseRefRe.exec(s[1]);
      // Require a digit so struck prose like ~~Phase Overview~~ is ignored.
      if (phaseRef && /\d/.test(phaseRef[1])) retired.add(phaseKeyFromToken(phaseRef[1]));
    }
  }
  return retired;
}

/**
 * #612 (round-4 fix): the single shared implementation for the phase-heading
 * counter `buildStateFrontmatter` (read path) and `cmdStateSync` (write
 * path) each built inline as an independent copy. The comment at each call
 * site already claimed "the two counters must see the same phases or
 * `state json` and `state sync` report different totals for one repo
 * (#3242 Bug B)" — this makes that invariant STRUCTURAL (one implementation,
 * two call sites) instead of two copies a future edit could silently
 * diverge.
 *
 * Two DELIBERATELY DIFFERENT counting strategies, selected by `convention`:
 *
 * - BRACKET: counts via `tokenizeHeadings(scope)` at levels 2-4 (mirroring
 *   `getMilestonePhaseFilter`'s own level bound, `roadmap-parser.cts:1090`),
 *   testing each heading's (hash-stripped, fence-STRIPPED-by-construction)
 *   text against the phase-heading-intro grammar directly. Fence-aware by
 *   construction — `tokenizeHeadings` never produces a token for a fenced
 *   line — closing round-4's Major 1: a fenced EXAMPLE phase heading in the
 *   preamble (`` ### [GSD.02] 05: Example phase `` inside a
 *   ` ```markdown ` block) previously inflated this count via the raw regex
 *   below, which ran over the whole scope STRING with no fence awareness at
 *   all (F9, F10 — `total_phases` read 3 where the milestone has 2 real
 *   phases). The producer (`extractCurrentMilestone`'s returned scope
 *   string) is deliberately NOT changed — every other consumer of that
 *   string needs its full content fidelity, and the legacy path's identity
 *   forbids touching the string all consumers share; this fixes the
 *   COUNTING, not the scope.
 *
 * - LEGACY (any non-bracket convention, including unresolved/null): retain
 *   the existing raw `content.exec()` counting strategy. On the read path,
 *   route sentinel exclusion through #3185's canonical predicate; the sync
 *   path intentionally retains its pre-existing absence of that exclusion.
 *
 * `applyConventionTokenSentinelRules` makes the remaining convention-specific
 * asymmetry explicit. Both read and sync exclude bare bracket token 999; only
 * the read path excludes canonical legacy sentinels. Both bracket paths also
 * retain the bracket-id and bare-0 rules. Sharing the implementation therefore
 * cannot silently move either convention's total.
 */
function countRoadmapPhaseHeadings(
  scope: string,
  convention: string | null | undefined,
  retiredPhaseNums: Set<string>,
  applyConventionTokenSentinelRules: boolean,
): number {
  let count = 0;
  if (convention === 'bracket') {
    const introSrc = phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention, true);
    const phaseHeadingPattern = new RegExp(`^${introSrc}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'i');
    for (const h of tokenizeHeadings(scope)) {
      if (h.level < 2 || h.level > 4) continue;
      const m = phaseHeadingPattern.exec(h.text);
      if (!m) continue;
      const bracketId = m[1];
      const token = m[2];
      // Only count tokens that contain at least one digit — excludes
      // pure-word section headings (Overview, Details) while keeping
      // numeric phases (01, 05.1) and project-code IDs (PROJ-42).
      if (!/\d/.test(token)) continue;
      // #612 READING-B: a bracket heading carries its sentinel in the
      // bracket, so `### [GSD.999] 01:` is an icebox item even though its
      // token is `01`.
      if (bracketId && isSentinelPhaseId(`${bracketId}-${token}`, 'bracket')) continue;
      // #612: under bracket the token rule composes with the bracket-id
      // check as the engine's {0, 999} sentinel set.
      if (bracketId && /^0\b/.test(token)) continue;
      if (applyConventionTokenSentinelRules && /^999\b/.test(token)) continue;
      // #1514: retired/folded phases are struck through in the ROADMAP;
      // exclude them from the denominator (they can never be completed).
      if (retiredPhaseNums.has(phaseKeyFromToken(token))) continue;
      count++;
    }
    return count;
  }
  // LEGACY stays on the pre-round-4 raw exec loop. #3185 owns the read-path
  // sentinel predicate; sync deliberately preserves its prior behavior.
  const phaseHeadingPattern = new RegExp(`#{2,4}\\s*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention, true)}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = phaseHeadingPattern.exec(scope)) !== null) {
    const token = m[1];
    if (!/\d/.test(token)) continue;
    if (applyConventionTokenSentinelRules && isSentinelPhaseId(token)) continue;
    if (retiredPhaseNums.has(phaseKeyFromToken(token))) continue;
    count++;
  }
  return count;
}

/**
 * Extract machine-readable fields from STATE.md markdown body and build
 * a YAML frontmatter object. Allows hooks and scripts to read state
 * reliably via `state json` instead of fragile regex parsing.
 */
function buildStateFrontmatter(bodyContent: string, cwd: string | undefined, storedMilestone?: string | null, storedTotalPhases?: number | null): Record<string, unknown> {
  // #2956: scope `Phase` extraction to ## Current Position (mirrors the read
  // path in cmdStateSnapshot and the Stopped At / Paused At ## Session scoping
  // below). Phase canonically lives in ## Current Position (templates/state.md);
  // without the scope, a historical Phase: / **Phase:** line in an archive
  // section overwrites current_phase here, and the next read surfaces it. Fall
  // back to full-body search when no ## Current Position section exists.
  const currentPositionScope = matchCurrentPositionSection(bodyContent) ?? bodyContent;
  const prosePhase = parseProsePhaseField(stateExtractField(currentPositionScope, 'Phase'));
  const currentPhase = stateExtractField(bodyContent, 'Current Phase') ?? prosePhase.phase;
  const currentPhaseName = stateExtractField(bodyContent, 'Current Phase Name') ?? prosePhase.name;
  const currentPlan = stateExtractField(bodyContent, 'Current Plan');
  const totalPhasesRaw = stateExtractField(bodyContent, 'Total Phases');
  const totalPlansRaw = stateExtractField(bodyContent, 'Total Plans in Phase');
  const status = stateExtractField(bodyContent, 'Status');
  const progressRaw = stateExtractField(bodyContent, 'Progress');
  const rawLastActivity = stateExtractField(bodyContent, 'Last Activity') ?? stateExtractField(bodyContent, 'Last activity');
  const proseLastActivity = parseProseLastActivityField(rawLastActivity);
  const lastActivity = proseLastActivity.date ?? rawLastActivity;
  const lastActivityDesc = stateExtractField(bodyContent, 'Last Activity Description') ?? proseLastActivity.description;
  // Bug #2444 / #2567: scope Stopped At AND Paused At extraction to the
  // ## Session section so historical prose elsewhere in the body (e.g. in a
  // Session Continuity Archive section) never overwrites the current value.
  // Fall back to full-body search only when no ## Session section exists.
  // #1101: prefer the canonical `## Session` block, falling back to the bootstrap
  // `## Session Continuity` heading. See matchSessionSection for the anchoring.
  const sessionSectionMatch = matchSessionSection(bodyContent);
  const sessionBodyScope = sessionSectionMatch ?? bodyContent;
  const stoppedAt = stateExtractField(sessionBodyScope, 'Stopped At') || stateExtractField(sessionBodyScope, 'Stopped at');
  // #2567: Paused At is a session field — scope it to ## Session too so a
  // stale "Paused At:" line in an archive section cannot overwrite the value.
  const pausedAt = stateExtractField(sessionBodyScope, 'Paused At');

  let milestone: string | null = null;
  let milestoneName: string | null = null;
  // #1761 regression fix (#3216): the milestone STATE.md actually ASSERTS,
  // independent of whether getMilestoneInfo's identity scope is COMPLETE.
  // Needed below by the disk-scan block's `isMilestoneBoundedInRoadmap` guard
  // — that check answers "is the ASSERTED version bounded to a versioned
  // ROADMAP heading", a different question from "is the identity trustworthy
  // enough to persist" (`milestone` above). Conflating the two regressed
  // #1761: when a real STATE `milestone:` value has no matching ROADMAP
  // heading, `info.scope` is never COMPLETE (rightly — there's no curated
  // name to persist), but the version was still genuinely asserted and the
  // bounded check must still run on it, or the guard silently no-ops and
  // `state json` reports a conflated whole-document total_phases/percent.
  let assertedMilestoneVersion: string | null = null;
  if (cwd) {
    // DEAD catch removed (#2245 audit): getMilestoneInfo has its own outer
    // try/catch (roadmap-parser.cts) that already swallows every internal
    // failure and always returns a ScopedResult — it never throws, so this
    // wrapper could never be triggered.
    // #3216 (ADR-3180 §7.2 rule 6): this is the #3197 disk-write path. Rule 6
    // draws the line at the FIELD, not the scope as a whole — "a version known
    // but no name resolvable is TRUNCATED carrying {version, name: null} — the
    // version is a real answer, the name is a non-answer, and collapsing the
    // two is the failure this contract exists to prevent." So `milestone`
    // (the version) is written whenever COMPLETE or TRUNCATED — both carry a
    // genuine version per rule 6 — while `milestoneName` is written only on
    // COMPLETE, since TRUNCATED's name is by definition unresolved and must
    // never be fabricated. UNSCOPED/UNREADABLE have no real version either
    // way, so both stay null there. This mirrors cmdCommit (src/commands.cts),
    // which accepts COMPLETE or TRUNCATED for the same reason (the version is
    // real), and deliberately diverges from archivePhaseDirectories
    // (src/milestone.cts), which demands COMPLETE only because it uses the
    // value as a filesystem path component and a TRUNCATED version is not
    // safe to use there.
    const info = getMilestoneInfo(cwd);
    assertedMilestoneVersion = info.value ? info.value.version : null;
    if ((info.scope === SCOPE.COMPLETE || info.scope === SCOPE.TRUNCATED) && info.value) {
      milestone = info.value.version;
    }
    if (info.scope === SCOPE.COMPLETE && info.value) {
      milestoneName = info.value.name;
    }
  }

  let totalPhases: number | null = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  let completedPhases: number | null = null;
  let totalPlans: number | null = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  let completedPlans: number | null = null;
  // #1761 read-path: set from cached.milestoneBounded inside the disk-scan
  // block; consumed at the percent computation to mirror the cmdStateSync guard.
  let milestoneUnbounded = false;
  // #3217 (ADR-3180 §7.6 rule 4, finding 1): the real listMilestonePhaseDirs
  // scope for the disk-scanned counts below, set from cached.phaseDirScope
  // when a fresh disk scan runs. SCOPE.COMPLETE is the correct default here
  // — NOT a rule-4 hardcode — for the cases where no disk scan happens at all
  // (no cwd, or phasesDir absent): totalPhases/totalPlans then come straight
  // from the pre-existing frontmatter fields parsed above, a path this phase
  // does not touch and which predates listMilestonePhaseDirs entirely.
  let diskScope: Scope = SCOPE.COMPLETE;

  // #612: resolved ONCE per call, federated workstream -> root, and shared by
  // the heading counter, the retirement filter and the retired-directory skip so
  // no two of them can split on different answers.
  const phaseConvention = cwd ? resolvePhaseIdConvention(cwd) : null;

  if (cwd) {
    try {
      const phasesDir = planningPaths(cwd).phases;
      if (fs.existsSync(phasesDir)) {
        // Use cached disk scan when available — avoids N+1 readdirSync calls
        // on repeated buildStateFrontmatter invocations within the same process (#1967)
        let cached = _diskScanCache.get(cwd);
        if (!cached) {
          // Read the current-milestone ROADMAP scope once: it feeds both the
          // heading-based phase count below and the retired/folded-phase
          // exclusion (#1514). Computed before the disk scan so retired phases
          // can be dropped from the dir set too.
          let roadmapScope: string | null = null;
          let roadmapRaw: string | null = null;
          let retiredPhaseNums = new Set<string>();
          try {
            const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
            roadmapRaw = platformReadSync(roadmapPath);
            if (roadmapRaw !== null) {
              roadmapScope = extractCurrentMilestone(roadmapRaw, cwd);
              retiredPhaseNums = extractRetiredPhaseNumbers(roadmapScope, phaseConvention);
            }
          } catch { /* fall through: no roadmap scope → no retired exclusion */ }

          // #3017: scope the milestone filter to the STORED milestone when available,
          // so a state.* write doesn't auto-derive (and mis-bind) to a different
          // milestone's heading and clobber the stored value + progress counts.
          // #3185 (ADR-3180 Decision 1): "which phase directories belong to the
          // CURRENT (stored) milestone" — routed through the canonical owner
          // instead of a hand-rolled readdirSync + isDirInMilestone filter
          // (which also never excluded sentinels, unlike the owner).
          const { value: allMatchingDirs, scope: phaseDirScope } = listMilestonePhaseDirs(phasesDir, {
            cwd,
            versionOverride: storedMilestone ?? null,
            phaseIdConvention: phaseConvention,
          });

          // Bug #2445: when stale phase dirs from a prior milestone remain in
          // .planning/phases/ alongside new dirs with the same phase number,
          // de-duplicate by normalized phase number keeping exactly one dir
          // per key (deterministic tie-break: see #3355 below). This prevents
          // double-counting (e.g. two "Phase 1" dirs).
          const seenPhaseNums = new Map<string, string>(); // normalizedNum -> dirName
          for (const dir of allMatchingDirs) {
            // #1514: a retired/folded phase keeps a directory but no completion
            // artifact; drop it from the disk phase set so it counts toward
            // neither the denominator nor the numerator (mirrors the heading
            // exclusion below). Project-code-aware via phaseKeyFromDir.
            if (retiredPhaseNums.size > 0 && retiredPhaseNums.has(phaseKeyFromDir(dir, phaseConvention))) continue;
            // #3185: dedup grouping routed through the canonical phaseKeyFromDir
            // (src/phase-id.cts) instead of a local leading-digits regex that
            // diverged from extractPhaseToken/phaseKeyFromDir on
            // project-code-prefixed dirs (whole dirname fell through as the key,
            // so a `PROJ-05`/`PROJ-05-slug` pair never deduped) and on
            // multi-segment milestone dirs. Same key surface used two lines
            // above for the retiredPhaseNums exclusion, so both filters agree.
            const key = phaseKeyFromDir(dir, phaseConvention);
            if (!seenPhaseNums.has(key)) {
              seenPhaseNums.set(key, dir);
            } else {
              // #3355: the survivor of a same-milestone collision must be
              // chosen from repository CONTENT, never from filesystem state.
              // The pre-#3355 tie-break was `mtimeMs` — a checkout-order
              // signal — so two byte-identical checkouts of the same commit
              // that wrote the colliding dirs in a different order picked
              // different survivors, and progress.total_plans /
              // completed_plans drifted across clones and CI runs. The
              // directory NAME is git-tracked content and a total order, so
              // the lexicographically-first dir wins deterministically. The
              // collision is still a project-level defect (duplicate phase
              // number in scope), so it is surfaced on stderr instead of
              // being silently resolved. The Bug #2445 invariant — exactly
              // one survivor per normalized phase number — is unchanged.
              const incumbent = seenPhaseNums.get(key) as string;
              const survivor = dir < incumbent ? dir : incumbent;
              seenPhaseNums.set(key, survivor);
              process.stderr.write(
                `gsd: warning — phase directories '${incumbent}' and '${dir}' both normalize to phase key '${key}' (duplicate phase number in .planning/phases/); keeping '${survivor}' by deterministic lexicographic order. (#3355)\n`
              );
            }
          }
          const phaseDirs = [...seenPhaseNums.values()];

          let diskTotalPlans = 0;
          let diskTotalSummaries = 0;
          let diskCompletedPhases = 0;

          for (const dir of phaseDirs) {
            const phaseDir = path.join(phasesDir, dir);
            const { planCount, summaryCount } = scanPhasePlans(phaseDir);
            diskTotalPlans += planCount;
            diskTotalSummaries += summaryCount;
            // ADR-3180 §7.4 (#3186, #2957 disk-strict): "which phases are
            // complete" is the completion question, routed through the single
            // canonical owner (isPhaseComplete, src/verification.cts) — NOT
            // scanPhasePlans's own `completed` field, which only answers "are
            // all plans summarized" (a different question; see plan-scan.cts's
            // own comment on that field). Folding this consumer onto the raw
            // summaries-met flag was the exact "consolidate two of three and
            // leave the third" gap §7.4's forcing function rules out.
            // #612: `phaseConvention` threaded so a bracket phase dir resolves
            // and scopes its verification report like its legacy twin — the
            // read-side half of the same thread cmdStateSync gets below.
            if (isPhaseComplete(phaseDir, { convention: phaseConvention }).value.complete) diskCompletedPhases++;
          }
          // Count phase headings from ROADMAP — single source of truth for
          // total_phases (#549). #612 round-4: shared with cmdStateSync's
          // identical-purpose counter via countRoadmapPhaseHeadings (above
          // extractRetiredPhaseNumbers). The shared helper composes its
          // fence-aware bracket strategy with #3185's canonical legacy
          // sentinel predicate for this read-path call.
          const roadmapPhaseCount = roadmapScope !== null
            ? countRoadmapPhaseHeadings(roadmapScope, phaseConvention, retiredPhaseNums, true)
            : 0;

          cached = (() => {
            // #1761 read-path: mirror the cmdStateSync guard (#1794). When the
            // asserted milestone version can't be bounded to a versioned ROADMAP
            // heading, extractCurrentMilestone falls back to the whole document
            // and roadmapPhaseCount conflates sibling milestones. In that case
            // don't substitute the whole-doc count — fall back to the on-disk
            // phase-dir count only, and mark unbounded so percent is skipped
            // downstream (mirrors the sync write-path guard).
            let milestoneBounded = true;
            // #3216 fix (#1761 regression): use `assertedMilestoneVersion` —
            // the version STATE.md actually asserts — not the scope-gated
            // `milestone`. `milestone` is null on any non-COMPLETE identity
            // scope (deliberately, so a non-trustworthy identity never
            // persists), but a real asserted version with no matching
            // ROADMAP heading is EXACTLY the unbounded case this guard exists
            // to catch; gating on `milestone` skipped the guard entirely and
            // let the whole-document roadmapPhaseCount conflate sibling
            // milestones again.
            if (assertedMilestoneVersion && roadmapRaw !== null) {
              // #3184: routed through the single owner (roadmap-parser.cjs)
              // instead of a hand-rolled, unbounded-substring re-derivation —
              // the prior inline regex had no boundary assertion after the
              // version token, so `v2.0` matched inside `v2.0.1` (#2562-class
              // defect, design row 17).
              milestoneBounded = isMilestoneBounded(roadmapRaw, String(assertedMilestoneVersion).trim(), phaseConvention);
            }
            // #2828: distinguish a FLAT unmilestoned roadmap (no milestone sectioning
            // at all — only Phase headings) from a MILESTONED-but-unbounded one
            // (milestone/version headings exist but the asserted one isn't among them).
            // On a flat roadmap the whole-doc count is correct (no sibling milestones to
            // conflate); on a sectioned-but-unbounded one it conflates siblings (#1761),
            // so fall back to phaseDirs.length.
            // #3184: routed through the single owner (roadmap-parser.cjs) —
            // deliberately weaker than isMilestoneBoundedInRoadmap above (no
            // version-token requirement); see hasMilestoneSectioning's own
            // doc comment for why that distinction is load-bearing.
            // #3642: the flat test uses the >=1 sibling (hasAnyMilestoneSection),
            // not the >=2 predicate. >=2 under-answers the question this branch
            // asks: with EXACTLY ONE milestone section and an asserted milestone
            // absent from the ROADMAP, >=2 read "flat" and the whole-document
            // count — which IS that single section's phases — was written as the
            // asserted milestone's total, silently clobbering the stored value.
            // The >=2 threshold governs SIBLING conflation; asserted-vs-section
            // needs only one section to go wrong. Zero sections (genuinely flat)
            // keeps the whole-document count, per #2828.
            const roadmapHasAnyMilestoneSection = roadmapRaw !== null
              && hasAnyMilestoneSection(roadmapRaw);
            const safeToUseRoadmapCount = milestoneBounded
              || (roadmapPhaseCount > 0 && !roadmapHasAnyMilestoneSection);
            // #3354: the milestoned-but-unbounded sibling of the #2828/#3204
            // shapes. The whole-document roadmapPhaseCount is rightly rejected
            // above (it would conflate sibling milestones, #1761), but the
            // on-disk phase-dir count is NOT an authoritative substitute for
            // the rejected total either — it counts only the current
            // milestone's realized directories (25 declared → 4 written in the
            // issue's report), silently shrinking progress.total_phases on
            // every STATE.md write. Mirror the branch's own percent withhold
            // (milestoneUnbounded below): return a null sentinel so the caller
            // keeps the pre-existing stored value instead of writing the
            // substitute, and warn on stderr naming the unbounded token so the
            // operator can curate the ROADMAP heading or the STATE assertion.
            // The degenerate un-sectioned zero-heading case keeps the
            // phaseDirs.length fallback — with nothing declared anywhere else,
            // the disk count is the only source and remains correct.
            const milestonedButUnbounded = !milestoneBounded && roadmapHasAnyMilestoneSection;
            if (milestonedButUnbounded) {
              process.stderr.write(
                `gsd: warning — milestone '${String(assertedMilestoneVersion ?? '').trim()}' is asserted in STATE.md but matches no ROADMAP heading, and the ROADMAP carries milestone section(s) — one (#3642) or several (#3354) — none matching it; the whole-document count would attribute a foreign section's phases to this milestone and the on-disk phase-directory count would understate the declared total, so progress.total_phases is left at its stored value. (#3354/#3642)\n`
              );
            }
            // #3573: the roadmap-absent sibling of the #3354 shape. With ROADMAP.md
            // absent/unreadable the #549 heading counter never ran (roadmapScope
            // stayed null), `milestoneBounded` is vacuously true (its gate requires
            // roadmapRaw), and the dir count — which only ever counts phases that
            // have STARTED — would be persisted as progress.total_phases by every
            // state.* write. A STATE that asserts a milestone (storedMilestone —
            // getMilestoneInfo is useless here, it reads the roadmap that is
            // absent) declared a total somewhere; keep the stored frontmatter
            // value instead. Without an asserted milestone (fresh project,
            // pre-roadmap) the disk count is still the only source and stays
            // authoritative (the #3354 doctrine's degenerate case).
            const roadmapAbsentWithAssertedMilestone =
              roadmapRaw === null &&
              typeof storedMilestone === 'string' &&
              storedMilestone.trim() !== '';
            if (roadmapAbsentWithAssertedMilestone) {
              process.stderr.write(
                `gsd: warning — milestone '${storedMilestone.trim()}' is asserted in STATE.md but ROADMAP.md is absent or unreadable, so the phase-heading total cannot be derived; the on-disk phase-directory count would understate the declared total, so progress.total_phases is left at its stored value. (#3573)\n`
              );
            }
            return {
              // The two WITHHOLD shapes (#3354 milestoned-but-unbounded, #3573
              // roadmap-absent-with-asserted-milestone) must be evaluated BEFORE
              // safeToUseRoadmapCount — in the #3573 shape milestoneBounded is
              // vacuously true (its gate requires roadmapRaw), so the safe-count
              // arm would otherwise swallow the withhold.
              totalPhases: (milestonedButUnbounded || roadmapAbsentWithAssertedMilestone)
                ? null
                : (safeToUseRoadmapCount ? Math.max(phaseDirs.length, roadmapPhaseCount) : phaseDirs.length),
              milestoneBounded,
              completedPhases: diskCompletedPhases,
              totalPlans: diskTotalPlans,
              completedPlans: diskTotalSummaries,
              phaseDirScope,
            };
          })();
          _diskScanCache.set(cwd, cached);
        }
        // #3354: cached.totalPhases === null is the milestoned-but-unbounded
        // WITHHOLD sentinel — the scan refused to substitute the dir count for
        // a rejected whole-document total, so keep the pre-existing value:
        // the stored frontmatter total when the caller can supply it, else the
        // body "Total Phases" annotation already parsed above, else leave null
        // (the key is omitted from the progress block).
        if (cached.totalPhases !== null) {
          totalPhases = cached.totalPhases;
        } else if (storedTotalPhases !== null && storedTotalPhases !== undefined) {
          totalPhases = storedTotalPhases;
        }
        completedPhases = cached.completedPhases;
        totalPlans = cached.totalPlans;
        completedPlans = cached.completedPlans;
        milestoneUnbounded = cached.milestoneBounded === false;
        diskScope = cached.phaseDirScope;
      }
      /* best-effort (#2245 audit): this is a READ path building STATE.md's
       * display frontmatter. The real throw source is fs.readdirSync(phasesDir)
       * a few lines up — an inaccessible/racily-removed phases dir must not
       * crash `state show`; on failure this simply keeps whatever
       * frontmatter-derived totals/completedPhases/etc. were already set
       * above, a graceful degrade rather than a corrupted write (nothing is
       * persisted from this block). */
    } catch { /* intentionally empty */ }
  }

  // Derive percent from disk counts when available (ground truth).
  // Uses min(plan_fraction, phase_fraction) via computeProgressPercent so that
  // ROADMAP-declared-but-unrealized future phases cap the reported completion
  // instead of a false 100% from plan-only coverage (#3242 Bug B).
  // Falls back to the body Progress: field only when no plan files exist on disk.
  // #3217 (ADR-3180 §7.6 rule 4, finding 1): computeProgressPercent requires
  // a `Scope` for its own rule-4 gate. `diskScope` is the real
  // `listMilestonePhaseDirs` scope threaded through `_diskScanCache`
  // (`phaseDirScope` above) when a fresh disk scan ran — an UNREADABLE
  // phases dir now withholds here exactly as it does at every sibling
  // surface, closing the cross-surface disagreement the isolated review
  // caught. When no disk scan ran at all (no cwd, or phasesDir absent)
  // `diskScope` keeps its SCOPE.COMPLETE default, preserving this
  // function's pre-existing behavior on that (unrelated, pre-dating
  // listMilestonePhaseDirs) fallback path. This call site also keeps its own
  // orthogonal `milestoneUnbounded` null-out below (#1761) — a different
  // guard (ROADMAP heading boundedness, not disk readability).
  let progressPercent = computeProgressPercent(completedPlans, totalPlans, completedPhases, totalPhases, diskScope);
  // #1761 read-path: when the milestone can't be bounded, percent would be
  // derived from a conflated/understated total — skip it (mirror cmdStateSync).
  if (milestoneUnbounded) progressPercent = null;
  // #3217 finding 1 (follow-on): a non-COMPLETE diskScope must withhold the
  // percentage EVERYWHERE, including this prose fallback — without the
  // `diskScope === SCOPE.COMPLETE` guard, a stale/existing "Progress: N%"
  // body line would silently defeat computeProgressPercent's rule-4 null,
  // re-introducing a rendered percentage on the exact scope this phase
  // withholds for (this is how the reviewer's UNREADABLE-phases fixture
  // could still surface a number even after the scope threading above).
  if (progressPercent === null && progressRaw && !milestoneUnbounded && diskScope === SCOPE.COMPLETE) {
    const pctMatch = progressRaw.match(/(\d+)%/);
    if (pctMatch) progressPercent = parseInt(pctMatch[1], 10);
  }

  let normalizedStatus = normalizeStateStatus(status, pausedAt);
  // #3578: normalizeStateStatus matches 'complete' as a case-insensitive
  // SUBSTRING, so the phase-completion prose cmdStateCompletePhase writes to
  // the body (`Phase ${N} complete`) collapses to the milestone-level
  // 'completed' status even when other phases remain open. Phase-level
  // prose must never decide milestone-level status — completedPhases /
  // totalPhases / diskScope, already derived above from a disk scan, are
  // the authority on whether the MILESTONE is actually done. Only override
  // when: (a) normalizeStateStatus actually landed on 'completed'; (b) the
  // raw prose is UNAMBIGUOUSLY phase-completion prose — the anchored
  // pattern below deliberately excludes "All phases complete" (no `\S+`
  // phase token) and milestone-close prose like "v1.0 milestone complete"
  // (no leading "phase"); and (c) the counters are trustworthy (a COMPLETE
  // disk scope, both counts are finite numbers, and a positive
  // denominator) and affirmatively disagree with 'completed'. In every
  // other case normalizedStatus is left exactly as normalizeStateStatus
  // returned it.
  if (
    normalizedStatus === 'completed' &&
    typeof status === 'string' &&
    /^\s*phase\s+\S+\s+complete\s*$/i.test(status) &&
    diskScope === SCOPE.COMPLETE &&
    // #1761: an unbounded milestone yields a conflated/understated total — the
    // same authority that nulls progressPercent above. Without this, a bad
    // denominator could demote a genuinely-complete milestone.
    !milestoneUnbounded &&
    typeof completedPhases === 'number' && Number.isFinite(completedPhases) &&
    typeof totalPhases === 'number' && Number.isFinite(totalPhases) &&
    totalPhases > 0 &&
    completedPhases < totalPhases
  ) {
    normalizedStatus = 'executing';
  }

  const fm: Record<string, unknown> = { gsd_state_version: '1.0' };

  if (milestone) fm['milestone'] = milestone;
  if (milestoneName) fm['milestone_name'] = milestoneName;
  if (currentPhase) fm['current_phase'] = currentPhase;
  if (currentPhaseName) fm['current_phase_name'] = currentPhaseName;
  if (currentPlan) fm['current_plan'] = currentPlan;
  fm['status'] = normalizedStatus;
  if (stoppedAt) fm['stopped_at'] = stoppedAt;
  if (pausedAt) fm['paused_at'] = pausedAt;
  fm['last_updated'] = realClock.nowIso();
  if (lastActivity) fm['last_activity'] = lastActivity;
  if (lastActivityDesc) fm['last_activity_desc'] = lastActivityDesc;
  // #2573: stamp the commit this STATE.md was written against, so consumers can
  // report how far the codebase has moved since. Omitted entirely outside a git
  // repo — an absent field reads as "unknown", which is the honest answer and
  // keeps every consumer's tri-state intact (see readStateHeadFreshness).
  const stateHead = readGitHeadSha(cwd);
  if (stateHead) fm['state_head'] = stateHead;

  const progress: Record<string, unknown> = {};
  if (totalPhases !== null) progress['total_phases'] = totalPhases;
  if (completedPhases !== null) progress['completed_phases'] = completedPhases;
  if (totalPlans !== null) progress['total_plans'] = totalPlans;
  if (completedPlans !== null) progress['completed_plans'] = completedPlans;
  if (progressPercent !== null) progress['percent'] = progressPercent;
  if (Object.keys(progress).length > 0) fm['progress'] = progress;

  return fm;
}

// ─── state_head commit provenance (#2573) ────────────────────────────────────
//
// STATE.md records the commit it was written against (`state_head`); consumers
// derive how many commits the codebase has moved since. This mirrors the shipped
// graphify commit-staleness contract (src/graphify.cts, #3170) rather than
// inventing a second vocabulary: `commits_behind` is a count, and `commit_stale`
// is TRI-STATE — null means "we don't know" (no git, no stamp, unresolvable
// commit), which is deliberately distinct from false ("known fresh").
//
// IMPORTANT — this is a freshness PROXY, never a drift measurement.
// `rev-list state_head..HEAD` counts every commit in between, including ones
// that never touched anything STATE.md describes. And because `state_head`
// restamps on EVERY state write, a low count means "something wrote STATE
// recently", NOT "STATE's content is accurate". Consumers must word it as
// approximate and must never gate on it.

/** Strict hash fence before any value from disk reaches a git argument. */
const STATE_HEAD_HASH_RE = /^[0-9a-f]{4,40}$/i;

/**
 * Resolve the project's current HEAD sha, or null when unavailable.
 * Bounded + non-interactive via execGit (10s timeout, GIT_TERMINAL_PROMPT=0);
 * a non-repo, missing git, or timeout degrades to null rather than throwing.
 */
/**
 * Does the project root carry its own git repository?
 *
 * #2573 D5. `git rev-parse HEAD` walks UP from cwd and stops at the FIRST
 * enclosing `.git`. So the repo that answered is the project's own exactly when
 * the project root itself carries a `.git` entry — a directory for a normal
 * clone, a file for a worktree or submodule, both of which `existsSync` accepts.
 * If it does not, the answer necessarily came from an ancestor repo and the
 * stamp would assert provenance the project cannot claim.
 *
 * Deliberately a filesystem-identity check rather than comparing
 * `--show-toplevel` against the project root as strings. That comparison is
 * unreliable across platforms — macOS resolves temp dirs through
 * `/private/var/…`, Windows adds 8.3 short names and separator/case variance —
 * and an over-strict compare degrades healthy projects to "unknown", which is
 * the very failure this check exists to prevent, inverted. No path spelling is
 * involved here at all.
 */
function projectOwnsItsRepo(projectRoot: string): boolean {
  try {
    return fs.existsSync(path.join(projectRoot, '.git'));
  } catch {
    return false;
  }
}

function readGitHeadSha(cwd: string | undefined): string | null {
  if (!cwd) return null;
  // #2573 degrade path D5. `git rev-parse HEAD` walks UP from cwd to the nearest
  // enclosing `.git`, and nothing pins that repo to the project. A GSD project
  // living inside an unrelated checkout — a dotfiles/notes repo, or the outer
  // workspace of a `planning.sub_repos` layout where all code commits land in
  // the sub-repos — would otherwise measure freshness against a repo it has no
  // relationship to, and report `commit_stale: false` ("known fresh") while
  // doing it. Unverified provenance must degrade to unknown, never to fresh.
  //
  // TWO independent conditions must hold before a stamp is trustworthy, and both
  // are checked below because either alone is insufficient:
  //   1. the project root owns a `.git` (else an ancestor repo answered), and
  //   2. the project is not a `sub_repos` workspace (else the repo that answers
  //      is the outer wrapper, whose HEAD does not move when the code does).
  // KNOWN LIMITATION, by design: in a `sub_repos` workspace this feature reports
  // unknown rather than measuring the children. Per-child freshness needs a
  // defined aggregate across N histories and is out of scope for this increment.
  //
  // `--show-toplevel HEAD` answers both in ONE spawn, so pinning costs no extra
  // subprocess on this path (the caller holds the STATE lock).
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot(cwd);
  } catch {
    return null; // cannot prove which repo would answer → unknown
  }
  if (!projectOwnsItsRepo(projectRoot)) return null;

  // #2573 D5, sub_repos flavor. Owning a `.git` is necessary but NOT sufficient.
  // In a `planning.sub_repos` workspace the outer directory can legitimately own
  // BOTH `.planning/` and its own repo while every code commit lands in a nested
  // child repo — `docs/CONFIGURATION.md` describes sub_repos as scoping work per
  // sub-repo "instead of treating the outer repo as a monorepo". The outer HEAD
  // then never advances, so `merge-base --is-ancestor` passes trivially and
  // `rev-list` counts 0: the stamp would report `commit_stale: false`, i.e.
  // "known fresh", while the code it describes has moved arbitrarily far.
  //
  // That is a WRONG answer, not a missing one, and it is the same invariant the
  // ancestor-repo check above exists to protect: a freshness claim the project
  // cannot substantiate must degrade to unknown, never to fresh. Measuring the
  // children instead would mean picking one HEAD out of N unrelated histories
  // (or inventing an aggregate), which is a design question beyond this
  // increment — so this scopes to the honest tri-state and declines to answer.
  // Deliberately keyed on the DECLARED config rather than probing the filesystem
  // for nested `.git` entries: the declaration is what the workspace asserts
  // about itself, and a probe would spuriously fire on a vendored dependency.
  try {
    const subRepos = (loadConfig(projectRoot) as { sub_repos?: unknown }).sub_repos;
    if (Array.isArray(subRepos) && subRepos.length > 0) return null;
  } catch {
    return null; // cannot read the layout → cannot claim provenance → unknown
  }

  const r = execGit(['rev-parse', 'HEAD'], { cwd });
  if (r.exitCode !== 0) return null;

  const sha = r.stdout.trim();
  return STATE_HEAD_HASH_RE.test(sha) ? sha : null;
}

interface StateHeadFreshness {
  /** The recorded stamp, short form, or null when absent/malformed. */
  state_head: string | null;
  /** Current HEAD, short form, or null outside a resolvable repo. */
  current_commit: string | null;
  /** Commits between the stamp and HEAD; null when either end is unknown. */
  commits_behind: number | null;
  /** Tri-state: null = unknown, false = known fresh, true = moved since. */
  commit_stale: boolean | null;
}

/**
 * Derive the commit-age freshness signal from a recorded `state_head`.
 *
 * Single source of truth for the derivation — `validate.health` (W024) and
 * smart-entry both consume this rather than re-deriving it, so the tri-state
 * and the hash fence cannot drift apart between surfaces.
 *
 * Never throws: every unresolvable input degrades to nulls.
 */
function readStateHeadFreshness(
  cwd: string | undefined,
  stateHead: unknown,
): StateHeadFreshness {
  const raw = (typeof stateHead === 'string' ? stateHead : '').trim();
  const stamp = STATE_HEAD_HASH_RE.test(raw) ? raw : null;
  const head = readGitHeadSha(cwd);

  let commitsBehind: number | null = null;
  let commitStale: boolean | null = null;
  if (stamp && head && cwd) {
    // The stamp must be an ANCESTOR of HEAD before a distance means anything.
    // `rev-list --count A..B` exits 0 with "0" when A is not reachable from B —
    // which is what a `reset --hard` to an earlier commit, a rebase or squash
    // that drops the stamped commit, or a force-push rewriting history all
    // produce. Without this guard those cases report `commit_stale: false`,
    // i.e. "known fresh", for a codebase that was actually rewound past the
    // stamp — collapsing the exact unknown-vs-fresh distinction this tri-state
    // exists to preserve. A non-ancestor stamp is UNKNOWN, so it stays null.
    const ancestry = execGit(['merge-base', '--is-ancestor', stamp, head], { cwd });
    if (ancestry.exitCode === 0) {
      const r = execGit(['rev-list', '--count', `${stamp}..${head}`], { cwd });
      if (r.exitCode === 0) {
        const n = parseInt(r.stdout.trim(), 10);
        if (Number.isFinite(n)) {
          commitsBehind = n;
          // #2573 D4 — deliberately RAW, not thresholded. `commit_stale` means
          // exactly what its contract says: the codebase has moved since the
          // stamp. Applying an advisory threshold here would make the field lie
          // at n < threshold, and W024 needs the true count to threshold on.
          // Alarm-fatigue is handled at the ALARMING surface, not the
          // derivation: W024 (the only user-visible consumer) fires at
          // STATE_HEAD_ADVISORY_COMMITS, which absorbs the `commit_docs: true`
          // off-by-one. Smart-entry re-exports the raw tri-state as advisory
          // JSON and is not consumed by classify().
          commitStale = n > 0;
        }
      }
    }
  }

  return {
    state_head: stamp ? stamp.slice(0, 7) : null,
    current_commit: head ? head.slice(0, 7) : null,
    commits_behind: commitsBehind,
    commit_stale: commitStale,
  };
}

/**
 * #3354: read `progress.total_phases` out of already-extracted STATE.md
 * frontmatter as a finite number, or null. Feeds buildStateFrontmatter's
 * milestoned-but-unbounded withhold so the stored total survives the write
 * instead of being clobbered by the on-disk phase-directory count.
 */
function readStoredTotalPhases(existingFm: Record<string, unknown> | null | undefined): number | null {
  if (!existingFm || typeof existingFm !== 'object') return null;
  const progress = existingFm['progress'];
  if (!progress || typeof progress !== 'object') return null;
  const raw = (progress as Record<string, unknown>)['total_phases'];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function syncStateFrontmatter(
  content: string,
  cwd: string | undefined,
  authoritativeFm?: Record<string, unknown>,
  sanctionedPermanentEmptyFallback?: boolean,
): string {
  // Read existing frontmatter BEFORE stripping — it may contain values
  // that the body no longer has (e.g., Status field removed by an agent).
  // `cwd` already identifies the workspace this content came from, so the STATE.md path is
  // derivable here without widening the signature (#1882).
  const existingFm = extractFrontmatter(
    content,
    cwd ? planningPaths(cwd).state : undefined,
  ) as Record<string, unknown>;

  // #3881 review, second round: an UNPARSEABLE frontmatter block (malformed YAML, a git
  // merge-conflict marker, a refused anchor) must never be silently REPLACED by a freshly
  // re-derived one — that destroys the only copy of what the block actually contained, with
  // no signal to the human that their document was in conflict. `beginFrontmatterReassembly`
  // (state-transition.cts) already preserves the raw fmPrefix through the pure transform
  // layer for every `transitionCore` kind; this was the gap — this function re-parses the
  // ALREADY-preserved `content` and, finding {} + the marker, rebuilt a fresh block anyway,
  // discarding the raw prefix the transform layer had just protected. Confirmed by execution
  // against `state complete-phase`/`update`/`patch`/`begin-phase`: each returned success with
  // the conflict markers gone and a freshly-derived, well-formed frontmatter block in their
  // place (re-derivation, not deletion — the document never lost its frontmatter FENCE).
  //
  // `sanctionedPermanentEmptyFallback` is threaded ONLY from `writeStateMd`, itself consumed
  // ONLY by `cmdStateSync` (#905) and `/gsd-health --repair`'s `REGENERATE_STATE` — ADR-3408
  // §8.3's CLOSED list of commands whose documented contract is "body wins, re-derive
  // unconditionally" (a factory reset / explicit resync). Those two are untouched here: this
  // guard fires only on the OTHER call path (`syncAndPreserveStateMd`, i.e. every
  // `readModifyWriteStateMd`-based command), where re-deriving over unparseable content was
  // never the intended contract in the first place — it was an unhandled gap, not a decision.
  if (!sanctionedPermanentEmptyFallback && isUnparseableFrontmatter(existingFm)) {
    return content;
  }

  const body = stripFrontmatter(content);
  // #3017: pass the stored milestone from the existing frontmatter so
  // buildStateFrontmatter scopes its disk scan to the correct milestone
  // instead of auto-deriving (and potentially mis-binding).
  const storedMilestone = typeof existingFm['milestone'] === 'string' ? existingFm['milestone'] : null;
  // #3354: also pass the stored total so buildStateFrontmatter's
  // milestoned-but-unbounded withhold can preserve it across the write
  // (the derived progress sub-block replaces the stored one wholesale below,
  // so an omitted key would otherwise DELETE the stored value).
  const derivedFm = buildStateFrontmatter(body, cwd, storedMilestone, readStoredTotalPhases(existingFm));

  // Preserve existing frontmatter status when body-derived status is 'unknown'.
  // This prevents a missing Status: field in the body from overwriting a
  // previously valid status (e.g., 'executing' → 'unknown').
  if (derivedFm['status'] === 'unknown' && existingFm['status'] && existingFm['status'] !== 'unknown') {
    derivedFm['status'] = existingFm['status'];
  }

  // Bug #948: preserve `milestone_name` / `milestone` when the derived value
  // is the template placeholder 'milestone'. getMilestoneInfo returns the
  // literal string 'milestone' when it cannot match the version from the roadmap
  // (e.g. no ROADMAP.md, roadmap lacks the heading for the stored version, or the
  // milestone version read from STATE.md itself triggers the lookup before the
  // file is fully written). A placeholder must never overwrite a real name that the
  // existing frontmatter already holds; only an empty derived value falls through
  // to this guard (the primary #905 preserve path below handles that).
  const MILESTONE_NAME_PLACEHOLDER = 'milestone';
  // #2135: widen the preserve guard. A bad derive is not always the literal
  // placeholder — getMilestoneInfo can return a delimiter-led fragment
  // ("— Active Milestone") when the roadmap regex mis-binds. Preserve the
  // existing curated name unless the derived value actually looks like a name:
  // non-empty, not the placeholder, and not punctuation-led.
  const derivedName = derivedFm['milestone_name'];
  const derivedLooksLikeName = typeof derivedName === 'string'
    && derivedName.length > 0
    && derivedName !== MILESTONE_NAME_PLACEHOLDER
    && !/^[\s—–:-]/.test(derivedName);
  if (
    !derivedLooksLikeName &&
    existingFm['milestone_name'] &&
    existingFm['milestone_name'] !== MILESTONE_NAME_PLACEHOLDER
  ) {
    derivedFm['milestone_name'] = existingFm['milestone_name'];
    // Keep the stored milestone version consistent with the preserved name.
    if (existingFm['milestone']) {
      derivedFm['milestone'] = existingFm['milestone'];
    }
  }

  // ADR-3408 §8.5 (D1): the six empty-only "#905" guards that used to live
  // here UNCONDITIONALLY are deleted for the write-seam pipeline
  // (`syncAndPreserveStateMd`, consumed by `readModifyWriteStateMd` and by
  // `cmdPhaseComplete`'s atomic-commit adapter). An empty derived value now
  // reaches `applyStatePreservation` unmolested, so the table-driven executor
  // — not a private copy inside this function — decides whether a curated
  // frontmatter value survives, and reports the decision via
  // `divergedFields` when it does. That was the actual D1 bug: these guards
  // ran BEFORE the executor ever saw the value, so a transform that
  // deliberately emptied a body line (delta CHANGED) lost silently — the
  // guard restored the stale frontmatter, the executor's own #1230 delta
  // check then found "already restored, nothing to do", and
  // `divergedFields` stayed empty even though a curated value had just won
  // over a genuine derived-empty.
  //
  // `writeStateMd`'s two callers — `cmdStateSync` and `/gsd-health --repair`'s
  // `REGENERATE_STATE` — are §8.3's closed, sanctioned-permanent exception
  // list: NEITHER ever runs `applyStatePreservation` afterward, because their
  // whole contract is "re-derive frontmatter FROM the body, body wins" (the
  // opposite of preservation). For them, these six conditions are the ONLY
  // mechanism that has ever kept a curated frontmatter value alive when the
  // body simply carries no annotation for a field at all (most STATE.md
  // files do not restate every field in body prose on every write) — losing
  // that would blank `current_phase_name` / `stopped_at` / etc. on every
  // `state sync`, which is a regression, not this phase's fix: `state sync`'s
  // output must stay byte-identical (ADR-3408 §8.3 Amendment 2). So the same
  // six conditions are kept, verbatim, but now gated behind the explicit
  // `sanctionedPermanentEmptyFallback` parameter — threaded ONLY from
  // `writeStateMd` — instead of running unconditionally or being duplicated
  // as a second private copy. This is still ONE enforcement point: the six
  // conditions exist in exactly one place in the source, selected by caller
  // identity per the closed §8.3 exception list, never re-derived elsewhere.
  //
  // The disagreeing case (a present-but-stale body value vs a fresher
  // frontmatter value, #948/#3374/§8.5) was never handled here even before
  // this change: it is governed by applyStatePreservation's
  // preserve-when-unchanged delta, applied post-sync by the shared
  // applyPostSyncPreservation pass.
  if (sanctionedPermanentEmptyFallback) {
    if (!derivedFm['stopped_at'] && existingFm['stopped_at']) {
      derivedFm['stopped_at'] = existingFm['stopped_at'];
    }
    if (!derivedFm['paused_at'] && existingFm['paused_at']) {
      derivedFm['paused_at'] = existingFm['paused_at'];
    }
    if (!derivedFm['current_phase'] && existingFm['current_phase']) {
      derivedFm['current_phase'] = existingFm['current_phase'];
    }
    if (!derivedFm['current_phase_name'] && existingFm['current_phase_name']) {
      derivedFm['current_phase_name'] = existingFm['current_phase_name'];
    }
    if (!derivedFm['current_plan'] && existingFm['current_plan']) {
      derivedFm['current_plan'] = existingFm['current_plan'];
    }
    // progress is a sub-object: fall back to existing only when the
    // body+disk scan produced NO progress block at all. When
    // buildStateFrontmatter did derive a progress block (even a lower one),
    // that derived value wins — the shouldPreserveExistingProgress
    // cross-milestone logic is applied later in cmdStateJson on the read
    // path where it is appropriate.
    if (!derivedFm['progress'] && existingFm['progress']) {
      derivedFm['progress'] = normalizeProgressNumbers(existingFm['progress']);
    }
  }

  // #2202: carry forward any existing frontmatter key that the schema does not
  // own, so custom/unknown keys are not silently dropped on every mutating verb.
  // Schema-owned keys (already in derivedFm from buildStateFrontmatter + the
  // sanctioned-permanent guards above, when they ran) still win.
  for (const key of Object.keys(existingFm)) {
    if (key in derivedFm || existingFm[key] === undefined) continue;

    // #2573: a `source: 'free'` field is the writer's word on every write and
    // carries no preservation (see the FieldSource doc). When buildStateFrontmatter
    // omits it — `state_head` outside a git repo, per its `if (stateHead)` guard —
    // carrying the old value forward would re-assert provenance the file no longer
    // has: a stale state_head would claim STATE.md was written against a commit it
    // wasn't, contradicting its own ADR-1769 row.
    //
    // Narrow the skip to `source: 'free'`, NOT every `derive` row. `last_activity`
    // ({source:'body'}) and the `progress.*` rows ({source:'disk'}) are also
    // `derive`, but they are body/disk-sourced and MUST still carry forward when
    // the writer omits them this pass — dropping `last_activity` here is silent
    // frontmatter data loss and would defeat #2570's staleness fix downstream.
    // `last_updated` and `gsd_state_version` are the only other `free` rows and are
    // both produced unconditionally by buildStateFrontmatter, so this loop never
    // reaches them; `state_head` is the sole field the skip governs. Consult the
    // table rather than naming fields, so the policy stays single-sourced.
    const classification = stateTransitionMod.getFieldClassification(key);
    if (classification && classification.source === 'free') continue;

    // ADR-3408 §8.1/§8.5 (D1 follow-on — found by probe, not predicted by the
    // design): a `preserve-when-unchanged` / `preserve-always` field must be
    // decided ONLY by `applyStatePreservation` — the single enforcement point
    // — never by this generic carry-forward, on the write-seam path. Before
    // the six sanctioned-permanent guards above were gated behind
    // `sanctionedPermanentEmptyFallback` (D1), this loop's `key in derivedFm`
    // check was effectively always true for a field the guards had already
    // restored, so this branch was unreachable for it and the distinction
    // never mattered. With the guards now OFF on the write-seam path,
    // `derivedFm` genuinely lacks the key when the body carries no
    // annotation — and without this skip, this loop silently resurrects the
    // exact stale value the executor's delta rule (§8.5 Row 2) just decided
    // to discard, re-introducing the D1 bug through a second, unrelated code
    // path (confirmed live: an A5-shaped probe restored `current_phase_name`
    // via THIS loop even with the six guards deleted).
    //
    // Gated to the write-seam path ONLY (`!sanctionedPermanentEmptyFallback`)
    // — `writeStateMd`'s two sanctioned-permanent callers never run
    // `applyStatePreservation` at all, so unconditionally skipping here would
    // blank fields this loop has always carried forward for them (e.g.
    // `last_activity_desc`, which was never one of the six explicit guards
    // above but relied on THIS loop for its empty-case fallback), breaking
    // `state sync`'s required byte-identical output for a field D1 never
    // named. On the write-seam path this executor-only rule genuinely widens
    // beyond the original six fields (e.g. also covers `last_activity_desc`)
    // — a deliberate, in-scope consequence of "one enforcement point", not a
    // separate defect.
    if (
      !sanctionedPermanentEmptyFallback &&
      classification &&
      (classification.preservation === 'preserve-when-unchanged' || classification.preservation === 'preserve-always')
    ) continue;

    derivedFm[key] = existingFm[key];
  }

  // #2567: guard the information-losing direction — a stale archive
  // "Last activity:" line must not overwrite a newer frontmatter value.
  preferNewerLastActivity(existingFm, derivedFm);

  // #2736: intent-first override, applied last. A transition adapter that
  // already holds the exact value (completePhase's next-phase display name,
  // beginPhase's phase name) passes it here, so the body-prose re-derivation
  // above — which is lossy by construction for names containing a
  // parenthetical (`Closer-ruling measurement (D1a)` → `D1a`) — never runs
  // the final word on a field the transition just resolved. The prose parser
  // remains the fallback for genuinely unknown prose only.
  if (authoritativeFm) {
    for (const [key, value] of Object.entries(authoritativeFm)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        derivedFm[key] = value;
      }
    }
  }

  // #3257: propagate full-line frontmatter comments from the extracted source onto the
  // rebuilt derivedFm (buildStateFrontmatter + the Object.keys carry-forward above both
  // skip the Symbol-keyed channel, so without this the comments would be lost here even
  // though parseGuardedYamlRegion/reconstructFrontmatter preserve them in isolation).
  propagateCommentChannel(existingFm as unknown as Frontmatter, derivedFm as unknown as Frontmatter);

  const yamlStr = reconstructFrontmatter(derivedFm as unknown as Frontmatter);
  return `---\n${yamlStr}\n---\n\n${body}`;
}

// Transient errno codes that indicate a temporary filesystem condition under
// concurrent O_EXCL races — Docker overlay-fs (ENOENT/EINVAL/EIO), NFS
// (ESTALE), and OS-level interrupt/retry signals (EAGAIN/EINTR).  These are
// recoverable; acquireStateLock retries instead of propagating them.
// Truly fatal codes (EMFILE, ENOSPC, EROFS, EACCES) are NOT in this set and
// will still throw immediately.
const ACQUIRE_LOCK_RETRY_ERRNOS = new Set([
  'EPERM',   // Windows / macOS AV scanner holds the file open during delete
  'EBUSY',   // Windows: file in use by another process
  'EAGAIN',  // POSIX: resource temporarily unavailable
  'EINTR',   // POSIX: syscall interrupted by signal
  'EINVAL',  // Docker overlay-fs: transient during concurrent O_EXCL creation
  'EIO',     // Docker overlay-fs / NFS: transient I/O error
  'ENOENT',  // Docker overlay-fs: parent dir transiently missing during race
  'ESTALE',  // NFS: stale file handle (self-resolves on retry)
]);

/**
 * Acquire a lockfile for STATE.md operations.
 * Returns the lock path for later release.
 *
 * @param statePath
 * @param clock
 *   Optional clock seam for testing. Defaults to realClock (Date.now + Atomics.wait).
 *   Pass a fake clock from tests/helpers/clock.cjs to drive timeout/stale logic
 *   without real wall-clock waits.
 */
function acquireStateLock(statePath: string, clock?: StateLockClock): string {
  if (clock === undefined) clock = realClock;
  const lockPath = statePath + '.lock';
  const retryDelay = 200; // ms
  const maxWaitMs = 30000;
  // Deadman ceiling (audit M1) — set ABOVE maxWaitMs so a holder that reads as
  // VERIFIED-LIVE is NEVER stolen within the wait budget; only a crashed (dead
  // pid) or unparseable-body lock is stolen, and a pid-reuse holder (reads alive
  // but is unrelated) is recovered once age crosses this absolute ceiling rather
  // than blocking forever. The prior mtime-only `staleThresholdMs = 10000` gate
  // was BELOW maxWaitMs, so a live-but-slow holder >10 s was robbed mid-write.
  const deadmanCeilingMs = 60000;
  // Fresh-create floor (PR #1532 review, window a) — a lock with an EMPTY/unparseable
  // body is either mid-creation (O_EXCL create done, pid not yet written by the holder)
  // or a genuine orphan. While such a body is younger than this floor it is treated as
  // mid-creation and is NEVER stolen — stealing it at age ≈ 0 robs a holder still
  // writing its pid (the lost-update window capability-lock.cts's `age <= LOCK_STALE_MS`
  // floor closes). The create→write gap is sub-millisecond; this floor is orders of
  // magnitude larger yet well under maxWaitMs so a real orphan still clears within budget.
  // A COMPLETE dead-pid body is NOT subject to this floor — it is stolen promptly.
  const freshCreateFloorMs = 1000;
  const startedAt = clock.now();

  // Shared helper: check the time budget then back off with jitter before the
  // next retry.  Both the EEXIST contention path and the recoverable-errno path
  // must go through this so neither can busy-spin (#1217).
  const checkBudgetAndSleep = (context: string) => {
    if (clock.now() - startedAt >= maxWaitMs) {
      const e = new Error(
        'acquireStateLock: ' + lockPath + ' ' + context + ' for ' +
        (clock.now() - startedAt) + 'ms (exceeded ' + maxWaitMs + 'ms budget)'
      );
      (e as unknown as Record<string, unknown>).lockBudgetExceeded = true;
      throw e;
    }
    const jitter = Math.floor(Math.random() * 50);
    clock.sleep(retryDelay + jitter);
  };

  let _loopIteration = 0;
  while (true) {
    if (_stateLockTestHooks.onLoopIteration) _stateLockTestHooks.onLoopIteration({ iteration: _loopIteration++ });
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      // Audit M9 (resource-safety): once the exclusive create SUCCEEDS, a
      // writeSync/closeSync failure must NOT leak the fd or strand the just-created
      // (now empty) lock — an orphan body self-blocks every later acquirer until a
      // liveness steal or the deadman. On any write/close error, guardedly close the
      // fd and unlink the file we created, then re-throw to the existing outer catch
      // (which keeps classifying recoverable vs fatal errnos — DRY). A FATAL errno
      // still propagates after cleanup; a RECOVERABLE one retries from a clean slate.
      // Mirrors capability-lock.cts:415-425.
      try {
        const injected = _consumeSimulatedWriteError();
        if (injected) throw injected; // test seam: one-shot writeSync failure (M9)
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* best-effort — fd may already be closed */ }
        // Best-effort unlink of the lock WE just created. Guarded so we never throw
        // here; if another acquirer already stole the empty lock the unlink is a
        // harmless ENOENT no-op (we do not double-unlink someone else's lock — the
        // open(O_EXCL) above guarantees we created this path this iteration).
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw writeErr; // re-throw to the outer catch for recoverable/fatal classification
      }
      // Exit-time cleanup keeps a crashed locked region from leaving a stale file (#1916).
      _heldStateLocks.add(lockPath);
      return lockPath;
    } catch (err) {
      // Transient filesystem errors (Docker overlay-fs, NFS, OS signals, AV scanners)
      // are recoverable — retry with the same budget + backoff as the EEXIST path so
      // a permanently-failing errno cannot busy-spin at 100% CPU (#1217).
      // See ACQUIRE_LOCK_RETRY_ERRNOS for the full list and rationale.
      if (ACQUIRE_LOCK_RETRY_ERRNOS.has((err as NodeJS.ErrnoException).code as string)) {
        checkBudgetAndSleep((err as NodeJS.ErrnoException).code + ' persisted');
        continue;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // propagate — silent bypass causes lost updates
      // Liveness-gated steal (audit M1) + steal-safety (PR #1532 review). The steal
      // decision is four-way on the lock body (#3057 B2 added the fourth):
      //   - VERIFIED-LIVE holder (parseable pid that signals alive): NEVER stolen until
      //     its age crosses the absolute deadman ceiling (the pid-reuse backstop) —
      //     nuking a slow-but-live writer's lock causes lost updates (#3711 / #500/#905/
      //     #1230 family).
      //   - COMPLETE DEAD pid (parseable pid, not alive): stolen PROMPTLY regardless of
      //     age — a crashed holder left a full body.
      //   - UNREADABLE body (I/O fault reading the file): NOT the same as empty — we
      //     have no evidence this is a fresh create window, only that we could not read
      //     it. Held to the SAME conservative ceiling as a verified-live holder rather
      //     than the short fresh-create floor, so a transient read fault can never rob
      //     an active holder the way stealing at 1s would.
      //   - EMPTY / unparseable body (body WAS read, and holds no valid pid): liveness is
      //     unknowable. While FRESH (age <= freshCreateFloorMs) it is a lock still
      //     mid-creation (O_EXCL done, pid not yet written) and is NOT stolen (window a);
      //     only once aged past the floor is it a genuine orphan and stealable.
      // The steal itself is an ATOMIC rename-then-recreate (only one racer can rename the
      // inode) guarded by an identity re-confirm, so a racer that recreates a fresh lock
      // in the decision→steal gap never has its replacement deleted (window b). Mirrors
      // capability-lock.cts:455-499.
      try {
        const stat = fs.statSync(lockPath);
        const ageMs = clock.now() - stat.mtimeMs;
        const bodyStatus = _stateLockBodyStatus(lockPath);
        const bodyPid = bodyStatus.kind === 'pid' ? bodyStatus.pid : null;
        const holderLive = bodyPid !== null && _stateLockIsPidAlive(bodyPid);
        let steal: boolean;
        if (holderLive) {
          steal = ageMs > deadmanCeilingMs;   // pid-reuse backstop only
        } else if (bodyPid !== null) {
          steal = true;                       // complete dead pid → prompt steal
        } else if (bodyStatus.kind === 'unreadable') {
          steal = ageMs > deadmanCeilingMs;   // I/O fault ≠ known-fresh — do not grant the short floor
        } else {
          steal = ageMs > freshCreateFloorMs; // empty/garbage → protect the create window
        }
        if (steal) {
          if (_stateLockTestHooks.beforeSteal) _stateLockTestHooks.beforeSteal({ lockPath });
          // Identity re-confirm immediately before the steal: a racer that stole +
          // recreated a fresh lock in the decision→steal gap changes (dev, ino) and/or
          // the body pid → do NOT delete the replacement; re-evaluate from scratch.
          let confirmStat: fs.Stats;
          try {
            confirmStat = fs.statSync(lockPath);
          } catch {
            continue; // lock vanished between decision and steal — retry the create.
          }
          const sameInstance =
            typeof stat.dev === 'number' && typeof stat.ino === 'number' &&
            confirmStat.dev === stat.dev && confirmStat.ino === stat.ino &&
            _stateLockBodyPid(lockPath) === bodyPid;
          if (!sameInstance) {
            // The lock changed under us (a racer won the steal + recreated). Back off
            // and re-evaluate rather than deleting the racer's fresh replacement.
            checkBudgetAndSleep('lock changed before steal');
            continue;
          }
          // Atomic steal: rename the inode aside, then remove it. Only ONE racer can
          // win the rename; a failed rename means another process already stole it, so
          // we must NOT fall through to a delete — back off and retry the create.
          const stolen = lockPath + '.stale-' + process.pid + '-' + clock.now() + '-' + (_stateStealSeq++);
          let renamed = false;
          try { retryRenameSync(lockPath, stolen); renamed = true; } catch { /* another racer won */ }
          if (renamed) {
            try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
            // Successful steal — retry immediately to grab the just-freed lock.
            // Must NOT call checkBudgetAndSleep here: a throw-after-rename would
            // corrupt filesystem state, and the budget is already bounded on the next
            // iteration's EEXIST or open attempt (#1217 regression fix).
            continue;
          }
          // Lost the steal race (or a transient rename failure) — apply budget + backoff
          // so it cannot busy-spin (#1217).
          checkBudgetAndSleep('stale lock steal lost to racer');
          continue;
        }
      } catch (err) {
        // Re-throw a budget-exceeded error from the steal path above unchanged — its
        // message already names the real cause ("lock changed before steal" / "stale
        // lock steal lost to racer") and double-wrapping it would replace that with the
        // misleading "statSync failed after EEXIST" context string (#1217 diagnostic fix).
        if ((err as Record<string, unknown>)?.lockBudgetExceeded) throw err;
        // statSync failed — lock was likely released between our EEXIST and this
        // stat call.  Apply budget + backoff so a persistent statSync failure
        // cannot busy-spin (#1217).
        checkBudgetAndSleep('statSync failed after EEXIST');
        continue;
      }
      checkBudgetAndSleep('held by live process');
    }
  }
}

function releaseStateLock(lockPath: string): void {
  _heldStateLocks.delete(lockPath);
  try { fs.unlinkSync(lockPath); } catch { /* lock already gone */ }
}

function withStateLock<T>(statePath: string, fn: () => T): T {
  const lockPath = acquireStateLock(statePath);
  try {
    return fn();
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * Write STATE.md with synchronized YAML frontmatter.
 * All STATE.md writes should use this instead of raw writeFileSync.
 * Uses a simple lockfile to prevent parallel agents from overwriting
 * each other's changes (race condition with read-modify-write cycle).
 *
 * @param statePath
 * @param content
 * @param cwd
 * @param clock
 *   Optional clock seam; defaults to realClock. Passed through to acquireStateLock.
 */
/**
 * ADR-3473 §8.6: `writeStateMd` is ADR-3408 §8.3's sanctioned-exception write
 * path — only a `rebuildStateTransaction` may travel it. Enforced here rather
 * than left to caller discipline: the transaction TYPE is what makes the two
 * sanctioned exceptions (`cmdStateSync`, `REGENERATE_STATE`) greppable and
 * closed, and an `open()` transaction reaching this function would mean a
 * preservation-governed write silently skipped preservation.
 */
function writeStateMd(statePath: string, content: string, transaction: StateTransaction, cwd?: string, clock?: StateLockClock): void {
  if (transaction.kind !== 'rebuild') {
    const err = new Error(
      `writeStateMd: expected a 'rebuild' transaction, got '${transaction.kind}'. writeStateMd is ` +
      'ADR-3408 §8.3\'s sanctioned-exception write path (cmdStateSync / REGENERATE_STATE only) — ' +
      'only rebuildStateTransaction() may travel it (ADR-3473 §8.6). An open() transaction here ' +
      'would silently skip preservation for a write that was supposed to run it.',
    ) as Error & { code: string };
    err.code = 'STATE_TRANSACTION_KIND_INVALID';
    throw err;
  }
  const lockPath = acquireStateLock(statePath, clock);
  // Test seam (audit M8): fire AFTER the lock is taken so a test can simulate a
  // concurrent writer landing in the (now-closed) scan→lock window.
  if (_stateLockTestHooks.afterAcquire) _stateLockTestHooks.afterAcquire(lockPath);
  try {
    // Audit M8 (leaky-abstractions): the disk scan that counts PLAN/SUMMARY files
    // to build the frontmatter is the READ half of this read-modify-write — it must
    // run INSIDE the lock (mirroring readModifyWriteStateMd), not before it. Scanning
    // before acquireStateLock left a TOCTOU window where a concurrent writer that
    // committed a new PLAN/SUMMARY between our scan and our lock made writeStateMd
    // stamp STALE progress counts (lost update — the #500/#905/#1230 family). The
    // scan order is otherwise byte-for-behaviour identical for single-threaded
    // callers — only the concurrent-writer window closes.
    //
    // Invalidate the disk scan cache first — the write may create new PLAN/SUMMARY
    // files that buildStateFrontmatter must see (#1967).
    if (cwd) _diskScanCache.delete(cwd);
    // ADR-3408 §8.3: `writeStateMd` is the sole write path for the two
    // sanctioned-permanent exceptions (`cmdStateSync`, `REGENERATE_STATE`) —
    // the sanctioned-permanent empty-field fallback is now DERIVED FROM THE
    // TRANSACTION KIND (ADR-3473 §8.6) rather than asserted by a literal
    // `true` at this call site: only a `rebuild` transaction can reach this
    // function (enforced above), so `transaction.kind === 'rebuild'` is
    // always `true` here today, but the derivation is what keeps the
    // fallback's scope tied to the transaction type rather than a
    // hard-coded constant that could silently drift from it.
    const synced = syncStateFrontmatter(content, cwd, undefined, transaction.kind === 'rebuild');
    platformWriteSync(statePath, synced);
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * #3374: the shared post-sync preservation pass — the pre/post body-source
 * snapshot + table-driven `applyStatePreservation` + #2736 authoritative
 * re-assert sequence. Extracted from readModifyWriteStateMd so
 * `cmdPhaseComplete`'s atomic-commit adapter (phase.cts) — which syncs
 * STATE.md directly because it is committed atomically with
 * ROADMAP/REQUIREMENTS and so cannot go through the RMW wrapper — applies the
 * identical policy instead of a second, weaker encoding. Previously the
 * adapter had no preservation at all, letting a stale body `Stopped at:` line
 * silently clobber a fresher frontmatter `stopped_at` on every phase
 * completion (#3374 Variant A).
 *
 * NOT applied on the writeStateMd path: `state sync`'s contract is the
 * opposite by design (#905 — "body annotation beats existing frontmatter when
 * both are present": sync exists to re-derive frontmatter from the body), so a
 * blanket preservation pass there re-locks stale frontmatter. The
 * milestone-complete equivalent of the #3374 exposure is tracked as a
 * follow-up (see PR #3491 / the closed PR #3442 review's MAJOR finding).
 *
 * `originalContent` is the pre-write on-disk content (drives the #1230
 * pre-snapshots), `transformedContent` is the post-transform content (the
 * sync only rewrites the frontmatter block, so its body IS the post-write
 * body), and `syncedContent` is what `syncStateFrontmatter` produced.
 */
/**
 * #3471 Fix: `StatePreservationOptions` is silently mis-consumable by any
 * non-TypeScript caller — `tsc` only type-checks src/, so a plain-.cjs test
 * (or any future JS caller) can pass a boolean where this options object
 * goes and both functions below would previously proceed with `resync`,
 * `authoritativeFm`, `deriveProgressKeys`, and `divergedFields` all
 * `undefined`, degrading to a well-formed-looking but silently-empty
 * `divergedFields: []` — exactly the "stale but present" failure shape
 * ADR-3408 exists to remove. This is a contract assertion (caller-shape
 * only), not field-level validation — mirrors `throwUnwiredRow`'s
 * structured-error shape in src/state-transition.cts.
 */
function assertStatePreservationOptions(options: unknown, caller: string): asserts options is StatePreservationOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    const err = new Error(
      `${caller}: options argument must be a StatePreservationOptions object, got ${typeof options === 'object' ? 'array/null' : typeof options}. ` +
      'This function takes a single options object as its final ' +
      'parameter, not positional resync/authoritativeFm/deriveProgressKeys/divergedFields arguments (#3471).',
    ) as Error & { code: string; receivedType: string };
    err.code = 'STATE_PRESERVATION_OPTIONS_INVALID';
    err.receivedType = Array.isArray(options) ? 'array' : typeof options;
    throw err;
  }
}

function applyPostSyncPreservation(
  originalContent: string,
  transformedContent: string,
  syncedContent: string,
  statePath: string,
  options: StatePreservationOptions,
): string {
  assertStatePreservationOptions(options, 'applyPostSyncPreservation');
  const { resync, authoritativeFm, deriveProgressKeys, divergedFields, explicitProgressField, preWriteState } = options;

  // Bug #1230: delta heuristic — snapshot pre-transform body source fields so
  // we can detect whether THIS write changed them. syncStateFrontmatter
  // re-derives frontmatter status/stopped_at from the body on every write;
  // when the body's source field was NOT changed by the transform, the
  // existing frontmatter value (e.g. a hand-set 'completed') must win over
  // the body-derived value (e.g. 'verifying' from a stale "Status: Verifying
  // Phase 3" line that an earlier tool wrote). We do NOT disturb `preFm`
  // above (null when resync:true) — these are independent snapshots.
  // Strip frontmatter before calling stateExtractField so the YAML `status:`
  // key in the frontmatter block cannot shadow the body field we are tracking.
  const preFmSnapshot = extractFrontmatter(originalContent, statePath) as Record<string, unknown>;

  // #3881 review, second round: `syncStateFrontmatter` above already declines to re-derive
  // over an UNPARSEABLE original frontmatter block (its own matching guard), so `syncedContent`
  // here is `transformedContent` verbatim. But this function's own downstream preservation
  // machinery (`applyStatePreservation` + the `authoritativeFm` reassertion below) reads
  // `postFm = extractFrontmatter(syncedContent, ...)` — {} + the marker, since the block still
  // doesn't parse — restores curated fields from `transaction.snapshot`, and reconstructs a
  // FRESH frontmatter block from the result, destroying the raw block a second time even
  // though `syncStateFrontmatter` just finished protecting it. `applyPostSyncPreservation` is
  // reached ONLY via the non-sanctioned path (`syncAndPreserveStateMd`; `writeStateMd`'s two
  // ADR-3408 §8.3 closed-list callers — `cmdStateSync` #905 and `/gsd-health --repair`'s
  // `REGENERATE_STATE` — never call it at all), so this guard needs no extra parameter to stay
  // scoped off that list. Confirmed by execution: `state begin-phase` on a conflict-marked
  // STATE.md reached exactly this second clobber even after the `syncStateFrontmatter` fix.
  if (isUnparseableFrontmatter(preFmSnapshot)) {
    return transformedContent;
  }

  const preBody = stripFrontmatter(originalContent);
  const preBodyStatus = stateExtractField(preBody, 'Status');
  // Bug #1230 / Change B: scope stopped_at delta to the ## Session section,
  // mirroring buildStateFrontmatter's sessionBodyScope logic.
  // A stale "Stopped at:" in a non-Session section (e.g. Session Continuity
  // Archive prose) must not interfere with the delta comparison.
  const preSessionMatch = matchSessionSection(preBody);
  const preSessionScope = preSessionMatch ?? preBody;
  const preBodyStoppedAt = stateExtractField(preSessionScope, 'Stopped At') || stateExtractField(preSessionScope, 'Stopped at');

  // ADR-1769 Phase 6 / #1743 / #1695: snapshot the body source for the curated
  // current_phase_name (the `Phase:` line parseProsePhaseField harvests). When
  // this write does NOT change that line, the curated frontmatter value must
  // win over syncStateFrontmatter's body re-derivation (which can harvest a
  // wrong parenthetical aside — #1695). Gated by the field-classification
  // table's preserve-always row so the rule lives in one place.
  const preBodyPhaseSource = stateExtractField(preBody, 'Phase');

  // #3258: snapshot the body sources for the additional preserve-when-unchanged
  // rows applyStatePreservation now honors (last_activity_desc, paused_at,
  // current_phase, current_plan). Each mirrors buildStateFrontmatter's
  // derivation so the #1230 delta ("did THIS write change the source?") is
  // accurate: current_phase combines `Current Phase` with the prose `Phase:`
  // fallback (parseProsePhaseField, scoped to ## Current Position); paused_at
  // is session-scoped (mirrors stopped_at); last_activity_desc combines the
  // `Last Activity Description` field with the prose desc fallback.
  const preCurrentPositionScope = matchCurrentPositionSection(preBody) ?? preBody;
  const preBodyCurrentPlan = stateExtractField(preBody, 'Current Plan');
  const preBodyCurrentPhase = stateExtractField(preBody, 'Current Phase')
    ?? parseProsePhaseField(stateExtractField(preCurrentPositionScope, 'Phase')).phase;
  const preBodyPausedAt = stateExtractField(preSessionScope, 'Paused At');
  const preBodyLastActivityRaw = stateExtractField(preBody, 'Last Activity')
    ?? stateExtractField(preBody, 'Last activity');
  const preBodyLastActivityDesc = stateExtractField(preBody, 'Last Activity Description')
    ?? parseProseLastActivityField(preBodyLastActivityRaw).description;

  // Post-transform body source fields used for the delta comparison (#1230).
  // Use `transformedContent` (not `syncedContent`): syncStateFrontmatter only
  // rewrites the frontmatter block, so the body is identical in both — and we
  // need the body the transform produced. Strip frontmatter so the YAML
  // status key cannot shadow the body field we are tracking.
  const postBody = stripFrontmatter(transformedContent);
  const postBodyStatus = stateExtractField(postBody, 'Status');
  // Bug #1230 / Change B: scope stopped_at delta to the ## Session section,
  // consistent with the pre-transform snapshot above and buildStateFrontmatter.
  const postSessionMatch = matchSessionSection(postBody);
  const postSessionScope = postSessionMatch ?? postBody;
  const postBodyStoppedAt = stateExtractField(postSessionScope, 'Stopped At') || stateExtractField(postSessionScope, 'Stopped at');
  // ADR-1769 Phase 6 / #1695: post-transform body Phase source for the
  // current_phase_name delta comparison.
  const postBodyPhaseSource = stateExtractField(postBody, 'Phase');
  // #3258: post-transform body sources for the preserve-when-unchanged rows
  // added in #3258 (mirrors the pre-transform block above).
  const postCurrentPositionScope = matchCurrentPositionSection(postBody) ?? postBody;
  const postBodyCurrentPlan = stateExtractField(postBody, 'Current Plan');
  const postBodyCurrentPhase = stateExtractField(postBody, 'Current Phase')
    ?? parseProsePhaseField(stateExtractField(postCurrentPositionScope, 'Phase')).phase;
  const postBodyPausedAt = stateExtractField(postSessionScope, 'Paused At');
  const postBodyLastActivityRaw = stateExtractField(postBody, 'Last Activity')
    ?? stateExtractField(postBody, 'Last activity');
  const postBodyLastActivityDesc = stateExtractField(postBody, 'Last Activity Description')
    ?? parseProseLastActivityField(postBodyLastActivityRaw).description;
  // #3468: single channel for every preserve-when-unchanged row. Before this
  // change, seven body-source pre/post pairs travelled in two different
  // shapes — this map for four fields, six dedicated parameters
  // (preBodyStatus/postBodyStatus, preBodyStoppedAt/postBodyStoppedAt,
  // preBodyPhaseSource/postBodyPhaseSource) for the other three — same data,
  // same purpose, which is exactly why applyStatePreservation needed a
  // hand-written branch per field instead of one loop over the table. Every
  // row FIELD_CLASSIFICATION declares preserve-when-unchanged MUST appear
  // here — an omission now throws (STATE_PRESERVATION_UNWIRED_ROW, ADR-3408
  // §8.2) at the first write rather than becoming a quiet preservation bug.
  // Note current_phase_name's source is the body `Phase:` line, deliberately
  // a DIFFERENT source from current_phase's: the key names the field the
  // policy GUARDS, not the body field it reads.
  const bodyDeltas = {
    last_activity_desc: { pre: preBodyLastActivityDesc, post: postBodyLastActivityDesc },
    paused_at: { pre: preBodyPausedAt, post: postBodyPausedAt },
    current_phase: { pre: preBodyCurrentPhase, post: postBodyCurrentPhase },
    current_plan: { pre: preBodyCurrentPlan, post: postBodyCurrentPlan },
    status: { pre: preBodyStatus, post: postBodyStatus },
    stopped_at: { pre: preBodyStoppedAt, post: postBodyStoppedAt },
    current_phase_name: { pre: preBodyPhaseSource, post: postBodyPhaseSource },
    // ADR-3473 §8.7 (#3872): `last_activity` is the one `FRONTMATTER_BODY_SOURCE`
    // key that is NOT `preserve-when-unchanged` (it is `derive` — always
    // re-stamped from the body) and so was never part of this map before.
    // Added ONLY for `reconcileReportedFields`'s consumption below (via
    // `preWriteState.bodyDeltas`) — harmless here, since
    // `applyPreserveWhenUnchanged` is dispatched by
    // `getPreserveWhenUnchangedFields()`, never by iterating this object's
    // keys, so an extra non-preserve-when-unchanged entry changes no
    // preservation behavior.
    last_activity: { pre: preBodyLastActivityRaw, post: postBodyLastActivityRaw },
  };

  // ADR-1769 #1796 (Path A — finish the consolidation): the post-sync
  // preservation block is now the pure, table-driven `applyStatePreservation`
  // in the STATE.md Transition Module. progress / status / stopped_at /
  // current_phase_name are all governed by their FIELD_CLASSIFICATION row —
  // one policy source, not three drifting encodings. #3258 extends the same
  // pass to last_activity_desc / paused_at / current_phase / current_plan
  // (preserve-when-unchanged) and milestone / milestone_name (preserve-if-
  // placeholder). Behavior-identical to the pre-#1796 inline block for the
  // original four fields; this is the absorption ADR-1769 / CONTEXT.md
  // already claimed shipped.
  const postFm = extractFrontmatter(syncedContent, statePath) as Record<string, unknown>;
  // #3469 (ADR-3408 §8.5): snapshot the freshly-synced (pre-preservation)
  // frontmatter so a caller that wants visibility into "did preservation
  // restore a curated value over a disagreeing derived one" can diff against
  // it via the optional `divergedFields` out-param below. Additive only:
  // callers that omit it (readModifyWriteStateMd, cmdPhaseComplete) pay
  // nothing extra and see no change to `synced`/the returned content.
  const preservationInputSnapshot = divergedFields ? { ...postFm } : null;
  // ADR-3473 §8.6: the pre-write snapshot + policy flags now travel as ONE
  // transaction rather than as a nullable `preFm` alongside the always-present
  // `preFmSnapshot` (same source, same extractFrontmatter call — `preFm` was
  // `preFmSnapshot` with the `resync` policy baked in by nulling it, which is
  // what made `applyPreserveAlways` inert on the default resyncing write
  // path — #3756).
  const transaction = stateTransitionMod.openStateTransaction({
    snapshot: preFmSnapshot,
    resync,
    deriveProgressKeys: deriveProgressKeys === true,
    bodyDeltas,
    explicitProgressField: explicitProgressField === true,
  });
  // ADR-3473 §8.7 (#3872): fill the caller's out-param with the TRANSACTION'S
  // OWN snapshot object (not a second `extractFrontmatter(originalContent)`
  // derivation — `transaction.snapshot === preFmSnapshot`, reusing it is the
  // whole point) plus the pre-write body, so `reconcileReportedFields` can
  // diff persisted-vs-pre-write instead of re-deriving either side itself.
  if (preWriteState) {
    preWriteState.fm = transaction.snapshot;
    preWriteState.body = preBody;
    // ADR-3473 §8.7 (#3872): the pre/post body-source delta for every
    // FRONTMATTER_BODY_SOURCE key — see `StatePreWriteSnapshot`'s docstring
    // for why `reconcileReportedFields` needs this instead of a raw
    // frontmatter diff for these specific keys.
    preWriteState.bodyDeltas = bodyDeltas;
  }
  const preservation = applyStatePreservation({ transaction, postFm });
  if (divergedFields && preservationInputSnapshot) {
    // §8.5's "liberal but visible": every field whose value actually
    // differs before vs after `applyStatePreservation` is a field where the
    // curated (frontmatter) value won over a disagreeing freshly-derived
    // one — regardless of which policy executor fired. Diffing the object
    // (rather than special-casing which executor mutated it) is intentional:
    // it stays correct if a future FIELD_CLASSIFICATION row adds a new
    // preservation policy without this function needing to know about it.
    for (const key of Object.keys(preservation.postFm)) {
      const before = preservationInputSnapshot[key];
      const after = preservation.postFm[key];
      // ADR-3473 §8.7 (#3872 standards-axis finding): route through the ONE
      // owner of this comparison rule (`stateFieldValuesDiffer`, defined
      // below) instead of carrying a second inline `JSON.stringify`-vs-`!==`
      // copy — this is exactly the duplicated-rule shape this epic exists to
      // remove. `stateFieldValuesDiffer` is a function declaration (hoisted),
      // so calling it here, above its textual definition, is safe.
      if (stateFieldValuesDiffer(before, after)) divergedFields.push(key);
    }
    // ADR-3408 §8.5 Row 2 (D1's actual bug, the reason the guards had to be
    // deleted rather than merely relocated): the loop above can only see a
    // field that `applyStatePreservation` itself RESTORED — it diffs
    // `postFm` before vs after the executor ran, and `preserve-when-unchanged`
    // never adds an absent key back when the body source changed this write
    // (the delta rule correctly lets the empty derived value win, so `postFm`
    // never gains the key at all). That means a curated value can vanish —
    // deliberately, per policy — with NOTHING in the loop above to report it.
    // "Liberal but visible" requires the discard itself to be named, not just
    // a restore. Scoped to exactly the fields `bodyDeltas` tracks
    // (preserve-when-unchanged rows only — `preserve-always`/`progress` and
    // `preserve-if-placeholder`/`milestone*` are unaffected by the delta rule
    // and already fully covered by the restore-diff loop above).
    for (const [field, delta] of Object.entries(bodyDeltas)) {
      if (divergedFields.includes(field)) continue; // already reported as a restore above
      const before = preFmSnapshot[field];
      const beforeIsReal = typeof before === 'string' && before.trim().length > 0;
      if (!beforeIsReal) continue; // nothing curated existed to discard
      if (delta.pre === delta.post) continue; // body source unchanged — governed by the restore branch, not the discard rule
      const after = preservation.postFm[field];
      const afterIsEmpty = after === undefined || after === null
        || (typeof after === 'string' && after.trim().length === 0);
      if (afterIsEmpty) divergedFields.push(field);
    }
  }
  // #2736: re-assert the intent-first values AFTER preservation. On STATE.md
  // layouts with no body `Phase:` line, both phase-source snapshots are null
  // (equal), so the #1695 restore fires and would put the stale pre-transition
  // name back over the authoritative one. Intent beats both the prose
  // re-derivation and the curated restore — the transition just resolved it.
  let authoritativeReasserted = false;
  if (authoritativeFm) {
    for (const [key, value] of Object.entries(authoritativeFm)) {
      if (typeof value === 'string' && value.trim().length > 0 && preservation.postFm[key] !== value) {
        preservation.postFm[key] = value;
        authoritativeReasserted = true;
      }
    }
  }

  if (preservation.mutated || authoritativeReasserted) {
    // #3742: preservation RESTORES frontmatter keys the body-derived rebuild
    // could not produce (e.g. `current_phase` on a layout with no body
    // `**Current Phase:**` line) — but the comment channel was filtered
    // against the pre-restore key set during sync, so a full-line comment
    // attached to a restored key died with nothing to re-attach it. Propagate
    // the channel from the PRE-WRITE snapshot here, after the restores, so a
    // comment's survival depends on its key surviving the whole write — not
    // on which body line happened to feed the rebuild. Merge semantics
    // (propagateCommentChannel) keep any channel the synced content already
    // carried. No resync gate: this is the RMW path, where `resync` is the
    // DEFAULT (readModifyWriteStateMd derives it as `options.resync !==
    // false`) and preservation itself runs regardless — the factory-reset
    // semantic the #3742 review worried about lives in writeStateMd's
    // `rebuild` transactions, which never reach this branch.
    if (preFmSnapshot && !isUnparseableFrontmatter(preFmSnapshot)) {
      propagateCommentChannel(preFmSnapshot as unknown as Frontmatter, preservation.postFm as unknown as Frontmatter);
    }
    const yamlStr = reconstructFrontmatter(preservation.postFm as unknown as Frontmatter);
    const body = stripFrontmatter(syncedContent);
    return `---\n${yamlStr}\n---\n\n${body}`;
  }
  return syncedContent;
}

/**
 * ADR-3408 §8.3 — the ONE write-seam composition: `syncStateFrontmatter` then
 * `applyPostSyncPreservation`, as a single named `content -> content`
 * function. Every STATE.md write that (a) is not one of the two sanctioned-
 * permanent exceptions (`cmdStateSync`, `REGENERATE_STATE` — §8.3's closed
 * exception list, ADR Amendment 2) and (b) needs a non-standard I/O envelope
 * calls THIS — never `syncStateFrontmatter` + `applyPostSyncPreservation`
 * assembled locally. §8.3: "Assembling the stages at a call site is a
 * re-derivation even when every step calls the owner." Phase 2 (#3469) found
 * exactly that shape live in `cmdPhaseComplete`'s atomic-commit adapter
 * (phase.cts) — every step called an owner, so the drift guard and an
 * owner-level test both stayed green while the composition itself was free
 * to diverge from `readModifyWriteStateMd`'s.
 *
 * Both current non-RMW callers of the pair — `readModifyWriteStateMd` and
 * `cmdPhaseComplete`'s atomic 3-file commit adapter — now call this instead
 * of assembling the two stages themselves. `cmdMilestoneComplete` (the
 * #3374-shaped exposure `applyPostSyncPreservation`'s own docstring flagged
 * as a follow-up) is the third.
 *
 * Returns CONTENT ONLY — a caller that needs its own I/O envelope (a lock,
 * an atomic multi-file commit) supplies it around this call; this function
 * never takes over the write.
 *
 * `divergedFields` is passed straight through to `applyPostSyncPreservation`
 * — see its own docstring.
 */
function syncAndPreserveStateMd(
  originalContent: string,
  transformedContent: string,
  statePath: string,
  cwd: string | undefined,
  options: StatePreservationOptions,
): string {
  assertStatePreservationOptions(options, 'syncAndPreserveStateMd');
  const synced = syncStateFrontmatter(transformedContent, cwd, options.authoritativeFm);
  return applyPostSyncPreservation(
    originalContent,
    transformedContent,
    synced,
    statePath,
    options,
  );
}

/**
 * Atomic read-modify-write for STATE.md.
 * Holds the lock across the entire read -> transform -> write cycle,
 * preventing the lost-update problem where two agents read the same
 * content and the second write clobbers the first.
 *
 * @param statePath
 * @param transformFn - (content: string) => string
 * @param cwd
 * @param options
 *   resync: when true (default) rebuilds the entire frontmatter from disk after
 *   the transform. Pass { resync: false } for body-only updates (e.g. state.update
 *   on a single field) that must not trample manually-curated cross-milestone
 *   progress.* counters in the frontmatter (#3242 Bug A).
 *   When resync is false, syncStateFrontmatter still runs to maintain/create the
 *   frontmatter block, but any existing progress.* sub-keys are preserved from
 *   the pre-transform file rather than being rebuilt from disk.
 * @param clock
 *   Optional clock seam; defaults to realClock. Passed through to acquireStateLock.
 */
function readModifyWriteStateMd(statePath: string, transformFn: (content: string) => string, cwd: string, options?: ReadModifyWriteOptions, clock?: StateLockClock): boolean {
  const resync = !options || options.resync !== false;
  const lockPath = acquireStateLock(statePath, clock);
  try {
    const content = platformReadSync(statePath) || '';

    const modified = transformFn(content);

    // Bug #948: no-op guard — if the transform produced no change, do NOT write
    // the file. An unconditional write would bump `last_updated`, reset
    // `milestone_name` to the template placeholder, and resurrect stale
    // body-derived `stopped_at` values via syncStateFrontmatter. Skipping the
    // write when content is unchanged is safe because every caller that mutates
    // content already returns the mutated string, and callers that detect a
    // no-op explicitly return the original content unchanged.
    if (modified === content) {
      return false;
    }

    // #3469 (ADR-3408 §8.3): sync + post-sync preservation is the single
    // owned composition (`syncAndPreserveStateMd`), not assembled here — this
    // call site and `cmdPhaseComplete`'s atomic-commit adapter both route
    // through the same function so the composition cannot diverge between
    // the two.
    const synced = syncAndPreserveStateMd(
      content,
      modified,
      statePath,
      cwd,
      {
        resync,
        authoritativeFm: options?.authoritativeFm,
        deriveProgressKeys: options?.deriveProgressKeys === true,
        divergedFields: options?.divergedFields,
        explicitProgressField: options?.explicitProgressField === true,
        // ADR-3473 §8.7 (#3872): forwarded so `applyPostSyncPreservation` can
        // fill it — an unenumerated option here is silently dropped
        // (Phase 1's commit message; #3871), which is exactly how a prior cut
        // of this option would have gone missing.
        preWriteState: options?.preWriteState,
      },
    );

    platformWriteSync(statePath, synced);
    return true;
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * ADR-3408 §8.4/§8.5 (D4): frontmatter field name → the body Title-Case
 * label the `updated` arrays below use. Every `preserve-when-unchanged` row
 * in `FIELD_CLASSIFICATION` MUST have an entry here (pinned by a parity test,
 * #3471 review) — `reconcileReportedFields` consults this so a preservation
 * event on `current_phase_name` folds into a report that otherwise only ever
 * speaks in body labels like `Current Phase Name` (#3345's direction). A
 * `preserve-when-unchanged` field missing here is a table drift bug and
 * `bodyLabelFor` throws rather than silently degrading to the raw
 * snake_case key (#3471 review — this is a second hand-maintained table
 * parallel to `FIELD_CLASSIFICATION`, so an unwired row must fail as loudly
 * as `throwUnwiredRow` in `state-transition.cts` does for the same shape of
 * omission). `preserve-always`/`preserve-if-placeholder` fields (`progress`,
 * `milestone`, `milestone_name`) are deliberately absent — `divergedFields`
 * (ADR-3408 §8.5's out-param) is NOT scoped to `preserve-when-unchanged`
 * rows alone (see `applyPostSyncPreservation`'s "regardless of which policy
 * executor fired" diff), so those fields legitimately reach the lookup with
 * no body-line label to report — `progress` is a structured sub-object and
 * `milestone`/`milestone_name` version/name pairs, neither ever rendered as
 * a body prose line — and `bodyLabelFor` falls through to the raw key for
 * exactly that closed, tested set (`tests/state.test.cjs` A2f pins
 * `divergedFields` reporting bare `'progress'`).
 */
/**
 * #3873 (ADR-3473 §8.8): PROJECTED from `STATE_FIELD_SCHEMA`
 * (`src/state-md-schema.cts`)'s `bodyLabel` field, in this EXPLICIT key
 * order — the pre-#3873 literal's own order, which puts `status` AFTER
 * `stopped_at`/`paused_at` (the opposite of `FRONTMATTER_BODY_SOURCE`'s order
 * in `state-transition.cts`; the two pre-existing tables disagreed with each
 * other's order too, so each projection reproduces its OWN table's order
 * rather than a shared derivation). Byte-identical to the pre-#3873 literal:
 * same 7 keys, same order, same frozen (NOT null-prototype — this table was
 * a plain `Object.freeze({...})` literal before #3873 and stays one) shape.
 * `last_activity` is deliberately excluded — see `STATE_FIELD_SCHEMA`'s
 * `last_activity` row docstring for the resolved disagreement. Pinned by
 * `tests/state.test.cjs`'s `bodyLabelProjectionMatchesTodaysTable` and
 * `lastActivityLabelResolutionMatchesShippedBehavior`.
 */
const FRONTMATTER_KEY_TO_BODY_LABEL_KEY_ORDER = Object.freeze([
  'current_phase',
  'current_phase_name',
  'current_plan',
  'stopped_at',
  'paused_at',
  'status',
  'last_activity_desc',
] as const);

const FRONTMATTER_KEY_TO_BODY_LABEL: Readonly<Record<string, string>> = Object.freeze(
  FRONTMATTER_KEY_TO_BODY_LABEL_KEY_ORDER.reduce((acc, key) => {
    const row = stateMdSchemaMod.STATE_FIELD_SCHEMA[key];
    if (row.bodyLabel !== undefined) acc[key] = row.bodyLabel;
    return acc;
  }, {} as Record<string, string>),
);

/**
 * ADR-3408 §8.4 (D4) / #3471 review: label lookup for a `divergedFields`
 * entry. Throws for a `preserve-when-unchanged` field with no
 * `FRONTMATTER_KEY_TO_BODY_LABEL` row — that combination can only happen if
 * a future row is added to `FIELD_CLASSIFICATION` without a matching label,
 * an internal table-drift bug, never a user-document defect (mirrors
 * `throwUnwiredRow`'s shape in `state-transition.cts`: an `Error` carrying
 * `code` and `field` own-properties). Falls through to the raw field name
 * for every other policy (`preserve-always`, `preserve-if-placeholder`) —
 * those fields were never claimed to have a body-line label and reaching
 * this lookup with one of them is the documented, tested, working case
 * (e.g. `progress`), not a silent degrade.
 */
function bodyLabelFor(field: string): string {
  // ADR-3473 §8.7 (#3872 review): an OWN-PROPERTY check, never a bare
  // bracket read — `FRONTMATTER_KEY_TO_BODY_LABEL` is a plain object literal
  // (real `Object.prototype` in its chain), so `[field]` for a hostile field
  // named `__proto__`/`constructor`/`toString` returns the INHERITED
  // prototype-chain member (`Object.prototype` itself, the `Object`
  // constructor function, `Object.prototype.toString`) instead of
  // `undefined` — which would then be returned as the "label" and leak a
  // non-string value into the caller's `updated` array. Proven by
  // `dottedResolutionDoesNotPollutePrototypes` (test matrix row 25) before
  // this fix. Mirrors `resolveFrontmatterPath`'s own-property discipline.
  if (Object.prototype.hasOwnProperty.call(FRONTMATTER_KEY_TO_BODY_LABEL, field)) {
    return FRONTMATTER_KEY_TO_BODY_LABEL[field];
  }
  const cls = stateTransitionMod.getFieldClassification(field);
  if (cls && cls.preservation === 'preserve-when-unchanged') {
    const err = new Error(
      `reconcileReportedFields: preserve-when-unchanged field ${JSON.stringify(field)} has no ` +
      'FRONTMATTER_KEY_TO_BODY_LABEL entry. This is an internal invariant violation (ADR-3408 ' +
      '§8.4/D4) — add a label for this field to FRONTMATTER_KEY_TO_BODY_LABEL.',
    ) as Error & { code: string; field: string };
    err.code = 'STATE_BODY_LABEL_UNWIRED_ROW';
    err.field = field;
    throw err;
  }
  return field;
}

/**
 * ADR-3473 §8.7 (issue #3872): the provenance exclusion — the ONLY
 * frontmatter key measured to change on EVERY write, regardless of content.
 * Verified at the CLI (`40-design.md` "Two corrections from reproducing it"):
 * two content-identical writes to a git-backed fixture differ in exactly
 * this one key. `state_head` was deliberately measured OUT of this set —
 * it restamps every write but its PERSISTED VALUE changes only when git HEAD
 * actually moved, so it tracks a real fact and does not flood.
 *
 * A CLOSED, ENUMERATED set — not a predicate or a callback (Greenspun's
 * Tenth Rule, ADR-3473 §8.7's Laws section: "the moment it takes a callback
 * it has become the classification table again under a new name"). It
 * exists to protect `src/state.cts:607` — `state.patch`'s ENTIRE
 * success/failure signal is `results.updated.length > 0` — admitting an
 * always-changing key here would make that boolean permanently `true`, so a
 * fully-failed patch would report success.
 */
const STATE_UPDATED_PROVENANCE_EXCLUSION: readonly string[] = Object.freeze(['last_updated']);

/** Sentinel: "this dotted path did not resolve to any value" — distinct from every real value including `undefined`/`null`, so absence and an explicit null are never confused. */
const STATE_FIELD_ABSENT: unique symbol = Symbol('state-field-absent');

/**
 * ADR-3473 §8.7 (#3872): resolve `path` against a parsed frontmatter object.
 * Pure, never throws.
 *
 * Order is pinned (test matrix row 26, `literalDottedKeyResolvesBeforePathTraversal`):
 * a LITERAL flat key wins first — a field name that happens to contain a `.`
 * but is stored as one flat key must not be shadowed by path traversal —
 * and only when no literal key exists does `path` get split and walked as a
 * dotted path.
 *
 * Hostile-input rows (23-25 of the test matrix) all resolve to
 * `STATE_FIELD_ABSENT` rather than throwing: a missing parent, a scalar
 * parent (`typeof cursor !== 'object'`), and — the prototype-pollution
 * case — a `__proto__`/`constructor`/`toString` segment. The own-property
 * check (`Object.prototype.hasOwnProperty.call`, never a bare `in` or
 * bracket read) is what makes the last one safe: an inherited
 * `Object.prototype` member is never mistaken for an own data key, and
 * because this function only ever READS a segment (never assigns one),
 * no prototype can be polluted by walking it.
 */
function resolveFrontmatterPath(fm: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(fm, path)) return fm[path];
  if (!path.includes('.')) return STATE_FIELD_ABSENT;
  let cursor: unknown = fm;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return STATE_FIELD_ABSENT;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return STATE_FIELD_ABSENT;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * ADR-3473 §8.7 (#3872): representation-insensitive equality for a
 * persisted-vs-snapshot leaf value (test matrix rows 21/22). Frontmatter
 * scalars round-trip as STRINGS (`extractFrontmatter`, §8.1's open type
 * question) while an in-memory derivation can hold a real number or boolean
 * — a naive `!==` would report every numeric/boolean field changed on every
 * write. Mirrors the existing `divergedFields` diff's typeof-object branch
 * in `applyPostSyncPreservation` (JSON.stringify for objects, else a
 * normalized scalar compare) rather than inventing a second comparison.
 * Presence-vs-absence (`STATE_FIELD_ABSENT` on exactly one side) is always a
 * change — a deleted or newly-added key (test matrix rows 16/17) — never
 * folded into the scalar branch below it.
 */
/**
 * ADR-3473 §8.7 (#3872): `String(v)` on an `unknown` is unsafe (a hostile
 * object could carry a custom, throwing, or `[object Object]`-degrading
 * `toString`) — narrowed per-branch here so each `String()` call below only
 * ever runs on a primitive TypeScript itself knows is safe to stringify.
 */
function stateScalarString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
}

function stateFieldValuesDiffer(before: unknown, after: unknown): boolean {
  if (before === STATE_FIELD_ABSENT && after === STATE_FIELD_ABSENT) return false;
  if (before === STATE_FIELD_ABSENT || after === STATE_FIELD_ABSENT) return true;
  if (typeof before === 'object' || typeof after === 'object') {
    return JSON.stringify(before) !== JSON.stringify(after);
  }
  return stateScalarString(before).trim() !== stateScalarString(after).trim();
}

/**
 * ADR-3473 §8.7 (#3872): the declared dotted-leaf children of a frontmatter
 * key, read off `FIELD_CLASSIFICATION` (`progress` -> its five
 * `progress.*` rows) rather than walked from arbitrary nesting depth of a
 * user-authored document. A BOUNDED, DECLARED enumeration — the design
 * doc's Rejected #5 and the "Emit dotted leaves, not the parent" rule both
 * depend on this staying a closed set the schema names, not unbounded
 * traversal of whatever object shape happens to be on disk.
 */
function declaredLeavesOf(key: string): string[] {
  const prefix = `${key}.`;
  return Object.keys(FIELD_CLASSIFICATION).filter((k) => k.startsWith(prefix));
}

/**
 * ADR-3473 §8.7 (#3872): every frontmatter key — resolved at DOTTED-LEAF
 * granularity for a key with declared leaves (`progress` -> only the
 * `progress.*` leaves that actually moved, never bare `progress` itself;
 * design doc rule 4/Rejected #5) — whose PERSISTED value differs from the
 * transaction's pre-write SNAPSHOT. Pure: no I/O, no `FIELD_CLASSIFICATION`
 * preservation-policy consultation (that filter is exactly what this rule
 * deletes — ADR-3473 §8.7 "no field is excluded by classification").
 * `last_updated` is the one-element provenance exclusion; every other key,
 * including `state_head`, is a candidate.
 *
 * **A `FRONTMATTER_BODY_SOURCE` key is diffed via `bodyDeltas`, never via a
 * raw frontmatter compare.** Found while driving the #1264 regression check
 * through this rewrite at the CLI: `syncStateFrontmatter` re-derives EVERY
 * body-sourced key into frontmatter on EVERY write, independent of whether
 * this write's own transform touched it. A hand-authored (or day-1
 * bootstrap) STATE.md whose frontmatter has not yet caught up to an
 * already-stable body value — e.g. `current_phase_name` present in the body
 * but absent from a pre-write frontmatter block that only ever recorded
 * `status`/`progress` — makes that key look newly ADDED under a raw diff
 * (rows 15/17) even though nothing changed. The real "did THIS write change
 * it" signal for these keys is whether their BODY SOURCE moved, which is
 * exactly what `bodyDeltas` (built once, in `applyPostSyncPreservation`,
 * from `originalContent` vs `transformedContent`) already answers — reused
 * here rather than re-derived, and it is what correctly REPORTS #3818's
 * `current_phase` (the body source did move) while staying SILENT on a
 * merely-backfilled, body-unchanged key (the #1264 false positive this
 * function's first cut produced).
 *
 * **A declared dotted-leaf (`declaredLeavesOf`, e.g. every `progress.*` row)
 * absent from the snapshot and present in persisted is materialization, not
 * a change.** Found the same way as the paragraph above, one layer down:
 * `progress` is `source: 'disk'` (state-transition.cts), re-derived by
 * `buildStateFrontmatter`'s phase-directory scan on every write regardless
 * of whether the caller's own action touched it — and the phases directory
 * cannot move during a STATE.md write, so a fresh `progress` block appearing
 * where the snapshot had none is the scanner catching a never-synced
 * document up, not the caller changing anything. This is the SAME
 * provenance principle `STATE_UPDATED_PROVENANCE_EXCLUSION` applies to
 * `last_updated` (a field stamped by the write's occurrence, not its
 * action) — generalized to the declared-leaf case, deliberately NOT a
 * second classification-based exclusion: `progress`'s `preserve-always`
 * policy plays no part in the check below, and a leaf already PRESENT in
 * the snapshot is diffed exactly as every other field is, including
 * reporting its outright disappearance (row 16) — only the absent-in-
 * snapshot-but-materialized-in-persisted transition is suppressed.
 */
function computeChangedFrontmatterFields(
  snapshotFm: Record<string, unknown>,
  persistedFm: Record<string, unknown>,
  bodyDeltas: Record<string, { pre: string | null; post: string | null }> | undefined,
): string[] {
  const changed: string[] = [];
  const topKeys = new Set([...Object.keys(snapshotFm), ...Object.keys(persistedFm)]);
  for (const key of topKeys) {
    if (STATE_UPDATED_PROVENANCE_EXCLUSION.includes(key)) continue;

    if (stateTransitionMod.getFrontmatterBodySource(key) !== null) {
      const delta = bodyDeltas ? bodyDeltas[key] : undefined;
      if (delta && stateFieldValuesDiffer(delta.pre ?? STATE_FIELD_ABSENT, delta.post ?? STATE_FIELD_ABSENT)) {
        changed.push(key);
      }
      continue;
    }

    const leaves = declaredLeavesOf(key);
    if (leaves.length > 0) {
      for (const leaf of leaves) {
        const before = resolveFrontmatterPath(snapshotFm, leaf);
        const after = resolveFrontmatterPath(persistedFm, leaf);
        // Generalizes the SAME provenance principle STATE_UPDATED_PROVENANCE_EXCLUSION
        // applies to `last_updated` one level up — this is NOT a classification-based
        // exclusion (progress's `preserve-always` policy plays no part here; that filter
        // stays deleted per §8.7). It is a fact about the DECLARED LEAF SET: every key
        // enumerated by `declaredLeavesOf` is `source: 'disk'` (state-transition.cts),
        // re-derived from a scan that cannot move during a STATE.md write (the write only
        // touches STATE.md, never the phases directory). So a leaf ABSENT from the
        // pre-write snapshot and PRESENT in persisted is the scanner catching a document
        // up to a derivation it had never synced before — the write's own OCCURRENCE
        // produced the bytes, not the caller's ACTION, exactly the `last_updated` shape.
        // A leaf already PRESENT in the snapshot behaves normally: any difference
        // (including disappearing entirely, row 16) is reported, because there the
        // snapshot proves the derivation had already run once, so a new persisted value
        // can only come from something genuinely moving (#3743/#3818).
        if (before === STATE_FIELD_ABSENT && after !== STATE_FIELD_ABSENT) continue;
        if (stateFieldValuesDiffer(before, after)) changed.push(leaf);
      }
      continue;
    }
    const before = resolveFrontmatterPath(snapshotFm, key);
    const after = resolveFrontmatterPath(persistedFm, key);
    if (stateFieldValuesDiffer(before, after)) changed.push(key);
  }
  return changed;
}

/**
 * ADR-3473 §8.7 (issue #3872): the transaction diff. `updated` is derived
 * by comparing PERSISTED frontmatter against the transaction's pre-write
 * SNAPSHOT — replacing the prior comparison of the transform's own OUTPUT
 * against persisted bytes, which answered a different question ("did the
 * transform's write survive to disk", #3351) from the one §8.7 asks ("what
 * did this write actually change" — both #3351's direction and #3345/#3818's
 * fall out of ONE comparison against the pre-write state; see the design
 * doc's "ambiguity in §8.7" section for why the transform-output comparison
 * was rejected).
 *
 * No field is excluded by classification — `getFieldClassification` /
 * `preservation !== 'preserve-when-unchanged'` is gone, not relocated. The
 * ONLY exclusion is `STATE_UPDATED_PROVENANCE_EXCLUSION` (provenance, not
 * classification): an unchanged `progress` no longer needs a special filter
 * to stay unreported (#1264) because the diff itself says "unchanged" —
 * and a GENUINELY changed `progress.*` leaf (#3743, #3818) is no longer
 * suppressed by the same filter.
 *
 * @param preWriteState The transaction's pre-write snapshot + body — the
 *   `preWriteState` out-param `applyPostSyncPreservation` filled during
 *   THIS write (see `ReadModifyWriteOptions.preWriteState`'s docstring).
 *   `.fm`/`.body` are `undefined` only when `readModifyWriteStateMd`'s own
 *   #948 no-op guard fired (transform output was byte-identical to input),
 *   in which case nothing was ever written and `[]` is the correct,
 *   short-circuited answer — never a diff against a synthesized empty `{}`
 *   snapshot, which would read every already-persisted key as newly ADDED.
 * @param reported The candidate field names — the transform's OWN success
 *   list. Body Title-Case labels (`Status`, `Current Plan`, `Current
 *   Position`) and frontmatter keys (including dotted leaves like
 *   `progress.total_plans`) are both valid; each is resolved via the same
 *   `valueOf` fallback chain used for the inclusion test below.
 * @param divergedFields Kept for signature/out-param stability (ADR-3408
 *   §8.5) — populated exactly as before by `applyPostSyncPreservation` and
 *   still read directly by other code and `tests/state.test.cjs`'s A2f case
 *   — but no longer consulted here as a candidate SOURCE (design doc row
 *   18): the frontmatter diff subsumes what it used to contribute, and it
 *   sees only what *preservation* changed, never what *sync* changed
 *   (#3818's own direction), which is why keeping it as the candidate
 *   source was rejected (design doc, Rejected #1).
 */
function reconcileReportedFields(
  statePath: string,
  preWriteState: StatePreWriteSnapshot,
  reported: string[],
  divergedFields: string[],
): string[] {
  void divergedFields; // ADR-3473 §8.7 D18: out-param only, not a candidate source here.
  if (preWriteState.fm === undefined || preWriteState.body === undefined) return [];

  const persisted = platformReadSync(statePath) || '';
  const persistedFm = extractFrontmatter(persisted, statePath) as Record<string, unknown>;
  const persistedBody = stripFrontmatter(persisted);
  const snapshotFm = preWriteState.fm;
  const snapshotBody = preWriteState.body;

  // #3471 review (unchanged by this rewrite): body-FIRST, frontmatter-key-
  // FLAT-fallback, dotted-PATH-fallback last. Body-first mirrors the actual
  // write precedence `patchCore`/`updateCore` apply (#1162's fix — a
  // lowercase body label that happens to case-exact-match a frontmatter key
  // must still resolve against the body). `field` a literal flat key (even
  // one containing a `.`) is tried before it is split and walked as a
  // dotted path (test matrix row 26) — `resolveFrontmatterPath` pins that
  // same order for the frontmatter side alone.
  //
  // `Current Position` is special-cased: it names the WHOLE `## Current
  // Position` section, not a single `Label: value` line, so
  // `stateExtractField` can never resolve it (this is the root cause of the
  // "Current Position undercount" — a transform can correctly push
  // `'Current Position'` into its own `updated` list, and this function
  // still silently dropped it, because `valueOf` returned `null` for BOTH
  // sides and `null === null` failed the old `intended !== null` guard).
  // `sliceCurrentPositionSection` is the existing fence-aware section
  // locator (state-transition.cts) — reused rather than re-derived.
  const valueOf = (fm: Record<string, unknown>, body: string, field: string): string | null => {
    if (field === 'Current Position') {
      const section = stateTransitionMod.sliceCurrentPositionSection(body);
      return section !== null ? section.trim() : null;
    }
    const bodyValue = stateExtractField(body, field);
    if (bodyValue !== null) return bodyValue;
    if (Object.prototype.hasOwnProperty.call(fm, field)) return String(fm[field]);
    if (field.includes('.')) {
      const resolved = resolveFrontmatterPath(fm, field);
      if (resolved !== STATE_FIELD_ABSENT) {
        return stateScalarString(resolved);
      }
    }
    return null;
  };

  // A field in `reported` can itself be a declared derived leaf (e.g.
  // `plannedPhaseCore` pushing `'progress.total_plans'` — state-
  // transition.cts:1752). `valueOf`'s null-vs-string convention cannot tell
  // "absent from the frontmatter" apart from "resolved to the literal string
  // 'null'/''", so it cannot carry the same materialization rule
  // `computeChangedFrontmatterFields` applies below. Route these fields
  // through the SAME primitives (`resolveFrontmatterPath` + the
  // `STATE_FIELD_ABSENT` sentinel + `stateFieldValuesDiffer`) instead of a
  // second, parallel absence convention — one rule, reused, not duplicated.
  const isDeclaredDerivedLeaf = (candidate: string): boolean =>
    candidate.includes('.') && Object.prototype.hasOwnProperty.call(FIELD_CLASSIFICATION, candidate);

  const changed = (field: string): boolean => {
    if (isDeclaredDerivedLeaf(field)) {
      const before = resolveFrontmatterPath(snapshotFm, field);
      const after = resolveFrontmatterPath(persistedFm, field);
      // Same generalized provenance rule as computeChangedFrontmatterFields:
      // absent-in-snapshot-materializing-in-persisted is the disk scan
      // catching a never-synced document up, not this write's own action.
      if (before === STATE_FIELD_ABSENT && after !== STATE_FIELD_ABSENT) return false;
      return stateFieldValuesDiffer(before, after);
    }
    const before = valueOf(snapshotFm, snapshotBody, field);
    const after = valueOf(persistedFm, persistedBody, field);
    if (before === null && after === null) return false;
    if (before === null || after === null) return true;
    return before.trim() !== after.trim();
  };

  // Candidate set = `reported` ∪ every frontmatter key (dotted-leaf
  // granularity) whose persisted value differs from the snapshot, minus the
  // provenance exclusion. A frontmatter-diff-discovered field is mapped
  // through `bodyLabelFor` so it lands in the SAME output vocabulary a
  // transform would have used (`status` -> `'Status'`; `progress.total_plans`
  // has no body-line label and falls through to its raw dotted key, same as
  // today's `progress`/`milestone*` fall-through).
  const changedFrontmatterFields = computeChangedFrontmatterFields(snapshotFm, persistedFm, preWriteState.bodyDeltas);
  const mappedFrontmatterFields = changedFrontmatterFields.map((field) => bodyLabelFor(field));

  const seen = new Set<string>();
  const reconciled: string[] = [];
  for (const field of reported) {
    if (STATE_UPDATED_PROVENANCE_EXCLUSION.includes(field) || seen.has(field)) continue;
    if (changed(field)) {
      seen.add(field);
      reconciled.push(field);
    }
  }
  for (const field of mappedFrontmatterFields) {
    if (STATE_UPDATED_PROVENANCE_EXCLUSION.includes(field) || seen.has(field)) continue;
    seen.add(field);
    reconciled.push(field);
  }
  return reconciled;
}

function cmdStateJson(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, 'STATE.md not found');
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  const existingFm = extractFrontmatter(content, statePath) as Record<string, unknown>;
  const body = stripFrontmatter(content);

  // Always rebuild from body + disk so progress counters reflect current state.
  // Returning cached frontmatter directly causes stale percent/completed_plans
  // when SUMMARY files were added after the last STATE.md write (#1589).
  // #3354: pass the stored total so the milestoned-but-unbounded withhold can
  // report the preserved value instead of omitting the key.
  // #3573: pass the STORED MILESTONE too (same parity reasoning) — otherwise the
  // roadmap-absent withhold never fires on this read surface and `state json`
  // reports the phase-directory count while the persisted file preserves the
  // stored total, exactly the write/read divergence #3354 closed for its shape.
  const storedMilestoneJson = typeof existingFm['milestone'] === 'string' ? existingFm['milestone'] : null;
  const built = buildStateFrontmatter(body, cwd, storedMilestoneJson, readStoredTotalPhases(existingFm));

  // ADR-3408 §8.5 / D3: route stopped_at / paused_at / status / current_phase /
  // current_phase_name / current_plan through the SAME `preserve-when-unchanged`
  // executor the write path uses (`applyPreserveWhenUnchanged`), instead of a
  // third private copy of the empty-only guards with no delta/staleness check
  // at all — the shape that let a stale-but-present body annotation always
  // beat a fresher curated frontmatter value in `state json` output (#3395's
  // shape outside the write seam).
  //
  // `cmdStateJson` never writes — it is one snapshot read, not a
  // before/after transform — so "did THIS write change the body source"
  // (the #1230 delta the executor consults) is definitionally "no": every
  // field's body source is passed as its own delta pre/post pair (the same
  // value twice). That is what makes the executor's rule resolve to
  // "restore the curated value whenever a real one exists" here — exactly
  // §8.5's "same terms as an empty derived value" extended to a present
  // one, i.e. the exact D3 fix. Deliberately scoped to only these six
  // fields (not the full `applyStatePreservation` dispatch loop): `progress`
  // (preserve-always) keeps its own `shouldPreserveExistingProgress`
  // cross-milestone rule below — a DIFFERENT policy that must survive this
  // change untouched — and `milestone`/`milestone_name`
  // (preserve-if-placeholder) are out of D3's scope entirely.
  if (existingFm) {
    const sessionScope = matchSessionSection(body) ?? body;
    const positionScope = matchCurrentPositionSection(body) ?? body;
    const bodyStoppedAt = stateExtractField(sessionScope, 'Stopped At') || stateExtractField(sessionScope, 'Stopped at');
    const bodyPausedAt = stateExtractField(sessionScope, 'Paused At');
    const bodyPhaseSource = stateExtractField(body, 'Phase');
    const bodyCurrentPhase = stateExtractField(body, 'Current Phase')
      ?? parseProsePhaseField(stateExtractField(positionScope, 'Phase')).phase;
    const bodyCurrentPlan = stateExtractField(body, 'Current Plan');
    const bodyStatus = stateExtractField(body, 'Status');
    // #3836: mirrors applyPostSyncPreservation's own derivation (state.cts
    // bodyDeltas, `last_activity_desc`) — the `Last Activity Description`
    // label, falling back to the prose `Last Activity:` line's parsed
    // description. Read-side twin of #3258's write-side wiring; this field is
    // `preserve-when-unchanged` per FIELD_CLASSIFICATION and was previously
    // absent from this read path entirely (never derived here, never in the
    // loop below), so a stale body annotation always beat a fresher curated
    // frontmatter value on every `state json` read.
    const bodyLastActivityRaw = stateExtractField(body, 'Last Activity') ?? stateExtractField(body, 'Last activity');
    const bodyLastActivityDesc = stateExtractField(body, 'Last Activity Description')
      ?? parseProseLastActivityField(bodyLastActivityRaw).description;

    const unchanged = (v: string | null): { pre: string | null; post: string | null } => ({ pre: v, post: v });
    const ctx = {
      postFm: built,
      snapshot: existingFm,
      resync: true,
      deriveProgressKeys: false,
      bodyDeltas: {
        status: unchanged(bodyStatus),
        stopped_at: unchanged(bodyStoppedAt),
        paused_at: unchanged(bodyPausedAt),
        current_phase: unchanged(bodyCurrentPhase),
        current_plan: unchanged(bodyCurrentPlan),
        current_phase_name: unchanged(bodyPhaseSource),
        last_activity_desc: unchanged(bodyLastActivityDesc),
      },
      mutated: false,
    };
    // #3836: derive the field set from FIELD_CLASSIFICATION's
    // `preserve-when-unchanged` rows (single source of truth) instead of a
    // hand-typed literal that can drift from the table — this IS the fix,
    // not merely an addition of one more name to the literal.
    for (const field of stateTransitionMod.getPreserveWhenUnchangedFields()) {
      const cls = stateTransitionMod.getFieldClassification(field);
      if (cls) stateTransitionMod.applyPreserveWhenUnchanged(field, cls, ctx);
    }
  }
  // Preserve curated cross-milestone aggregates when local disk scanning sees
  // only a narrower realized subset (#3242 Bug A). Stale lower counters still
  // rebuild from disk because they do not exceed the derived scan.
  if (existingFm && shouldPreserveExistingProgress(existingFm['progress'], built['progress'])) {
    built['progress'] = normalizeProgressNumbers(existingFm['progress']);
  }

  // #2567: guard the information-losing direction — a stale archive
  // "Last activity:" line must not surface as the current value. Mirrors the
  // syncStateFrontmatter guard so the read path agrees with the write path.
  preferNewerLastActivity(existingFm, built);

  output(built, raw, JSON.stringify(built, null, 2));
}

/**
 * Update STATE.md when a new phase begins execution.
 * Updates body text fields (Current focus, Status, Last Activity, Current Position)
 * and synchronizes frontmatter via writeStateMd.
 * Fixes: #1102 (plan counts), #1103 (status/last_activity), #1104 (body text).
 */
function cmdStateBeginPhase(cwd: string, phaseNumber: string | number, phaseName: string | null | undefined, planCount: number | null | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  // ADR-1769 Phase 1: dispatches to the STATE.md Transition Module. The 175-line
  // RMW callback that used to live here (format detection + preservation policy
  // + section mutation + idempotency guard + resume branching) is now the pure
  // `transitionCore` function in src/state-transition.cts, backed by the
  // field-classification table. readModifyWriteStateMd still owns the lock,
  // #1230 post-sync preservation, and the no-op write guard.
  const intent: StateTransitionIntent = {
    kind: 'beginPhase',
    phaseNumber,
    phaseName: phaseName ?? null,
    planCount: planCount ?? null,
  };
  const deps: StateTransitionDeps = {
    clock: realClock,
    sourcePath: statePath,
  };

  // #2736: the transition holds the exact display name; without this the
  // post-transform sync re-derives current_phase_name from the freshly
  // written `Phase: N (Name) — EXECUTING` line, which truncates any name
  // that itself contains a parenthetical. The #1695 delta-gate preservation
  // still runs after the sync; the override is re-asserted after it inside
  // readModifyWriteStateMd for layouts with no body `Phase:` line.
  const divergedFields: string[] = [];
  // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
  // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
  const preWriteState: StatePreWriteSnapshot = {};
  const rmwOptions: ReadModifyWriteOptions = {
    authoritativeFm: intent.phaseName ? { current_phase_name: intent.phaseName } : undefined,
    divergedFields,
    preWriteState,
  };
  let precomputedUpdated: string[] = [];
  // #3311: begin-phase is the claim point — it is the one Current Position
  // transition that explicitly names its phase, so it both records this
  // session's claim and detects a conflicting live claim for a different
  // phase. The check runs INSIDE the STATE.md lock so concurrent begin-phase
  // calls cannot both read "no claim" and both write.
  let milestoneConflict: milestoneLockMod.MilestoneConflict | null = null;
  const wrote = readModifyWriteStateMd(statePath, (content) => {
    milestoneConflict = milestoneLockMod.claimMilestonePhase(cwd, String(phaseNumber));
    if (milestoneConflict) {
      milestoneLockMod.warnMilestoneConflict(milestoneConflict, `state.begin-phase ${phaseNumber}`);
    }
    const result = transitionCore(content, intent, deps);
    precomputedUpdated = result.updated;
    // #3127 resume: the core preserved the mid-flight Current Phase Name, so
    // the intent-first override must not fire — it would drift frontmatter
    // away from the preserved body value. Dropping it here is safe because
    // readModifyWriteStateMd consults options only after this callback returns.
    if (result.data?.['resumed']) {
      delete rmwOptions.authoritativeFm;
    }
    return result.content;
  }, cwd, rmwOptions);

  // ADR-3408 §8.4 (D4): reconcile `beginPhaseCore`'s own success list against
  // the bytes actually persisted (fix(#3351) generalized) and fold in any
  // field preservation restored that this transform never touched (#3345's
  // direction).
  const updated = reconcileReportedFields(statePath, preWriteState, precomputedUpdated, divergedFields);

  output(
    { updated, phase: phaseNumber, phase_name: phaseName || null, plan_count: planCount || null, milestone_conflict: milestoneConflict },
    raw,
    updated.length > 0 ? 'true' : 'false',
  );
  // #3227 (design doc §40 row 26 / "Not-corruption" rule): gate on `wrote`
  // (readModifyWriteStateMd's own return value — its #948 no-op guard skips
  // the write outright when the transform produced no diff), not on
  // `updated.length > 0`. Confirmed reproducer: an unrecognized-format
  // STATE.md makes `beginPhaseCore` match zero body fields AND leave
  // `existingFm` untouched, so the raw transform output is byte-identical to
  // the input, the RMW guard fires, and `wrote` is false — matching
  // `updated: []` here. Unlike `cmdStatePlannedPhase` (which must NOT use
  // this same `wrote` signal — see its comment for why `plannedPhaseCore`
  // mutates frontmatter in place even on this exact no-op shape),
  // `beginPhaseCore` never mutates `existingFm`, so `wrote` and
  // `updated.length > 0` agree on every case audited for this phase; `wrote`
  // is kept as the gate here (and on `cmdStateAdvancePlan`/
  // `cmdStateCompletePhase` below, where it is REQUIRED — `updated`/
  // `reconciled` can be non-empty there even when nothing was written,
  // confirmed by direct re-invocation) for one consistent rule across every
  // RMW-backed command in this file: publish iff `readModifyWriteStateMd`
  // itself reports a write. Best-effort — cannot throw, cannot change this
  // command's exit code or output.
  if (wrote) publishStateContract(cwd);
}

/**
 * Write a WAITING.json signal file when GSD hits a decision point.
 * External watchers (fswatch, polling, orchestrators) can detect this.
 * File is written to .planning/WAITING.json (or .gsd/WAITING.json if .gsd exists).
 * Fixes #1034.
 */
function cmdSignalWaiting(cwd: string, type: string | undefined, question: string | undefined, options: string | undefined, phase: string | undefined, raw: boolean): void {
  const gsdDir = fs.existsSync(path.join(cwd, '.gsd')) ? path.join(cwd, '.gsd') : planningDir(cwd);
  const waitingPath = path.join(gsdDir, 'WAITING.json');

  const signal = {
    status: 'waiting',
    type: type || 'decision_point',
    question: question || null,
    options: options ? options.split('|').map(o => o.trim()) : [],
    since: realClock.nowIso(),
    phase: phase || null,
  };

  try {
    platformEnsureDir(gsdDir);
    platformWriteSync(waitingPath, JSON.stringify(signal, null, 2));
    output({ signaled: true, path: waitingPath }, raw, 'true');
  } catch (e) {
    output({ signaled: false, error: (e as Error).message }, raw, 'false');
  }
}

/**
 * Remove the WAITING.json signal file when user answers and agent resumes.
 */
function cmdSignalResume(cwd: string, raw: boolean): void {
  const paths = [
    path.join(cwd, '.gsd', 'WAITING.json'),
    path.join(planningDir(cwd), 'WAITING.json'),
  ];

  let removed = false;
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); removed = true; } catch { /* intentionally empty */ }
    }
  }

  output({ resumed: true, removed }, raw, removed ? 'true' : 'false');
}

// ─── Gate Functions (STATE.md consistency enforcement) ────────────────────────

/**
 * Find the character offset where the FIRST GFM table whose header is a
 * superset of `required` column names begins (order-independent; extra
 * columns tolerated) — the position-aware counterpart to markdown-table's
 * `findTableWithColumns`, used to scope `updateTableCell` (which always
 * operates on "the first table in its input") to the RIGHT table when an
 * unrelated earlier table (that doesn't itself name every required column)
 * may precede it in the same document. Returns `null` when no such table is
 * found. Never trips the table-regex fingerprint (no `[^|]` cell-capture
 * class) and never throws.
 *
 * Ragged-tolerant (#2245 Blocker 2): accepts the offset the moment a HEADER
 * line names every required column — it deliberately does NOT additionally
 * require `parseMarkdownTable(text.slice(m.index)).ok`, which validates every
 * DATA row's cell count. A ragged sibling row anywhere in the table used to
 * make that whole-table parse fail, so the offset came back `null` and the
 * caller's `updateTableCell` calls (which scope to this offset) never even
 * ran against an otherwise-perfectly-findable row.
 */
function findTableStartOffset(text: string, required: string[]): number | null {
  const lineRe = /^[ \t]*\|.*\|[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const trimmed = m[0].trim();
    const cols = trimmed.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
    if (required.every((rq) => cols.includes(rq))) {
      return m.index;
    }
  }
  return null;
}

/**
 * Update the ## Performance Metrics section in STATE.md content.
 * Increments Velocity totals and upserts a By Phase table row.
 * Returns modified content string.
 */
function updatePerformanceMetricsSection(content: string, cwd: string, phaseNum: string | number, planCount: number, summaryCount: number): string {
  // By Phase table — upsert the row for THIS phase FIRST. The velocity total is then
  // DERIVED from the table's Plans column so it stays idempotent on re-run: completing
  // the same phase again upserts the same row, so the column sum is stable. The previous
  // blind-add (prevTotal + summaryCount) re-read the cumulative total each call and
  // double-counted on every re-run. (#1582)
  //
  // Located by column NAME via the markdown-table seam (ADR-2143 §7) —
  // supersedes the prior module-level byPhaseTablePattern regex for the
  // existence/lookup half of this logic.
  const byPhaseCols = ['Phase', 'Plans', 'Total', 'Avg/Plan'];
  // Ragged-tolerant (#2245 Blocker 2): scope to the table's start offset
  // (findTableStartOffset — itself now ragged-tolerant, see above) rather
  // than gating existence/lookup on findTableWithColumns, which requires the
  // WHOLE table to parse — a ragged row for a DIFFERENT phase used to
  // silently no-op every phase's upsert.
  const tableStart = findTableStartOffset(content, byPhaseCols);
  if (tableStart !== null) {
    // Match the existing row for this phase, tolerating leading-zero padding in either
    // direction (#1659): canonicalize a numeric phase to its integer form so a seeded
    // "| 05 |" row is upserted (not duplicated) by `phase complete 5`, and vice-versa.
    const phaseNumStr = String(phaseNum);
    const canonCell = /^\d+$/.test(phaseNumStr) ? `0*${Number(phaseNumStr)}` : escapeRegex(phaseNumStr);
    const phaseCellRe = new RegExp(`^${canonCell}$`, 'i');
    const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());

    const before = content.slice(0, tableStart);
    let tableText = content.slice(tableStart);

    // Ragged-tolerant existence probe: a no-op updateTableCell write on the
    // identifying "Phase" column (its own tolerant row scan) decides whether
    // this phase's row already exists, without requiring every OTHER row in
    // the table to also parse cleanly.
    let rowExists = false;
    const existsProbe = updateTableCell(tableText, rowMatch, 'Phase', (current) => {
      rowExists = true;
      return current;
    });
    void existsProbe;

    if (rowExists) {
      // Update existing row — one updateTableCell call per column (Phase
      // itself may also change shape, e.g. "05" -> "5" per #1659).
      const phaseResult = updateTableCell(tableText, rowMatch, 'Phase', ` ${phaseNum} `);
      if (phaseResult.ok) tableText = phaseResult.value;
      const plansResult = updateTableCell(tableText, rowMatch, 'Plans', ` ${summaryCount} `);
      if (plansResult.ok) tableText = plansResult.value;
      const totalResult = updateTableCell(tableText, rowMatch, 'Total', ' - ');
      if (totalResult.ok) tableText = totalResult.value;
      const avgResult = updateTableCell(tableText, rowMatch, 'Avg/Plan', ' - ');
      if (avgResult.ok) tableText = avgResult.value;

      content = before + tableText;
    } else {
      // Row doesn't exist — INSERT a new row. Row insertion (unlike a cell
      // update) is outside updateTableCell's scope (ADR-2143 §7 Phase 4);
      // `insertTableRow` (markdown-table.cjs) is its name-addressed,
      // header-order-agnostic sibling (#2245 audit: this used to locate the
      // table via `byPhaseTablePattern`, a canonical-column-ORDER-only regex,
      // and build the row as a hardcoded positional literal — so a reordered/
      // superset By-Phase header, already tolerated above by
      // findTableStartOffset and read by-NAME in the update/sum halves,
      // silently inserted NOTHING).
      //
      // Drop a lone all-placeholder row first (e.g. the freshly-scaffolded
      // "| - | - | - | - |" seed row) — same convention the prior
      // canonical-order path used, generalized to any column order/count:
      // a row whose every PRESENT cell is "-" is the placeholder.
      const placeholderRow = (row: Record<string, string>): boolean =>
        Object.values(row).every((cell) => cell.trim() === '-');
      const withoutPlaceholder = deleteTableRow(tableText, placeholderRow);
      if (withoutPlaceholder.ok) tableText = withoutPlaceholder.value;

      // Map the By-Phase values onto the table's ACTUAL header columns by
      // NAME — an unrecognized column (a superset header) falls back to "-",
      // insertTableRow's default.
      const valueFor = (col: string): string | undefined => {
        if (col === 'Phase') return String(phaseNum);
        if (col === 'Plans') return String(summaryCount);
        if (col === 'Total' || col === 'Avg/Plan') return '-';
        return undefined;
      };
      const insertResult = insertTableRow(tableText, valueFor);
      if (insertResult.ok) tableText = insertResult.value;

      content = before + tableText;
    }
  }

  // Velocity: Total plans completed — DERIVED as the sum of the By-Phase Plans column
  // across all data rows. Idempotent by construction (re-running phase complete upserts
  // the same row → same sum) and self-healing (a hand-edited inflated total is corrected
  // to the true sum on the next completion). When the By-Phase table is absent, leave the
  // velocity total unchanged rather than guess. (#1582)
  //
  // Ragged-tolerant AND name-addressed (#2245 audit): each data row is split via
  // `splitTableRow` and its "Plans" cell located by the HEADER's own column
  // order (not a fixed ordinal), so a reordered/superset By-Phase header is
  // summed correctly instead of silently reading the wrong cell. A row that's
  // too short to physically contain the "Plans" column is skipped, not
  // treated as an error — mirrors updateTableCell's ragged-row tolerance
  // (a hand-edited/ragged row for one phase must not blank out the derived
  // total for every phase). Still scoped via findTableStartOffset so the RIGHT
  // table is summed when an earlier unrelated table also has a "Phase"
  // column (#2012).
  if (/Total plans completed:\s*(\d+|\[N\])/.test(content)) {
    const sumTableStart = findTableStartOffset(content, byPhaseCols);
    if (sumTableStart !== null) {
      const tableLines = content.slice(sumTableStart).split(/\r?\n/);
      const headerCells = splitTableRow(tableLines[0] ?? '');
      const plansIdx = headerCells.indexOf('Plans');
      let sum = 0;
      if (plansIdx !== -1) {
        // The delimiter row is skipped by NAME (isDelimiterRow), not by a
        // hardcoded "always line index 1" assumption, so this stays
        // self-consistent with the ragged-tolerant read below.
        const delimiterCells = splitTableRow(tableLines[1] ?? '');
        const dataStart = isDelimiterRow(delimiterCells) ? 2 : 1;
        for (const row of tableLines.slice(dataStart)) {
          if (!row.trim().startsWith('|')) break;
          const cells = splitTableRow(row);
          if (plansIdx < cells.length && /^\d+$/.test(cells[plansIdx])) {
            sum += parseInt(cells[plansIdx], 10);
          }
        }
      }
      content = content.replace(
        /Total plans completed:\s*(\d+|\[N\])/,
        `Total plans completed: ${sum}`,
      );
    }
  }

  return content;
}

/**
 * Gate 3a: Record state after plan-phase completes.
 * Updates Status to "Ready to execute", Total Plans, Last Activity.
 */
function cmdStatePlannedPhase(cwd: string, phaseNumber: string | number, phaseName: string | null | undefined, planCount: number | null | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  // ADR-1769 Phase 4: dispatches to the STATE.md Transition Module. The RMW
  // callback that lived here (body strip/reassemble, template-aware Status +
  // Last Activity, Total Plans in Phase, Last Activity Description, Current
  // Position section update) is the pure `plannedPhaseCore` in
  // src/state-transition.cts, backed by the field-classification table.
  // resync:false is preserved: plan-phase must NOT re-derive milestone-wide
  // progress.* from a half-planned disk snapshot (#500 RC1). readModifyWriteStateMd
  // still owns the lock, the #1230 preservation, and the no-op write guard.
  const intent: StateTransitionIntent = {
    kind: 'plannedPhase',
    phaseNumber,
    phaseName: phaseName ?? null,
    planCount: planCount ?? null,
  };
  const deps: StateTransitionDeps = {
    clock: realClock,
    sourcePath: statePath,
  };

  // #3395 / #2736: the transition holds the exact display name. plannedPhaseCore
  // writes it into the Current Position `Phase: N (Name) — READY TO EXECUTE`
  // line, and the prose re-derivation of current_phase_name truncates names
  // that themselves contain a parenthetical — the authoritative override keeps
  // the exact value, exactly as cmdStateBeginPhase does for its EXECUTING line.
  //
  // #3834: without a name, the body-source delta rule that would normally
  // preserve the curated `current_phase_name` (FIELD_CLASSIFICATION:
  // preserve-when-unchanged) cannot fire — THIS write rewrites the `Phase:`
  // source line to `N — READY TO EXECUTE` itself, so pre/post disagree by
  // construction and the post-sync re-derivation harvests "READY TO EXECUTE"
  // as if it were the name. The fix mirrors the named-arg path: reassert an
  // authoritative override, falling back to the pre-write curated value (read
  // inside the RMW callback, before this write's own body mutation) rather
  // than leaving the field to a delta heuristic this exact transition defeats.
  const divergedFields: string[] = [];
  // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
  // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
  const preWriteState: StatePreWriteSnapshot = {};
  const rmwOptions: ReadModifyWriteOptions = {
    resync: false,
    deriveProgressKeys: true,
    authoritativeFm: intent.phaseName ? { current_phase_name: intent.phaseName } : undefined,
    divergedFields,
    preWriteState,
  };

  let precomputedUpdated: string[] = [];
  readModifyWriteStateMd(statePath, (content) => {
    if (!intent.phaseName) {
      const preFm = extractFrontmatter(content, statePath) as Record<string, unknown>;
      const curatedName = preFm['current_phase_name'];
      if (typeof curatedName === 'string' && curatedName.trim().length > 0) {
        rmwOptions.authoritativeFm = { current_phase_name: curatedName };
      }
    }
    const result = transitionCore(content, intent, deps);
    precomputedUpdated = result.updated;
    return result.content;
  }, cwd, rmwOptions);

  // ADR-3408 §8.4 (D4): reconcile `plannedPhaseCore`'s own success list
  // against the bytes actually persisted (fix(#3351) generalized) and fold
  // in any field preservation restored that this transform never touched
  // (#3345's direction) — traced for this phase (design doc: "not traced in
  // the analysis pass") and found to need exactly the same treatment as
  // `cmdStateBeginPhase`.
  const updated = reconcileReportedFields(statePath, preWriteState, precomputedUpdated, divergedFields);

  const result = updated.length === 0
    ? { updated, phase: phaseNumber, plan_count: planCount, warning: 'STATE.md Current Position has no recognized labels — transition was a no-op. Verify STATE.md uses the canonical labeled format (Status:, Total Plans in Phase:, etc.).' }
    : { updated, phase: phaseNumber, plan_count: planCount };
  output(result, raw, updated.length > 0 ? 'true' : 'false');
  // #3227 (design doc §40 row 26 / "Not-corruption" rule): gate on
  // `updated.length > 0`, NOT on `readModifyWriteStateMd`'s own write-happened
  // return value. The two are NOT equivalent here: readModifyWriteStateMd's
  // #948 no-op guard compares the transform's RAW returned string against the
  // RAW original file content, but `syncStateFrontmatter`'s progress-block
  // sync and this command's `authoritativeFm: {current_phase_name}` override
  // both run INSIDE the transform (via `frontmatterMod.reconstructFrontmatter`
  // over `existingFm`), so an unrecognized-format STATE.md — zero fields the
  // transition could actually apply, `updated: []`, the "transition was a
  // no-op" warning above — can still make the raw returned string differ
  // from the input (frontmatter gets synthesized: `gsd_state_version`,
  // `last_updated`, a zeroed `progress` block, `current_phase_name`), so the
  // RMW guard does NOT fire and a real write happens. That write is not a
  // meaningful state transition by this command's OWN reporting contract
  // (`updated: []`) — publishing on it would refresh state.json's
  // `updated_at` for a call this command itself reports did nothing.
  // `updated.length > 0` is the field-classification-table-backed signal
  // that actually answers "did plannedPhaseCore itself change anything this
  // caller asked it to change" — empirically verified: an unrecognized-format
  // STATE.md reproduces `updated: []` with a genuine (frontmatter-only) disk
  // write underneath it, and gating on `updated.length > 0` is what makes
  // this reproducer NOT publish.
  if (updated.length > 0) publishStateContract(cwd);
}

/**
 * Bug #2630: reset STATE.md for a new milestone cycle.
 * Stomps frontmatter milestone/milestone_name/status/progress AND rewrites
 * the Current Position body. Preserves Accumulated Context.
 * Symmetric with the SDK `stateMilestoneSwitch` handler.
 */
function cmdStateMilestoneSwitch(cwd: string, version: string | undefined, name: string | undefined, raw: boolean): void {
  if (!version || !String(version).trim()) {
    output({ error: 'milestone required (--milestone <vX.Y>)' }, raw, undefined);
    return;
  }
  const resolvedName = (name && String(name).trim()) || 'milestone';
  const statePath = planningPaths(cwd).state;

  // ADR-1769 Phase 4: dispatches to the STATE.md Transition Module. The reset
  // policy (frontmatter rebuild + Current Position body reset) is the pure
  // `milestoneSwitchCore` in src/state-transition.cts. acquireStateLock +
  // platformWriteSync are retained (NOT readModifyWriteStateMd) because
  // milestoneSwitch rebuilds frontmatter directly and must not run the
  // steady-state syncStateFrontmatter post-sync.
  const intent: StateTransitionIntent = { kind: 'milestoneSwitch', version, name: resolvedName };
  const deps: StateTransitionDeps = { clock: realClock, sourcePath: statePath };

  let switched = false;
  const lockPath = acquireStateLock(statePath);
  try {
    const content = platformReadSync(statePath) || '';
    const result = transitionCore(content, intent, deps);
    platformWriteSync(statePath, result.content);
    output(
      { switched: true, version, name: resolvedName, status: 'planning' },
      raw,
      'true',
    );
    switched = true;
  } finally {
    releaseStateLock(lockPath);
  }
  // #3227: publish AFTER releaseStateLock — publishStateContract derives `next`
  // from classifyProject, which shells out to git (bounded, but up to 3 x 10s).
  // Holding the STATE.md lock across that would turn a millisecond hold into a
  // git-bound one for every concurrent GSD process.
  if (switched) publishStateContract(cwd);
}

/**
 * Gate 1: Validate STATE.md against filesystem.
 * Returns { valid, warnings, drift, scope } JSON.
 *
 * #3187 (ADR-3180 §7.7, Decisions 2-4): two defects fixed here.
 *
 * (1) #3162 THE HEADLINE. Every warning this function can emit used to be
 * gated behind `if (currentPhase && fs.existsSync(phasesDir))`, and
 * `currentPhase` came from a body-only `stateExtractField(content, 'Current
 * Phase')` call with no frontmatter fallback. A STATE.md whose phase lives
 * ONLY in frontmatter therefore resolved `currentPhase` to `null`, the whole
 * drift block was skipped, and the function returned
 * `{valid:true, warnings:[], drift:{}}` — "could not look" was
 * output-identical to "looked, all clean." Current Phase / Status / Total
 * Plans in Phase now route through `stateFieldValue` (the single owner of the
 * #1760 frontmatter-then-body fallback chain), so the frontmatter tier is
 * actually consulted.
 *
 * (2) #1255 FRONTMATTER SHADOWING. The old code passed UNSTRIPPED `content`
 * to the extractor. `stateExtractField`'s plain-format branch is
 * `^Field:` with the `i` flag, so a frontmatter `status:` key matched the
 * pattern for the body field `Status` and won, because the frontmatter block
 * precedes the body. Parsed once now — `extractFrontmatter` +
 * `stripFrontmatter` — and `fm`/`body` are handed to the chain owner, exactly
 * as `advancePlanCore`/`beginPhaseCore`/`completePhaseCore`/
 * `readModifyWriteStateMd` already guard against this class of defect.
 *
 * `scope` (ADR-3180 Decision 2) reports whether the derivation actually ran:
 *   - `COMPLETE`  — the phase-vs-disk derivation ran over usable input,
 *     including when it legitimately finds no VERIFICATION.md / no matching
 *     phase directory (a real answer, not a non-answer).
 *   - `UNSCOPED`  — Current Phase could not be resolved by ANY chain step (no
 *     frontmatter scalar, no body field), so the drift derivation had no
 *     phase to scope its disk lookup to and could not run at all. Reporting
 *     this as COMPLETE would recreate the #3162 collapse this phase closes,
 *     one layer out.
 *   - `UNREADABLE` — the frontmatter parse or the phases-dir scan itself
 *     could not be consulted (an existing `catch` block used to swallow this
 *     silently; the degrade stays, but is now visible).
 *
 * ⛔ Rejected (ADR-3180 §7.7 Rejected #2): a non-`COMPLETE` scope is never
 * routed to `valid:false`. `valid` keeps meaning "no drift warnings were
 * found"; `scope` says whether the derivation could actually run. A caller
 * branches on both — folding them into one boolean recreates the exact
 * collapse this epic removes, in the opposite direction (a legacy STATE.md
 * with no resolvable phase is a supported degrade, not an invalid document).
 */

/**
 * #1255/#3187: parse frontmatter and strip it from the body ONCE, shared by
 * `cmdStateValidate` and `cmdStateCompletePhase` so both consult the identical
 * fm/body precedence and degrade identically when the frontmatter half of the
 * chain cannot be consulted. Extracted (code-review finding, epic #3180): the
 * two call sites previously carried a byte-identical try/catch, comments
 * included — an epic whose own thesis is "one canonical owner per
 * derivation" must not ship a duplicated derivation in its own diff.
 *
 * Returns `scope: SCOPE.COMPLETE` unless the frontmatter parse itself threw,
 * in which case `fm` degrades to `{}` and `scope` becomes `SCOPE.UNREADABLE`
 * — callers that mutate `scope` further (e.g. `cmdStateValidate`'s later
 * UNSCOPED/disk-scan degrades) start from this returned value rather than a
 * fresh `SCOPE.COMPLETE`.
 */
function readStateFrontmatterScoped(content: string, statePath: string): { fm: Record<string, unknown>; body: string; scope: planningScopeMod.Scope } {
  let fm: Record<string, unknown>;
  let scope: planningScopeMod.Scope = SCOPE.COMPLETE;
  try {
    fm = extractFrontmatter(content, statePath);
  } catch {
    // extractFrontmatter is documented never to throw, but this mirrors the
    // defensive try/catch already used around it elsewhere in this file
    // (e.g. spliceFrontmatter) — a parse hiccup here means the frontmatter
    // half of the chain could not be consulted; degrade visibly.
    fm = {};
    scope = SCOPE.UNREADABLE;
  }
  const body = stripFrontmatter(content);
  return { fm, body, scope };
}

/**
 * Builds an S0NN `Diagnostic` for `cmdStateValidate` (§8.4 rule 3 —
 * `cmdStateValidate` is a plain imperative function, not a `Rule.check`, so
 * it builds `Diagnostic[]` directly rather than going through
 * `evaluateRuleTable`/the `RULES` array machinery). Every S0NN subject is
 * advisory-only today (`cmdStateValidate` has never had a repair path), so
 * every remedy is `adviseRemedy` — `advice` is the short imperative command
 * text shown to the operator, matching the style Phase 11's rule-group files
 * already use for their own ADVISE-only findings (e.g.
 * `roadmap-disk-consistency.cts`'s `adviseRemedy('Create phase directory or
 * remove from roadmap')`).
 */
function stateDiagnostic(code: string, severity: Severity, message: string, advice: string): Diagnostic {
  return { code, severity, message, remedy: adviseRemedy(advice) };
}

function cmdStateValidate(cwd: string, raw: boolean, opts: { strict?: boolean } = {}): void {
  const statePath = planningPaths(cwd).state;
  // #3696: `valid: false` used to exit 0, so a CI step or git hook could not gate
  // on state correctness without parsing JSON — every consumer had to
  // re-implement the "is this actually valid" decision, which is the
  // duplication #3473 is about.
  //
  // The DEFAULT is deliberately unchanged. `state validate`'s exit status is
  // Tier-2 observable output reaching "downstream projects that cannot be
  // enumerated" (ADR-3180 Decision 3, Hyrum's Law), so flipping 0 -> 1 for
  // everyone would break every script that runs it unconditionally. `--strict`
  // is the opt-in the issue itself offers as the alternative.
  //
  // Routed through one emit helper rather than a trailing assignment because
  // three of the exit paths below (`STATE.md not found`, S001, and the four
  // `return` branches in the phase-drift scan) emit and return early — a fix
  // that only set the exit code at the end of the function would silently miss
  // them, which is exactly the shape of the bug being fixed.
  const emit = (payload: { valid?: boolean; error?: string; warnings?: Diagnostic[]; scope?: planningScopeMod.Scope }): void => {
    if (opts.strict && payload.valid !== true) process.exitCode = 1;
    output(payload, raw, undefined);
  };
  if (!fs.existsSync(statePath)) {
    emit({ error: 'STATE.md not found' });
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  // #2701: fail loud on NUL/binary corruption before drift checks. A corrupt
  // STATE.md otherwise validates as clean and is silently skipped by recursive
  // searchers downstream, reading as "absent" rather than "corrupt."
  const encErr = textEncodingError(content, 'STATE.md');
  if (encErr) {
    // S001 — error-class severity (this branch has always set `valid: false`
    // unconditionally and returned immediately, matching every other
    // error-class code, not a mere warning). Message reused verbatim from
    // `textEncodingError`, not paraphrased.
    emit({
      valid: false,
      warnings: [stateDiagnostic('S001', SEVERITY.ERROR, encErr, 'Re-save STATE.md as UTF-8 text with the embedded NUL byte(s) removed')],
    });
    return;
  }
  const warnings: Diagnostic[] = [];

  // #1255/#3187: parse frontmatter and strip it from the body ONCE, so the
  // chain owner sees the same fm/body precedence every other migrated call
  // site sees. Pass statePath so a truncated STATE.md is named in the #1882
  // diagnostic rather than reported under a content digest.
  const { fm, body, scope: initialScope } = readStateFrontmatterScoped(content, statePath);
  const scope: planningScopeMod.Scope = initialScope;

  const status = stateFieldValue(fm, body, 'status', 'Status').value || '';
  const resolvedPhase = resolveStatePhase(fm, body);
  const currentPhase = resolvedPhase.phase;
  const totalPlansRaw = stateFieldValue(fm, body, 'total_plans_in_phase', 'Total Plans in Phase').value;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;

  const phasesDir = planningPaths(cwd).phases;

  if (currentPhase === null) {
    warnings.push(stateDiagnostic(
      'S002',
      SEVERITY.WARNING,
      'Cannot validate phase drift: STATE.md has no usable current_phase, Current Phase, or Current Position Phase value',
      'Set current_phase (frontmatter) or Current Phase / Current Position Phase (body) in STATE.md',
    ));
    emit({ valid: false, warnings, scope });
    return;
  }
  const selectedPhaseKey = phaseKeyFromToken(currentPhase);
  if (Object.values(resolvedPhase.sources).some(source => source !== null && phaseKeyFromToken(source) !== selectedPhaseKey)) {
    warnings.push(stateDiagnostic(
      'S003',
      SEVERITY.WARNING,
      `Phase reference conflict: validating authoritative phase ${currentPhase}; align STATE.md phase sources`,
      'Align STATE.md phase sources (frontmatter, Current Phase, Current Position Phase) on one phase',
    ));
  }
  if (!fs.existsSync(phasesDir)) {
    warnings.push(stateDiagnostic(
      'S004',
      SEVERITY.WARNING,
      `Cannot validate phase drift: phases directory is missing for phase ${currentPhase}`,
      'Create the phases directory or correct current_phase to a phase that exists on disk',
    ));
    emit({ valid: false, warnings, scope });
    return;
  }
  // #612: #3208 replaced this lookup's `startsWith` prefix test with the
  // canonical key comparison — which is the right surface, and is exactly why it
  // now needs the convention. `phaseKeyFromDir` refuses to read a bracket
  // directory without an explicit signal (a bracket dir is string-
  // indistinguishable from the legacy letter-prefixed-decimal family, ADR-2121),
  // so un-threaded it returns the WHOLE dir name as the key —
  // `GSD.02-05-delta` -> `GSD.02-5-DELTA` — while `selectedPhaseKey` is the bare
  // `05` that `parsePhaseFromProse` yields. The two sides of one comparison were
  // derived under different conventions, which is #2562's defect class and the
  // thing this file's other three `phaseKeyFromDir` call sites already thread
  // against. Un-threaded, a bracket repo whose phase directory plainly exists
  // reports `no phase directory matches phase 05` and `valid: false` — a
  // wrong-and-confident answer on precisely the repos this convention supports.
  // Resolved here rather than reusing a caller's value because cmdStateValidate
  // has no other convention-dependent read. Non-bracket conventions (null,
  // 'milestone-prefixed', unresolvable) are byte-identical to the un-threaded
  // call by construction: `extractPhaseToken` branches only on `=== 'bracket'`.
  const validateConvention = resolvePhaseIdConvention(cwd);
  let phaseDirPath: string;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const phaseDir = entries.find(entry => entry.isDirectory() && phaseKeyFromDir(entry.name, validateConvention) === selectedPhaseKey);
    if (!phaseDir) {
      warnings.push(stateDiagnostic(
        'S004',
        SEVERITY.WARNING,
        `Cannot validate phase drift: no phase directory matches phase ${currentPhase}`,
        'Create a phase directory matching the current phase or correct current_phase',
      ));
      emit({ valid: false, warnings, scope });
      return;
    }
    phaseDirPath = path.join(phasesDir, phaseDir.name);
  } catch {
    warnings.push(stateDiagnostic(
      'S004',
      SEVERITY.WARNING,
      `Cannot validate phase drift: phases directory is unreadable for phase ${currentPhase}`,
      'Check phases directory permissions and re-run validate',
    ));
    emit({ valid: false, warnings, scope });
    return;
  }
  try {
    const scan = scanPhasePlans(phaseDirPath);
    if (scan.scope !== SCOPE.COMPLETE) {
      throw new Error('phase plan scan is incomplete');
    }
    const { planCount: diskPlans, summaryCount: diskSummaries } = scan;

        // Check plan count mismatch
        if (totalPlansInPhase !== null && diskPlans !== totalPlansInPhase) {
          warnings.push(stateDiagnostic(
            'S005',
            SEVERITY.WARNING,
            `Plan count mismatch: STATE.md says ${totalPlansInPhase} plans, disk has ${diskPlans}`,
            'Run state sync or correct Total Plans in Phase to match the plans on disk',
          ));
        }

        // Check for VERIFICATION.md — scoped to THIS phase's own token (#3511)
        // so a stray, cross-phase, or ad-hoc VERIFICATION file cannot claim
        // this phase's status has drifted.
        //
        // WARNING-4 (#3511 review): the pre-filter grammar here is
        // deliberately BROADER than the `-VERIFICATION.md` suffix every
        // other site in the codebase uses — `.includes('VERIFICATION')`
        // admits names like `03_VERIFICATION.md` (underscore, no dash) that
        // the dashed grammar would reject outright. That breadth predates
        // #3511 and is intentional here (this is a best-effort drift
        // WARNING scan, not an authoritative single-pick resolver), so it is
        // left as-is rather than narrowed to match the dashed sites — doing
        // so would be a separate, un-asked-for behavior change (S006/S007).
        // What #3511 DOES change is that a name this broader grammar admits
        // is now ALSO subject to the same `scopeToPhase` membership check as
        // every dashed-grammar site, so a stray `04_VERIFICATION.md`-shaped
        // file in phase 03's directory is excluded exactly like a stray
        // `04-VERIFICATION.md` would be — while `03_VERIFICATION.md` (own
        // phase, underscore separator) is NOT excluded: `isPhaseArtifact`
        // (`phase-id.cts`) accepts `_` as a candidate-boundary separator
        // alongside `-` and `.` for exactly this reason, so an S006/S007
        // scan of `03-alpha/03_VERIFICATION.md` still resolves to S006
        // ("verification passed" drift), not a false S007.
        const files = fs.readdirSync(phaseDirPath);
        const phaseDirBaseName = path.basename(phaseDirPath);
        // #612: `validateConvention` threaded (already resolved above for
        // `phaseKeyFromDir`) so the S006/S007 scan scopes bracket dirs by
        // their real token instead of the include-everything fail-safe.
        const verificationFiles = scopeToPhase(
          files.filter(f => f.includes('VERIFICATION') && f.endsWith('.md')),
          phaseDirBaseName,
          validateConvention,
        );
        for (const vf of verificationFiles) {
          try {
            const vContent = fs.readFileSync(path.join(phaseDirPath, vf), 'utf-8');
            if (/status:\s*passed/i.test(vContent) && /executing/i.test(status)) {
              warnings.push(stateDiagnostic(
                'S006',
                SEVERITY.WARNING,
                `Status drift: STATE.md says "${status}" but ${vf} shows verification passed — phase may be complete`,
                'Run state complete-phase (or otherwise advance STATE.md status past "executing")',
              ));
            }
          } catch { /* best-effort (#2245 audit): cmdStateValidate is a diagnostic
             * warnings scan across N VERIFICATION.md files — one unreadable file
             * (permission/race) must not abort the scan of the rest; it's simply
             * excluded from drift detection. Does not degrade `scope` — the other
             * N-1 files were consulted fine. */ }
        }

        // Check if all plans have summaries but status still says executing
        if (diskPlans > 0 && diskSummaries >= diskPlans && /executing/i.test(status)) {
          // Only warn if no verification exists (if verification passed, the above warning covers it)
          if (verificationFiles.length === 0) {
            // S007 stays WARNING (not INFO): closely related to S006 (both
            // signal "phase may be ready to advance"), and S006 is WARNING —
            // giving the sibling condition a different severity for the same
            // underlying signal would be a false distinction.
            warnings.push(stateDiagnostic(
              'S007',
              SEVERITY.WARNING,
              `All ${diskPlans} plans have summaries but status is still "${status}" — phase may be ready for verification`,
              'Run phase verification, then advance STATE.md status past "executing"',
            ));
          }
        }
  } catch {
    warnings.push(stateDiagnostic(
      'S004',
      SEVERITY.WARNING,
      `Cannot validate phase drift: phase directory is unreadable for phase ${currentPhase}`,
      'Check phase directory permissions and re-run validate',
    ));
  }

  // #3696 — the `last_activity` invariant. Three readers consumed this field
  // and none of them checked it, so a value no reader can parse validated as
  // `{valid:true, warnings:[], scope:'complete'}`: the scan ran to completion
  // and simply never looked. Read through the same owner every other field here
  // uses (ADR-3180 §7.7) — never a private `stateExtractField` call, which is
  // what `scripts/lint-state-field-drift.cjs` counts.
  const lastActivity = stateFieldValue(fm, body, 'last_activity', 'Last activity').value;
  // NOT FILLED IN IS NOT DRIFT, and that covers three shapes, not one: absent,
  // blank, and the shipped template's `[YYYY-MM-DD] — [What happened]`
  // placeholder. Only a value a writer actually supplied can be wrong.
  if (!isUnfilledFieldValue(lastActivity)) {
    // Calendar validity, not merely `\d{4}-\d{2}-\d{2}` shape: smart-entry's
    // reader rejects 2026-02-30 via isRealCalendarDate (ADR-227 — validate shape
    // AND value). Accepting it here would leave the two surfaces disagreeing
    // about whether the file is usable, which is the complaint #3696 opens with.
    //
    // Review round 2: this asserts the LEADING date token, not
    // `parseProseLastActivityField`'s fully-anchored `date — description`
    // grammar. That grammar is stricter than any real reader, and routing the
    // check through it made S008 fire on values smart-entry parses fine (e.g.
    // `2026-08-24 Shipped feature X`, no dash separator) — the same
    // two-surfaces-disagree defect, pointing the other way. See
    // `leadingCalendarDate`.
    if (leadingCalendarDate(lastActivity) === null) {
      warnings.push(stateDiagnostic(
        'S008',
        SEVERITY.WARNING,
        `Unreadable last activity: "${lastActivity}" does not begin with a real calendar date, so no reader can date this project's activity`,
        'Rewrite the Last activity line to begin with a date that exists, as "YYYY-MM-DD — what happened"',
      ));
    }

    // The attached half of #3696: `templates/state.md` prescribes a single-line
    // field, but writers emit descriptions long enough to wrap, and
    // `stateExtractField`'s newline-excluding `(.+)` drops the remainder with no
    // diagnostic. The DOCUMENT is what violates the template here, so this
    // reports the violation rather than teaching the reader a multi-line grammar
    // the template does not sanction (ADR-3180 §7.7 Rejected #1 forbids widening
    // stateExtractField, which has 20 callers and a CRITICAL blast radius).
    //
    // Scan the body ONLY when the body is what was actually read. The ladder
    // prefers the frontmatter scalar, so a document carrying a clean
    // `last_activity:` in frontmatter AND a stale, wrapped `Last activity:` line
    // in the body would otherwise report S009 — and exit 1 under `--strict` —
    // over a remainder that no reader consumes and whose field is entirely
    // valid. Asking the owner with an EMPTY body isolates the frontmatter rung
    // without re-deriving the ladder here (which is what
    // `scripts/lint-state-field-drift.cjs` counts).
    const fromFrontmatter = stateFieldValue(fm, '', 'last_activity', 'Last activity').value;
    const dropped = fromFrontmatter !== null ? null : stateFieldContinuation(body, 'Last activity');
    if (dropped !== null) {
      warnings.push(stateDiagnostic(
        'S009',
        SEVERITY.WARNING,
        `Truncated last activity description: "${dropped}" follows the Last activity line and is silently dropped by every reader`,
        'Fold the Last activity description onto one line — the template prescribes a single-line field',
      ));
    }
  }

  const valid = warnings.length === 0;
  emit({ valid, warnings, scope });
}

/**
 * Gate 2: Sync STATE.md from filesystem ground truth.
 * Scans phase dirs, reconstructs counters, progress, metrics.
 * Supports --verify for dry-run mode.
 */
function cmdStateSync(cwd: string, options: StateSyncOptions | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const verify = options && options.verify;
  const content = fs.readFileSync(statePath, 'utf-8');
  // ADR-3473 §8.5 (#3881): `state sync` is on ADR-3408 §8.3's closed
  // sanctioned-regenerate list — "the body wins" — and `syncStateFrontmatter`
  // (below, via `writeStateMd`'s `sanctionedPermanentEmptyFallback`) is
  // therefore CORRECT to overwrite even an unparseable existing frontmatter
  // block (git merge-conflict markers, malformed YAML). What was missing was
  // disclosure: a derived conclusion (`synced: true`) must not be reported as
  // authoritative when the derivation dropped input it could not resolve
  // (§8.5) — silently destroying the only copy of an unreadable block with no
  // signal is "failure is a value" (§8.4) violated. Computed once, up front,
  // from the pre-write snapshot so both the `--verify` (dry-run) and the real
  // write branch can surface it identically.
  const existingSyncFm = extractFrontmatter(content, statePath) as Record<string, unknown>;
  const syncFrontmatterWasUnparseable = isUnparseableFrontmatter(existingSyncFm);
  const changes: string[] = [];
  let modified = content;


  const phasesDir = planningPaths(cwd).phases;
  if (!fs.existsSync(phasesDir)) {
    output({ synced: true, changes: [], dry_run: !!verify }, raw, undefined);
    return;
  }

  // #1514: read the current-milestone ROADMAP scope once so retired/folded
  // phases are excluded from BOTH the disk scan and the heading count here,
  // exactly as buildStateFrontmatter does — otherwise `state sync --verify`
  // would keep re-deriving the inflated denominator and report "no drift".
  let syncRoadmapScope: string | null = null;
  let syncRoadmapRaw: string | null = null;
  let syncRetiredPhaseNums = new Set<string>();
  const syncConvention = resolvePhaseIdConvention(cwd);
  try {
    const roadmapRaw = platformReadSync(path.join(planningDir(cwd), 'ROADMAP.md'));
    if (roadmapRaw !== null) {
      syncRoadmapRaw = roadmapRaw;
      syncRoadmapScope = extractCurrentMilestone(roadmapRaw, cwd);
      syncRetiredPhaseNums = extractRetiredPhaseNumbers(syncRoadmapScope, syncConvention);
    }
  } catch { /* fall through: no roadmap scope → no retired exclusion */ }

  // #2761 Major 1 (round-2 adversarial review): this disk scan fed
  // totalDiskPlans/totalDiskSummaries/diskCompletedPhases/syncTotalPhases
  // below UNFILTERED — no milestone-window filter, unlike
  // buildStateFrontmatter's identical-purpose scan a few hundred lines above
  // (`:1698`). One command (`state sync`) therefore wrote TWO contradictory
  // numbers into the same STATE.md: frontmatter total_phases/completed_phases
  // milestone-scoped correctly (via the READ derivation), body Progress
  // percent computed from the whole disk. On the ADR-canonical version-less
  // bracket fixture (4 dirs, 3 complete; asserted milestone = 2 phases, both
  // complete): body wrote 75% where 100% is true (repro3).
  //
  // GATED on `syncConvention === 'bracket'` — an unconditional filter would
  // ALSO move LEGACY sync percents, since the milestone-scoping-vs-whole-disk
  // divergence this fixes is engine-wide, not bracket-specific; the gate
  // keeps legacy byte-identical, which is the binding constraint here. This
  // is a DEVIATION from an earlier "mirror :1698 unconditionally" phrasing —
  // deliberate, not an oversight: legacy repos are DOWNSTREAM of a Progress
  // percent that has read this way for a long time, and moving it as a side
  // effect of a bracket-only PR is out of this fix's scope.
  // Upstream #3185 made `listMilestonePhaseDirs` the sole phase-directory
  // enumeration owner; it delegates window membership to
  // getMilestonePhaseFilter. Cache that owner's bracket result as a set and
  // compose it with this scan, rather than restoring the retired direct
  // parser dependency. Legacy retains this scan's prior pass-all behavior.
  const syncMilestonePhaseDirs = syncConvention === 'bracket'
    ? new Set(listMilestonePhaseDirs(phasesDir, { cwd, phaseIdConvention: syncConvention }).value)
    : null;

  // Scan all phases
  let entries: string[];
  try {
    entries = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => !(syncRetiredPhaseNums.size > 0 && syncRetiredPhaseNums.has(phaseKeyFromDir(name, syncConvention))))
      .filter(name => syncMilestonePhaseDirs === null || syncMilestonePhaseDirs.has(name))
      .sort();
  } catch {
    output({ synced: true, changes: [], dry_run: !!verify }, raw, undefined);
    return;
  }

  let totalDiskPlans = 0;
  let totalDiskSummaries = 0;
  let diskCompletedPhases = 0;
  let highestIncompletePhase: string | null = null;
  let _highestIncompletePhaseNum: string | null = null;
  let highestIncompletePhaseplanCount = 0;
  let _highestIncompletePhaseSummaryCount = 0;

  for (const dir of entries) {
    const dirPath = path.join(phasesDir, dir);
    const { planCount: plans, summaryCount: summaries } = scanPhasePlans(dirPath);
    totalDiskPlans += plans;
    totalDiskSummaries += summaries;
    // ADR-3180 §7.4 (#3186, #2957 disk-strict): route through the single
    // canonical owner (isPhaseComplete), not scanPhasePlans's own `completed`
    // field ("are all plans summarized?" — a different question). This is the
    // same fix buildStateFrontmatter got above; cmdStateSync (`state sync`)
    // was a second, independent consumer of the same raw field the initial
    // migration missed — without it, `state sync` and `state json` disagreed
    // on completed_phases for the identical disk state.
    // #612: `syncConvention` threaded — the write-side half of
    // buildStateFrontmatter's thread above, so `state sync` and `state json`
    // keep agreeing on completed_phases under the bracket convention.
    if (isPhaseComplete(dirPath, { convention: syncConvention }).value.complete) diskCompletedPhases++;

    // Track the highest phase with incomplete plans (or any plans)
    const phaseMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    if (phaseMatch && plans > 0) {
      if (summaries < plans) {
        // Incomplete phase — this is likely the current one
        highestIncompletePhase = dir;
        _highestIncompletePhaseNum = phaseMatch[1];
        highestIncompletePhaseplanCount = plans;
        _highestIncompletePhaseSummaryCount = summaries;
      } else if (!highestIncompletePhase) {
        // All complete, track as potential current
        highestIncompletePhase = dir;
        _highestIncompletePhaseNum = phaseMatch[1];
        highestIncompletePhaseplanCount = plans;
        _highestIncompletePhaseSummaryCount = summaries;
      }
    }
  }

  // Determine total phases from ROADMAP (may be larger than realized disk dirs).
  // #612 round-4: shares countRoadmapPhaseHeadings with buildStateFrontmatter
  // (defined just above extractRetiredPhaseNumbers) so both report
  // consistent totals off the SAME implementation, not two independently
  // maintained copies (#3242 Bug B).
  // #612 round-5: bracket sync enables the same bare-token 999 exclusion as
  // the read path and getMilestonePhaseFilter, preventing frontmatter/body
  // disagreement. Non-bracket conventions still pass false, preserving the
  // pre-existing legacy sync behavior while #3185 remains the read-path owner.
  let syncTotalPhases: number | null = null;
  const roadmapPhaseCount = syncRoadmapScope !== null
    ? countRoadmapPhaseHeadings(syncRoadmapScope, syncConvention, syncRetiredPhaseNums, syncConvention === 'bracket')
    : 0;
  if (roadmapPhaseCount > 0) {
    syncTotalPhases = Math.max(entries.length, roadmapPhaseCount);
  } else {
    syncTotalPhases = entries.length;
  }

  // ADR-1769 Phase 7: the body writes (Total Plans in Phase, Progress bar, Last
  // Activity) are the pure `syncCore` in src/state-transition.cts.
  // #1761: when a milestone version is set in frontmatter but the ROADMAP has no
  // versioned heading for it, the milestone cannot be bounded to a versioned phase
  // set — leave Progress untouched (percent=null) rather than silently writing
  // fallback-derived wrong values. Projects without a milestone version (the common
  // sync-test shape) are unaffected: the gate only fires when a version is asserted.
  const fmVersion = (extractFrontmatter(content, statePath) as Record<string, unknown>).milestone;
  const versionStr = typeof fmVersion === 'string' && fmVersion.trim() ? fmVersion.trim() : null;
  let milestoneBounded = true;
  if (versionStr !== null && syncRoadmapRaw !== null) {
    // #3184: routed through the single owner (roadmap-parser.cjs) instead of
    // a hand-rolled, unbounded-substring re-derivation — see the identical
    // fix in buildStateFrontmatter above. #612 composes its gated bracket
    // extension on top inside isMilestoneBounded.
    milestoneBounded = isMilestoneBounded(syncRoadmapRaw, versionStr, syncConvention);
  }
  let percent: number | null = null;
  if (!milestoneBounded) {
    changes.push(`Progress: skipped — milestone ${versionStr} cannot be bounded to a versioned ROADMAP phase set (#1761)`);
  } else {
    // #3217 (ADR-3180 §7.6 rule 4) BLOCKER fix: the prior comment here claimed
    // `entries` (the raw fs.readdirSync listing above) was "never routed
    // through listMilestonePhaseDirs, so there is no real Scope to pass" —
    // that was factually wrong. The same `syncRoadmapRaw`/`syncRoadmapScope`
    // already parsed above (~3104) is precisely what
    // `listMilestonePhaseDirs` (via `getMilestonePhaseFilter`) re-derives
    // from `cwd` to produce a real `Scope` — the identical shape already
    // threaded through `buildStateFrontmatter`'s `diskScope` above. Calling
    // it here (discarding `.value`, which duplicates `entries`'s own
    // retired-phase-filtered listing) gets the real scope without changing
    // the disk-scan totals computed above.
    //
    // #2761 (round-11 M2 follow-up): deliberately NOT threading
    // `phaseIdConvention` here, unlike the other call sites this same PR
    // converts. Only `.scope` is consumed (the `.value` directory list is
    // thrown away), and inside `getMilestonePhaseFilter` `scope` is computed
    // from `extractCurrentMilestoneScoped`/`classifyMilestoneWindow` BEFORE
    // `headingConvention` is resolved — `phaseIdConvention` only reaches the
    // heading/dir MEMBERSHIP scan (`scanMilestonePhaseIds`, `isDirInMilestone`)
    // that produces `.value`, never the scope discriminator itself. So the
    // `undefined` default here (lazy resolve-from-config) and an explicitly
    // threaded `syncConvention` would compute the identical `scope` either
    // way — there is no silent-inherit exposure to close at this site, only
    // at sites (milestone.cts, cmdStateUpdateProgress above) that also
    // consume `.value`.
    const syncScope: Scope = listMilestonePhaseDirs(phasesDir, { cwd, versionOverride: versionStr }).scope;
    if (syncScope !== SCOPE.COMPLETE) {
      changes.push(`Progress: skipped — milestone phase scope is "${syncScope}", not COMPLETE (#3217)`);
    } else {
      const p = computeProgressPercent(totalDiskSummaries, totalDiskPlans, diskCompletedPhases, syncTotalPhases, syncScope);
      percent = p !== null ? p : 0;
    }
  }

  const syncResult = transitionCore(
    modified,
    { kind: 'sync', totalPlansInPhase: highestIncompletePhase ? highestIncompletePhaseplanCount : null, percent },
    { clock: realClock },
  );
  modified = syncResult.content;
  const coreChanges = (syncResult.data as { changes?: string[] } | undefined)?.changes ?? [];
  changes.push(...coreChanges);

  // #3881 (ADR-3473 §8.5): only warn when a write will actually regenerate the
  // frontmatter — if nothing changed this run, the unparseable block (if any)
  // was never touched, so there is nothing to disclose. Mirrors the exact
  // condition the write branch below uses to decide whether to write at all.
  const syncWillWrite = changes.length > 0 || modified !== content;
  if (syncWillWrite && syncFrontmatterWasUnparseable) {
    const unparseableWarning =
      `gsd: warning — STATE.md's existing frontmatter could not be parsed (malformed YAML, or ` +
      `unresolved content such as git merge-conflict markers) and was regenerated from the body; ` +
      `any content in the old frontmatter block — including merge-conflict markers — has been ` +
      `replaced. (#3881)`;
    process.stderr.write(`${unparseableWarning}\n`);
    changes.push(unparseableWarning);
  }

  if (verify) {
    output({ synced: false, changes, dry_run: true }, raw, undefined);
    return;
  }

  if (syncWillWrite) {
    // ADR-3473 §8.6: `rebuild()` is the typed expression of #905's contract —
    // `state sync` exists to let the body win, so preservation must NOT run,
    // and the snapshot is carried anyway because §8.7's reporting needs it.
    writeStateMd(statePath, modified, stateTransitionMod.rebuildStateTransaction({
      snapshot: extractFrontmatter(content, statePath),
    }), cwd);
  }

  output({ synced: true, changes, dry_run: false }, raw, undefined);
}

/**
 * Prune old entries from STATE.md sections that grow unboundedly (#1970).
 * Moves decisions, recently-completed summaries, and resolved blockers
 * older than keepRecent phases to STATE-ARCHIVE.md.
 *
 * Options:
 *   keepRecent: number of recent phases to retain (default: 3)
 *   dryRun: if true, return what would be pruned without modifying STATE.md
 */
function cmdStatePrune(cwd: string, options: StatePruneOptions, raw: boolean): void {
  const silent = !!options.silent;
  const emit = silent ? () => {} : (result: Record<string, unknown>, r: boolean, v?: string) => output(result, r, v);
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { emit({ error: 'STATE.md not found' }, raw); return; }

  const keepRecent = parseInt(String(options.keepRecent), 10) || 3;
  const dryRun = !!options.dryRun;
  // Resolve the current phase via `resolveCurrentPhaseId` — the shared owner of
  // the canonical frontmatter → `Current Phase` field → scoped prose ladder
  // (#1760 origin, #1776 scoping, #3187 ownership; see its doc comment). Prune
  // engages on a template-conformant STATE.md instead of bailing "Only 0
  // phases" (#1760). #3231/#3481 routed the phase-labeled write commands
  // through the same helper rather than leaving a second copy of the ladder here.
  const rawState = fs.readFileSync(statePath, 'utf-8');
  const fm = extractFrontmatter(rawState, statePath) as Record<string, unknown>;
  const body = stripFrontmatter(rawState);
  // Prune needs an integer cutoff, so it parses the resolved id itself; a
  // non-numeric or absent id lands on 0 and prune bails, as before.
  const currentPhase = parseInt(String(resolveCurrentPhaseId(fm, body)), 10) || 0;
  const cutoff = currentPhase - keepRecent;

  if (cutoff <= 0) {
    emit({ pruned: false, reason: `Only ${currentPhase} phases — nothing to prune with --keep-recent ${keepRecent}` }, raw, 'false');
    return;
  }

  const archivePath = path.join(path.dirname(statePath), 'STATE-ARCHIVE.md');
  const archived: PrunedSection[] = [];

  // ADR-1769 Phase 7: the section-pruning is the pure `pruneCore` in
  // src/state-transition.cts (byte-identical tokenizeHeadings section splicing).
  // This adapter owns currentPhase derivation (#1760 `Phase`/`Current Phase`
  // fallback above), dry-run, and STATE-ARCHIVE.md writes.
  const runPruneCore = (content: string): { newContent: string; archivedSections: PrunedSection[] } => {
    const result = transitionCore(content, { kind: 'prune', cutoff }, { clock: realClock });
    return {
      newContent: result.content,
      archivedSections: ((result.data as { archivedSections?: PrunedSection[] } | undefined)?.archivedSections) ?? [],
    };
  };

  if (dryRun) {
    // Dry-run: compute what would be pruned without writing anything
    const content = fs.readFileSync(statePath, 'utf-8');
    const result = runPruneCore(content);
    const totalPruned = result.archivedSections.reduce((sum, s) => sum + s.count, 0);
    emit({
      pruned: false,
      dry_run: true,
      cutoff_phase: cutoff,
      keep_recent: keepRecent,
      sections: result.archivedSections.map(s => ({ section: s.section, entries_would_archive: s.count })),
      total_would_archive: totalPruned,
      note: totalPruned > 0 ? 'Run without --dry-run to actually prune' : 'Nothing to prune',
    }, raw, totalPruned > 0 ? 'true' : 'false');
    return;
  }

  readModifyWriteStateMd(statePath, (content) => {
    const result = runPruneCore(content);
    archived.push(...result.archivedSections);
    return result.newContent;
  }, cwd);

  // Write archived entries to STATE-ARCHIVE.md
  if (archived.length > 0) {
    const timestamp = realClock.localToday();
    let archiveContent = platformReadSync(archivePath);
    if (archiveContent === null) {
      archiveContent = '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
    }
    archiveContent += `## Pruned ${timestamp} (phases 1-${cutoff}, kept recent ${keepRecent})\n\n`;
    for (const section of archived) {
      archiveContent += `### ${section.section}\n\n${section.lines.join('\n')}\n\n`;
    }
    platformWriteSync(archivePath, archiveContent);
  }

  const totalPruned = archived.reduce((sum, s) => sum + s.count, 0);
  emit({
    pruned: totalPruned > 0,
    cutoff_phase: cutoff,
    keep_recent: keepRecent,
    sections: archived.map(s => ({ section: s.section, entries_archived: s.count })),
    total_archived: totalPruned,
    archive_file: totalPruned > 0 ? 'STATE-ARCHIVE.md' : null,
  }, raw, totalPruned > 0 ? 'true' : 'false');
}

/**
 * Rebuild STATE.md body structure from canonical sources (ADR-1817).
 *
 * Implements the `gsd state rebuild` subcommand (issue #1817 Phase 2, #1826).
 * Wires the pure `rebuildCore` transition (Phase 1, #1827) to the CLI:
 *   - Locks via `readModifyWriteStateMd` (real path) or reads-only (dry-run).
 *   - Wires `phaseInventoryProvider` to a real `.planning/phases/` disk scan.
 *   - `--dry-run`: computes the rebuild, emits a structured diff, writes nothing.
 *   - `--verbose`: emits the audit-log entries to stderr (in addition to the
 *     `## Rebuild Log` section that `rebuildCore` already appends to STATE.md).
 *
 * Per ADR-1817 §5 this is the heavy/manual counterpart to the lightweight,
 * auto-triggered `state sync` (3 frontmatter fields). The two compose
 * non-overlappingly.
 */
function cmdStateRebuild(cwd: string, options: StateRebuildOptions, raw: boolean): void {
  const silent = !!options.silent;
  const emit = silent ? () => {} : (result: Record<string, unknown>, r: boolean, v?: string) => output(result, r, v);
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { emit({ error: 'STATE.md not found' }, raw); return; }

  const dryRun = !!options.dryRun;
  const verbose = !!options.verbose;

  // Wire phaseInventoryProvider to a real `.planning/phases/` disk scan. This
  // is the same canonical source `buildStateFrontmatter` consults; the Leaky-
  // Abstractions guard in `rebuildCore` (ADR-1817 §1) keeps the pure core
  // testable without this dep — here we provide it.
  //
  // #3057 B1: a missing `.planning/phases/` directory is genuinely "nothing
  // to reconcile" (`ok:true, phases: []`) — but a `readdirSync`/`statSync`
  // THROW on a directory that DOES exist (permission fault, corrupted
  // mount, etc.) is a real scan failure (`ok:false`). The old implementation
  // returned `null` for both, so `state rebuild` could report success while
  // by-phase-table reconciliation silently never ran. Per-entry stat
  // failures (an individual phase dir vanishing mid-scan) still `continue`
  // past that one entry — that is not a whole-scan failure.
  const phaseInventoryProvider = (): PhaseInventoryResult => {
    try {
      const phasesDir = path.join(planningPaths(cwd).planning, 'phases');
      if (!fs.existsSync(phasesDir) || !fs.statSync(phasesDir).isDirectory()) return { ok: true, phases: [] };
      // #3185: deliberately NOT listMilestonePhaseDirs. `state rebuild` is a
      // RECONCILIATION pass against ground truth -- it must see every phase
      // directory on disk so an orphan STATE.md row for a phase that no longer
      // exists (or sits outside the current window) is dropped. Scoping this
      // would make the rebuild silently preserve stale rows.
      const entries = fs.readdirSync(phasesDir);
      const records: PhaseInventoryRecord[] = [];
      for (const entry of entries) {
        const full = path.join(phasesDir, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;
        // Directory-name convention: `<NN>-<slug>` (e.g. `03-test-phase`).
        const m = entry.match(/^(\d+)-(.+)$/);
        if (!m) continue;
        // #3183 (lint-plan-count-drift / ADR-3180 Decision 2): source
        // planCount/summaryCount from the single owner (scanPhasePlans)
        // instead of a local root-only `-PLAN.md`/`-SUMMARY.md` readdirSync
        // filter — picks up bare PLAN.md/SUMMARY.md and nested plans/. A
        // non-COMPLETE scope (TRUNCATED: nested plans/ unreadable;
        // UNREADABLE: `full` itself unreadable) is not a trustworthy count —
        // throw so it surfaces via the outer catch as a real scan failure
        // (`ok:false`), mirroring the #3057 B1 contract documented above for
        // the sibling `fs.readdirSync(phasesDir)` failure mode, rather than
        // silently reporting an undercount.
        const scan = scanPhasePlans(full);
        if (scan.scope !== SCOPE.COMPLETE) {
          throw new Error(`could not fully scan plan directory (scope ${scan.scope}): ${full}`);
        }
        const { planCount, summaryCount } = scan;
        records.push({ number: m[1], name: m[2], planCount, summaryCount });
      }
      return { ok: true, phases: records };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  const deps: StateTransitionDeps = {
    clock: realClock,
    phaseInventoryProvider,
    // Without this, `state rebuild --dry-run` reported a truncated STATE.md anonymously: the
    // write path is named only because readModifyWriteStateMd parses with the path first, and
    // the dry-run branch reads the file directly and never does. Dry-run is the read-only mode
    // an operator reaches for first when they suspect corruption, so it is the one that most
    // needs to name the file (#1882).
    sourcePath: statePath,
  };

  const runRebuild = (content: string) => transitionCore(content, { kind: 'rebuild' }, deps);

  const emitVerboseLog = (log: unknown): void => {
    if (!verbose || !Array.isArray(log)) return;
    for (const entry of log) {
      // Treat user-data as data-only (ADR-1577 untrusted-input-boundary).
      process.stderr.write(`[rebuild] ${JSON.stringify(entry)}\n`);
    }
  };

  // #3057 B1: distinguish "nothing to rebuild" from "the phase-inventory
  // disk scan failed, so by-phase-table reconciliation could not run" — both
  // used to collapse to the same `mutated:false` / "Nothing to rebuild" note.
  type RebuildData = {
    log?: unknown[];
    mutated?: boolean;
    phase_inventory_scan_failed?: boolean;
    phase_inventory_scan_reason?: string;
  };
  const scanFailureNote = (reason: string | undefined): string =>
    'Nothing rebuilt: the phase-inventory disk scan failed, so by-phase-table reconciliation did not run' +
    (reason ? ` (${reason})` : '');

  if (dryRun) {
    const content = fs.readFileSync(statePath, 'utf-8');
    const result = runRebuild(content);
    const data = (result.data ?? {}) as RebuildData;
    emitVerboseLog(data.log);
    const mutated = data.mutated === true;
    const scanFailed = data.phase_inventory_scan_failed === true;
    emit({
      rebuilt: false,
      dry_run: true,
      mutations: Array.isArray(data.log) ? data.log.length : 0,
      mutated,
      phase_inventory_scan_failed: scanFailed,
      phase_inventory_scan_reason: scanFailed ? data.phase_inventory_scan_reason : undefined,
      note: mutated
        ? 'Run without --dry-run to apply changes'
        : scanFailed ? scanFailureNote(data.phase_inventory_scan_reason) : 'Nothing to rebuild',
    }, raw, mutated ? 'true' : 'false');
    return;
  }

  // Real path: lock + RMW via the existing seam. The rebuild log is captured
  // so we can emit it to stderr under --verbose (the section is also written
  // to STATE.md by rebuildCore itself, per ADR-1817 §3).
  let capturedLog: unknown[] = [];
  let capturedMutated = false;
  let capturedScanFailed = false;
  let capturedScanReason: string | undefined;
  readModifyWriteStateMd(statePath, (content: string) => {
    const result = runRebuild(content);
    const data = (result.data ?? {}) as RebuildData;
    capturedLog = Array.isArray(data.log) ? data.log : [];
    capturedMutated = data.mutated === true;
    capturedScanFailed = data.phase_inventory_scan_failed === true;
    capturedScanReason = data.phase_inventory_scan_reason;
    return result.content;
  }, cwd);

  emitVerboseLog(capturedLog);

  emit({
    rebuilt: capturedMutated,
    mutations: capturedLog.length,
    phase_inventory_scan_failed: capturedScanFailed,
    phase_inventory_scan_reason: capturedScanFailed ? capturedScanReason : undefined,
    note: capturedMutated
      ? 'STATE.md rebuilt; see ## Rebuild Log section for the audit trail'
      : capturedScanFailed ? scanFailureNote(capturedScanReason) : 'Nothing to rebuild',
  }, raw, capturedMutated ? 'true' : 'false');
}

/**
 * Mark the current phase as COMPLETE in STATE.md.
 * Updates Status, Last Activity, and the Current Position section to reflect
 * that the phase execution is finished and the project is ready for the next phase.
 * Implements the `gsd state complete-phase` subcommand (issue #2735).
 */
function resolvePhaseIdForCompletePhase(fm: Record<string, unknown>, body: string, overridePhase: string | undefined): string | null {
  // #3187: route through the single #1760 fallback-chain owner (fm scalar
  // then body field) instead of two raw stateExtractField calls on
  // frontmatter-blind content — a STATE.md whose phase lives only in
  // frontmatter no longer resolves to null here. `Phase` (the historical
  // second-choice field name) has no frontmatter counterpart, so its fmKey
  // is null — same shape as cmdStateSnapshot's `stateFieldValue(fm,
  // currentPositionScope, null, 'Phase')` fallback.
  const candidate = overridePhase ||
    stateFieldValue(fm, body, 'current_phase', 'Current Phase').value ||
    stateFieldValue(fm, body, null, 'Phase').value ||
    '';

  // #2125: parse via the canonical anchored parser so a narrative `Phase:`
  // body line (e.g. "Milestone v0.5 complete") does not mine a bogus token —
  // the old unanchored regex yielded "0.5" and rewrote STATE.md as
  // "Phase 0.5 complete". A canonical token at the start of the value
  // (3, 03, 3A, 3.3, 10.2, "3 of 5", "1 — Setup") is preserved; a milestone
  // closure line yields null, so the caller's "unable to resolve" guard fires.
  return parsePhaseFromProse(candidate).phase;
}

/**
 * #3408 review (close-known-limits): `cmdStateCompletePhase`'s `updated`
 * tracks two different kinds of thing — a single FIELD `reconcileReportedFields`
 * can look up against the persisted bytes, or the whole `Current Position`
 * SECTION block, which is not a field at all. Typing the distinction at the
 * producer (each `updated.push(...)` site) means the reconciliation step
 * below reads the kind directly instead of re-deriving it by matching the
 * entry's `name` against a hardcoded Set of section names. The command's
 * OUTPUT CONTRACT is unaffected: `updated` is still flattened to a flat
 * `string[]` (same entries, same order) at the single `output()` call site.
 */
type StateCompletePhaseUpdateEntry =
  | { kind: 'field'; name: string }
  | { kind: 'section'; name: string };

function cmdStateCompletePhase(cwd: string, raw: boolean, overridePhase?: string): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  // #1255/#3187: parse frontmatter and strip it from the body ONCE, mirroring
  // cmdStateValidate/cmdStateSnapshot, so resolvePhaseIdForCompletePhase and
  // the idempotency guard below consult the identical fm/body precedence —
  // the two sites cannot drift onto different chains, extending the #2125
  // "same canonical parser" guarantee one layer earlier.
  const { fm, body, scope } = readStateFrontmatterScoped(content, statePath);

  // #3187 Postel/visibility (design doc's sharpest case): this whole handler
  // is the DESTRUCTIVE path the #3489 idempotency guard below protects — it
  // decides whether a re-run of `state complete-phase --phase N` is allowed
  // to roll STATE.md back to N's moment-of-completion. If the frontmatter
  // half of the chain could not be consulted (`scope` UNREADABLE),
  // `existingCurrentPhase` below could read as null even though the
  // project's true current phase lives only in that unreadable frontmatter —
  // silently treating a non-COMPLETE scope as "not complete" would let the
  // guard's `existingCurrentPhase &&` check fail OPEN and re-run an
  // already-completed phase. Refuse outright instead of guessing; this
  // applies even when `--phase` is explicit, because the guard's job is to
  // protect against exactly that already-completed-phase case regardless of
  // how the target phase was named.
  if (scope !== SCOPE.COMPLETE) {
    output(
      { error: 'Unable to read STATE.md frontmatter; refusing to run complete-phase to avoid a destructive rollback (#3489). Fix or remove the malformed frontmatter and retry.' },
      raw,
      undefined,
    );
    return;
  }

  const resolvedPhase = resolvePhaseIdForCompletePhase(fm, body, overridePhase);
  if (!resolvedPhase || /^phase$/i.test(resolvedPhase)) {
    output({ error: 'Unable to resolve current phase. Pass an explicit phase: state complete-phase --phase <N>' }, raw, undefined);
    return;
  }

  // Idempotency guard (#3489). If STATE.md's canonical `Current Phase` field
  // already names a phase distinct from the one we are being asked to mark
  // complete, the project has advanced past the requested phase (e.g. a
  // follow-up phase was inserted, or the next phase began). Re-running
  // `state complete-phase --phase <N>` in that situation previously rolled
  // STATE.md back to <N>'s moment-of-completion — silently clobbering Status,
  // Last Activity, Last Activity Description, and the Current Position body.
  // The handler is now a no-op in that case so re-invocation from downstream
  // workflows cannot regress the project state.
  const existingCurrentPhaseRaw = stateFieldValue(fm, body, 'current_phase', 'Current Phase').value || '';
  // #2125: same canonical parser as resolvePhaseIdForCompletePhase so the two
  // sites cannot diverge on the token they extract.
  const existingCurrentPhase = parsePhaseFromProse(existingCurrentPhaseRaw).phase;
  if (existingCurrentPhase && existingCurrentPhase !== resolvedPhase) {
    output(
      { updated: [], phase: resolvedPhase, idempotent: true, note: 'phase already superseded; no-op' },
      raw,
      'false',
    );
    return;
  }

  const today = realClock.localToday();
  // #3408 review (close-known-limits): `updated` mixes two different kinds of
  // thing — FIELD names (Status, Last Activity, ...), each reconcilable
  // against the persisted bytes via `reconcileReportedFields`, and the
  // SECTION name `Current Position` (the whole Current-Position block, not a
  // single field `stateExtractField` can look up). Rather than re-deriving
  // the distinction downstream by string-matching against a Set, each entry
  // now carries its kind at the point it is PRODUCED; the flattening to a
  // flat `string[]` (the command's OUTPUT CONTRACT — unchanged) happens once
  // below, right before `output()`.
  const updated: StateCompletePhaseUpdateEntry[] = [];
  const divergedFields: string[] = [];
  // ADR-3473 §8.7 (#3872): caller-allocated out-param, filled with the
  // transaction's own pre-write snapshot + body by `applyPostSyncPreservation`.
  const preWriteState: StatePreWriteSnapshot = {};
  // #3835: complete-phase unconditionally rewrites the body `Phase:` line to
  // `N — COMPLETE` below. That defeats current_phase_name's
  // preserve-when-unchanged delta rule the same way #3834's no-`--name`
  // planned-phase write does — pre/post body-source disagree BY CONSTRUCTION
  // (this write is what changed the source line), so the post-sync
  // re-derivation harvests nothing from "COMPLETE" and the curated key is
  // dropped entirely rather than preserved. The write site already documents
  // "an absent name does NOT clear an existing curated value" for the body
  // (`Current Phase Name` section below) — this reasserts the same rule for
  // the frontmatter key, mirroring cmdStatePlannedPhase's fix.
  const rmwOptions: ReadModifyWriteOptions = { divergedFields, preWriteState };

  const wrote = readModifyWriteStateMd(statePath, (content) => {
    const currentPhase = resolvedPhase;

    // Bug #1255: operate on body only so the YAML frontmatter `status:` key
    // cannot shadow the body Status field (pipe-table or inline).
    //
    // ADR-3473 §8.1 (#3881 review, finding 5): previously this block hand-reimplemented
    // the isUnparseableFrontmatter/rawFrontmatterPrefix shape inline instead of using the
    // canonical helper — the sixth copy of a block already duplicated 5x in
    // state-transition.cts. Routed through the shared `beginFrontmatterReassembly` so this
    // module can never drift from the frontmatter-preservation contract state-transition.cts
    // enforces everywhere else.
    const { existingFm, body: initialBody, reassemble } =
      stateTransitionMod.beginFrontmatterReassembly(content, statePath);
    let body = initialBody;
    const curatedPhaseName = existingFm['current_phase_name'];
    if (typeof curatedPhaseName === 'string' && curatedPhaseName.trim().length > 0) {
      rmwOptions.authoritativeFm = { current_phase_name: curatedPhaseName };
    }

    // Update Status field (body only — #1255)
    const statusValue = `Phase ${currentPhase} complete`;
    let result = stateReplaceField(body, 'Status', statusValue);
    if (result) { body = result; updated.push({ kind: 'field', name: 'Status' }); }

    // Update Last Activity date
    result = stateReplaceField(body, 'Last Activity', today);
    if (result) { body = result; updated.push({ kind: 'field', name: 'Last Activity' }); }

    // Update Last Activity Description
    const activityDesc = `Phase ${currentPhase} marked complete`;
    result = stateReplaceField(body, 'Last Activity Description', activityDesc);
    if (result) { body = result; updated.push({ kind: 'field', name: 'Last Activity Description' }); }

    // Update ## Current Position section
    // ADR-1372 T6: positionPattern → tokenizeHeadings; stop at level ≥ 2.
    // Mirrors /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i
    {
      const cpHs = tokenizeHeadings(body);
      const cpIdx = cpHs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
      if (cpIdx !== -1) {
        const cpH = cpHs[cpIdx];
        const cpBodyLines = body.split('\n');
        const cpHL = cpBodyLines[cpH.line - 1];
        const cpBodyStart = cpH.offset + cpHL.length + 1;
        let cpBodyEnd = body.length;
        for (let j = cpIdx + 1; j < cpHs.length; j++) {
          if (STOP_H2_PLUS(cpHs[j].level)) { cpBodyEnd = cpHs[j].offset - 1; break; }
        }
        let posBody = body.slice(cpBodyStart, cpBodyEnd);

        // Update Phase line to show COMPLETE
        const newPhase = `Phase: ${currentPhase} — COMPLETE`;
        if (/^Phase:/m.test(posBody)) {
          posBody = posBody.replace(/^Phase:.*$/m, newPhase);
        } else {
          // Pipe-table format in Current Position (#1255)
          // Value cell must be bare (no "Phase:" label prefix) — the column header already provides the label.
          const replaced = stateReplaceField(posBody, 'Phase', `${currentPhase} — COMPLETE`);
          if (replaced !== null) posBody = replaced;
        }

        // Update Status line if present
        const newStatus = `Status: Phase ${currentPhase} complete`;
        if (/^Status:/m.test(posBody)) {
          posBody = posBody.replace(/^Status:.*$/m, newStatus);
        } else {
          // Pipe-table format in Current Position (#1255)
          const replaced = stateReplaceField(posBody, 'Status', `Phase ${currentPhase} complete`);
          if (replaced !== null) posBody = replaced;
        }

        // Update Last activity line if present
        const newActivity = `Last activity: ${today} — Phase ${currentPhase} marked complete`;
        if (/^Last activity:/im.test(posBody)) {
          posBody = posBody.replace(/^Last activity:.*$/im, newActivity);
        } else {
          // Pipe-table format in Current Position (#1255)
          // Value must match the inline branch (date + narrative), not bare date.
          const activityValue = `${today} — Phase ${currentPhase} marked complete`;
          const replaced = stateReplaceField(posBody, 'Last Activity', activityValue)
            ?? stateReplaceField(posBody, 'Last activity', activityValue);
          if (replaced !== null) posBody = replaced;
        }

        body = body.slice(0, cpBodyStart) + posBody + body.slice(cpBodyEnd);
        updated.push({ kind: 'section', name: 'Current Position' });
      }
    }

    return reassemble(body);
  }, cwd, rmwOptions);

  // ADR-3408 §8.4 (D4): traced for this phase (design doc: "not traced in
  // the analysis pass"). Unlike the transitionCore-based commands, this
  // adapter's `updated` mixes FIELD entries (Status, Last Activity, Last
  // Activity Description — each reconcilable against the persisted bytes,
  // same as every other command in this phase) with the SECTION entry
  // `Current Position` (the whole Current-Position block, not a single
  // field `stateExtractField` can look up — reconciling it the same way as
  // a field would always drop it as a false negative). Reconcile only the
  // field-shaped entries (#3351's direction), pass the section entry
  // through unconditionally, and fold in any field preservation restored
  // that this transform never touched (#3345's direction). The kind was
  // decided at PUSH time above (typed producer), not re-derived here by
  // string-matching a name against a Set.
  const sectionEntries = updated.filter((e) => e.kind === 'section').map((e) => e.name);
  const fieldEntries = updated.filter((e) => e.kind === 'field').map((e) => e.name);
  const reconciled = [...sectionEntries, ...reconcileReportedFields(statePath, preWriteState, fieldEntries, divergedFields)];

  output(
    { updated: reconciled, phase: resolvedPhase },
    raw,
    reconciled.length > 0 ? 'true' : 'false',
  );
  // #3227: gate on `wrote` (readModifyWriteStateMd's own return value), not
  // `reconciled.length > 0` — a re-run of complete-phase against a phase
  // that is ALREADY marked complete (same status/date/Current Position
  // values already on disk) still has `stateReplaceField` report a match for
  // every field it looks up, so `reconciled` is non-empty even though the
  // #948 no-op guard skipped the write. Same reasoning as
  // cmdStateBeginPhase/cmdStatePlannedPhase/cmdStateAdvancePlan above.
  if (wrote) publishStateContract(cwd);
}

export = {
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
  acquireStateLock,
  releaseStateLock,
  writeStateMd,
  readModifyWriteStateMd,
  syncStateFrontmatter,
  // #3374: the shared post-sync preservation pass (snapshots + table-driven
  // applyStatePreservation + #2736 re-assert).
  applyPostSyncPreservation,
  // #3469 (ADR-3408 §8.3): the ONE write-seam composition (sync +
  // preservation) as content -> content. Exported for cmdPhaseComplete's
  // atomic-commit adapter (phase.cts, syncs STATE.md directly because it is
  // committed atomically with ROADMAP/REQUIREMENTS) and for
  // cmdMilestoneComplete (milestone.cts) — both need the composition's
  // output but supply their own I/O envelope around it.
  syncAndPreserveStateMd,
  readStateHeadFreshness,
  withStateLock,
  updatePerformanceMetricsSection,
  cmdStateLoad,
  cmdStateGet,
  cmdStatePatch,
  cmdStateUpdate,
  cmdStateAdvancePlan,
  cmdStateRecordMetric,
  cmdStateUpdateProgress,
  cmdStateAddDecision,
  cmdStateAddBlocker,
  cmdStateAddRoadmapEvolution,
  cmdStateResolveBlocker,
  cmdStateRecordSession,
  cmdStateSnapshot,
  cmdStateJson,
  cmdStateBeginPhase,
  cmdStatePlannedPhase,
  cmdStateCompletePhase,
  cmdStateValidate,
  cmdStateSync,
  cmdStatePrune,
  cmdStateRebuild,
  cmdStateMilestoneSwitch,
  cmdSignalWaiting,
  cmdSignalResume,
  // Test seam (#1514): the pure retired/folded-phase parser, exposed so its
  // strikethrough-detection logic can be property-tested directly.
  _extractRetiredPhaseNumbers: extractRetiredPhaseNumbers,
  // Test seam (#3471 review): the second hand-maintained table beside
  // FIELD_CLASSIFICATION, exposed so a parity test can pin that every
  // `preserve-when-unchanged` row has a label here.
  _FRONTMATTER_KEY_TO_BODY_LABEL: FRONTMATTER_KEY_TO_BODY_LABEL,
  // Test seam (ADR-3473 §8.7, #3872): the transaction diff and its pure
  // building blocks, exposed so the ~15 boundary/hostile/property rows in
  // the test matrix (dotted-path resolution, prototype-pollution safety,
  // string/number representation insensitivity, the provenance exclusion)
  // can be driven directly with fabricated snapshot/persisted objects
  // instead of round-tripping every case through a full RMW write.
  _reconcileReportedFields: reconcileReportedFields,
  _computeChangedFrontmatterFields: computeChangedFrontmatterFields,
  _resolveFrontmatterPath: resolveFrontmatterPath,
  _stateFieldValuesDiffer: stateFieldValuesDiffer,
  _STATE_UPDATED_PROVENANCE_EXCLUSION: STATE_UPDATED_PROVENANCE_EXCLUSION,
  // Test seam (#3873 phase-3 test matrix row 9): `bodyLabelFor` itself is not
  // otherwise reachable from outside this module. Exposed so a test can drive
  // the real STATE_BODY_LABEL_UNWIRED_ROW throw directly, rather than only
  // pinning the table it reads (`_FRONTMATTER_KEY_TO_BODY_LABEL`) against
  // itself.
  _bodyLabelFor: bodyLabelFor,
  // Test seam (audit M1): inject a deterministic isPidAlive so the liveness-gated
  // steal decision is exercised without real pids. Mirrors capability-lock.cts.
  _setLockProbes(probes: Partial<{ isPidAlive: (pid: number) => boolean }>): void {
    if (typeof probes.isPidAlive === 'function') _stateLockProbes.isPidAlive = probes.isPidAlive;
  },
  _resetLockProbes(): void {
    _stateLockProbes.isPidAlive = _realIsPidAlive;
  },
  // Test seam (audit M8/M9): inject deterministic hooks for the scan-in-lock window
  // (afterAcquire), the one-shot recoverable writeSync failure (simulateWriteError),
  // and per-iteration orphan-lock snapshots (onLoopIteration). See _stateLockTestHooks.
  _setStateLockTestHooks(hooks: StateLockTestHooks): void {
    if ('afterAcquire' in hooks) _stateLockTestHooks.afterAcquire = hooks.afterAcquire;
    if ('simulateWriteError' in hooks) _stateLockTestHooks.simulateWriteError = hooks.simulateWriteError;
    if ('onLoopIteration' in hooks) _stateLockTestHooks.onLoopIteration = hooks.onLoopIteration;
    if ('beforeSteal' in hooks) _stateLockTestHooks.beforeSteal = hooks.beforeSteal;
  },
  _resetStateLockTestHooks(): void {
    delete _stateLockTestHooks.afterAcquire;
    delete _stateLockTestHooks.simulateWriteError;
    delete _stateLockTestHooks.onLoopIteration;
    delete _stateLockTestHooks.beforeSteal;
  },
};
