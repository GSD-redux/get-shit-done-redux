/**
 * Task Content Resolution Module (ADR-3646 Phase 1, #3970).
 *
 * Given a task's `tracker-id` attribute value (parsed verbatim by
 * `plan-document.cts`, never split there) and the set of installed
 * capabilities' `taskContentResolver` declarations, resolves the task's
 * content from the matching external tracker via a bounded subprocess call —
 * or reports that no resolution applies.
 *
 * PURE / IMPURE SPLIT, loosely mirroring `review-lane-invocation.cts`'s
 * resolve-then-run shape, but deliberately NOT copying its full machinery
 * (Gall's Law — see `40-design.md`'s "Laws that apply" section): this problem
 * has no probe/model/effort/prompt-channel axes, just one deterministic
 * id-lookup. `splitTrackerId`, `findResolver`, and `buildInvocation` are pure
 * and total (never throw, even on hostile third-party-shaped input — a
 * capability manifest is third-party-authored, and while `capability-
 * validator.cjs` validates it at install time, this module re-validates
 * defensively rather than trusting that boundary). `resolveTaskContent` is
 * the one impure boundary: it spawns exactly one bounded subprocess, through
 * an injectable `execFn` so tests never spawn a real process or wait a real
 * timeout (CLAUDE.md's clock-seam rule).
 *
 * HARD-HALT CONTRACT (ADR-3646 Decision 4): an ambiguous resolver match, a
 * non-zero resolver exit, a timeout, or malformed resolver stdout all THROW.
 * None of these degrade to a silently-empty or silently-picked result — a
 * task-content resolution failure must halt the caller (`task-command-
 * router.cts`'s `resolve-content` subcommand turns each throw into the CLI's
 * own non-zero exit), never fall back to inline PLAN.md content pretending
 * nothing happened.
 *
 * ADR-457 build-at-publish: source in src/task-content-resolution.cts,
 * compiled to gsd-core/bin/lib/task-content-resolution.cjs (gitignored).
 */

// Use non-destructured namespace import so test-time mock.method(childProcess,
// 'spawnSync') can intercept calls from this seam — destructured imports
// capture references at load time and become un-mockable (matches the
// convention documented in shell-command-projection.cts).
import childProcess from 'node:child_process';

// ─── Result taxonomy ──────────────────────────────────────────────────────────

/**
 * The four non-throwing outcomes of `resolveTaskContent`. Frozen because the
 * `kind` discriminant is the product — callers (the CLI seam) switch on it
 * directly rather than string-matching prose.
 */
const TASK_CONTENT_RESULT = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  NO_RESOLVER: 'no-resolver',
  RESOLVED: 'resolved',
  EMPTY: 'empty',
} as const);

type TaskContentResultKind =
  (typeof TASK_CONTENT_RESULT)[keyof typeof TASK_CONTENT_RESULT];

interface ResolvedTaskContent {
  action: string | null;
  verify: string | null;
  acceptanceCriteria: string[];
  readFirst: string[];
  done: string | null;
}

type TaskContentResolution =
  | { kind: 'not-applicable' }
  | { kind: 'no-resolver' }
  | { kind: 'empty' }
  | { kind: 'resolved'; content: ResolvedTaskContent };

// ─── Throwable error taxonomy ─────────────────────────────────────────────────
// These four ALWAYS throw — they are configuration/execution defects, never a
// value `resolveTaskContent` returns. See the module docstring's hard-halt
// contract.

/**
 * Two or more installed capabilities declare a `taskContentResolver` for the
 * same `trackerPrefix`. Structurally impossible in a correctly-validated
 * install (`capability-validator.cjs` enforces cross-capability prefix
 * uniqueness), but `findResolver` must still refuse to silently pick one if a
 * test harness or a validator bug ever produces this shape.
 */
class ResolverAmbiguousError extends Error {
  prefix: string;
  capabilityIds: string[];
  constructor(prefix: string, capabilityIds: string[]) {
    super(
      `tracker prefix '${prefix}' matches ${capabilityIds.length} installed capability resolvers ` +
        `(${capabilityIds.join(', ')}) — ambiguous resolver registration must never silently pick one`,
    );
    this.name = 'ResolverAmbiguousError';
    this.prefix = prefix;
    this.capabilityIds = capabilityIds;
  }
}

/** The resolver subprocess exited non-zero (or failed to spawn at all). */
class ResolverFailedError extends Error {
  exitCode: number | null;
  stderrTail: string;
  constructor(binary: string, exitCode: number | null, stderrTail: string) {
    super(
      `resolver command '${binary}' exited ${exitCode === null ? 'with no exit code (spawn failure)' : exitCode}` +
        (stderrTail ? `: ${stderrTail}` : ''),
    );
    this.name = 'ResolverFailedError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** The resolver subprocess exceeded its declared `invoke.timeoutMs` bound. */
class ResolverTimeoutError extends Error {
  timeoutMs: number;
  constructor(binary: string, timeoutMs: number) {
    super(`resolver command '${binary}' timed out after ${timeoutMs}ms`);
    this.name = 'ResolverTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The resolver's stdout was not valid JSON, or was valid JSON that is not a
 * plain object (a `null`, array, string, number, or boolean top-level value
 * is rejected — only a plain object can carry the `description`/`verify`/
 * `acceptance_criteria`/`read_first`/`done` fields this seam reads).
 */
class ResolverMalformedOutputError extends Error {
  stdoutSample: string;
  constructor(binary: string, reason: string, stdoutSample: string) {
    super(`resolver command '${binary}' produced malformed output: ${reason}`);
    this.name = 'ResolverMalformedOutputError';
    this.stdoutSample = stdoutSample;
  }
}

// ─── Manifest shapes ───────────────────────────────────────────────────────────

interface TaskContentResolverInvoke {
  binary: string;
  args: string[];
  timeoutMs: number;
}

interface TaskContentResolverDeclaration {
  capabilityId: string;
  trackerPrefix: string;
  invoke: TaskContentResolverInvoke;
}

interface CapabilityLike {
  id: string;
  taskContentResolver?: unknown;
}

// ─── Pure functions ────────────────────────────────────────────────────────────

/**
 * Split a `tracker-id` attribute value into its prefix and id, on the FIRST
 * `:` only — colons after the first stay in the id verbatim (a tracker whose
 * native ids contain colons, e.g. `beads:issue:GSD-1` → `{prefix: "beads",
 * id: "issue:GSD-1"}`).
 *
 * PURE. Returns `null` for `null`/empty input, and for a string with no `:`
 * at all (nothing to split — there is no prefix to match a resolver against).
 */
function splitTrackerId(trackerId: string | null): { prefix: string; id: string } | null {
  if (typeof trackerId !== 'string' || trackerId.length === 0) return null;
  const colonIdx = trackerId.indexOf(':');
  if (colonIdx === -1) return null;
  const prefix = trackerId.slice(0, colonIdx);
  const id = trackerId.slice(colonIdx + 1);
  if (!prefix || !id) return null;
  return { prefix, id };
}

/**
 * Defensively re-validate a raw `taskContentResolver` declaration's shape.
 * `capability-validator.cjs` already enforces this at install time, but this
 * module treats every capability manifest as third-party-authored input and
 * never trusts a shape it has not itself checked — a malformed declaration is
 * treated as though it does not exist for matching purposes, never thrown on.
 */
function parseResolverDeclaration(
  capabilityId: string,
  raw: unknown,
): TaskContentResolverDeclaration | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as { trackerPrefix?: unknown; invoke?: unknown };
  const trackerPrefix = typeof body.trackerPrefix === 'string' ? body.trackerPrefix.trim() : '';
  if (!trackerPrefix) return null;

  const inv = body.invoke;
  if (inv === null || typeof inv !== 'object' || Array.isArray(inv)) return null;
  const invBody = inv as { binary?: unknown; args?: unknown; timeoutMs?: unknown };

  const binary = typeof invBody.binary === 'string' ? invBody.binary.trim() : '';
  if (!binary) return null;

  const args = Array.isArray(invBody.args)
    ? invBody.args.filter((a): a is string => typeof a === 'string')
    : null;
  if (args === null || args.length !== (invBody.args as unknown[]).length) return null;
  if (!args.includes('{{id}}')) return null;

  const timeoutMs = invBody.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) return null;

  return {
    capabilityId,
    trackerPrefix,
    invoke: { binary, args, timeoutMs },
  };
}

/**
 * Find the resolver declared for `prefix` among `capabilities`.
 *
 * PURE, total. Returns:
 *   - the single matching declaration when exactly one well-formed resolver
 *     declares `trackerPrefix === prefix`;
 *   - `null` when zero capabilities declare a well-formed resolver for it
 *     (an unrecognized prefix is a data case, not a defect — see design row 11);
 *   - the literal string `'ambiguous'` when two or more do — this must be
 *     structurally impossible in a correctly-validated install, but this
 *     function refuses to silently pick one regardless.
 */
function findResolver(
  prefix: string,
  capabilities: Array<CapabilityLike>,
): TaskContentResolverDeclaration | 'ambiguous' | null {
  const matches: TaskContentResolverDeclaration[] = [];
  for (const cap of capabilities ?? []) {
    if (!cap || typeof cap !== 'object') continue;
    const decl = parseResolverDeclaration(cap.id, cap.taskContentResolver);
    if (decl && decl.trackerPrefix === prefix) matches.push(decl);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

/**
 * Expand a resolver's `invoke.args` template, replacing every `"{{id}}"`
 * entry with the literal `id` string. Exact-match token replacement, not
 * template-string interpolation — mirrors `review-lane-invocation.cts`'s
 * argv-expansion discipline (a placeholder is a whole array element, not a
 * substring).
 *
 * PURE.
 */
function buildInvocation(
  resolver: { invoke: TaskContentResolverInvoke },
  id: string,
): TaskContentResolverInvoke {
  return {
    binary: resolver.invoke.binary,
    args: resolver.invoke.args.map((a) => (a === '{{id}}' ? id : a)),
    timeoutMs: resolver.invoke.timeoutMs,
  };
}

// ─── Subprocess boundary ──────────────────────────────────────────────────────

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type ExecFn = (binary: string, args: string[], opts: { timeout: number }) => ExecResult;

/**
 * Real subprocess execution — the default `execFn`. Uses Node's `spawnSync`
 * with the `timeout` option so a hung resolver is killed at the bound rather
 * than hanging the caller (CLAUDE.md's Unbounded Subprocesses gauntlet line).
 */
function realExec(binary: string, args: string[], opts: { timeout: number }): ExecResult {
  const result = childProcess.spawnSync(binary, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout,
    windowsHide: true,
  });
  return {
    status: result.status ?? null,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    error: result.error ?? undefined,
  };
}

/**
 * True when an `ExecResult` indicates the subprocess was killed by the
 * `timeout` option, i.e. it never completed and reported a real answer. Only
 * `error.code === 'ETIMEDOUT'` is checked — Node.js guarantees this
 * cross-platform when `spawnSync`'s `timeout` option fires; pairing it with a
 * `signal === 'SIGTERM'` check is platform-fragile (Windows does not
 * necessarily report SIGTERM the same way) and risks a false negative. Same
 * predicate discipline as `shell-command-projection.cts`'s `isSpawnTimeout`.
 */
function isExecTimeout(result: ExecResult): boolean {
  const err: NodeJS.ErrnoException | undefined = result.error;
  return err?.code === 'ETIMEDOUT';
}

// ─── Resolver JSON → content mapping ──────────────────────────────────────────

function coerceStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Map a resolver's validated JSON object onto `ResolvedTaskContent`. Every
 * field is coerced defensively — the resolver's JSON is a third-party CLI's
 * output, validated for exit code and JSON-object-shape upstream, but never
 * trusted field-by-field. A missing or wrong-typed field degrades sanely
 * (string/null fields fall back to `null`, array fields fall back to `[]`);
 * only the caller's `description`-emptiness check throws no further errors
 * here — this function is never the one that decides `resolved` vs `empty`.
 */
function mapResolverOutput(body: Record<string, unknown>): ResolvedTaskContent {
  return {
    action: coerceStringOrNull(body['description']),
    verify: coerceStringOrNull(body['verify']),
    acceptanceCriteria: coerceStringArray(body['acceptance_criteria']),
    readFirst: coerceStringArray(body['read_first']),
    done: coerceStringOrNull(body['done']),
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────────

interface ResolveTaskContentInput {
  trackerId: string | null;
  capabilities: Array<CapabilityLike>;
  /** Override the resolver's declared `invoke.timeoutMs`, primarily for tests. */
  timeoutOverrideMs?: number;
  execFn?: ExecFn;
}

/**
 * Orchestrate one task's content resolution: split the `tracker-id`, find the
 * matching capability's resolver, invoke it through the bounded subprocess
 * boundary, and map its JSON output onto the four documented outcomes.
 *
 * The only impure boundary is `execFn` (defaults to a real `spawnSync` call).
 * Injecting a fake `execFn` lets tests assert every outcome — including a
 * timeout — deterministically, without spawning a real process or waiting a
 * real `timeoutMs`.
 */
function resolveTaskContent(input: ResolveTaskContentInput): TaskContentResolution {
  const split = splitTrackerId(input.trackerId);
  if (split === null) return { kind: TASK_CONTENT_RESULT.NOT_APPLICABLE };

  const resolver = findResolver(split.prefix, input.capabilities ?? []);
  if (resolver === null) return { kind: TASK_CONTENT_RESULT.NO_RESOLVER };
  if (resolver === 'ambiguous') {
    // findResolver never returns the capability ids for the ambiguous case
    // (it discards the losing matches) — re-derive them here for the error.
    const ids = (input.capabilities ?? [])
      .filter((cap) => {
        const decl = parseResolverDeclaration(cap?.id, cap?.taskContentResolver);
        return decl !== null && decl.trackerPrefix === split.prefix;
      })
      .map((cap) => cap.id);
    throw new ResolverAmbiguousError(split.prefix, ids);
  }

  const invocation = buildInvocation(resolver, split.id);
  const timeoutMs = input.timeoutOverrideMs ?? invocation.timeoutMs;
  const execFn = input.execFn ?? realExec;
  const result = execFn(invocation.binary, invocation.args, { timeout: timeoutMs });

  if (isExecTimeout(result)) {
    throw new ResolverTimeoutError(invocation.binary, timeoutMs);
  }
  if (result.error || result.status !== 0) {
    const stderrTail = (result.stderr ?? '').trim().slice(-2000);
    throw new ResolverFailedError(invocation.binary, result.status, stderrTail);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ResolverMalformedOutputError(
      invocation.binary,
      'stdout is not valid JSON',
      result.stdout.slice(0, 200),
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResolverMalformedOutputError(
      invocation.binary,
      `stdout parsed as valid JSON but is not a plain object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
      result.stdout.slice(0, 200),
    );
  }

  const content = mapResolverOutput(parsed as Record<string, unknown>);
  const description = typeof content.action === 'string' ? content.action.trim() : '';
  if (description.length === 0) {
    return { kind: TASK_CONTENT_RESULT.EMPTY };
  }
  return { kind: TASK_CONTENT_RESULT.RESOLVED, content };
}

const taskContentResolution = {
  TASK_CONTENT_RESULT,
  splitTrackerId,
  findResolver,
  buildInvocation,
  resolveTaskContent,
  ResolverAmbiguousError,
  ResolverFailedError,
  ResolverTimeoutError,
  ResolverMalformedOutputError,
};

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace taskContentResolution {
  export {
    TaskContentResultKind,
    ResolvedTaskContent,
    TaskContentResolution,
    TaskContentResolverInvoke,
    TaskContentResolverDeclaration,
    CapabilityLike,
    ExecResult,
    ExecFn,
    ResolveTaskContentInput,
  };
}

export = taskContentResolution;
