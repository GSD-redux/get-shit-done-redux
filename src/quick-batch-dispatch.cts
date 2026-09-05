/**
 * Quick-Batch Dispatch Core (#3676, Phase 4 of epic #3344 / ADR-1239
 * "Quick-batch binding").
 *
 * PURE decision logic for `/gsd:quick-batch`: argument validation, effective
 * concurrency, deterministic merge ordering, spawn backpressure, and
 * failure/verification routing. This module answers "what should happen
 * next" — it NEVER performs `Agent()` dispatch, `git worktree` I/O, or writes
 * `BATCH.json`/STATE.md itself. Those live in the workflow markdown (a
 * separate follow-up pass) and in `src/quick-batch.cts` (durable manifest
 * mutation, reused as-is).
 *
 * Capacity and isolation are CALLER-SUPPLIED inputs here — the CLI layer
 * resolves those via the existing `dispatch-capacity`/`dispatch-isolation`
 * queries (`gsd-core/bin/gsd-tools.cjs`'s `routeDispatchCapacity`/
 * `routeDispatchIsolation`); this module never re-derives that negotiation.
 *
 * The one exception to "never performs I/O" is `buildCleanupManifestEntry`,
 * which accepts a plan document's raw text (already read by the caller) and
 * parses it via the existing `parsePlanDocument` (`src/plan-document.cts`) —
 * no filesystem access happens inside this module.
 *
 * Design lock: `.gsd/phase/feat-3676-quick-batch-command-workflow/40-design.md`.
 * Test matrix: `.gsd/phase/feat-3676-quick-batch-command-workflow/50-test-matrix.md`.
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/quick-batch-dispatch.cjs.
 */

import type { Result } from './write-set.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument } = planDocumentMod;

// ─── Argument validation (design rows 5,7-10,13-15) ────────────────────────

/** Parsed, validated `/gsd:quick-batch` arguments. */
interface QuickBatchArgs {
  jobs: 'auto' | number;
  validate: boolean;
  research: boolean;
  /** `--resume <batch-id>`, or null when omitted. */
  resume: string | null;
}

/**
 * Validate `/gsd:quick-batch` CLI args BEFORE any dispatch. Rejects
 * `--discuss`/`--full` outright (v1 exclusion, design rows 7-9,13-15 — a
 * mixed valid+rejected-flag invocation is still rejected: presence alone is
 * sufficient, regardless of other flags), and rejects a malformed `--jobs`
 * value (non-numeric or <= 0, row 5/9) before any dispatch. `--jobs` omitted
 * defaults to `'auto'` (row 10).
 */
function parseQuickBatchArgs(args: string[]): Result<QuickBatchArgs> {
  if (!Array.isArray(args)) {
    return { ok: false, reason: 'quick-batch args must be an array' };
  }
  if (args.includes('--discuss')) {
    return { ok: false, reason: 'quick-batch does not support --discuss in v1 — use /gsd:quick --discuss per item instead' };
  }
  if (args.includes('--full')) {
    return { ok: false, reason: 'quick-batch does not support --full in v1' };
  }

  let jobs: 'auto' | number = 'auto';
  const jobsIdx = args.indexOf('--jobs');
  if (jobsIdx !== -1) {
    const raw = args[jobsIdx + 1];
    if (raw === undefined || raw.startsWith('--')) {
      return { ok: false, reason: 'quick-batch --jobs requires a value ("auto" or a positive integer)' };
    }
    if (raw === 'auto') {
      jobs = 'auto';
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { ok: false, reason: `quick-batch --jobs must be "auto" or a positive integer, got ${JSON.stringify(raw)}` };
      }
      jobs = n;
    }
  }

  const validate = args.includes('--validate');
  const research = args.includes('--research');

  let resume: string | null = null;
  const resumeIdx = args.indexOf('--resume');
  if (resumeIdx !== -1) {
    const raw = args[resumeIdx + 1];
    if (raw === undefined || raw.startsWith('--')) {
      return { ok: false, reason: 'quick-batch --resume requires a batch id' };
    }
    resume = raw;
  }

  return { ok: true, value: { jobs, validate, research, resume } };
}

// ─── Effective concurrency (design rows 3-4,6,12) ───────────────────────────

interface EffectiveConcurrencyInput {
  /** `'auto'` or the validated positive integer from `--jobs N`. */
  jobs: 'auto' | number;
  /** Number of tasks/items the concurrency is being computed for. */
  taskCount: number;
  /** Resolved capacity ceiling (from `dispatch-capacity`). */
  capacity: number;
  /** Resolved isolation mode (from `dispatch-isolation`). Only `'none'` is special-cased here. */
  isolation: string;
  /**
   * Whether the wave being scheduled performs a mutation (worktree
   * create/executor/merge). `isolation === 'none'` forces concurrency to 1
   * ONLY for a mutating wave (row 6) — a non-mutating (research-only) stage
   * is NOT subject to that cap (row 12).
   */
  mutating: boolean;
}

/**
 * `--jobs auto` (or omitted) → capacity alone (rows 3,10). `--jobs N` →
 * `min(taskCount, N, capacity)` (row 4). When `isolation === 'none'` and the
 * wave is `mutating`, concurrency is forced to 1 regardless of `--jobs`/
 * capacity (row 6) — a non-mutating wave is unaffected (row 12).
 */
function computeEffectiveConcurrency(input: EffectiveConcurrencyInput): number {
  let concurrency = input.jobs === 'auto'
    ? input.capacity
    : Math.min(input.taskCount, input.jobs, input.capacity);
  if (input.isolation === 'none' && input.mutating) {
    concurrency = Math.min(concurrency, 1);
  }
  return Math.max(concurrency, 0);
}

// ─── Deterministic merge ordering (design row 24; test-matrix rows 32-33) ───

/**
 * Given a wave's ORIGINAL dispatch order (`waveOrder`, as `computeWaves`
 * assigned it) and the set of ids whose leaf has finished ("ready"),
 * returns the prefix of `waveOrder` that is currently mergeable — merges
 * happen strictly in wave order, so an item is only mergeable once every
 * item before it in `waveOrder` is ALSO ready. An out-of-order completion
 * (e.g. item 2 finishes before item 1) waits: `computeMergeOrder` returns
 * only `[]` until item 1 is also ready.
 */
function computeMergeOrder(waveOrder: string[], readyIds: Set<string>): string[] {
  const mergeable: string[] = [];
  for (const id of waveOrder) {
    if (!readyIds.has(id)) break;
    mergeable.push(id);
  }
  return mergeable;
}

// ─── Spawn backpressure (design row 27; test-matrix row 39) ────────────────

interface SpawnPlanInput {
  /** Eligible item ids, in dispatch-priority order. */
  eligibleIds: string[];
  /** Total in-flight ceiling (effective concurrency). */
  capacity: number;
  /** How many leaves are already in flight right now. */
  currentInFlight: number;
  /** Ids the host explicitly refused to spawn this round (never counted against capacity). */
  refused?: Set<string> | string[];
}

interface SpawnPlanResult {
  /** Ids to spawn now — never more than `capacity - currentInFlight`. */
  spawn: string[];
  /** Ids that stay/return to `pending` — refused OR backpressured. Never `failed`, never increases fan-out. */
  pending: string[];
}

/**
 * Pure backpressure model: given eligible items, a capacity ceiling, and a
 * set of host-refused ids, decide which ids spawn now and which stay
 * `pending`. Total in-flight (`currentInFlight + spawn.length`) never
 * exceeds `capacity` at any point (row 27, property row 53). A refused id
 * is never counted against capacity and never marked `failed` — it simply
 * returns to `pending` for a later round.
 */
function computeSpawnPlan(input: SpawnPlanInput): SpawnPlanResult {
  const refusedSet = input.refused instanceof Set ? input.refused : new Set(input.refused ?? []);
  let available = Math.max(input.capacity - input.currentInFlight, 0);
  const spawn: string[] = [];
  const pending: string[] = [];
  for (const id of input.eligibleIds) {
    if (refusedSet.has(id)) {
      pending.push(id);
      continue;
    }
    if (available > 0) {
      spawn.push(id);
      available -= 1;
    } else {
      pending.push(id);
    }
  }
  return { spawn, pending };
}

// ─── Failure/verification routing (design rows 28,30,31,34-35) ─────────────

type VerifierStatus = 'passed' | 'gaps_found' | 'human_needed';

type VerificationRouting =
  | { action: 'complete' }
  | { action: 'human_needed' }
  | { action: 'fail'; failureReason: string };

/**
 * Route a verifier's status to an item action. `human_needed` is terminal
 * for the item — the caller must NOT call `completeQuickItem` (row 30, no
 * STATE row appended). `gaps_found` fails the item WITHOUT rollback and
 * WITHOUT an automatic gap-fix retry (row 31,34). `passed` completes it.
 */
function routeVerificationOutcome(status: VerifierStatus): VerificationRouting {
  switch (status) {
    case 'passed':
      return { action: 'complete' };
    case 'human_needed':
      return { action: 'human_needed' };
    case 'gaps_found':
      return { action: 'fail', failureReason: 'verification reported gaps_found (no automatic gap-fix retry in v1)' };
  }
}

type MergeOutcomeKind =
  | { kind: 'merged' }
  | { kind: 'merge_failed'; detail?: string }
  | { kind: 'scope_violation'; detail?: string };

type MergeRouting =
  | { action: 'complete' }
  | { action: 'fail'; failureReason: string; preserveWorktree: true };

/**
 * Route a merge attempt's outcome to an item action. Both `merge_failed`
 * (real conflict) and `scope_violation` (undeclared deletion / advisory
 * scope drift escalated to a gate — see `executeWorktreeWaveCleanupPlan`)
 * mark the item `failed` with a `failure_reason` and PRESERVE the worktree
 * for diagnosis — this function never signals worktree removal (row 28,
 * 34-35). `merged` completes the item.
 */
function routeMergeOutcome(outcome: MergeOutcomeKind): MergeRouting {
  switch (outcome.kind) {
    case 'merged':
      return { action: 'complete' };
    case 'merge_failed':
      return {
        action: 'fail',
        failureReason: outcome.detail ? `merge_failed: ${outcome.detail}` : 'merge_failed',
        preserveWorktree: true,
      };
    case 'scope_violation':
      return {
        action: 'fail',
        failureReason: outcome.detail ? `scope_violation: ${outcome.detail}` : 'scope_violation',
        preserveWorktree: true,
      };
  }
}

// ─── Crash-window duplicate-dispatch guard (#3677, epic #3344 Phase 5) ─────

interface FilterAlreadyExecutedResult {
  /** Eligible ids NOT known to have already finished executing — safe to spawn this round. */
  spawnEligible: string[];
  /**
   * Eligible ids whose `SUMMARY.md` already exists on disk — the CALLER
   * determines this via its own filesystem check (this function performs
   * no I/O). NEVER re-dispatch one of these into a second worktree:
   * `merge-wave.md`'s own on-disk `SUMMARY.md` criterion already picks
   * each of them up independently of this eligible/spawn list.
   */
  alreadyExecuted: string[];
}

/**
 * Crash-window duplicate-dispatch guard
 * (`.gsd/phase/feat-3677-quick-batch-hardening-acceptance/40-design.md` §1).
 * `quick-batch resume`'s `eligible` is purely status/dependency-derived —
 * it has no awareness that an item already finished executing (a real
 * commit, `SUMMARY.md` written) before a coordinator crash left
 * `BATCH.json` at `pending` (the STATE.md-row crash-window detection
 * inside `resumeBatch` only fires once Step 9 has run). This mirrors the
 * file-existence exclusion `planner-wave.md` already applies one layer
 * earlier for `PLAN.md`, extracted as its own pure decision (rather than
 * left as workflow prose only) so it is independently testable: given the
 * eligible ids for this round and the subset the CALLER has already
 * determined finished executing, splits them into ids safe to spawn now
 * and ids that must never be re-dispatched.
 */
function filterAlreadyExecuted(eligibleIds: string[], executedIds: string[] | Set<string>): FilterAlreadyExecutedResult {
  const executedSet = executedIds instanceof Set ? executedIds : new Set(executedIds);
  const spawnEligible: string[] = [];
  const alreadyExecuted: string[] = [];
  for (const id of eligibleIds) {
    if (executedSet.has(id)) {
      alreadyExecuted.push(id);
    } else {
      spawnEligible.push(id);
    }
  }
  return { spawnEligible, alreadyExecuted };
}

// ─── Cleanup-wave manifest entry construction (design row 26, Open Q2) ─────

interface CleanupEntryInput {
  agentId: string | null;
  worktreePath: string;
  branch: string;
  expectedBase: string;
  allowedBases?: string[];
  /** Raw `*-PLAN.md` text, read fresh by the caller — NEVER sourced from `BATCH.json`. */
  planContent: string;
}

interface CleanupManifestEntry {
  agent_id: string | null;
  worktree_path: string;
  branch: string;
  expected_base: string;
  allowed_bases?: string[];
  files_modified: string[];
  declared_deletions: string[];
}

/**
 * Build one `worktree.cleanup-wave` manifest entry for an item, deriving
 * `files_modified`/`declared_deletions` FRESH from the item's own PLAN.md via
 * the existing `parsePlanDocument` (never from `BATCH.json`'s `planned_files`
 * alone — Open Question 2's accepted resolution). An empty `declared_deletions`
 * for a plan that genuinely deletes nothing is indistinguishable from a plan
 * that forgot to declare one — this is `partitionDeclaredDeletions`'s own
 * pre-existing "absent/empty = declares nothing" convention, inherited here,
 * not resolved.
 */
function buildCleanupManifestEntry(input: CleanupEntryInput): CleanupManifestEntry {
  const parsed = parsePlanDocument(input.planContent);
  const entry: CleanupManifestEntry = {
    agent_id: input.agentId,
    worktree_path: input.worktreePath,
    branch: input.branch,
    expected_base: input.expectedBase,
    files_modified: parsed.filesModified,
    declared_deletions: parsed.filesDeleted,
  };
  if (input.allowedBases !== undefined) {
    entry.allowed_bases = input.allowedBases;
  }
  return entry;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const quickBatchDispatch = {
  parseQuickBatchArgs,
  computeEffectiveConcurrency,
  computeMergeOrder,
  computeSpawnPlan,
  routeVerificationOutcome,
  routeMergeOutcome,
  buildCleanupManifestEntry,
  filterAlreadyExecuted,
};

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace quickBatchDispatch {
  export {
    QuickBatchArgs,
    EffectiveConcurrencyInput,
    SpawnPlanInput,
    SpawnPlanResult,
    VerifierStatus,
    VerificationRouting,
    MergeOutcomeKind,
    MergeRouting,
    CleanupEntryInput,
    CleanupManifestEntry,
    FilterAlreadyExecutedResult,
  };
}

export = quickBatchDispatch;
