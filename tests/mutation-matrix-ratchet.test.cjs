'use strict';

/**
 * tests/mutation-matrix-ratchet.test.cjs
 *
 * Guards the per-module mutation-score ratchet contract defined in
 * scripts/mutation-matrix.cjs (ADR-456 / issue #1187).
 *
 * Assertions:
 *  (a) TARGET_MUTATION_SCORE is exported as a numeric constant equal to 80.
 *  (b) Every COVERED module declares a numeric minScore (50 ≤ minScore ≤ 100).
 *  (c) The matrix entry emitted by buildResult() / the script's JSON output
 *      includes minScore for each module.
 *  (d) A COVERED module missing minScore causes the above assertions to fail
 *      (negative proof — ensured by the ≥50 / ≤100 range check).
 *
 * Design note: this test imports the script's internals via require() — the
 * script exports COVERED and TARGET_MUTATION_SCORE so they can be tested
 * without subprocess overhead. buildResult() is not exported so we verify the
 * matrix output by running the script as a child process (stdin pipe mode).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fc = require('fast-check');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');

const MATRIX_SCRIPT = path.resolve(__dirname, '../scripts/mutation-matrix.cjs');
const matrix = require(MATRIX_SCRIPT);

// Deliberately RE-DERIVED here from matrix.COVERED, rather than calling the
// exported matrix.allCoveredTests() — resolveMutationTestFiles(undefined)'s
// production implementation itself calls allCoveredTests(), so comparing its
// output against that same function would make the assertion a tautology
// that passes no matter what either function does. This independent
// derivation is what makes the comparison test the production code.
const derived = [...new Set(Object.values(matrix.COVERED).flatMap((mod) => mod.tests))].sort();

// ── (a) TARGET_MUTATION_SCORE ─────────────────────────────────────────────────
describe('mutation-matrix ratchet: TARGET_MUTATION_SCORE export', () => {
  test('exports TARGET_MUTATION_SCORE', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(matrix, 'TARGET_MUTATION_SCORE'),
      'mutation-matrix.cjs must export TARGET_MUTATION_SCORE'
    );
  });

  test('TARGET_MUTATION_SCORE is numeric', () => {
    assert.strictEqual(
      typeof matrix.TARGET_MUTATION_SCORE,
      'number',
      'TARGET_MUTATION_SCORE must be a number'
    );
  });

  test('TARGET_MUTATION_SCORE equals 80', () => {
    assert.strictEqual(
      matrix.TARGET_MUTATION_SCORE,
      80,
      'TARGET_MUTATION_SCORE must equal 80 (ADR-456 floor)'
    );
  });
});

// ── (b) every COVERED module has a valid minScore ─────────────────────────────
describe('mutation-matrix ratchet: per-module minScore in COVERED', () => {
  test('exports COVERED object', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(matrix, 'COVERED'),
      'mutation-matrix.cjs must export COVERED'
    );
    assert.strictEqual(typeof matrix.COVERED, 'object');
    assert.ok(matrix.COVERED !== null);
  });

  const covered = matrix.COVERED || {};
  const moduleNames = Object.keys(covered);

  test('COVERED has at least one module', () => {
    assert.ok(moduleNames.length > 0, 'COVERED must contain at least one module');
  });

  for (const name of moduleNames) {
    describe(`module: ${name}`, () => {
      test(`${name}: declares minScore`, () => {
        const entry = covered[name];
        assert.ok(
          Object.prototype.hasOwnProperty.call(entry, 'minScore'),
          `COVERED['${name}'] must have a minScore property`
        );
      });

      test(`${name}: minScore is a number`, () => {
        const entry = covered[name];
        assert.strictEqual(
          typeof entry.minScore,
          'number',
          `COVERED['${name}'].minScore must be a number`
        );
      });

      test(`${name}: minScore is between 50 and 100 (inclusive)`, () => {
        const entry = covered[name];
        assert.ok(
          entry.minScore >= 50,
          `COVERED['${name}'].minScore (${entry.minScore}) must be ≥ 50`
        );
        assert.ok(
          entry.minScore <= 100,
          `COVERED['${name}'].minScore (${entry.minScore}) must be ≤ 100`
        );
      });
    });
  }
});

// ── (c) matrix JSON emitted by the script includes minScore per module ────────
describe('mutation-matrix ratchet: matrix JSON output includes minScore', () => {
  test('script emits valid JSON with minScore in each matrix include entry', () => {
    // Use stdin pipe mode: pass every COVERED module's src/*.cts path as
    // "changed" files so all modules appear in the matrix output.
    // computeMatrix() matches `src/<module>.cts` — derive from the module name.
    const covered = matrix.COVERED || {};
    const moduleNames = Object.keys(covered);
    const stdinLines = moduleNames.map(name => `src/${name}.cts`).join('\n');

    const spawnResult = runNode(
      [MATRIX_SCRIPT],
      {
        input: stdinLines + '\n',
        cwd: path.resolve(__dirname, '..'),
        timeoutMs: PROBE_TIMEOUT_MS,
      }
    );
    throwIfFailed(spawnResult, `node ${MATRIX_SCRIPT}`);
    const raw = spawnResult.stdout;

    let result;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      assert.fail(`mutation-matrix.cjs did not emit valid JSON: ${e.message}\nOutput: ${raw}`);
    }

    assert.strictEqual(result.has_work, 'true', 'has_work must be "true" when covered modules change');
    assert.ok(Array.isArray(result.matrix.include), 'matrix.include must be an array');
    assert.ok(result.matrix.include.length > 0, 'matrix.include must not be empty');

    for (const entry of result.matrix.include) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry, 'minScore'),
        `matrix entry for '${entry.name}' must include minScore in JSON output`
      );
      assert.strictEqual(
        typeof entry.minScore,
        'number',
        `matrix entry for '${entry.name}' minScore must be a number`
      );
      assert.ok(
        entry.minScore >= 50 && entry.minScore <= 100,
        `matrix entry for '${entry.name}' minScore (${entry.minScore}) must be between 50 and 100`
      );
    }
  });
});

// ── (d) negative proof: missing minScore is detectable ───────────────────────
describe('mutation-matrix ratchet: guard detects missing minScore', () => {
  test('a module entry without minScore would fail the range check (50-100)', () => {
    // Simulate the invariant: if minScore is missing, typeof === 'undefined',
    // which is not 'number' → the per-module assertion above would catch it.
    const fakeEntry = { cjs: 'foo.cjs', tests: ['tests/foo.test.cjs'] };
    assert.notStrictEqual(
      typeof fakeEntry.minScore,
      'number',
      'An entry without minScore must NOT pass the typeof-number check'
    );
    // Also verify that undefined < 50 and undefined > 100 are both false,
    // meaning the ≥50 check below would also catch it if typeof were lenient.
    assert.ok(
      !(fakeEntry.minScore >= 50),
      'undefined minScore must fail the ≥50 guard'
    );
  });
});

// ── (e) monotonic ratchet: minScore must exactly match baseline ───────────────
// RATCHET_BASELINE is a deliberate review-visible mirror of the floors in COVERED.
//
// CONTRACT: every COVERED module's minScore must EQUAL its entry here.
// ANY change to a floor (up or down) requires updating RATCHET_BASELINE in the
// same diff, making the change explicit in code review. This prevents a floor
// from being raised in COVERED and later silently lowered back to baseline.
//
// To ADD a new module to COVERED: add a baseline entry here in the same diff.
// The assertion "every COVERED module has a baseline" enforces this.
// The assertion "every baseline module still exists in COVERED" enforces the
// reverse: removing a module from COVERED also requires updating the baseline.
const RATCHET_BASELINE = {
  'context-utilization':     91,  // CI run 33012034388 (2026-08-25): measured 92.31%; floor(92.31)-1
  'context-composer':        78,  // CI run 33012034388 (2026-08-25): measured 79.92%; floor(79.92)-1
  'prompt-budget':           87,  // CI run 33012034388 (2026-08-25): measured 88.95%; floor(88.95)-1
  'frontmatter':             65,  // #3706: raised from 62; measured 66.67 on PR 3867
  'adr-parser':              68,
  'config-schema':           74,  // CI run 33012034388 (2026-08-25): measured 75.51%; floor(75.51)-1
  'active-workstream-store': 86,  // CI run 33012034388 (2026-08-25): measured 87.42%; floor(87.42)-1
  'core-utils':              75,
  'planning-inspect':        56,  // CI run 32392791843: 57.03% (unit shard); ratchet candidate vs TARGET 80
  'plan-document':           75,  // CI run 32392791843: 76.58% (unit shard)
  'planning-command-router': 94,  // CI run 32392791843: 95.65% (unit shard); already exceeds TARGET 80
  'model-catalog':           58,  // #3007: measured 59.62% in CI (248 killed / 168 survived); floor(59.62)-1
  'state-contract':          65,  // #3227: CI run 32769289750, job 97565813640,
                                   // `Stryker (state-contract)`: measured 66.25%; floor(66.25)-1.
                                   // Below TARGET_MUTATION_SCORE (80) — ratchet candidate like
                                   // planning-inspect / model-catalog above; raise as tests improve.
};

describe('mutation-matrix ratchet: floor equality enforcement', () => {
  const covered = matrix.COVERED || {};
  const coveredNames = Object.keys(covered);

  test('every COVERED module has a RATCHET_BASELINE entry (new modules must add one)', () => {
    for (const name of coveredNames) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(RATCHET_BASELINE, name),
        `COVERED module '${name}' has no RATCHET_BASELINE entry — add one before merging`
      );
    }
  });

  test('every RATCHET_BASELINE module still exists in COVERED (removed modules must drop their baseline entry)', () => {
    for (const name of Object.keys(RATCHET_BASELINE)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(covered, name),
        `RATCHET_BASELINE has entry for '${name}' but it no longer exists in COVERED — remove the baseline entry`
      );
    }
  });

  for (const name of coveredNames) {
    test(`${name}: minScore === baseline (${RATCHET_BASELINE[name] ?? 'NO BASELINE'}) — any floor change must update RATCHET_BASELINE`, () => {
      const baseline = RATCHET_BASELINE[name];
      if (baseline === undefined) {
        // Already caught by the presence check above; skip the numeric compare
        // to avoid a confusing NaN comparison error.
        assert.fail(`no RATCHET_BASELINE for '${name}' — add it`);
        return;
      }
      const actual = covered[name].minScore;
      assert.strictEqual(
        actual,
        baseline,
        `COVERED['${name}'].minScore (${actual}) !== RATCHET_BASELINE (${baseline}) — update RATCHET_BASELINE to match the new floor`
      );
    });
  }
});

// ── (f) resolveMutationBreak behaviour ───────────────────────────────────────
describe('resolveMutationBreak: fail-closed env-var resolver', () => {
  const { resolveMutationBreak } = matrix;

  test('exports resolveMutationBreak as a function', () => {
    assert.strictEqual(typeof resolveMutationBreak, 'function');
  });

  test('undefined → 60 (local run backstop)', () => {
    assert.strictEqual(resolveMutationBreak(undefined), 60);
  });

  test("'' (empty string) → throws (CI shard wiring error)", () => {
    assert.throws(
      () => resolveMutationBreak(''),
      /MUTATION_BREAK is set but empty/
    );
  });

  test("'   ' (whitespace-only) → throws (CI shard wiring error)", () => {
    assert.throws(
      () => resolveMutationBreak('   '),
      /MUTATION_BREAK is set but empty/
    );
  });

  test("'abc' → throws (non-numeric)", () => {
    assert.throws(
      () => resolveMutationBreak('abc'),
      /MUTATION_BREAK invalid/
    );
  });

  test("'0' → throws (out of range: below 1)", () => {
    assert.throws(
      () => resolveMutationBreak('0'),
      /MUTATION_BREAK invalid/
    );
  });

  test("'150' → throws (out of range: above 100)", () => {
    assert.throws(
      () => resolveMutationBreak('150'),
      /MUTATION_BREAK invalid/
    );
  });

  test("'80' → 80", () => {
    assert.strictEqual(resolveMutationBreak('80'), 80);
  });

  test("'62' → 62", () => {
    assert.strictEqual(resolveMutationBreak('62'), 62);
  });
});

// ── (g) resolveMutationTestFiles behaviour (#3915: tap-runner test-file resolver) ────
// stryker's tap-runner has no single `command` to inject a per-shard test list into —
// it takes an explicit `tap.testFiles` array — so the derived-union default that used to
// live only in stryker.config.mjs's DEFAULT_TEST_CMD string needs a resolver twin to
// resolveMutationBreak: same fail-closed shape, same single call site, this time
// producing a file-list array instead of a numeric threshold.
describe('resolveMutationTestFiles: fail-closed test-file-list resolver', () => {
  const { resolveMutationTestFiles } = matrix;

  test('exports resolveMutationTestFiles as a function', () => {
    assert.strictEqual(typeof resolveMutationTestFiles, 'function');
  });

  test('undefined → sorted, de-duplicated union of every COVERED[*].tests', () => {
    assert.deepStrictEqual(resolveMutationTestFiles(undefined), derived);
  });

  test('every entry of the undefined-default result exists on disk', () => {
    for (const entry of resolveMutationTestFiles(undefined)) {
      assert.ok(
        fs.existsSync(path.resolve(REPO_ROOT, entry)),
        `derived default test file does not exist on disk: ${entry}`
      );
    }
  });

  test('single test file (boundary 1) → one-element array', () => {
    assert.deepStrictEqual(
      resolveMutationTestFiles('tests/frontmatter.unit.test.cjs'),
      ['tests/frontmatter.unit.test.cjs']
    );
  });

  test('two space-separated test files → two-element array', () => {
    assert.deepStrictEqual(
      resolveMutationTestFiles('tests/frontmatter.unit.test.cjs tests/unusable-input.test.cjs'),
      ['tests/frontmatter.unit.test.cjs', 'tests/unusable-input.test.cjs']
    );
  });

  test("'' (empty string) → throws (CI shard wiring error)", () => {
    assert.throws(() => resolveMutationTestFiles(''), /set but empty/);
  });

  test("'   ' (whitespace-only) → throws (CI shard wiring error)", () => {
    assert.throws(() => resolveMutationTestFiles('   '), /set but empty/);
  });

  test("'\\t\\n  ' (mixed whitespace-only) → throws (CI shard wiring error)", () => {
    assert.throws(() => resolveMutationTestFiles('\t\n  '), /set but empty/);
  });

  test('null → throws', () => {
    assert.throws(() => resolveMutationTestFiles(null));
  });

  test('123 (non-string) → throws', () => {
    assert.throws(() => resolveMutationTestFiles(123));
  });

  test('an array (not a string) → throws', () => {
    assert.throws(() => resolveMutationTestFiles(['tests/frontmatter.unit.test.cjs']));
  });

  test('leading/trailing whitespace is trimmed to exactly one entry with no surrounding whitespace', () => {
    const result = resolveMutationTestFiles('  tests/frontmatter.unit.test.cjs  ');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], result[0].trim());
    assert.strictEqual(result[0], 'tests/frontmatter.unit.test.cjs');
  });

  test('mixed tab/newline/space separators → exactly 3 non-empty entries', () => {
    const result = resolveMutationTestFiles(
      'tests/frontmatter.unit.test.cjs\t\ttests/unusable-input.test.cjs\n tests/frontmatter.property.test.cjs'
    );
    assert.strictEqual(result.length, 3);
    for (const entry of result) assert.notStrictEqual(entry, '');
  });

  test('CRLF-separated entries → exactly 2 entries, none carrying a \\r', () => {
    const result = resolveMutationTestFiles(
      'tests/frontmatter.unit.test.cjs\r\ntests/unusable-input.test.cjs'
    );
    assert.strictEqual(result.length, 2);
    for (const entry of result) assert.ok(!entry.includes('\r'), `entry retained a \\r: ${JSON.stringify(entry)}`);
  });

  test('a repeated entry is de-duplicated to exactly 1', () => {
    const result = resolveMutationTestFiles(
      'tests/frontmatter.unit.test.cjs tests/frontmatter.unit.test.cjs'
    );
    assert.deepStrictEqual(result, ['tests/frontmatter.unit.test.cjs']);
  });

  test('a nonexistent test file throws, naming the bad path', () => {
    assert.throws(
      () => resolveMutationTestFiles('tests/does-not-exist-3915.test.cjs'),
      /does-not-exist-3915/
    );
  });

  test('one bad entry among otherwise-valid entries still throws', () => {
    assert.throws(
      () => resolveMutationTestFiles('tests/frontmatter.unit.test.cjs tests/does-not-exist-3915.test.cjs'),
      /does-not-exist-3915/
    );
  });

  test('an entry naming an existing directory throws, indicating it is not a regular file', () => {
    assert.throws(
      () => resolveMutationTestFiles('tests'),
      /not a regular file/
    );
  });

  test('an entry escaping the repo root via ../../../etc/passwd throws, indicating the escape', () => {
    assert.throws(
      () => resolveMutationTestFiles('../../../etc/passwd'),
      /escape the repo root/
    );
  });

  test('an entry escaping via a valid-looking prefix (tests/../../outside-3915.cjs) throws for escaping the repo root', () => {
    assert.throws(
      () => resolveMutationTestFiles('tests/../../outside-3915.cjs'),
      /escape the repo root/
    );
  });

  test('the full derived default, space-joined, round-trips through the resolver', () => {
    assert.deepStrictEqual(resolveMutationTestFiles(derived.join(' ')), derived);
  });
});

describe('resolveMutationTestFiles: round-trip property', () => {
  const { resolveMutationTestFiles } = matrix;

  test('any non-empty subset of the derived default, space-joined, resolves back to that de-duplicated subset', () => {
    fc.assert(
      fc.property(
        fc.subarray(derived, { minLength: 1 }),
        (subset) => {
          const expected = [...new Set(subset)].sort();
          const actual = resolveMutationTestFiles(subset.join(' '));
          assert.deepStrictEqual(actual, expected);
        }
      ),
      { seed: 3915, numRuns: 100 }
    );
  });
});

// ── (h) mutation matrix: isolation field removed (#3915) ─────────────────────
// stryker's tap-runner has no equivalent of `node --test --test-isolation=<mode>`
// (it drives Node's own TAP test-reporter file-by-file), so the per-shard
// `isolation` field this matrix used to emit for mutation.yml's
// MUTATION_TEST_CMD env line has nothing left to wire into and must be removed
// from buildResult()'s output entirely, not merely left unused.
describe('mutation matrix: isolation field removed (#3915)', () => {
  const { resolveMutationTestFiles } = matrix;

  test('every emitted matrix entry has no isolation field but keeps the rest of the contract', () => {
    const covered = matrix.COVERED || {};
    const moduleNames = Object.keys(covered);
    const stdinLines = moduleNames.map((name) => `src/${name}.cts`).join('\n');

    const spawnResult = runNode(
      [MATRIX_SCRIPT],
      {
        input: stdinLines + '\n',
        cwd: REPO_ROOT,
        timeoutMs: PROBE_TIMEOUT_MS,
      }
    );
    throwIfFailed(spawnResult, `node ${MATRIX_SCRIPT}`);
    const result = JSON.parse(spawnResult.stdout);

    assert.ok(result.matrix.include.length > 0, 'matrix.include must not be empty');

    for (const entry of result.matrix.include) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(entry, 'isolation'),
        `matrix entry for '${entry.name}' must NOT include an isolation field (#3915: tap-runner has no test-isolation flag)`
      );
      for (const key of ['name', 'mutate', 'tests', 'minScore', 'timeoutMinutes']) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(entry, key),
          `matrix entry for '${entry.name}' must still include '${key}'`
        );
      }

      // Round-trip between the two halves of the wiring: the tests string this
      // matrix emits must resolve back to exactly the COVERED entry's own tests.
      assert.deepStrictEqual(
        resolveMutationTestFiles(entry.tests),
        matrix.COVERED[entry.name].tests
      );
    }
  });
});
