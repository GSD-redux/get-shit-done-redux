/**
 * Quick-Batch command router — CLI subcommand dispatcher for
 * `gsd-tools quick-batch` (#3676, Phase 4 of epic #3344 / ADR-1239).
 *
 * Quick-batch is a first-party, always-on command family (like `/gsd:quick`,
 * which has no capability-registry entry), so this router is wired directly
 * into `HOST_COMMAND_ROUTERS` (`gsd-core/bin/gsd-tools.cjs`) — NOT the opt-in
 * capability-registry/`activationKey` path `graphify` uses. Shape follows
 * `graphify-command-router.cts` (thin `routeHubCommandFamily` wrapper), which
 * gives the Hub's `makeUnknownCommand` handling for free on an unknown
 * subcommand (test-matrix row 47).
 *
 * Verbs wrap `src/quick-batch.cts` (durable manifest read/write — reused
 * as-is) and `src/quick-batch-dispatch.cts` (pure decision logic, #3676's
 * own new module). This router performs NO decision logic of its own beyond
 * argument shaping — every behavioral rule lives in one of those two
 * modules, per the design doc's "Do the simplest thing" law.
 *
 * Test seam: pass `_quickBatch`/`_quickBatchDispatch` in the options object
 * to inject recording mocks instead of the real modules — same `_`-prefix
 * convention `graphify-command-router.cts` uses.
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/quick-batch-command-router.cjs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import quickBatch = require('./quick-batch.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import quickBatchDispatch = require('./quick-batch-dispatch.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { safeJsonParse } from './security.cjs';

const { output, ERROR_REASON } = io;
const { makeInvalidArgs } = commandRoutingHub;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuickBatchModule {
  parseTaskList(text: string): unknown;
  parseTaskListFromFile(cwd: string, filePath: string): unknown;
  createBatch(cwd: string, items: unknown[], options?: Record<string, unknown>): unknown;
  loadBatch(cwd: string, batchId: string): unknown;
  resumeBatch(cwd: string, batchId: string, options?: Record<string, unknown>): unknown;
  completeQuickItem(cwd: string, batchId: string, quickId: string, fields: Record<string, unknown>): unknown;
  updateBatchItems(cwd: string, batchId: string, updates: unknown[]): unknown;
}

interface QuickBatchDispatchModule {
  parseQuickBatchArgs(args: string[]): unknown;
  computeEffectiveConcurrency(input: Record<string, unknown>): number;
  computeMergeOrder(waveOrder: string[], readyIds: Set<string>): string[];
  computeSpawnPlan(input: Record<string, unknown>): unknown;
  routeVerificationOutcome(status: string): unknown;
  routeMergeOutcome(outcome: Record<string, unknown>): unknown;
  buildCleanupManifestEntry(input: Record<string, unknown>): unknown;
  filterAlreadyExecuted(eligibleIds: string[], executedIds: string[]): unknown;
}

interface RouteQuickBatchCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _quickBatch?: QuickBatchModule;
  _quickBatchDispatch?: QuickBatchDispatchModule;
}

// ─── Small arg-parsing helpers (local — no new shared convention needed) ────

/** `--flag value` lookup; undefined when the flag is absent. */
function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseJsonArg<T>(raw: string | undefined, label: string): { ok: true; value: T } | { ok: false; reason: string } {
  if (raw === undefined) {
    return { ok: false, reason: `${label} requires a JSON value` };
  }
  const parsed = safeJsonParse(raw, { maxLength: 1048576, label });
  if (!parsed.ok) {
    return { ok: false, reason: `${label} is not valid JSON: ${parsed.error ?? 'unknown parse error'}` };
  }
  return { ok: true, value: parsed.value as T };
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeQuickBatchCommand({ args, cwd, raw, error, _quickBatch, _quickBatchDispatch }: RouteQuickBatchCommandOptions): void {
  const qb: QuickBatchModule = _quickBatch ?? (quickBatch as unknown as QuickBatchModule);
  const dispatch: QuickBatchDispatchModule = _quickBatchDispatch ?? (quickBatchDispatch as unknown as QuickBatchDispatchModule);

  /** Forward a `Result<T>` from either module straight to output()/error(). */
  function emit(result: unknown): void {
    if (result && typeof result === 'object' && 'ok' in result) {
      const r = result as { ok: boolean; reason?: string; value?: unknown };
      if (!r.ok) {
        error(r.reason ?? 'quick-batch command failed', ERROR_REASON.USAGE);
        return;
      }
      output(r.value, raw);
      return;
    }
    output(result, raw);
  }

  routeHubCommandFamily({
    family: 'quick-batch',
    args,
    subcommands: [
      'create',
      'update',
      'resume',
      'complete',
      'effective-concurrency',
      'merge-eligible',
      'spawn-plan',
      'filter-executed',
      'verification-routing',
      'merge-routing',
      'cleanup-entry',
      'parse-args',
    ],
    handlers: {
      // `quick-batch create --file <path> [--base-revision <sha>] [--options <json>]`
      create: () => {
        const filePath = argValue(args, '--file');
        if (!filePath) {
          return makeInvalidArgs('--file', 'Usage: gsd-tools quick-batch create --file <path> [--base-revision <sha>] [--options <json>]', ERROR_REASON.USAGE);
        }
        const parsed = qb.parseTaskListFromFile(cwd, filePath) as { ok: boolean; reason?: string; value?: Array<{ description: string }> };
        if (!parsed.ok) {
          return makeInvalidArgs('--file', parsed.reason ?? 'unable to parse task list', ERROR_REASON.USAGE);
        }
        const baseRevision = argValue(args, '--base-revision');
        const optionsRaw = argValue(args, '--options');
        let batchOptions: Record<string, unknown> | undefined;
        if (optionsRaw !== undefined) {
          const optResult = parseJsonArg<Record<string, unknown>>(optionsRaw, '--options');
          if (!optResult.ok) return makeInvalidArgs('--options', optResult.reason, ERROR_REASON.USAGE);
          batchOptions = optResult.value;
        }
        const items = (parsed.value ?? []).map((it) => ({ description: it.description }));
        emit(qb.createBatch(cwd, items, { baseRevision, batchOptions }));
      },
      // `quick-batch update --batch <id> --updates <json>`
      update: () => {
        const batchId = argValue(args, '--batch');
        if (!batchId) {
          return makeInvalidArgs('--batch', 'Usage: gsd-tools quick-batch update --batch <id> --updates <json>', ERROR_REASON.USAGE);
        }
        const updatesResult = parseJsonArg<unknown[]>(argValue(args, '--updates'), '--updates');
        if (!updatesResult.ok) return makeInvalidArgs('--updates', updatesResult.reason, ERROR_REASON.USAGE);
        emit(qb.updateBatchItems(cwd, batchId, updatesResult.value));
      },
      // `quick-batch resume --batch <id> [--current-base-revision <sha>]`
      resume: () => {
        const batchId = argValue(args, '--batch');
        if (!batchId) {
          return makeInvalidArgs('--batch', 'Usage: gsd-tools quick-batch resume --batch <id> [--current-base-revision <sha>]', ERROR_REASON.USAGE);
        }
        const currentBaseRevision = argValue(args, '--current-base-revision');
        emit(qb.resumeBatch(cwd, batchId, currentBaseRevision !== undefined ? { currentBaseRevision } : {}));
      },
      // `quick-batch complete --batch <id> --quick-id <id> --description <t> --date <d> --commit <sha> [--directory <dir>]`
      complete: () => {
        const batchId = argValue(args, '--batch');
        const quickId = argValue(args, '--quick-id');
        const description = argValue(args, '--description');
        const date = argValue(args, '--date');
        const commit = argValue(args, '--commit');
        if (!batchId || !quickId || !description || !date || !commit) {
          return makeInvalidArgs(
            '--batch/--quick-id/--description/--date/--commit',
            'Usage: gsd-tools quick-batch complete --batch <id> --quick-id <id> --description <t> --date <d> --commit <sha> [--directory <dir>]',
            ERROR_REASON.USAGE,
          );
        }
        const directory = argValue(args, '--directory');
        emit(qb.completeQuickItem(cwd, batchId, quickId, { description, date, commit, directory }));
      },
      // `quick-batch effective-concurrency --jobs <auto|N> --task-count <N> --capacity <N> --isolation <str> [--mutating]`
      'effective-concurrency': () => {
        const jobsRaw = argValue(args, '--jobs');
        const taskCount = Number(argValue(args, '--task-count'));
        const capacity = Number(argValue(args, '--capacity'));
        const isolation = argValue(args, '--isolation') ?? '';
        if (jobsRaw === undefined || !Number.isFinite(taskCount) || !Number.isFinite(capacity)) {
          return makeInvalidArgs(
            '--jobs/--task-count/--capacity',
            'Usage: gsd-tools quick-batch effective-concurrency --jobs <auto|N> --task-count <N> --capacity <N> --isolation <str> [--mutating]',
            ERROR_REASON.USAGE,
          );
        }
        const jobs: 'auto' | number = jobsRaw === 'auto' ? 'auto' : Number(jobsRaw);
        const mutating = args.includes('--mutating');
        output({
          concurrency: dispatch.computeEffectiveConcurrency({ jobs, taskCount, capacity, isolation, mutating }),
        }, raw);
      },
      // `quick-batch merge-eligible --wave-order <json-array> --ready <json-array>`
      'merge-eligible': () => {
        const waveOrderResult = parseJsonArg<string[]>(argValue(args, '--wave-order'), '--wave-order');
        if (!waveOrderResult.ok) return makeInvalidArgs('--wave-order', waveOrderResult.reason, ERROR_REASON.USAGE);
        const readyResult = parseJsonArg<string[]>(argValue(args, '--ready'), '--ready');
        if (!readyResult.ok) return makeInvalidArgs('--ready', readyResult.reason, ERROR_REASON.USAGE);
        output({
          mergeable: dispatch.computeMergeOrder(waveOrderResult.value, new Set(readyResult.value)),
        }, raw);
      },
      // `quick-batch spawn-plan --eligible <json-array> --capacity <N> --in-flight <N> [--refused <json-array>]`
      'spawn-plan': () => {
        const eligibleResult = parseJsonArg<string[]>(argValue(args, '--eligible'), '--eligible');
        if (!eligibleResult.ok) return makeInvalidArgs('--eligible', eligibleResult.reason, ERROR_REASON.USAGE);
        const capacity = Number(argValue(args, '--capacity'));
        const currentInFlight = Number(argValue(args, '--in-flight'));
        if (!Number.isFinite(capacity) || !Number.isFinite(currentInFlight)) {
          return makeInvalidArgs(
            '--capacity/--in-flight',
            'Usage: gsd-tools quick-batch spawn-plan --eligible <json-array> --capacity <N> --in-flight <N> [--refused <json-array>]',
            ERROR_REASON.USAGE,
          );
        }
        let refused: string[] = [];
        const refusedRaw = argValue(args, '--refused');
        if (refusedRaw !== undefined) {
          const refusedResult = parseJsonArg<string[]>(refusedRaw, '--refused');
          if (!refusedResult.ok) return makeInvalidArgs('--refused', refusedResult.reason, ERROR_REASON.USAGE);
          refused = refusedResult.value;
        }
        output(dispatch.computeSpawnPlan({ eligibleIds: eligibleResult.value, capacity, currentInFlight, refused }), raw);
      },
      // `quick-batch filter-executed --eligible <json-array> --executed <json-array>`
      // Crash-window duplicate-dispatch guard (#3677): splits this round's
      // eligible ids into `spawnEligible` (safe to dispatch) and
      // `alreadyExecuted` (SUMMARY.md already exists on disk — caller
      // determines this via its own filesystem check; NEVER re-dispatch
      // these — merge-wave.md's own on-disk criterion picks them up).
      'filter-executed': () => {
        const eligibleResult = parseJsonArg<string[]>(argValue(args, '--eligible'), '--eligible');
        if (!eligibleResult.ok) return makeInvalidArgs('--eligible', eligibleResult.reason, ERROR_REASON.USAGE);
        const executedResult = parseJsonArg<string[]>(argValue(args, '--executed'), '--executed');
        if (!executedResult.ok) return makeInvalidArgs('--executed', executedResult.reason, ERROR_REASON.USAGE);
        output(dispatch.filterAlreadyExecuted(eligibleResult.value, executedResult.value), raw);
      },
      // `quick-batch verification-routing --status <passed|gaps_found|human_needed>`
      'verification-routing': () => {
        const status = argValue(args, '--status');
        if (status !== 'passed' && status !== 'gaps_found' && status !== 'human_needed') {
          return makeInvalidArgs(
            '--status',
            'Usage: gsd-tools quick-batch verification-routing --status <passed|gaps_found|human_needed>',
            ERROR_REASON.USAGE,
          );
        }
        output(dispatch.routeVerificationOutcome(status), raw);
      },
      // `quick-batch merge-routing --kind <merged|merge_failed|scope_violation> [--detail <text>]`
      'merge-routing': () => {
        const kind = argValue(args, '--kind');
        if (kind !== 'merged' && kind !== 'merge_failed' && kind !== 'scope_violation') {
          return makeInvalidArgs(
            '--kind',
            'Usage: gsd-tools quick-batch merge-routing --kind <merged|merge_failed|scope_violation> [--detail <text>]',
            ERROR_REASON.USAGE,
          );
        }
        const detail = argValue(args, '--detail');
        output(dispatch.routeMergeOutcome(detail !== undefined ? { kind, detail } : { kind }), raw);
      },
      // `quick-batch cleanup-entry --agent-id <id|null> --worktree-path <p> --branch <b> --expected-base <b> [--allowed-bases <json-array>] --plan-content <text>`
      'cleanup-entry': () => {
        const agentIdRaw = argValue(args, '--agent-id');
        const worktreePath = argValue(args, '--worktree-path');
        const branch = argValue(args, '--branch');
        const expectedBase = argValue(args, '--expected-base');
        const planContent = argValue(args, '--plan-content');
        if (!worktreePath || !branch || !expectedBase || planContent === undefined) {
          return makeInvalidArgs(
            '--worktree-path/--branch/--expected-base/--plan-content',
            'Usage: gsd-tools quick-batch cleanup-entry --worktree-path <p> --branch <b> --expected-base <b> --plan-content <text> [--agent-id <id>] [--allowed-bases <json-array>]',
            ERROR_REASON.USAGE,
          );
        }
        let allowedBases: string[] | undefined;
        const allowedBasesRaw = argValue(args, '--allowed-bases');
        if (allowedBasesRaw !== undefined) {
          const allowedResult = parseJsonArg<string[]>(allowedBasesRaw, '--allowed-bases');
          if (!allowedResult.ok) return makeInvalidArgs('--allowed-bases', allowedResult.reason, ERROR_REASON.USAGE);
          allowedBases = allowedResult.value;
        }
        output(dispatch.buildCleanupManifestEntry({
          agentId: agentIdRaw ?? null,
          worktreePath,
          branch,
          expectedBase,
          allowedBases,
          planContent,
        }), raw);
      },
      // `quick-batch parse-args --text "<raw $ARGUMENTS string>"` (preferred —
      // callers pass the ENTIRE, still-quoted $ARGUMENTS as ONE argv element;
      // this handler does the whitespace split itself, in Node, so shell
      // pathname expansion (globbing) on attacker-influenced task text never
      // happens before this parser sees it — quoting `"$ARGUMENTS"` at the
      // call site is what closes that off; splitting it here is what keeps
      // the caller from having to word-split it unsafely beforehand).
      // `quick-batch parse-args -- <already-tokenized args>` (legacy/direct
      // form — still supported for a caller that already has a real argv
      // array with no shell splitting involved, e.g. a test harness).
      'parse-args': () => {
        const textArg = argValue(args, '--text');
        if (textArg !== undefined) {
          const rawArgs = textArg.trim().length === 0 ? [] : textArg.trim().split(/\s+/);
          emit(dispatch.parseQuickBatchArgs(rawArgs));
          return;
        }
        const sepIdx = args.indexOf('--');
        const rawArgs = sepIdx === -1 ? [] : args.slice(sepIdx + 1);
        emit(dispatch.parseQuickBatchArgs(rawArgs));
      },
    },
    unknownMessage: (subcommand: string, available: string[]) =>
      `Unknown quick-batch subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeQuickBatchCommand,
};
