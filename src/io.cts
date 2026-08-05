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

function output(result: unknown, raw: boolean, rawValue?: unknown): void {
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
  SDK_FAIL_FAST: 'sdk_fail_fast',
  SDK_UNKNOWN_COMMAND: 'sdk_unknown_command',
  SDK_MISSING_ARG: 'sdk_missing_arg',
  // workflow / phase
  PHASE_NOT_FOUND: 'phase_not_found',
  PHASE_VERIFICATION_INCOMPLETE: 'phase_verification_incomplete',
  PHASE_PLAN_COVERAGE_INCOMPLETE: 'phase_plan_coverage_incomplete',
  SUMMARY_NO_PLANNING: 'summary_no_planning',
  // graphify
  GRAPHIFY_NO_GRAPH: 'graphify_no_graph',
  GRAPHIFY_INVALID_QUERY: 'graphify_invalid_query',
  // hooks
  HOOKS_OPT_OUT: 'hooks_opt_out',
  // security-scan
  SECURITY_SCAN_FAILED: 'security_scan_failed',
  // generic
  USAGE: 'usage',
  UNKNOWN: 'unknown',
});

type ErrorReasonValue = typeof ERROR_REASON[keyof typeof ERROR_REASON];

/**
 * Process-level flag: when true, error() emits structured JSON to stderr
 * instead of plain "Error: <message>" text. Set by gsd-tools.cjs when the
 * CLI is invoked with `--json-errors`. Tests opt in to typed-IR error
 * assertions by passing that flag and parsing the JSON.
 *
 * Default off so existing callers and human operators keep their plain-text
 * diagnostics. The structured form is opt-in for tooling and tests (#2974).
 */
let _jsonErrorMode = false;
function setJsonErrorMode(v: unknown): void { _jsonErrorMode = !!v; }
function getJsonErrorMode(): boolean { return _jsonErrorMode; }

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
function error(message: string, reason: ErrorReasonValue = ERROR_REASON.UNKNOWN, extra?: Record<string, unknown>): never {
  if (_jsonErrorMode) {
    const payload = JSON.stringify({ ok: false, reason, message, ...(extra || {}) }) + '\n';
    writeAllSync(2, payload);
  } else {
    writeAllSync(2, 'Error: ' + message + '\n');
  }
  process.exit(1);
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
};
