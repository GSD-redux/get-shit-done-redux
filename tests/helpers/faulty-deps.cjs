'use strict';

/**
 * In-process fault-injection adapter (issue #3056, Phase 2 of epic #3051).
 *
 * `makeFaultyGit()` and `withFaultyFs()` inject faults ONLY via the `deps`
 * parameters that production seams already accept (`execGit`-shaped
 * functions, `fs` module methods). This is in-process injection ONLY.
 *
 * The Phase 1 subprocess-dispatch seam (`tests/helpers/process-seam.cjs`,
 * issue #3055) is DELIBERATELY NOT a fault-injection surface and must never
 * be used to simulate a timeout, an ENOENT, or any other fault: the
 * subprocess path has no way to distinguish an injected failure from a
 * genuine bench OOM or a real flaky CI host, and — per the process seam's
 * own retry policy — it would retry an injected timeout exactly as if it
 * were a real one, silently corrupting the test's intent (design matrix
 * row 24). Fault injection belongs at the `deps` seam, in-process, where the
 * test controls exactly what is faulted and exactly once.
 *
 * `makeFaultyGit(options)` returns a function structurally assignable to
 * `typeof execGit` from `shell-command-projection.cjs` — i.e. it satisfies
 * every `ExecGitFn` declaration in the tree (worktree-safety.cts,
 * git-base-branch.cts, worktree-base-ref.cts, verification.cts) because all
 * four are structural subsets/supersets of that one shape (#3071).
 *
 * `withFaultyFs(patches, body)` monkeypatches named `fs` methods and
 * guarantees restoration in a `finally` — this file is a standalone helper
 * with no test context, which is the ONLY place CONTRIBUTING.md ("Setup and
 * Cleanup") permits a `try/finally`: "try/finally is only permitted inside
 * standalone utility or helper functions that have no access to test
 * context." Test bodies must never use try/finally directly.
 *
 * NEVER use chmod to simulate an fs fault. `chmod 0o000` no-ops under root
 * (root bypasses mode bits), so a chmod-based fault silently passes with
 * zero coverage in root Docker/CI — see CONTRIBUTING.md and the Phase 2
 * design doc's "Not-corruption / negative space" section.
 */

const DEFAULT_PASSTHROUGH_RESULT = Object.freeze({
  exitCode: 0,
  stdout: '',
  stderr: '',
  signal: null,
  error: null,
  timedOut: false,
});

/**
 * Build the result shape for a single fault `kind`. Mirrors the shapes
 * `_spawnResult` in shell-command-projection.cts produces, so a faulted
 * result is indistinguishable in shape from a real one.
 *
 * @param {{kind: string, exitCode?: number, stderr?: string}} fault
 * @returns {{exitCode:number, stdout:string, stderr:string, signal:(string|null), error:(Error|null), timedOut:boolean}}
 */
function _buildFaultResult(fault) {
  switch (fault.kind) {
    case 'timeout': {
      const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      return {
        exitCode: 1,
        stdout: '',
        stderr: '',
        signal: 'SIGTERM',
        error,
        timedOut: true,
      };
    }
    case 'exit': {
      return {
        exitCode: typeof fault.exitCode === 'number' ? fault.exitCode : 1,
        stdout: '',
        stderr: fault.stderr || '',
        signal: null,
        error: null,
        timedOut: false,
      };
    }
    case 'spawnFail': {
      const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      return {
        exitCode: 127,
        stdout: '',
        stderr: '',
        signal: null,
        error,
        timedOut: false,
      };
    }
    default:
      throw new Error(`makeFaultyGit: unknown fault kind "${fault.kind}"`);
  }
}

/**
 * Return true when `fault.when` matches this invocation's argv.
 * `when` may be an argv predicate `(args) => boolean` or an array treated as
 * a prefix match against `args`.
 *
 * @param {*} when
 * @param {string[]} args
 * @returns {boolean}
 */
function _whenMatches(when, args) {
  if (when === undefined) return true;
  if (typeof when === 'function') return Boolean(when(args));
  if (Array.isArray(when)) {
    if (when.length > args.length) return false;
    return when.every((token, i) => args[i] === token);
  }
  return false;
}

/**
 * Build a fault-injecting stand-in for `execGit` (and, by structural typing,
 * for every `ExecGitFn` site in the tree — see module doc). Faults are
 * configured, never global: a call only faults when it matches every
 * constraint on a configured fault; every other call delegates to
 * `options.passthrough` (default: a benign zero-exit result).
 *
 * @param {object} [options]
 * @param {Array<{
 *   kind: 'timeout'|'exit'|'spawnFail',
 *   exitCode?: number,
 *   stderr?: string,
 *   when?: ((args: string[]) => boolean) | string[],
 *   onCall?: number,
 * }>} [options.faults] - fault configurations, evaluated in order; the first
 *   whose `when`/`onCall` match the current call wins.
 * @param {(args: string[], opts?: object) => object} [options.passthrough] -
 *   delegate for calls that do not match any configured fault. Defaults to a
 *   benign `{exitCode:0, stdout:'', stderr:'', signal:null, error:null, timedOut:false}`.
 * @returns {((args: string[], opts?: object) => object) & { calls: Array<{args:string[], opts:object}> }}
 */
function makeFaultyGit(options) {
  const opts = options || {};
  const faults = Array.isArray(opts.faults) ? opts.faults : [];
  const passthrough = typeof opts.passthrough === 'function'
    ? opts.passthrough
    : () => ({ ...DEFAULT_PASSTHROUGH_RESULT });

  const calls = [];

  function faultyGit(args, callOpts) {
    const recordedArgs = Array.isArray(args) ? args.slice() : args;
    const recordedOpts = callOpts || {};
    calls.push({ args: recordedArgs, opts: recordedOpts });
    const callNumber = calls.length;

    for (const fault of faults) {
      if (fault.onCall !== undefined && fault.onCall !== callNumber) continue;
      if (!_whenMatches(fault.when, recordedArgs)) continue;
      return _buildFaultResult(fault);
    }

    return passthrough(recordedArgs, recordedOpts);
  }

  faultyGit.calls = calls;
  return faultyGit;
}

/**
 * Monkeypatch named `fs` methods for the duration of `body()`, guaranteeing
 * restoration via `finally` even when `body` throws. Nestable: each call
 * saves its own originals into a local (not module-level) map, so an inner
 * `withFaultyFs` restoring first does not clobber an outer call's saved
 * original.
 *
 * This is the ONLY place in the test tree permitted to use try/finally —
 * see the module doc and CONTRIBUTING.md "Setup and Cleanup": "try/finally
 * is only permitted inside standalone utility or helper functions that have
 * no access to test context." This helper has no test context; it is a
 * plain function.
 *
 * @template T
 * @param {Record<string, (...args: any[]) => any>} patches - maps an `fs`
 *   method name to its replacement (typically a function that throws).
 * @param {() => T} body
 * @returns {T}
 */
function withFaultyFs(patches, body) {
  const fs = require('node:fs');
  const methodNames = Object.keys(patches);
  const originals = new Map();
  for (const name of methodNames) {
    originals.set(name, fs[name]);
    fs[name] = patches[name];
  }
  try {
    return body();
  } finally {
    for (const name of methodNames) {
      fs[name] = originals.get(name);
    }
  }
}

module.exports = { makeFaultyGit, withFaultyFs };
