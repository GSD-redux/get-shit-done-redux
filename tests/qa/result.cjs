'use strict';

/**
 * result.cjs — the typed `RunResult` IR for the loop QA walk.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `CONTRIBUTING.md` → "Prohibited: Raw Text Matching on Test Outputs" forbids
 * asserting on a child process's stdout/stderr text, and
 * `RULESET.TESTS.no-source-grep.tmp-file-traps` forbids reading tmp files the
 * SUT wrote. An oracle therefore may never look at raw output. This module is
 * the single place where raw bytes are turned into a typed value; everything
 * downstream asserts on `kind` and on parsed fields, never on prose.
 *
 * The classification is deliberately strict (Postel inverted): every observed
 * shape gets an explicit `kind`, so oracles need no leniency. Leniency in an
 * oracle is how a QA tool reports green on a broken engine.
 *
 * Every KIND below corresponds to a shape the real CLI actually produces; each
 * was observed against `gsd-tools`, not imagined. See
 * `.gsd/phase/test-2966-loop-qa-walk/40-design.md` for the behavior table.
 */

const fs = require('node:fs');

/**
 * Frozen classification of a single `gsd-tools` invocation.
 *
 * Tests assert on these constants, never on their string values, so renaming a
 * value is a one-line change here rather than a sweep through the suite.
 */
const KIND = Object.freeze({
  /** exit 0, stdout parsed as JSON (object OR scalar OR array). */
  JSON: 'json',
  /** exit 0, stdout non-empty but not JSON — an untyped success. NOT an error. Requires non-empty stdout. */
  PROSE: 'prose',
  /** exit 0, no stdout payload. NOT a crash. stderr may still carry warnings. */
  EMPTY: 'empty',
  /** exit 0, stdout JSON carrying an `error` key — the documented soft-failure idiom. */
  SOFT_ERROR: 'soft-error',
  /** exit 1, last stderr line parsed as `{ok:false,reason,message}`. */
  STRUCTURED_ERROR: 'structured-error',
  /** exit 1, stderr present but not parseable as the structured envelope. */
  UNSTRUCTURED_ERROR: 'unstructured-error',
  /** exit code outside {0,1}. */
  UNEXPECTED_EXIT: 'unexpected-exit',
  /** subprocess exceeded its timeout — degraded, never fatal to the walk. */
  TIMEOUT: 'timeout',
});

/**
 * `io.cjs` `output()` diverts payloads above this many characters to a temp
 * file and writes `@file:<path>` to stdout instead. A classifier that does not
 * know this reports NOT-JSON for perfectly healthy commands as soon as a
 * scenario's payload grows past the threshold.
 */
const FILE_POINTER_PREFIX = '@file:';

/**
 * Parse text as JSON, returning a sentinel rather than throwing.
 *
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function tryParseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Return the last non-empty line of a stream.
 *
 * Load-bearing: `gsd-tools` writes operator warnings to stderr *before* the
 * structured error envelope — e.g.
 *   `gsd-tools: warning: unknown config key(s) in .planning/config.json: …`
 * followed by `{"ok":false,…}`. Parsing the whole stderr blob therefore fails
 * on a command that is in fact conforming. During research this exact shape
 * produced a false positive against `review-lane`, which is why this function
 * exists instead of a bare `JSON.parse(stderr)`.
 *
 * @param {string} text
 * @returns {string} last non-empty line, or '' when there is none
 */
function lastNonEmptyLine(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== '') return line;
  }
  return '';
}

/**
 * Resolve stdout that may be an `@file:` pointer into the payload text.
 *
 * IO failure here is reported, never thrown: a walk that dies because a
 * pointee vanished tells you nothing about the engine under test.
 *
 * @param {string} stdout
 * @param {{ readFileSync?: typeof fs.readFileSync }} [io] injection seam for
 *   fault tests — `chmod 0o000` is a no-op under root and is banned.
 * @returns {{ text: string, pointer: string | null, unreadable: boolean }}
 */
function resolveFilePointer(stdout, io = {}) {
  const readFileSync = io.readFileSync || fs.readFileSync;
  const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
  if (!trimmed.startsWith(FILE_POINTER_PREFIX)) {
    return { text: stdout, pointer: null, unreadable: false };
  }
  const pointer = trimmed.slice(FILE_POINTER_PREFIX.length);
  try {
    return { text: readFileSync(pointer, 'utf-8'), pointer, unreadable: false };
  } catch {
    return { text: '', pointer, unreadable: true };
  }
}

/**
 * Classify a raw invocation into the typed IR.
 *
 * Precedence is deliberate and asserted by the test matrix:
 *   timeout > unexpected exit > exit 1 (error family) > exit 0 (success family)
 * An exit-1 run with a healthy-looking stdout payload is still an error — the
 * exit code outranks the payload.
 *
 * CLASSIFICATION KEYS OFF STDOUT, NOT STDERR (exit-0 family): whether a
 * successful run is EMPTY, PROSE, JSON, or SOFT_ERROR depends solely on the
 * (file-pointer-resolved) stdout payload. stderr on the exit-0 path is never
 * used to pick a `kind` — including when stdout is empty and stderr is not —
 * it is only ever surfaced through `warnings` (see below).
 *
 * @param {{ exitCode: number|null, stdout: string, stderr: string, timedOut?: boolean, argv?: string[] }} raw
 * @param {{ readFileSync?: typeof fs.readFileSync }} [io]
 * @returns {{
 *   kind: string, exitCode: number|null, argv: string[],
 *   json: unknown, err: object|null, pointer: string|null,
 *   warnings: string[],
 * }}
 *   `warnings` is populated only when the substrate actually supplied stderr
 *   text — today that means the exit-1 (error) family, since `loop-walk.cjs`'s
 *   `run()` discards stderr on a clean exit (`execFileSync` swallows it). See
 *   the JSDoc on `warnings` usage in `tests/qa/loop-walk.cjs` `run()` for the
 *   full explanation; do not build an oracle assuming success-path stderr is
 *   observable through that substrate.
 */
function classify(raw, io = {}) {
  const argv = Array.isArray(raw.argv) ? raw.argv : [];
  const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
  const base = { exitCode: raw.exitCode, argv, json: null, err: null, pointer: null, warnings: [] };

  if (raw.timedOut) return { ...base, kind: KIND.TIMEOUT };
  if (raw.exitCode !== 0 && raw.exitCode !== 1) return { ...base, kind: KIND.UNEXPECTED_EXIT };

  const stderrLines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '');

  if (raw.exitCode === 1) {
    // Warnings are every stderr line except the last: the last line is
    // consumed below as the candidate structured-error envelope, so it is
    // not itself a warning.
    const warnings = stderrLines.slice(0, Math.max(0, stderrLines.length - 1));
    const parsed = tryParseJson(lastNonEmptyLine(stderr));
    const envelope = parsed.ok && parsed.value !== null && typeof parsed.value === 'object'
      && parsed.value.ok === false && typeof parsed.value.reason === 'string';
    return envelope
      ? { ...base, kind: KIND.STRUCTURED_ERROR, err: parsed.value, warnings }
      : { ...base, kind: KIND.UNSTRUCTURED_ERROR, warnings };
  }

  // exit 0: no envelope is ever parsed out of stderr, so every stderr line is
  // a warning candidate — none of it is consumed the way exit-1's last line is.
  const warnings = stderrLines;

  const resolved = resolveFilePointer(raw.stdout, io);
  if (resolved.unreadable) {
    return { ...base, kind: KIND.UNSTRUCTURED_ERROR, pointer: resolved.pointer, warnings };
  }
  const text = typeof resolved.text === 'string' ? resolved.text : '';
  // Classification keys off STDOUT ONLY: a non-empty stderr with empty stdout
  // is still EMPTY (see module header + KIND.EMPTY docstring above), and the
  // stderr content is preserved in `warnings`, never dropped.
  if (text.trim() === '') return { ...base, kind: KIND.EMPTY, warnings };

  const parsed = tryParseJson(text);
  if (!parsed.ok) return { ...base, kind: KIND.PROSE, pointer: resolved.pointer, warnings };

  // `typeof null === 'object'`, and an array is an object too — both must fall
  // through to JSON rather than be probed for an `error` key.
  const isPlainObject = parsed.value !== null
    && typeof parsed.value === 'object'
    && !Array.isArray(parsed.value);
  const kind = isPlainObject && Object.prototype.hasOwnProperty.call(parsed.value, 'error')
    ? KIND.SOFT_ERROR
    : KIND.JSON;

  return { ...base, kind, json: parsed.value, pointer: resolved.pointer, warnings };
}

module.exports = {
  KIND,
  FILE_POINTER_PREFIX,
  classify,
  lastNonEmptyLine,
  resolveFilePointer,
  tryParseJson,
};
