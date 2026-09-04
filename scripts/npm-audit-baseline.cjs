#!/usr/bin/env node
'use strict';

/**
 * #4196: npm-audit baseline diff.
 *
 * The #3588 gate (tests/npm-integrity-gate.test.cjs) used to fail on ANY
 * advisory present in the production tree, regardless of whether the PR
 * being checked introduced it. Because npm's advisory database updates
 * continuously and independently of repo state, that made the gate fail
 * for reasons no PR caused -- see #4196 for the incident where PR #4188
 * passed this gate at merge time and failed it ~15 minutes later on the
 * identical commit, purely because a new advisory was disclosed in the
 * interim.
 *
 * This module computes which vulnerable packages are NEW relative to a
 * baseline tree (typically the PR's target branch), so the gate blocks a
 * PR only for advisories it actually introduces -- a pre-existing advisory
 * in an untouched transitive dependency no longer blocks unrelated work.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Per-attempt timeout. 60s comfortably covers the worst *working* latency
// measured against this endpoint (43.41s, see #4260) while staying well
// under the old single-shot 180s budget once multiplied by AUDIT_MAX_ATTEMPTS.
const AUDIT_ATTEMPT_TIMEOUT_MS = 60_000;
// Bounded retry, not unbounded -- a registry-side outage must still fail the
// gate eventually (see #4260's own caveat: silently disarming a required
// security check on a transport error is worse than failing it).
const AUDIT_MAX_ATTEMPTS = 3;
// Exponential backoff base between attempts (2s, 4s for attempts 1->2, 2->3).
const AUDIT_BACKOFF_BASE_MS = 2_000;

/**
 * Synchronous sleep (execFileSync-based retry logic is itself synchronous,
 * so backoff between attempts must be too). Uses Atomics.wait on a throwaway
 * SharedArrayBuffer, the standard Node pattern for a blocking sleep with no
 * external dependency.
 */
function sleepSyncMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * True when `error` represents a child process execFileSync killed via its
 * `timeout` option (e.g. AUDIT_ATTEMPT_TIMEOUT_MS firing against a
 * slow/degraded npm registry) rather than one that exited normally with a
 * non-zero code. Node sets `killed: true` and `signal` to the kill signal in
 * that case (see the child_process docs for execFileSync's `timeout`
 * option); a normal "npm audit found advisories" exit has neither set. The
 * distinction matters because a killed process's stdout is truncated
 * mid-write, not complete JSON -- treating it as recoverable JSON produces a
 * misleading `Unexpected end of JSON input` instead of naming the real
 * cause.
 */
function isTimeoutKill(error) {
  return Boolean(error && (error.killed === true || error.signal));
}

/**
 * Builds the standard timeout-kill error message, shared by every caller
 * that classifies a killed npm audit process after exhausting retries (see
 * isTimeoutKill, runNpmAuditWithRetry) -- kept in one place so the message
 * can't independently drift between callers, per this repo's Generative Fix
 * Divergence anti-pattern.
 *
 * Includes whatever `error.stderr` execFileSync captured before the last
 * kill (Node buffers stdout/stderr from a killed child in-memory and
 * attaches them to the thrown error; without surfacing it here that data
 * was simply discarded, giving zero diagnostic signal into WHY npm was
 * still running when the timeout fired).
 */
function buildTimeoutKillError(cwd, error, attempts = 1) {
  const stderr = error && error.stderr
    ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf-8') : String(error.stderr))
    : '';
  const stderrSuffix = stderr.trim()
    ? `\n\nCaptured stderr before the last kill:\n${stderr.trim().slice(0, 2000)}`
    : '\n\n(no stderr was captured before the last kill)';
  const attemptsPhrase = attempts > 1
    ? `after ${attempts} attempts (each up to ${AUDIT_ATTEMPT_TIMEOUT_MS}ms, with exponential backoff between)`
    : `after ${AUDIT_ATTEMPT_TIMEOUT_MS}ms`;
  return new Error(
    `npm audit timed out ${attemptsPhrase} in ${cwd} -- this is not a JSON ` +
    `parse failure, npm audit did not finish. The npm registry's advisories endpoint ` +
    `may be degraded; check https://status.npmjs.org before assuming a code regression.` +
    stderrSuffix,
  );
}

const AUDIT_DIFF_REASON = Object.freeze({
  OK_NO_NEW_VULNERABILITIES: 'ok_no_new_vulnerabilities',
  FAIL_NEW_VULNERABLE_PACKAGE: 'fail_new_vulnerable_package',
});

/**
 * Pure diff: which package names are vulnerable in `headVulnerabilities`
 * but were NOT already vulnerable in `baselineVulnerabilities`.
 *
 * Both args are the `.vulnerabilities` object from `npm audit --json`
 * (keyed by package name). Matched by package NAME only -- not by the
 * specific advisory ID or severity -- so a package that stays vulnerable
 * across a *different* newly-disclosed advisory for the same package is
 * still "pre-existing", not new. A package whose vulnerability *worsens*
 * while remaining the same package name is deliberately NOT flagged here;
 * that tradeoff keeps the predicate simple and matched to the #4196
 * incident shape (a transitive dependency neither side of the diff
 * touched). Severity escalation on an already-known-vulnerable package is
 * exactly the kind of thing the scheduled Dependabot channel should catch
 * instead (see #4196, PR #4200's auto-merge workflow).
 */
function diffNewVulnerablePackages(baselineVulnerabilities, headVulnerabilities) {
  const baselineNames = new Set(Object.keys(baselineVulnerabilities || {}));
  return Object.keys(headVulnerabilities || {}).filter((name) => !baselineNames.has(name));
}

/**
 * Typed verdict wrapping diffNewVulnerablePackages. `ok: false` means the
 * diff (head vs baseline) is non-empty -- this PR/push introduced at
 * least one newly-vulnerable package.
 */
function evaluateAuditDiff({ baselineVulnerabilities, headVulnerabilities }) {
  const newlyIntroduced = diffNewVulnerablePackages(baselineVulnerabilities, headVulnerabilities);
  if (newlyIntroduced.length > 0) {
    return { ok: false, reason: AUDIT_DIFF_REASON.FAIL_NEW_VULNERABLE_PACKAGE, newlyIntroduced };
  }
  return {
    ok: true,
    reason: AUDIT_DIFF_REASON.OK_NO_NEW_VULNERABILITIES,
    preExisting: Object.keys(headVulnerabilities || {}),
  };
}

/**
 * Runs `npm audit <args> --json` in `cwd` with bounded retry + exponential
 * backoff. A per-attempt timeout-kill (see isTimeoutKill) is retried rather
 * than failed immediately -- #4260: the audit backend has real, independent
 * latency variance from the rest of the registry (measured: 43.41s vs 0.20s
 * for a plain registry fetch, and two outright non-responses in the same
 * window), and a single 180s attempt with no retry meant any one bad moment
 * failed a REQUIRED gate on a transport hiccup, not a real advisory. A
 * non-timeout failure (e.g. a genuine non-zero exit with recoverable stdout,
 * or an unrecoverable error) is NOT retried -- only a confirmed timeout-kill
 * is, since retrying a deterministic failure wastes the budget without
 * changing the outcome.
 *
 * Exhausting all attempts still fails the gate (see #4260's own caveat:
 * silently skipping a required security check on a transport error is a
 * worse failure mode than occasionally re-running CI).
 */
function runNpmAuditWithRetry(cwd, args, { execFileSyncImpl = execFileSync, sleepImpl = sleepSyncMs } = {}) {
  const isWindows = process.platform === 'win32';
  const npmCandidates = isWindows ? ['npm.cmd', 'npm'] : ['npm'];
  let lastTimeoutError = null;

  for (let attempt = 1; attempt <= AUDIT_MAX_ATTEMPTS; attempt += 1) {
    let out;
    let timedOutThisAttempt = false;
    let lastErr = null;

    for (const npmCmd of npmCandidates) {
      try {
        out = execFileSyncImpl(npmCmd, args, {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: AUDIT_ATTEMPT_TIMEOUT_MS,
          shell: isWindows,
        });
        lastErr = null;
        break;
      } catch (e) {
        if (isTimeoutKill(e)) {
          timedOutThisAttempt = true;
          lastErr = e;
          break; // do not burn the alt npm-candidate slot on a timeout; go to the next retry attempt instead
        }
        // `npm audit` exits non-zero when advisories are present; the JSON is
        // still on stdout in that case. Recover and let the caller classify —
        // but only when stdout actually CARRIES the JSON: an audit that was
        // killed or aborted can exit non-zero with EMPTY stdout, and accepting
        // the empty string here surfaces as a bare `SyntaxError: Unexpected
        // end of JSON input` at the parse below, hiding the captured error
        // (observed on CI 2026-09-03, both lanes; cause undetermined).
        const recovered = e && typeof e.stdout !== 'undefined' && e.stdout !== null
          ? (Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf-8') : String(e.stdout))
          : '';
        if (recovered.trim()) {
          out = recovered;
          lastErr = null;
          break;
        }
        lastErr = e;
      }
    }

    if (timedOutThisAttempt) {
      lastTimeoutError = lastErr;
      if (attempt < AUDIT_MAX_ATTEMPTS) {
        sleepImpl(AUDIT_BACKOFF_BASE_MS * (2 ** (attempt - 1)));
        continue;
      }
      throw buildTimeoutKillError(cwd, lastTimeoutError, attempt);
    }

    if (lastErr) throw lastErr; // non-timeout failure: fail immediately, no retry

    const parsed = JSON.parse(out);
    if (parsed && parsed.metadata && parsed.metadata.vulnerabilities) {
      return parsed;
    }
    throw new Error(`Unexpected npm audit JSON shape in ${cwd}: missing metadata.vulnerabilities`);
  }
  // Unreachable (the loop always returns or throws), but keep a fallback
  // throw so a future refactor mistake fails loudly instead of returning
  // undefined.
  throw buildTimeoutKillError(cwd, lastTimeoutError, AUDIT_MAX_ATTEMPTS);
}

/**
 * Runs `npm audit --package-lock-only --omit=dev --json` in `cwd` and
 * returns the parsed JSON, or `null` if `cwd` has no package.json or no
 * package-lock.json (not an auditable tree -- callers treat this as
 * "skip"/"no baseline available", not an error).
 *
 * `--package-lock-only` deliberately avoids requiring `node_modules/` to
 * be installed: it lets a baseline tree be audited from nothing but an
 * extracted package.json + package-lock.json (see extractBaselineTree),
 * without a second full `npm ci`.
 */
function runPackageLockAudit(cwd, opts = {}) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  if (!fs.existsSync(path.join(cwd, 'package-lock.json'))) return null;
  return runNpmAuditWithRetry(cwd, ['audit', '--package-lock-only', '--omit=dev', '--json'], opts);
}

/**
 * Runs `npm audit --omit=dev --json` against the REAL installed node_modules
 * tree in `cwd` (unlike runPackageLockAudit's --package-lock-only mode,
 * which only needs package-lock.json on disk). Returns `null` if `cwd` has
 * no package.json or no node_modules/ (not an auditable/installed tree --
 * callers treat this as "skip", not an error).
 */
function runInstalledTreeAudit(cwd, opts = {}) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) return null;
  return runNpmAuditWithRetry(cwd, ['audit', '--omit=dev', '--json'], opts);
}

/**
 * Extracts package.json + package-lock.json (optionally under `subdir`,
 * e.g. 'sdk') from `ref` at git object level into a fresh temp directory --
 * no working-tree checkout, no `node_modules` install. Returns the temp
 * dir path, or `null` if `ref` cannot be resolved locally (e.g. a shallow
 * clone that never fetched it) or either file is absent at that ref --
 * callers treat `null` as "no baseline available", not an error.
 */
function extractBaselineTree(ref, repoRoot, subdir = '') {
  const rel = (name) => (subdir ? path.posix.join(subdir, name) : name);
  let pkgJson;
  let lockJson;
  try {
    pkgJson = execFileSync('git', ['show', `${ref}:${rel('package.json')}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    lockJson = execFileSync('git', ['show', `${ref}:${rel('package-lock.json')}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-audit-baseline-'));
  fs.writeFileSync(path.join(dir, 'package.json'), pkgJson);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lockJson);
  return dir;
}

// All-zeros is git's documented sentinel for "this ref did not exist
// before this push" (a brand-new branch's first push) -- never a real
// commit to diff against.
const NULL_SHA = '0000000000000000000000000000000000000000';

/**
 * Resolves the git ref to diff against, in priority order:
 *   1. AUDIT_BASELINE_REF env var -- the primary mechanism. CI sets this
 *      explicitly (see .github/workflows/test.yml) to github.event.pull_
 *      request.base.sha on a pull_request event, or github.event.before on
 *      a push event -- both pinned, race-free values Git/GitHub track for
 *      exactly this purpose. Prefer this over anything below whenever the
 *      caller can provide it.
 *   2. GITHUB_BASE_REF (GitHub Actions sets this on pull_request events)
 *      resolved against the LIVE origin/<branch> tip. Only reached if
 *      AUDIT_BASELINE_REF wasn't set -- e.g. a workflow that forgot to
 *      wire it. origin/<branch> can advance mid-run (see the GSD_EMITTED_
 *      BASE precedent in test.yml), so this is a degraded fallback, not
 *      the intended path for pull_request events in this repo's own CI.
 *   3. On a `push` event, `HEAD~1` -- correct ONLY when the push added
 *      exactly one commit (true for a squash-merge or a single ordinary
 *      commit). This repo also allows rebase-merge (allow_rebase_merge:
 *      true), which can land a PR as several discrete commits in one
 *      push -- HEAD~1 then lands on an EARLIER commit in the same push,
 *      which may already contain a vulnerable package that commit itself
 *      introduced, silently marking it "pre-existing". CI never reaches
 *      this branch (AUDIT_BASELINE_REF is always set by test.yml for
 *      push events); it exists only for out-of-band invocations (e.g.
 *      gsd-test) that don't set any of the above.
 *   4. `origin/next`, else a plain local branch named `next` (gsd-test's
 *      sandbox fetches the base as a local branch, not a remote-tracking
 *      ref -- see gsd-test-merges-into-LOCAL-base-branch in this repo's
 *      own operational notes), if either exists locally (this repo's
 *      integration branch -- matches DEFAULT_BASE in
 *      scripts/changeset/lint.cjs).
 * Returns '' if none resolve -- callers fall back to strict zero-tolerance
 * rather than silently skipping the gate.
 */
function resolveBaselineRef(repoRoot) {
  if (process.env.AUDIT_BASELINE_REF) return process.env.AUDIT_BASELINE_REF;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    try {
      const parent = execFileSync('git', ['rev-parse', '--verify', 'HEAD~1'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (parent && parent !== NULL_SHA) return parent;
    } catch {
      // not enough history; fall through
    }
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/next'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return 'origin/next';
  } catch {
    // fall through to a plain local branch
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'next'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return 'next';
  } catch {
    return '';
  }
}

module.exports = {
  AUDIT_DIFF_REASON,
  diffNewVulnerablePackages,
  evaluateAuditDiff,
  runPackageLockAudit,
  runInstalledTreeAudit,
  runNpmAuditWithRetry,
  extractBaselineTree,
  resolveBaselineRef,
  isTimeoutKill,
  buildTimeoutKillError,
  sleepSyncMs,
  AUDIT_ATTEMPT_TIMEOUT_MS,
  AUDIT_MAX_ATTEMPTS,
  AUDIT_BACKOFF_BASE_MS,
  NULL_SHA,
};
