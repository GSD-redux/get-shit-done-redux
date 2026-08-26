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
// SYNTHETIC_FLOOR is a fixture value this test file owns outright — never a real module's
// minScore from scripts/mutation-matrix.cjs. That real config ratchets UP as modules improve
// (exactly what this script's own CLI enforces), so a row that hardcodes a real floor breaks
// every time the ratchet does its job (see config-schema: 52 -> 74 by commit 973321541, which
// broke this file's previous PLANTED/RESTORED rows). Building a synthetic `--matrix` fixture
// with a floor this test controls makes the rows indifferent to any real module's floor moving.
const SYNTHETIC_MODULE = 'synthetic-ratchet-fixture';
const SYNTHETIC_FLOOR = 65;

function withMatrixFixture(floor, fn) {
  const dir = createTempDir('mutation-score-ratchet-matrix-');
  const matrixPath = path.join(dir, 'fixture-mutation-matrix.cjs');
  fs.writeFileSync(
    matrixPath,
    `'use strict';\nmodule.exports = { COVERED: { '${SYNTHETIC_MODULE}': { minScore: ${floor} } } };\n`,
    'utf8'
  );
  try {
    return fn(matrixPath);
  } finally {
    cleanup(dir);
  }
}

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
  test(`PLANTED: achieved score far above a synthetic module's floor (${SYNTHETIC_FLOOR}) FAILS the ratchet`, () => {
    withMatrixFixture(SYNTHETIC_FLOOR, (matrixPath) => {
      withReportFixture(SYNTHETIC_FLOOR + RATCHET_SLACK + 10, (reportPath) => {
        const result = runNode(
          [SCRIPT, '--module', SYNTHETIC_MODULE, '--report', reportPath, '--matrix', matrixPath],
          { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
        );
        assert.notEqual(result.exitCode, 0, `expected nonzero exit; stderr: ${result.stderr}`);
        assert.match(result.stderr, /raise the floor/);
        assert.match(result.stderr, new RegExp(SYNTHETIC_MODULE));
      });
    });
  });

  test('RESTORED: an achieved score within slack of the same synthetic floor PASSES', () => {
    withMatrixFixture(SYNTHETIC_FLOOR, (matrixPath) => {
      withReportFixture(SYNTHETIC_FLOOR + 1, (reportPath) => {
        const result = runNode(
          [SCRIPT, '--module', SYNTHETIC_MODULE, '--report', reportPath, '--matrix', matrixPath],
          { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
        );
        assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
        assert.match(result.stdout, /ok mutation-score-ratchet/);
      });
    });
  });

  test('an unknown --module exits nonzero with a clear message', () => {
    withMatrixFixture(SYNTHETIC_FLOOR, (matrixPath) => {
      withReportFixture(90, (reportPath) => {
        const result = runNode(
          [SCRIPT, '--module', 'does-not-exist', '--report', reportPath, '--matrix', matrixPath],
          { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
        );
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, /unknown module/);
      });
    });
  });

  test('a missing report file exits nonzero with a clear message', () => {
    withMatrixFixture(SYNTHETIC_FLOOR, (matrixPath) => {
      const result = runNode(
        [SCRIPT, '--module', SYNTHETIC_MODULE, '--report', path.join(os.tmpdir(), 'does-not-exist-mutation.json'), '--matrix', matrixPath],
        { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS }
      );
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /report not found/);
    });
  });
});
