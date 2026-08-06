'use strict';

/**
 * Process seam — the single spawnSync-based primitive test helpers use to
 * run a subprocess and get back a typed, discriminated-union result.
 *
 * Design contract: .gsd/phase/test-3055-process-seam-module/40-design.md
 * Test matrix:      .gsd/phase/test-3055-process-seam-module/50-test-matrix.md
 *
 * Scope (Phase 1, #3055): this module and the `runGsdTools` adapter in
 * tests/helpers.cjs. The 23 local wrapper helpers are migrated in a later
 * wave — they are not touched here.
 *
 * Why spawnSync (not execFileSync): execFileSync throws on any non-zero
 * exit or spawn error, forcing every caller through try/catch to recover
 * `stdout`/`stderr`/`status`. spawnSync returns all of that as data, which
 * is what lets this module express a single discriminated-union return
 * shape instead of a throw-shaped side channel.
 *
 * OUTCOME discrimination (verified empirically against this Node runtime's
 * spawnSync — see PR discussion for the probe transcripts, since the
 * design doc's stated error-code assumptions do not match observed
 * behavior on this platform/Node version):
 *
 *   - No `result.error` and `signal === null` -> EXITED (a clean or
 *     non-zero exit with no signal involved).
 *   - No `result.error` but `signal !== null` -> KILLED. A child terminated
 *     by a signal nobody in this seam sent (e.g. an external OOM killer, or
 *     `process.kill(pid, 'SIGKILL')` from outside) does NOT populate
 *     `result.error` on this runtime — verified empirically: `spawnSync`
 *     returns `{status: null, signal: 'SIGKILL', error: undefined}` for an
 *     externally-killed child. Treating that as EXITED would report
 *     `exitCode: null` under an EXITED outcome, an incoherent shape, and
 *     would silently drop the #969 kill-discrimination retry for the exact
 *     case it exists to catch. KILLED is reported as its own outcome so the
 *     `runGsdTools` adapter can retry it exactly like TIMED_OUT.
 *   - `result.error.code` is a buffer-overflow code (`ENOBUFS` on this
 *     runtime, or the `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` code documented
 *     for the async exec()/execFile() family, accepted defensively in case
 *     a different Node version/platform surfaces it here) -> BUFFER_OVERFLOW.
 *   - `result.error.code === 'ETIMEDOUT'` OR `signal !== null` -> TIMED_OUT.
 *     A timeout is identified POSITIVELY now, not by elimination: on this
 *     runtime spawnSync's own timeout kill reports `ETIMEDOUT`, and on a
 *     platform whose timeout errno differs, the child is still killed by a
 *     signal on the way out, so `signal !== null` still catches it. This
 *     replaces an earlier `status === null` catch-all that was too greedy —
 *     it also matched a spawn that never started at all (e.g. Windows
 *     `ENAMETOOLONG` from an oversized argv: `status: null, signal: null`),
 *     misclassifying a non-retryable spawn failure as a retryable timeout
 *     and driving the adapter into a retry loop that could never succeed.
 *   - Any other populated `result.error` -> SPAWN_FAILED. This subsumes the
 *     `ENOENT` case (binary not found) along with every other spawn-time
 *     errno (`ENAMETOOLONG`, `E2BIG`, `EACCES`, `EPERM`, …) — none of them
 *     carry a timeout errno or a signal, so none of them satisfy the
 *     TIMED_OUT branch above. A dedicated `ENOENT`-only branch was dropped
 *     since it produced the exact same outcome as this fallback; keeping it
 *     would have implied ENOENT gets special handling it does not need.
 */

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;

const OUTCOME = Object.freeze({
  EXITED: 'exited',
  KILLED: 'killed',
  TIMED_OUT: 'timed_out',
  BUFFER_OVERFLOW: 'buffer_overflow',
  SPAWN_FAILED: 'spawn_failed',
});

const BUFFER_OVERFLOW_CODES = new Set(['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);

/**
 * Resolve and validate `timeoutMs`. `undefined` means "use the bounded
 * default" and is the only valid way to get an unspecified timeout — there
 * is no code path in this module that spawns without one.
 */
function resolveTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `process-seam: timeoutMs must be a finite positive number, or omitted for the ` +
      `${DEFAULT_TIMEOUT_MS}ms default; received ${String(timeoutMs)}`
    );
  }
  return timeoutMs;
}

/**
 * Classify a raw spawnSync() result into the seam's discriminated union.
 */
function toSeamResult(result) {
  const { error, status, signal } = result;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const errorCode = error ? (error.code ?? null) : null;

  let outcome;
  if (!error) {
    outcome = signal === null ? OUTCOME.EXITED : OUTCOME.KILLED;
  } else if (BUFFER_OVERFLOW_CODES.has(errorCode)) {
    outcome = OUTCOME.BUFFER_OVERFLOW;
  } else if (errorCode === 'ETIMEDOUT' || signal !== null) {
    outcome = OUTCOME.TIMED_OUT;
  } else {
    // Any other populated `result.error` — ENOENT, ENAMETOOLONG, E2BIG,
    // EACCES, EPERM, etc. — is a spawn failure: the process never started
    // (or started and errored in a way that carries neither a timeout
    // errno nor a signal), so retrying can never succeed.
    outcome = OUTCOME.SPAWN_FAILED;
  }

  const timedOut = outcome === OUTCOME.TIMED_OUT;
  // KILLED always has signal !== null by construction (see the branch
  // above), so this single check also satisfies "killed is true for both
  // KILLED and TIMED_OUT" without narrowing existing behavior for the other
  // outcomes (e.g. a signaled BUFFER_OVERFLOW kill).
  const killed = timedOut || signal !== null;

  return {
    outcome,
    exitCode: status,
    stdout,
    stderr,
    timedOut,
    signal: signal ?? null,
    killed,
    code: errorCode,
  };
}

/**
 * Core seam primitive: spawn `command` with argv `args` and return the
 * typed OUTCOME-discriminated result. Never throws on a child's exit code,
 * a timeout, a buffer overflow, or a spawn failure — those are all data.
 * Throws (TypeError) only for a seam-contract violation: a non-array
 * `args`, or an invalid `timeoutMs`.
 *
 * @param {string} command - binary to spawn (never shell-interpreted).
 * @param {string[]} args - argv array. No shell-string parsing.
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {string} [options.input] - stdin payload. Omit entirely to leave
 *   stdin unwritten-then-closed; passing `''` is a different, deliberate
 *   choice callers may still make, but it is never implied by omission.
 * @param {number} [options.timeoutMs] - bounded; see resolveTimeoutMs.
 * @param {string} [options.killSignal] - forwarded to spawnSync verbatim;
 *   the seam asserts nothing about which signal is used.
 * @returns {{outcome:string, exitCode:number|null, stdout:string,
 *   stderr:string, timedOut:boolean, signal:string|null, killed:boolean,
 *   code:string|null}}
 */
function spawnSeam(command, args, options = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('process-seam: args must be an argv array, not a shell string');
  }
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);

  const spawnOptions = {
    encoding: 'utf-8', // Never caller-controlled — the seam always forces string output.
    timeout: timeoutMs,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;
  if (options.input !== undefined) spawnOptions.input = options.input;
  if (options.killSignal !== undefined) spawnOptions.killSignal = options.killSignal;

  const result = spawnSync(command, args, spawnOptions);
  return toSeamResult(result);
}

/**
 * Run a Node script/module via the current interpreter (`process.execPath`).
 * @param {string[]} args - argv passed to the spawned Node process.
 * @param {object} [options] - see spawnSeam.
 */
function runNode(args, options = {}) {
  return spawnSeam(process.execPath, args, options);
}

/**
 * Run `git`.
 * @param {string[]} args - argv passed to git.
 * @param {object} [options] - see spawnSeam.
 */
function runGit(args, options = {}) {
  return spawnSeam('git', args, options);
}

/**
 * Run a hook script, matching how tests/read-guard.test.cjs and
 * tests/workflow-guard.test.cjs invoke hooks/*.js today:
 * `execFileSync(process.execPath, [HOOK_PATH, ...args], ...)`.
 *
 * The hook surface this seam replaces is not node-only: 4 of the 23 local
 * wrappers being migrated drive `bash` guard/gate scripts directly
 * (tests/execute-phase-worktree-guard.test.cjs:59,
 * tests/graphify-auto-update.slow.test.cjs:248,
 * tests/worktree-cleanup.test.cjs:1549, tests/worktree-safety.test.cjs:4641).
 * Rather than add a fourth spawn primitive for one more binary, the target
 * interpreter is a parameter here. It is EXPLICIT, never inferred from
 * `target`'s extension — guessing an interpreter from a path fails silently
 * on a script whose name does not match its shebang.
 *
 * @param {string} target - the first argv element handed to the
 *   interpreter. Normally an absolute path to the hook/guard/gate script
 *   being run. But for an interpreter invoked with an inline program (e.g.
 *   `bash -c '<script text>'`), this is that interpreter's own flag —
 *   `'-c'` — with the actual program text supplied as the first element of
 *   `args`, not as `target` itself.
 * @param {string[]} [args] - extra argv for the hook. When `target` is an
 *   interpreter flag like `'-c'`, this is where the inline program text and
 *   its own argv go.
 * @param {object} [options] - see spawnSeam.
 * @param {string} [options.interpreter] - binary used to run `target`.
 *   Defaults to `process.execPath` (matching read-guard/workflow-guard
 *   today); pass `'bash'` to run a shell script instead.
 */
function runHook(target, args = [], options = {}) {
  const { interpreter = process.execPath, ...spawnOptions } = options;
  return spawnSeam(interpreter, [target, ...args], spawnOptions);
}

module.exports = { runNode, runGit, runHook, OUTCOME };
