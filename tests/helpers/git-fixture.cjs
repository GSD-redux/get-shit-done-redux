'use strict';

/**
 * git-fixture — the shared throw-on-failure mechanism for process-seam
 * results, its non-throwing counterpart, plus a throw-preserving wrapper
 * over the seam's `runGit`.
 *
 * Why this exists: `execSync`/`execFileSync` throw on any non-zero exit,
 * and 237+ sites in this repo's test suite are written against that throw —
 * they read `err.status`, `err.stdout`, `err.stderr`. `tests/helpers/
 * process-seam.cjs` deliberately never throws (see its own header): every
 * outcome, including a non-zero exit, a timeout, or a spawn failure, comes
 * back as data on a discriminated-union result. Migrating a throwing
 * `execSync`/`execFileSync` call site straight onto the seam without this
 * wrapper would silently turn a loud test failure (an uncaught throw) into
 * a quiet one (a result object nobody checked) — exactly the kind of
 * regression a migration must not introduce.
 *
 * `throwIfFailed` is that mechanism: given any process-seam result and a
 * human-readable name for what ran, it throws in the shape the legacy
 * `execSync`/`execFileSync` idiom produced, with the seam's typed fields
 * attached alongside it — or returns quietly on a clean exit. `gitOrThrow`
 * is `throwIfFailed` specialized to `runGit`. Every other local test helper
 * that needs the same throw-on-failure bridge (over `runNode`, `runHook`,
 * etc.) calls `throwIfFailed` directly instead of hand-rolling its own copy
 * of this shape — five call sites did exactly that before this module
 * exported it, and drifted from each other in the process (#3144).
 *
 * `toLegacyResult` is the non-throwing sibling: call sites that already
 * branch on exit status as data (never wanted a throw) still need the
 * result reshaped onto the legacy `{ status, stdout, stderr }` field names
 * their assertions read — ~8 test files hand-rolled that identical mapping
 * before this module exported it too (#3147).
 *
 * `tests/helpers/process-seam.cjs` itself is NOT modified by this module —
 * its never-throws contract is intact; this is a layer on top, not a change
 * underneath.
 */

const { runGit, OUTCOME } = require('./process-seam.cjs');

/**
 * Default timeout for `gitOrThrow` calls, in milliseconds.
 *
 * 15000ms: these are git plumbing operations (rev-parse, branch, log, ...)
 * against a small mkdtemp fixture repo — well over any observed local/CI
 * duration for that class of call, and far under the seam's own 60000ms
 * default so a hung git surfaces fast instead of riding out the seam's full
 * budget.
 */
const DEFAULT_GIT_TIMEOUT_MS = 15000;

/**
 * Throw on anything other than a clean (exit 0) process-seam result,
 * preserving the legacy `execSync`/`execFileSync` throw-on-failure idiom
 * that existing test code is written against. Returns quietly (no return
 * value) on a clean exit — callers that need `stdout` read it off `result`
 * themselves; this only decides whether to throw.
 *
 * @param {object} result - a process-seam result: `{outcome, exitCode,
 *   stdout, stderr, timedOut, signal}` (plus any seam-specific fields,
 *   e.g. `code`, which are ignored here).
 * @param {string} displayName - human string naming what ran, e.g.
 *   `'git commit -m seed'` or `'bash <quick-guard snippet>'`. Embedded in
 *   the thrown message so failures are attributable at a glance.
 * @throws {Error} On any non-zero exit, timeout, kill, or spawn failure.
 *   The thrown error carries, as own properties:
 *   - `status` — the exit code (the legacy `execSync`/`execFileSync` name;
 *     this repo's migrated catch blocks read `err.status`, e.g.
 *     tests/worktree-safety.test.cjs:1361, tests/read-guard.test.cjs:160,
 *     tests/security-scan.security.test.cjs:201).
 *   - `exitCode` — the same value as `status` (the seam's own name; both
 *     are aliases on purpose, not a rename).
 *   - `stdout`, `stderr` — strings.
 *   - `signal` — the seam's `signal` field.
 *   - `timedOut` — the seam's `timedOut` field.
 *   - `outcome` — the seam's `OUTCOME` discriminant.
 */
function throwIfFailed(result, displayName) {
  if (result.outcome === OUTCOME.EXITED && result.exitCode === 0) {
    return;
  }

  const err = new Error(
    `${displayName} failed — outcome=${result.outcome} exitCode=${result.exitCode} ` +
      `stderr=${result.stderr.trim()}`
  );
  err.status = result.exitCode;
  err.exitCode = result.exitCode;
  err.stdout = result.stdout;
  err.stderr = result.stderr;
  err.signal = result.signal;
  err.timedOut = result.timedOut;
  err.outcome = result.outcome;
  throw err;
}

/**
 * Run `git` via the process seam and throw on anything other than a clean
 * exit, preserving the legacy `execSync`/`execFileSync` throw-on-failure
 * idiom that existing test code is written against.
 *
 * @param {string[]} args - argv passed to git (never shell-interpreted).
 * @param {object} [options] - forwarded to `runGit`; see process-seam.cjs.
 *   `options.timeoutMs`, if provided, overrides `DEFAULT_GIT_TIMEOUT_MS`.
 * @returns {string} `stdout` on a clean (exit 0) run.
 * @throws {Error} See `throwIfFailed` for the exact shape thrown.
 */
function gitOrThrow(args, options = {}) {
  // Destructure (not spread-after) so an explicit `timeoutMs: undefined` in
  // `options` still resolves to the default: a destructure default applies
  // on `undefined`, whereas `{ timeoutMs: DEFAULT, ...options }` would let
  // an own `undefined` key silently overwrite it and fall through to the
  // seam's much larger default timeout.
  const { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, ...rest } = options;
  const r = runGit(args, { ...rest, timeoutMs });

  throwIfFailed(r, `gitOrThrow: \`${['git', ...args].join(' ')}\``);
  return r.stdout;
}

/**
 * The NON-throwing counterpart to `throwIfFailed`: maps any process-seam
 * result onto the legacy `execSync`/`execFileSync` `{ status, stdout,
 * stderr }` shape, without ever throwing. For call sites that already read
 * exit status as data (they branch on `.status`/`.stdout`/`.stderr`
 * themselves) rather than wanting a throw on failure — the same "the shape
 * is defined once rather than re-derived per suite" motivation as
 * `throwIfFailed`, just for the non-throwing half of the split. Before this
 * export existed, ~8 test files hand-rolled the identical three-line mapping
 * (#3147 pre-PR review finding).
 *
 * This is intentionally a bare mapping and nothing more: some call sites
 * layer additional site-specific behavior on top (an extra field, a parsed
 * JSON body in place of raw `stdout`, etc.) — those compose `toLegacyResult`
 * as a building block (e.g. `{ ...toLegacyResult(result), extra }`) rather
 * than folding their extra behavior into this helper, so this shape stays
 * exactly one thing everywhere it's used.
 *
 * @param {object} result - a process-seam result: `{outcome, exitCode,
 *   stdout, stderr, timedOut, signal}` (plus any seam-specific fields).
 * @returns {{status: number|null, stdout: string, stderr: string}} —
 *   `status` is the legacy `spawnSync`/`execFileSync` field name for
 *   `result.exitCode`; `stdout`/`stderr` pass through unchanged.
 */
function toLegacyResult(result) {
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

module.exports = { gitOrThrow, throwIfFailed, toLegacyResult, DEFAULT_GIT_TIMEOUT_MS };
