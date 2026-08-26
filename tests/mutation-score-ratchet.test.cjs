'use strict';

/**
 * tests/mutation-score-ratchet.test.cjs
 *
 * Regression net for scripts/check-mutation-score-ratchet.cjs (#3881
 * follow-up, mutation-matrix piece 3: "the floor must ratchet up, not sit
 * where it is forever"). Drives the pure `evaluateRatchet` against boundary
 * inputs, then proves the CLI end-to-end against a synthetic Stryker `json`
 * reporter fixture: FAILS when the achieved score clears the floor by more
 * than the documented slack, PASSES when raised (or when within slack).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  RATCHET_SLACK,
  evaluateRatchet,
  extractAchievedScore,
} = require('../scripts/check-mutation-score-ratchet.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-mutation-score-ratchet.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');

describe('evaluateRatchet: pure boundary behaviour', () => {
  test(`achieved exactly floor + ${RATCHET_SLACK} does NOT ratchet (boundary, inclusive)`, () => {
    const { shouldRatchet } = evaluateRatchet(65 + RATCHET_SLACK, 65);
    assert.equal(shouldRatchet, false);
  });

  test(`achieved floor + ${RATCHET_SLACK} + 0.01 DOES ratchet (just past the boundary)`, () => {
    const { shouldRatchet, suggestedFloor } = evaluateRatchet(65 + RATCHET_SLACK + 0.01, 65);
    assert.equal(shouldRatchet, true);
    assert.equal(suggestedFloor, Math.floor(65 + RATCHET_SLACK + 0.01) - 1);
  });

  test('achieved below floor does NOT ratchet (a floor breach is Stryker\'s own MUTATION_BREAK problem, not this script\'s)', () => {
    const { shouldRatchet } = evaluateRatchet(40, 65);
    assert.equal(shouldRatchet, false);
  });

  test('achieved equal to floor does NOT ratchet', () => {
    const { shouldRatchet } = evaluateRatchet(65, 65);
    assert.equal(shouldRatchet, false);
  });

  test('suggestedFloor follows floor(achieved) - 1 exactly (this file\'s own documented convention)', () => {
    const { suggestedFloor } = evaluateRatchet(92.7, 60);
    assert.equal(suggestedFloor, 91);
  });
});

describe('extractAchievedScore: Stryker json-reporter document', () => {
  test('computes the same score Stryker itself would report for a mixed killed/survived set', () => {
    const report = {
      schemaVersion: '1.0',
      thresholds: { high: 80, low: 60 },
      files: {
        'foo.js': {
          language: 'javascript',
          source: 'x',
          mutants: [
            { id: '1', mutatorName: 'a', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
            { id: '2', mutatorName: 'a', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
            { id: '3', mutatorName: 'a', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
            { id: '4', mutatorName: 'a', status: 'Survived', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
          ],
        },
      },
    };
    assert.equal(extractAchievedScore(report), 75);
  });

  test('throws when the report has no scoreable mutants (empty files map — a wiring bug, never a 0% score)', () => {
    assert.throws(() => extractAchievedScore({ schemaVersion: '1.0', thresholds: {}, files: {} }), /no scoreable mutants/);
  });
});

// ── CLI end-to-end: fail on a planted over-floor score, pass when the floor is raised ───
function withReportFixture(mutationScore, fn) {
  // Build a Stryker json-reporter-shaped document whose achieved score is EXACTLY
  // `mutationScore` via N killed + (100 - N) survived out of 100 mutants — avoids floating
  // point ambiguity in the fixture itself.
  const killed = Math.round(mutationScore);
  const mutants = [];
  for (let i = 0; i < 100; i++) {
    mutants.push({
      id: String(i),
      mutatorName: 'a',
      status: i < killed ? 'Killed' : 'Survived',
      location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    });
  }
  const report = {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: { 'foo.js': { language: 'javascript', source: 'x', mutants } },
  };
  const dir = createTempDir('mutation-score-ratchet-test-');
  const reportPath = path.join(dir, 'mutation.json');
  fs.writeFileSync(reportPath, JSON.stringify(report), 'utf8');
  try {
    return fn(reportPath);
  } finally {
    cleanup(dir);
  }
}

describe('check-mutation-score-ratchet CLI: end-to-end fail-then-pass', () => {
  test('PLANTED: achieved score far above config-schema\'s real floor (52) FAILS the ratchet', () => {
    withReportFixture(52 + RATCHET_SLACK + 10, (reportPath) => {
      const result = runNode(
        [SCRIPT, '--module', 'config-schema', '--report', reportPath],
        { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
      );
      assert.notEqual(result.exitCode, 0, `expected nonzero exit; stderr: ${result.stderr}`);
      assert.match(result.stderr, /raise the floor/);
      assert.match(result.stderr, /config-schema/);
    });
  });

  test('RESTORED: an achieved score within slack of the same floor PASSES', () => {
    withReportFixture(52 + 1, (reportPath) => {
      const result = runNode(
        [SCRIPT, '--module', 'config-schema', '--report', reportPath],
        { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
      );
      assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
      assert.match(result.stdout, /ok mutation-score-ratchet/);
    });
  });

  test('an unknown --module exits nonzero with a clear message', () => {
    withReportFixture(90, (reportPath) => {
      const result = runNode(
        [SCRIPT, '--module', 'does-not-exist', '--report', reportPath],
        { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
      );
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown module/);
    });
  });

  test('a missing report file exits nonzero with a clear message', () => {
    const result = runNode(
      [SCRIPT, '--module', 'config-schema', '--report', path.join(os.tmpdir(), 'does-not-exist-mutation.json')],
      { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /report not found/);
  });
});
