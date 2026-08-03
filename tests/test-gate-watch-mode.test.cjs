// allow-test-rule: source-text-is-the-product #1857
// Workflow .md files — their text IS the deployed contract the orchestrator runs.

/**
 * #1857: a GSD test gate must not hang forever on a watch-mode runner.
 *
 * Three gates were UNBOUNDED or silently-continued and are the core fix. They must:
 *   - route the resolved command through the shared `normalize-test-command`
 *     helper (defeats vitest/jest watch mode), so the paths cannot drift,
 *   - bound execution with `gsd_run run-with-timeout` using the
 *     `workflow.test_gate_timeout` budget, and
 *   - surface a timeout (exit 124) with a watch-mode hint — the regression gate
 *     ABORTS, the others surface clearly (never silently ignored).
 *
 * verify-phase's gate was ALREADY bounded (a fixed `run-with-timeout 300`, not a hang), so
 * it only needs the normalizer (so a watch runner exits fast) and keeps its own
 * fixed 5-minute bound — asserted separately below.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// #2932: the regression-gate step was split — steps/regression-gate.md now only
// discovers prior-phase test files and delegates (via "Read and execute") to
// steps/regression-gate-run.md, which carries the actual command resolution,
// normalize-test-command call, timeout bound, and watch-mode abort mechanics.
const REGRESSION_GATE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate.md');
const REGRESSION_GATE_RUN = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate-run.md');
const POST_MERGE_GATE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'post-merge-gate.md');
const AUDIT_FIX = path.join(ROOT, 'gsd-core', 'workflows', 'audit-fix.md');
const VERIFY_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'verify-phase.md');
const EXECUTE_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');

function read(p) { return fs.readFileSync(p, 'utf-8'); }

// The three gates that were unbounded/silently-continued: full normalize + configured timeout.
// Regression gate's mechanics now live in the delegated regression-gate-run.md (#2932).
const FULL_GATES = [
  ['regression gate', REGRESSION_GATE_RUN],
  ['post-merge gate', POST_MERGE_GATE],
  ['audit-fix gate', AUDIT_FIX],
];

describe('#1857: test gates normalize to one-shot and bound with a timeout', () => {
  for (const [label, file] of FULL_GATES) {
    describe(label, () => {
      test('routes the resolved command through the shared normalize-test-command helper', () => {
        const c = read(file);
        assert.match(c, /normalize-test-command/, `${label} must call the shared normalize-test-command helper`);
      });
      test('bounds execution with a timeout using the workflow.test_gate_timeout budget', () => {
        const c = read(file);
        assert.match(c, /workflow\.test_gate_timeout/, `${label} must read workflow.test_gate_timeout`);
        assert.match(c, /run-with-timeout "\$TEST_GATE_TIMEOUT"/, `${label} must wrap the test command in run-with-timeout with the configured budget`);
      });
      test('surfaces a timeout (exit 124) with a watch-mode hint — never a silent hang', () => {
        const c = read(file);
        assert.match(c, /-eq 124/, `${label} must handle the timeout exit code (124)`);
        assert.match(c, /watch\/dev mode/, `${label} must name watch/dev mode as the likely cause on timeout`);
      });
    });
  }

  // verify-phase is already bounded (fixed `run-with-timeout 300`, not a hang); it only
  // needs the normalizer so a watch runner exits fast, and names watch mode on 124.
  describe('verify-phase gate (already bounded — normalize-only)', () => {
    test('routes the resolved command through the shared normalize-test-command helper', () => {
      assert.match(read(VERIFY_PHASE), /normalize-test-command/, 'verify-phase must call the shared normalize-test-command helper');
    });
    test('surfaces its fixed timeout (exit 124) naming watch/dev mode', () => {
      const c = read(VERIFY_PHASE);
      assert.match(c, /-eq 124/, 'verify-phase must handle the timeout exit code (124)');
      assert.match(c, /watch\/dev mode/, 'verify-phase must name watch/dev mode as the likely cause on timeout');
    });
  });

  test('the regression gate ABORTS (halts) on a watch-mode timeout', () => {
    const c = read(REGRESSION_GATE);
    assert.match(c, /REGRESSION GATE ABORTED/, 'regression gate must abort (not continue) on timeout');
  });

  test('execute-phase.md delegates the regression gate to the extracted step (size-frozen file stays lean)', () => {
    const c = read(EXECUTE_PHASE);
    assert.match(c, /steps\/regression-gate\.md/, 'execute-phase.md must reference the extracted regression-gate step');
  });

  test('the gates share ONE normalizer — the helper is a single source of truth', () => {
    // The behaviour lives in src/normalize-test-command.cts; every gate invokes it
    // by the same verb name, so a change to watch-defeat logic touches one place.
    for (const file of [REGRESSION_GATE_RUN, POST_MERGE_GATE, AUDIT_FIX, VERIFY_PHASE]) {
      assert.match(read(file), /gsd_run query normalize-test-command/);
    }
  });
});

// #2350: `config-get KEY --default ""` WITHOUT `--raw` prints the JSON-encoded
// empty string (the 2-byte literal `""`) for an unset key, so a `[ -z "$CMD" ]`
// guard sees a non-empty string, SKIPS the whole Makefile/Cargo/go/npm/…
// auto-detection cascade, and runs the literal `""` as a command → exit 127,
// reported as a false build/test failure on any repo with no override and no
// detectable tooling (docs-only / planning-only repos, or any repo before its
// first build file). Every gate that resolves a build/test command this way MUST
// pass `--raw` so an unset key is a genuinely empty bash string the `-z` guard
// catches. This is a defect CLASS — post-merge-gate.md was the reported instance,
// but regression-gate.md, verify-phase.md, and audit-fix.md shared it, so the
// guard sweeps all of them (a single-file check gave false confidence). config-get's
// own `--raw` behaviour is covered in config-get-default.test.cjs.
describe('#2350: every gate resolves build/test commands with --raw', () => {
  // Each gate file that reads workflow.build_command / workflow.test_command to
  // build a shell command it then runs. Add new gates here as they appear.
  const GATE_FILES = [
    ['post-merge gate', POST_MERGE_GATE],
    ['regression gate', REGRESSION_GATE_RUN],
    ['verify-phase gate', VERIFY_PHASE],
    ['audit-fix gate', AUDIT_FIX],
  ];

  for (const [label, file] of GATE_FILES) {
    test(`${label}: no build/test_command config-get line is left without --raw`, () => {
      const lines = read(file)
        .split('\n')
        .filter((l) => /config-get\s+workflow\.(build|test)_command\s+--default\s+""/.test(l));
      // The gate must actually resolve a command this way (guards against the file
      // being renamed/refactored out from under this test without notice).
      assert.ok(lines.length > 0, `${label} (${path.basename(file)}) should resolve a build/test command via config-get`);
      const offending = lines.filter((l) => !/--raw/.test(l));
      assert.deepStrictEqual(
        offending,
        [],
        `${label}: every build/test_command config-get must pass --raw so an unset key is empty, not the literal ""; offending: ${offending.join(' | ')}`,
      );
    });
  }
});
