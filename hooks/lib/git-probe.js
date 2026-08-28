'use strict';
// hooks/lib/git-probe.js — classify a bounded spawnSync(git, ...) result,
// distinguishing a GENUINE negative answer (git ran and said "no") from
// "could not determine" (timeout / spawn failure / signal kill) — #3911.
//
// Proven defect: hooks/gsd-worktree-path-guard.js, hooks/gsd-workflow-guard.js,
// and hooks/gsd-windsurf-pre-write.js each treat spawnSync(git, ..., {timeout})
// returning a non-zero/empty result as "not applicable" and allow silently.
// A macOS CI run showed three deny cases land at 2084ms/2112ms/2177ms — just
// past the 2000ms budget — each returning exit 0 with EMPTY stdout AND EMPTY
// stderr: a timeout is INDISTINGUISHABLE, at the call site, from git cleanly
// answering "not a repo" / "not this worktree" unless the spawnSync() result
// itself is inspected for `error`/`signal`, not just `status`/`stdout`.
//
// This module does not change any hook's decision or exit code — it only
// answers "was this probe's answer real?" so a caller can emit a diagnostic
// on the undetermined branch while keeping the existing fail-open behavior.
//
// Classification mirrors tests/helpers/process-seam.cjs's OUTCOME vocabulary
// (EXITED vs TIMED_OUT/SPAWN_FAILED/KILLED) — same evidence-over-classification
// ordering (a populated `status` outranks an attached `error`, since Node can
// report `error.code === 'ETIMEDOUT'` on a result that also carried a real
// exit that beat the timer) — so a probe here and a subprocess outcome in the
// test suite never disagree on the same raw spawnSync() shape.

/**
 * @param {{error?: (Error & {code?: string})|null, status: number|null, signal: string|null}} result
 *   the raw return value of `spawnSync('git', ...)`.
 * @returns {{determined: true} | {determined: false, reason: string}}
 */
function classifyGitProbe(result) {
  const error = result && result.error;
  const status = result ? result.status : null;
  const signal = result ? result.signal : null;

  if (!error && signal === null) {
    // A real exit — status 0 or non-zero is a genuine, trustworthy answer.
    return { determined: true };
  }
  if (status !== null) {
    // `status` is only ever populated by a real exit; it outranks an attached
    // `error` even at the exact timeout boundary (process-seam.cjs's own
    // "evidence over classification" rule).
    return { determined: true };
  }

  const code = error ? (error.code ?? null) : null;
  let reason;
  if (code === 'ETIMEDOUT' || signal !== null) {
    reason = signal ? `timed out (signal ${signal})` : 'timed out';
  } else if (code) {
    reason = `spawn failed (${code})`;
  } else {
    reason = 'could not run (unknown reason)';
  }
  return { determined: false, reason };
}

/**
 * If `result` could not be determined (timeout / spawn failure / signal
 * kill), write a stderr diagnostic naming the probe and why — never changes
 * any exit code, never throws. A no-op when the probe genuinely ran and
 * answered (status 0 or non-zero with no error/signal).
 *
 * @param {string} hookName - e.g. 'gsd-worktree-path-guard'
 * @param {string} probeLabel - e.g. "git rev-parse --show-toplevel"
 * @param {*} result - the raw spawnSync() return value
 */
function reportIfUndetermined(hookName, probeLabel, result) {
  const classification = classifyGitProbe(result);
  if (classification.determined) return;
  try {
    process.stderr.write(
      `${hookName}: git probe '${probeLabel}' ${classification.reason} — ` +
      `allowing this call because the probe's answer is unknown, not because ` +
      `git answered "no" (#3911).\n`
    );
  } catch {
    // A stderr write failing (EPIPE, closed fd) must never itself change the
    // hook's fail-open outcome.
  }
}

module.exports = { classifyGitProbe, reportIfUndetermined };
