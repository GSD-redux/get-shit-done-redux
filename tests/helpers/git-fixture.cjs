'use strict';

/**
 * git-fixture — a throw-preserving wrapper over the process seam's `runGit`.
 *
 * Why this exists: `execSync`/`execFileSync` throw on any non-zero exit,
 * and 237 sites in this repo's test suite are written against that throw —
 * they read `err.status`, `err.stdout`, `err.stderr`. `tests/helpers/
 * process-seam.cjs` deliberately never throws (see its own header): every
 * outcome, including a non-zero exit, a timeout, or a spawn failure, comes
 * back as data on a discriminated-union result. Migrating a throwing
 * `execSync`/`execFileSync` call site straight onto the seam without this
 * wrapper would silently turn a loud test failure (an uncaught throw) into
 * a quiet one (a result object nobody checked) — exactly the kind of
 * regression a migration must not introduce.
 *
 * `gitOrThrow` is that bridge: it calls the seam's `runGit` and re-throws in
 * the shape the old idiom produced, with the seam's typed fields attached
 * alongside it. `tests/helpers/process-seam.cjs` itself is NOT modified by
 * this module — its never-throws contract is intact; this is a layer on
 * top, not a change underneath.
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
 * Run `git` via the process seam and throw on anything other than a clean
 * exit, preserving the legacy `execSync`/`execFileSync` throw-on-failure
 * idiom that existing test code is written against.
 *
 * @param {string[]} args - argv passed to git (never shell-interpreted).
 * @param {object} [options] - forwarded to `runGit`; see process-seam.cjs.
 *   `options.timeoutMs`, if provided, overrides `DEFAULT_GIT_TIMEOUT_MS`.
 * @returns {string} `stdout` on a clean (exit 0) run.
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
function gitOrThrow(args, options = {}) {
  // Destructure (not spread-after) so an explicit `timeoutMs: undefined` in
  // `options` still resolves to the default: a destructure default applies
  // on `undefined`, whereas `{ timeoutMs: DEFAULT, ...options }` would let
  // an own `undefined` key silently overwrite it and fall through to the
  // seam's much larger default timeout.
  const { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, ...rest } = options;
  const r = runGit(args, { ...rest, timeoutMs });

  if (r.outcome === OUTCOME.EXITED && r.exitCode === 0) {
    return r.stdout;
  }

  const argvDisplay = ['git', ...args].join(' ');
  const err = new Error(
    `gitOrThrow: \`${argvDisplay}\` failed — outcome=${r.outcome} exitCode=${r.exitCode} ` +
      `stderr=${r.stderr.trim()}`
  );
  err.status = r.exitCode;
  err.exitCode = r.exitCode;
  err.stdout = r.stdout;
  err.stderr = r.stderr;
  err.signal = r.signal;
  err.timedOut = r.timedOut;
  err.outcome = r.outcome;
  throw err;
}

module.exports = { gitOrThrow, DEFAULT_GIT_TIMEOUT_MS };
