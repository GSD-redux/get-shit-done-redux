/**
 * TDD RED-evidence classification (#3770).
 *
 * The `type: tdd` executor gate previously accepted ANY nonzero test command as
 * RED: syntax errors, zero-test discovery, fixture crashes, parser errors, and
 * unrelated assertions all authorized production edits (GREEN). This module
 * defines the compact RED evidence the gate now requires — the TARGET test's
 * identity plus a matching assertion failure — and classifies a persisted test
 * run into exactly one verdict:
 *
 *   RED_EVIDENCE_OK  — nonzero exit AND the target test failed as a REAL test
 *                      (distinctly named, TAP-reported failure). The ONLY
 *                      verdict that may advance to GREEN.
 *   INVALID_RED      — everything else, with a machine-readable reason:
 *                      unexpected_green | zero_tests_discovered |
 *                      nonzero_exit_without_test_failure |
 *                      fixture_or_load_failure | no_target_test_failure |
 *                      invalid_record | unreadable_record (router arm).
 *
 * Everything here is PURE — no fs, no spawn, no clock — so the executor can
 * persist the record (command, exit code, failing test, expected, actual) and
 * validate it via `gsd_run check tdd-red-evidence <record.json>`.
 *
 * TAP parsing reuses the proven primitives from prohibition-enforcement
 * (`parseNodeTestSummary`, `tapFailedTestNames`) — the same contract the
 * prohibition probe's fail-first prover already relies on (#1259).
 */

import { parseNodeTestSummary, tapFailedTestNames } from './prohibition-enforcement.cjs';

export type RedEvidenceVerdict = 'RED_EVIDENCE_OK' | 'INVALID_RED';

export type RedEvidenceReason =
  | 'target_test_failed'
  | 'unexpected_green'
  | 'zero_tests_discovered'
  | 'nonzero_exit_without_test_failure'
  | 'fixture_or_load_failure'
  | 'no_target_test_failure'
  | 'invalid_record'
  | 'unreadable_record';

/** The raw run record the executor persists after the RED-phase test command. */
export interface RedEvidenceInput {
  /** The exact test command that was run (persisted verbatim). */
  command: unknown;
  /** The command's exit code. */
  exitCode: unknown;
  /** The command's combined stdout (TAP for node --test). */
  output: unknown;
  /** Identity of the target test named by the plan (its `test('...')` name). */
  targetTest: unknown;
  /** Path of the test file the target test lives in (file-named failures are crashes). */
  targetFile?: unknown;
  /** Expected result stated by the plan's <behavior> (persisted verbatim). */
  expected?: unknown;
  /** Actual result observed in the failing assertion (persisted verbatim). */
  actual?: unknown;
}

/** The classification verdict plus the compact evidence it was decided on. */
export interface RedEvidenceResult {
  verdict: RedEvidenceVerdict;
  reason: RedEvidenceReason;
  evidence: {
    command: string;
    exit_code: number | null;
    target_test: string;
    tests: number;
    pass: number;
    fail: number;
    failing_tests: string[];
  };
}

/** The persisted RED evidence record (acceptance: command, exit code, failing test, expected, actual). */
export interface RedEvidenceRecord {
  command: string;
  exit_code: number | null;
  failing_test: string | null;
  target_test: string;
  expected: string | null;
  actual: string | null;
  verdict: RedEvidenceVerdict;
  reason: RedEvidenceReason;
}

/** Basename of a path-like string ('' for non-strings) — separators `/` and `\`. */
function baseOf(p: unknown): string {
  return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '';
}

/** Coerce and validate the raw record's scalar fields. Returns null exit_code only when absent/non-numeric. */
function readInput(input: RedEvidenceInput): {
  command: string;
  exitCode: number | null;
  output: string;
  targetTest: string;
} | null {
  const command = typeof input?.command === 'string' ? input.command : '';
  const output = typeof input?.output === 'string' ? input.output : '';
  const targetTest = typeof input?.targetTest === 'string' ? input.targetTest.trim() : '';
  const exitCode =
    typeof input?.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null;
  if (!command || !targetTest || exitCode === null) return null;
  return { command, exitCode, output, targetTest };
}

/**
 * Classify a persisted RED-phase test run. Fail-closed: malformed input, an
 * unparseable/empty TAP summary, a file-named (load/crash) failure, or a
 * failure that is not the target test's are all INVALID_RED — only a nonzero
 * exit WITH the distinctly-named target test failing is RED_EVIDENCE_OK.
 * Never throws.
 */
export function classifyRedEvidence(input: RedEvidenceInput): RedEvidenceResult {
  const parsed = readInput(input);
  if (!parsed) {
    return {
      verdict: 'INVALID_RED',
      reason: 'invalid_record',
      evidence: {
        command: typeof input?.command === 'string' ? input.command : '',
        exit_code: null,
        target_test: '',
        tests: 0,
        pass: 0,
        fail: 0,
        failing_tests: [],
      },
    };
  }
  const { command, exitCode, output, targetTest } = parsed;
  const summary = parseNodeTestSummary(output);
  const failing = tapFailedTestNames(output);
  const evidence = {
    command,
    exit_code: exitCode,
    target_test: targetTest,
    tests: summary.tests,
    pass: summary.pass,
    fail: summary.fail,
    failing_tests: failing,
  };

  // Existing fail-fast rule, now machine-checked: exit 0 during RED is an
  // unexpected GREEN — the feature may already exist or the test is wrong.
  if (exitCode === 0) {
    return { verdict: 'INVALID_RED', reason: 'unexpected_green', evidence };
  }
  // Zero-test discovery: the discovery pattern / fixture matched no tests.
  // A run that executed nothing cannot prove anything about the behavior.
  if (summary.tests === 0) {
    return { verdict: 'INVALID_RED', reason: 'zero_tests_discovered', evidence };
  }
  // Nonzero exit but TAP reports no failing test: harness/setup/parser crash
  // whose failure never reached a test assertion (or unparseable output).
  if (summary.fail === 0 || failing.length === 0) {
    return { verdict: 'INVALID_RED', reason: 'nonzero_exit_without_test_failure', evidence };
  }
  // Fixture/load failure: every failing entry is named like the target FILE —
  // node reports a load-time crash (throw-on-require, syntax error, ENOENT
  // fixture) as a file-named `not ok 1 - <file>`, never the target test.
  const targetBase = baseOf(input?.targetFile ?? '');
  const distinctlyNamed = failing.filter((n) => (targetBase ? baseOf(n) !== targetBase : true));
  if (distinctlyNamed.length === 0) {
    return { verdict: 'INVALID_RED', reason: 'fixture_or_load_failure', evidence };
  }
  // Unrelated failure: real tests ran and failed, but none is the target test
  // the plan named — an unrelated assertion must not authorize GREEN.
  if (!distinctlyNamed.includes(targetTest)) {
    return { verdict: 'INVALID_RED', reason: 'no_target_test_failure', evidence };
  }
  return { verdict: 'RED_EVIDENCE_OK', reason: 'target_test_failed', evidence };
}

/**
 * Project a classification into the persisted record shape — command, exit
 * code, failing test, expected, actual, verdict, reason — so the evidence
 * survives past the terminal and the gate can re-verify it deterministically.
 * Pure: JSON-serializable, no timestamps (the record's mtime/commit carries time).
 */
export function buildRedEvidenceRecord(input: RedEvidenceInput, result: RedEvidenceResult): RedEvidenceRecord {
  const failingTest =
    result.evidence.failing_tests.find((n) => n === result.evidence.target_test) ??
    result.evidence.failing_tests[0] ??
    null;
  return {
    command: result.evidence.command,
    exit_code: result.evidence.exit_code,
    failing_test: failingTest,
    target_test: result.evidence.target_test,
    expected: typeof input?.expected === 'string' ? input.expected : null,
    actual: typeof input?.actual === 'string' ? input.actual : null,
    verdict: result.verdict,
    reason: result.reason,
  };
}
