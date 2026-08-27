/**
 * GSD Tools Tests - --pick flag
 *
 * Regression tests for the --pick CLI flag that extracts a single field
 * from JSON output, replacing the need for jq as an external dependency.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');

// ─── --pick flag ─────────────────────────────────────────────────────────────

describe('--pick flag', () => {
  test('extracts a top-level field from JSON output', () => {
    const result = runGsdTools('generate-slug "hello world" --pick slug');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'hello-world');
  });

  test('extracts a top-level field using array args', () => {
    const result = runGsdTools(['generate-slug', 'hello world', '--pick', 'slug']);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'hello-world');
  });

  // #3365 / ADR-3473 §8.4 P6: an ABSENT field is a failure ("I could not
  // answer"), never a demotion to the empty answer at exit 0. This inverts
  // the old pinned assertion below (kept as a comment for the historical
  // record — measured on this tree, 2026-08-26, exit 0 + empty stdout):
  //   const result = runGsdTools('generate-slug "test" --pick nonexistent');
  //   assert.strictEqual(result.success, true);
  //   assert.strictEqual(result.output, '');
  test('absentFieldExitsNonZero_3365', () => {
    const result = runGsdTools('generate-slug "test" --pick nonexistent');
    assert.strictEqual(result.success, false, 'an absent --pick field must exit non-zero');
    assert.strictEqual(result.output, '');
    assert.match(result.error, /nonexistent/, 'stderr must name the requested field');
  });

  // P2 (test matrix): a count of zero is a real value, not absence — this
  // must keep PASSING before and after the fix (the non-change half of #3365).
  test('zeroCountPrintsZeroAtExitZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('query phases.list --type summaries --pick count', tmpDir);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output, '0');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P4 (test matrix, negative space N1): a field present with an explicit
  // `null` value is an answer, not a failure — must keep PASSING before and
  // after the fix. Measured: `phases.list --type plans --pick phase_dir` on
  // the enumeration path (no --phase given) returns `phase_dir: null`.
  test('presentButNullIsEmptyAtExitZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('query phases.list --type plans --pick phase_dir', tmpDir);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output, '');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P10 (test matrix): required boundary triple over an array field of
  // known length N=3 (three seeded phase directories).
  test('arrayIndexBoundaryAtLenMinus1_Len_LenPlus1', () => {
    const tmpDir = createTempProject();
    try {
      seedPhase(tmpDir, '01-alpha');
      seedPhase(tmpDir, '02-beta');
      seedPhase(tmpDir, '03-gamma');

      const atLenMinus1 = runGsdTools('query phases.list --pick directories[2]', tmpDir);
      assert.strictEqual(atLenMinus1.success, true);
      assert.strictEqual(atLenMinus1.output, '03-gamma');

      const atLen = runGsdTools('query phases.list --pick directories[3]', tmpDir);
      assert.strictEqual(atLen.success, false, 'index == length is out of range and must exit non-zero');

      const atLenPlus1 = runGsdTools('query phases.list --pick directories[4]', tmpDir);
      assert.strictEqual(atLenPlus1.success, false, 'index == length + 1 is out of range and must exit non-zero');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P12 (test matrix): the measured B11 defect — a non-JSON command's
  // `--pick` must never dump the whole document as a coincidental "success".
  // TODAY (measured on this tree, 2026-08-26), against an empty temp project:
  //   $ gsd-tools audit-open --pick nonexistent_field
  //   ### Milestone Close: Open Artifact Audit
  //
  //   All artifact types clear. Safe to proceed.
  //
  //   ---
  //   exit 0
  test('nonJsonOutputDoesNotDumpWholeDocument', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('audit-open --pick nonexistent_field', tmpDir);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output, '');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P13 (test matrix): `--raw --pick <known field>` withdraws its
  // coincidental "success" — measured today: exit 0, stdout `hello-world`,
  // via the same non-JSON dump `--raw` produces.
  test('rawPlusPickIsRejectedNotCoincidentallyRight', () => {
    const result = runGsdTools(['generate-slug', 'Hello World', '--raw', '--pick', 'slug']);
    assert.strictEqual(result.success, false);
  });

  // P14 (test matrix): the confidently-wrong case — measured today: exit 0,
  // stdout `hello-world` (the SLUG field's value, not the bogus field asked
  // for), via the same non-JSON dump.
  test('rawPlusPickBogusDoesNotEmitAnotherFieldsValue', () => {
    const result = runGsdTools(['generate-slug', 'Hello World', '--raw', '--pick', 'bogus']);
    assert.strictEqual(result.success, false);
    assert.ok(
      !result.output.includes('hello-world'),
      `must not leak another field's value; got: ${JSON.stringify(result.output)}`,
    );
  });

  test('errors when --pick has no value', () => {
    const result = runGsdTools('generate-slug "test" --pick');
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Missing value for --pick/);
  });

  test('errors when --pick value starts with --', () => {
    const result = runGsdTools(['generate-slug', 'test', '--pick', '--raw']);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Missing value for --pick/);
  });

  test('does not collide with frontmatter --field flag', () => {
    // frontmatter subcommand uses --field internally; --pick should not interfere
    const result = runGsdTools('generate-slug "test-value" --pick slug');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'test-value');
  });

  test('works with current-timestamp command', () => {
    const result = runGsdTools('current-timestamp --pick timestamp');
    assert.strictEqual(result.success, true);
    assert.ok(result.output.length > 0, 'timestamp should not be empty');
    assert.match(result.output, /^\d{4}-\d{2}-\d{2}T/);
  });
});
