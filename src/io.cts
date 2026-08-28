/**
 * CLI I/O primitives — output(), error(), ERROR_REASON, JSON-error mode,
 * and the temp-file helpers that output() depends on.
 *
 * Extracted from core.cts (ADR-857 rollout phase 1 / issue #859).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. The core.cjs re-export spine was retired in epic #1267;
 * callers import I/O primitives from io.cjs directly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformWriteSync, platformEnsureDir } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const {
  setJsonErrorMode, getJsonErrorMode, EXIT_ENVELOPE_REASON, ExitError,
  setPendingOutcome, projectOutcome, getContractVersion,
} = cliExitModule;

// ─── Temp-file helpers (needed by output()) ──────────────────────────────────

/**
 * Dedicated GSD temp directory: path.join(os.tmpdir(), 'gsd').
 * Created on first use. Keeps GSD temp files isolated from the system
 * temp directory so reap scans only GSD files (#1975).
 */
const GSD_TEMP_DIR = path.join(os.tmpdir(), 'gsd');

function ensureGsdTempDir(): void {
  platformEnsureDir(GSD_TEMP_DIR);
}

interface ReapOptions {
  maxAgeMs?: number;
  dirsOnly?: boolean;
}

/**
 * Remove stale gsd-* temp files/dirs older than maxAgeMs (default: 5 minutes).
 * Runs opportunistically before each new temp file write to prevent unbounded accumulation.
 * @param prefix - filename prefix to match (e.g., 'gsd-')
 * @param opts
 * @param opts.maxAgeMs - max age in ms before removal (default: 5 min)
 * @param opts.dirsOnly - if true, only remove directories (default: false)
 */
function reapStaleTempFiles(prefix = 'gsd-', { maxAgeMs = 5 * 60 * 1000, dirsOnly = false }: ReapOptions = {}): void {
  try {
    ensureGsdTempDir();
    const now = Date.now();
    const entries = fs.readdirSync(GSD_TEMP_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(GSD_TEMP_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else if (!dirsOnly) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch {
        // File may have been removed between readdir and stat — ignore
      }
    }
  } catch {
    // Non-critical — don't let cleanup failures break output
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Transient write errnos. When stdout/stderr is a NON-BLOCKING pipe — as it is
 * under the parallel `node --test` runner on Linux CI — a full pipe buffer makes
 * `fs.writeSync` throw EAGAIN, and a signal can interrupt it with EINTR. Both
 * clear on retry once the reader drains. This is the same transient class the
 * STATE.md lock path already retries (ACQUIRE_LOCK_RETRY_ERRNOS, #3776); #1008.
 */
const WRITE_RETRY_ERRNOS = new Set(['EAGAIN', 'EINTR']);

// Bounded so a pathological never-draining fd cannot spin forever. Each retry
// yields the thread for ~1ms via Atomics.wait (the project's sync-sleep idiom —
// see clock.cts realClock.sleep), so the cap is ~1s of total back-pressure wait.
const WRITE_MAX_RETRIES = 1000;
const WRITE_RETRY_BACKOFF_MS = 1;

// Sleep buffer is lazily allocated on the FIRST back-pressure retry (rare — only
// when a non-blocking pipe is full) and then reused. Keeping it out of module
// load costs nothing on the overwhelmingly common no-retry path and avoids
// perturbing SharedArrayBuffer-allocation accounting in other modules (perf-316).
let _writeSleepBuf: Int32Array | null = null;
function backoffOnce(): void {
  if (_writeSleepBuf === null) _writeSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(_writeSleepBuf, 0, 0, WRITE_RETRY_BACKOFF_MS);
}

/**
 * Write the entire payload to `fd`, tolerating non-blocking-pipe back-pressure.
 *
 * `fs.writeSync` does NOT block on a non-blocking pipe: a full buffer throws
 * EAGAIN, and a partially-drained buffer returns a SHORT count (fewer bytes than
 * requested). The previous bare `fs.writeSync(fd, string)` call assumed it always
 * blocked until the kernel accepted every byte — false under load, which both
 * threw spurious errors and risked silently truncating output (#1008).
 *
 * This loops on short counts (advancing the offset) and retries EAGAIN/EINTR with
 * a brief Atomics.wait backoff that yields the thread so the reader can drain.
 * Non-transient errors (e.g. EPIPE) propagate unchanged.
 */
function writeAllSync(fd: number, data: string): void {
  const buf = Buffer.from(data, 'utf8');
  let offset = 0;
  let retries = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (WRITE_RETRY_ERRNOS.has(code) && retries < WRITE_MAX_RETRIES) {
        retries += 1;
        backoffOnce();
        continue;
      }
      throw err;
    }
  }
}

/**
 * The wire form of a JSON result: the exact bytes `output()` emits for it.
 *
 * Exported because a caller that has to reason about the size of its own
 * response — graphify's `--budget` accounting (#2738) — must measure the string
 * this function produces rather than a second, privately-maintained
 * serialization that can drift from it. One definition, so estimator and
 * emitter cannot disagree about indentation or shape.
 *
 * The `@file:` redirection in `output()` is a transport detail, not a payload
 * change: the caller still consumes these bytes, so these are the right ones to
 * measure.
 */
function serializeForOutput(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

/**
 * A payload-carried error, per ADR-2980's own definition (#3912, ADR-3889
 * §4): `result` is an object carrying an `error` property, in ANY key
 * order — `{ found: false, error }` counts exactly the same as
 * `{ error, found: false }`. This is a shape check only; the `error`
 * value's own truthiness is irrelevant, and neither is `result`'s
 * prototype (a plain object literal is all any call site here ever
 * passes) — `hasOwnProperty` is enough to answer "does this payload
 * declare an error".
 */
function isPayloadCarriedError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && Object.prototype.hasOwnProperty.call(result, 'error');
}

function output(result: unknown, raw: boolean, rawValue?: unknown): void {
  // #3912 (ADR-3889 §4): a payload-carried error declares DEGRADED into the
  // pending-outcome cell runMain reads. This is the ONLY new thing output()
  // does — it still just writes fd 1 and returns; the exit code stays
  // whatever it already was under v1 (DEGRADED projects to 0), and nothing
  // here touches process.exitCode directly.
  if (isPayloadCarriedError(result)) {
    setPendingOutcome('DEGRADED');
  }
  let data: string;
  if (raw && rawValue !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    data = String(rawValue);
  } else {
    const json = serializeForOutput(result);
    // Large payloads exceed Claude Code's Bash tool buffer (~50KB).
    // Write to tmpfile and output the path prefixed with @file: so callers can detect it.
    if (json.length > 50000) {
      reapStaleTempFiles();
      ensureGsdTempDir();
      const tmpPath = path.join(GSD_TEMP_DIR, `gsd-${Date.now()}.json`);
      platformWriteSync(tmpPath, json);
      data = '@file:' + tmpPath;
    } else {
      data = json;
    }
  }
  // process.stdout.write() is async when stdout is a pipe — process.exit()
  // can tear down the process before the reader consumes the buffer. writeAllSync
  // pushes every byte synchronously (looping short counts, retrying EAGAIN/EINTR),
  // and skipping process.exit() lets the event loop drain naturally.
  writeAllSync(1, data);
}

/**
 * Frozen enum of typed reason codes used by error() for structured errors.
 * Each subcommand contributes its own codes; the enum exists so tests can
 * assert against typed values instead of grepping stderr (#2974).
 *
 * Adding a new code:
 *   - Pick a snake_case lowercase value (the JSON wire form)
 *   - Group by subsystem prefix (CONFIG_*, SDK_*, etc)
 *   - Pass it to error(msg, ERROR_REASON.NEW_CODE) at the call site
 */
const ERROR_REASON = Object.freeze({
  // config-get / config-set
  CONFIG_KEY_NOT_FOUND: 'config_key_not_found',
  CONFIG_NO_FILE: 'config_no_file',
  CONFIG_PARSE_FAILED: 'config_parse_failed',
  CONFIG_INVALID_KEY: 'config_invalid_key',
  // SDK / gsd-tools dispatch
  SDK_FAIL_FAST: EXIT_ENVELOPE_REASON,
  SDK_UNKNOWN_COMMAND: 'sdk_unknown_command',
  SDK_MISSING_ARG: 'sdk_missing_arg',
  // workflow / phase
  PHASE_NOT_FOUND: 'phase_not_found',
  PHASE_VERIFICATION_INCOMPLETE: 'phase_verification_incomplete',
  PHASE_PLAN_COVERAGE_INCOMPLETE: 'phase_plan_coverage_incomplete',
  SUMMARY_NO_PLANNING: 'summary_no_planning',
  // #3579: workstream-mode fail-safe guards (init.progress, phase.complete) —
  // distinguishes "no marker/pointer anywhere" from "a marker exists but
  // didn't resolve" so a JSON-error-mode caller can branch on `reason`
  // instead of regexing the human message.
  WORKSTREAM_MODE_NONE_ACTIVE: 'workstream_mode_none_active',
  WORKSTREAM_MODE_MARKER_UNRESOLVED: 'workstream_mode_marker_unresolved',
  // graphify
  GRAPHIFY_NO_GRAPH: 'graphify_no_graph',
  GRAPHIFY_INVALID_QUERY: 'graphify_invalid_query',
  // estimate-calibrate (#3882, ADR-3473 §8.2): the phases directory exists
  // but could not be read — a NON-answer, distinct from a project that
  // genuinely has zero completed phases yet.
  ESTIMATE_PHASES_UNREADABLE: 'estimate_phases_unreadable',
  // hooks
  HOOKS_OPT_OUT: 'hooks_opt_out',
  // commit-docs-guard (#3588)
  COMMIT_DOCS_GUARD_NOT_A_REPO: 'commit_docs_guard_not_a_repo',
  COMMIT_DOCS_GUARD_FOREIGN_HOOK: 'commit_docs_guard_foreign_hook',
  COMMIT_DOCS_GUARD_HOOKS_PATH_SET: 'commit_docs_guard_hooks_path_set',
  // security-scan
  SECURITY_SCAN_FAILED: 'security_scan_failed',
  // --pick (#3365 / #3358, ADR-3473 §8.4): an absent field or non-JSON
  // command output is a failure, never a demotion to an empty answer at
  // exit 0. See .gsd/phase/feat-3884-failure-is-a-value/40-design.md.
  PICK_FIELD_ABSENT: 'pick_field_absent',
  PICK_OUTPUT_NOT_JSON: 'pick_output_not_json',
  // generic
  USAGE: 'usage',
  UNKNOWN: 'unknown',
});

type ErrorReasonValue = typeof ERROR_REASON[keyof typeof ERROR_REASON];

// setJsonErrorMode / getJsonErrorMode now live in cli-exit.cts (imported above)
// and are re-exported here for the callers that already import them from io.

/**
 * Emit an error and exit. When the second argument is provided it must be
 * a value from ERROR_REASON; tests can assert on `result.reason`. When the
 * process is in JSON-error mode, stderr receives `{ ok: false, reason,
 * message }` so callers can parse it; otherwise stderr keeps the plain
 * text form for human operators.
 *
 * `extra` (optional) lets a caller attach additional structured fields
 * (e.g. `{ verification_stale_check_indeterminate: true }`) onto the
 * JSON-error-mode payload, spread alongside `ok`/`reason`/`message`, so a
 * test can assert on the value directly instead of regexing `message`'s
 * human-readable text. Ignored entirely in plain-text mode — the human
 * message is the only thing an operator sees there.
 */
/**
 * Render an UNTRUSTED string for embedding inside a human-readable,
 * plain-text diagnostic (the `'Error: ' + message` line `error()` writes in
 * non-JSON mode).
 *
 * WHY THIS EXISTS AND WHY `error()` DOES NOT DO IT ITSELF: `error()`
 * deliberately writes its `message` argument verbatim — several callers in
 * this repo intentionally emit multi-line diagnostics (e.g. the phase-gate
 * messages), and `error()` has no way to distinguish a legitimate multi-line
 * message from a hostile one, so it must not mangle newlines generically.
 * That means any UNTRUSTED substring a caller interpolates into `message`
 * (an argv token, a JSON key/value read back from a command's own output,
 * etc.) can smuggle its own `\n` and forge a second `Error: ` line on
 * stderr — a caller that parses stderr line-by-line would then see a second,
 * attacker-authored error. Every call site that interpolates untrusted data
 * into a diagnostic MUST pass that substring through this function first;
 * `error()` itself stays a dumb, faithful writer.
 *
 * `JSON.stringify` is the primitive: it wraps the value in quotes and
 * escapes control characters (`\n`, `\r`, `\t`, and the rest of the C0
 * range, plus the quote character itself), so the result can never span
 * more than one line or introduce an unescaped `"`. Callers embedding the
 * result MUST NOT add their own surrounding quotes — that would
 * double-quote it.
 */
function formatDiagnosticToken(value: string): string {
  return JSON.stringify(value);
}

/**
 * Map an ERROR_REASON wire value onto a declared outcome name (#3912,
 * ADR-3889 §4). Closed over the 25-member enum: every reason gets an
 * explicit entry below, so a 26th member added without a mapping falls
 * through to the `?? 'FAIL'` default rather than silently mis-projecting —
 * and tests/A1 iterates `Object.values(ERROR_REASON)`, so that default is
 * exactly what makes an unmapped addition visible instead of invisible.
 *
 * This function's result is ONLY consulted under v2 (see `error()` below) —
 * it is deliberately never routed through `projectOutcome` under v1, which
 * is what keeps the v1 pin intact (`projectOutcome` treats registered names
 * as version-invariant, so e.g. USAGE would otherwise become 64 today).
 *
 * Each non-FAIL choice below is justified inline; `UNKNOWN` and anything
 * with no clearly better fit stays `FAIL` — the honest default the design
 * calls for, not a guess dressed up as a specific outcome.
 */
const REASON_TO_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  // Bad argv/subcommand/argument — the caller, not the run, is at fault.
  [ERROR_REASON.CONFIG_INVALID_KEY]: 'USAGE',
  [ERROR_REASON.SDK_UNKNOWN_COMMAND]: 'USAGE',
  [ERROR_REASON.SDK_MISSING_ARG]: 'USAGE',
  [ERROR_REASON.GRAPHIFY_INVALID_QUERY]: 'USAGE',
  [ERROR_REASON.USAGE]: 'USAGE',

  // A specific, named thing does not exist / nothing was there to find —
  // genuine, known emptiness rather than a broken prerequisite.
  [ERROR_REASON.CONFIG_KEY_NOT_FOUND]: 'NO_INPUT',
  [ERROR_REASON.SUMMARY_NO_PLANNING]: 'NO_INPUT',
  [ERROR_REASON.WORKSTREAM_MODE_NONE_ACTIVE]: 'NO_INPUT',

  // A prerequisite is absent, unreadable, or otherwise not in a state the
  // run could proceed from — distinct from NO_INPUT's genuine emptiness.
  [ERROR_REASON.CONFIG_NO_FILE]: 'UNAVAILABLE',
  [ERROR_REASON.CONFIG_PARSE_FAILED]: 'UNAVAILABLE',
  [ERROR_REASON.PHASE_NOT_FOUND]: 'UNAVAILABLE',
  [ERROR_REASON.PHASE_VERIFICATION_INCOMPLETE]: 'UNAVAILABLE',
  [ERROR_REASON.PHASE_PLAN_COVERAGE_INCOMPLETE]: 'UNAVAILABLE',
  // Its own docstring: "a marker exists but didn't resolve" — a broken
  // prerequisite, not the "no marker anywhere" emptiness NONE_ACTIVE covers.
  [ERROR_REASON.WORKSTREAM_MODE_MARKER_UNRESOLVED]: 'UNAVAILABLE',
  [ERROR_REASON.GRAPHIFY_NO_GRAPH]: 'UNAVAILABLE',
  // Its own docstring: "a NON-answer, distinct from a project that
  // genuinely has zero completed phases yet" — UNAVAILABLE, not NO_INPUT.
  [ERROR_REASON.ESTIMATE_PHASES_UNREADABLE]: 'UNAVAILABLE',
  [ERROR_REASON.COMMIT_DOCS_GUARD_NOT_A_REPO]: 'UNAVAILABLE',
  [ERROR_REASON.COMMIT_DOCS_GUARD_FOREIGN_HOOK]: 'UNAVAILABLE',
  [ERROR_REASON.COMMIT_DOCS_GUARD_HOOKS_PATH_SET]: 'UNAVAILABLE',
  // Its own docstring: "an absent field or non-JSON command output is a
  // failure, never a demotion to an empty answer" — the field/output was
  // supposed to be there and was not; a prerequisite of the query failed.
  [ERROR_REASON.PICK_FIELD_ABSENT]: 'UNAVAILABLE',
  [ERROR_REASON.PICK_OUTPUT_NOT_JSON]: 'UNAVAILABLE',

  // Self-failure: the run itself broke, not its inputs.
  [ERROR_REASON.SDK_FAIL_FAST]: 'INTERNAL',
  [ERROR_REASON.SECURITY_SCAN_FAILED]: 'INTERNAL',

  // No clearly better fit — the honest default, per design.
  [ERROR_REASON.HOOKS_OPT_OUT]: 'FAIL',
  [ERROR_REASON.UNKNOWN]: 'FAIL',
});

function outcomeForReason(reason: ErrorReasonValue): string {
  return REASON_TO_OUTCOME[reason] ?? 'FAIL';
}

function error(message: string, reason: ErrorReasonValue = ERROR_REASON.UNKNOWN, extra?: Record<string, unknown>): never {
  if (getJsonErrorMode()) {
    const payload = JSON.stringify({ ok: false, reason, message, ...(extra || {}) }) + '\n';
    writeAllSync(2, payload);
  } else {
    writeAllSync(2, 'Error: ' + message + '\n');
  }
  // #3912 (ADR-3889 §4): the declaration is version-gated HERE, not inside
  // projectOutcome — registered names are version-invariant there, so
  // routing every reason through it unconditionally would change v1 exit
  // codes today (e.g. USAGE -> 64) and break the pin. Under v1 the exit
  // stays ExitError(1) unconditionally, byte-identical to every prior
  // release; only v2 projects the declared outcome through the registry.
  if (getContractVersion() === 'v2') {
    throw new ExitError(projectOutcome(outcomeForReason(reason), 'v2'));
  }
  // No message passed to ExitError: the stderr write above is already done,
  // byte-identical to the prior process.exit(1) behavior, and ExitError with
  // no message means runMain's catch adds nothing further to stderr.
  throw new ExitError(1);
}

export = {
  GSD_TEMP_DIR,
  ensureGsdTempDir,
  reapStaleTempFiles,
  output,
  serializeForOutput,
  ERROR_REASON,
  setJsonErrorMode,
  getJsonErrorMode,
  error,
  formatDiagnosticToken,
};
