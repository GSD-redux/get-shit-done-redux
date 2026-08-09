// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - frontmatter CLI integration
 *
 * Integration tests for the 4 frontmatter subcommands (get, set, merge, validate)
 * exercised through gsd-tools.cjs via execSync.
 *
 * Each test creates its own temp file, runs the CLI command, asserts output,
 * and cleans up in afterEach (per-test cleanup with individual temp files).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, parseFrontmatter } = require('./helpers.cjs');

// Track temp files for cleanup
let tempFiles = [];

function writeTempFile(content) {
  const tmpFile = path.join(os.tmpdir(), `gsd-fm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* already cleaned */ }
  }
  tempFiles = [];
});

// ─── frontmatter get ────────────────────────────────────────────────────────

describe('frontmatter get', () => {
  test('returns all fields as JSON', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 01\ntype: execute\n---\nbody text');
    const result = runGsdTools(['frontmatter', 'get', file]);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
    assert.strictEqual(parsed.plan, '01');
    assert.strictEqual(parsed.type, 'execute');
  });

  test('returns specific field with --field', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 02\ntype: tdd\n---\nbody');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'phase']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
  });

  test('returns error for missing field', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'nonexistent']);
    // The command succeeds (exit 0) but returns an error object in JSON
    assert.ok(result.success, 'Command should exit 0');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
    assert.ok(parsed.error.includes('Field not found'), 'Error should mention "Field not found"');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter get /nonexistent/path/file.md');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('handles file with no frontmatter', () => {
    const file = writeTempFile('Plain text with no frontmatter delimiters.');
    const result = runGsdTools(['frontmatter', 'get', file]);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.deepStrictEqual(parsed, {}, 'Should return empty object for no frontmatter');
  });
});

// ─── frontmatter set ────────────────────────────────────────────────────────

describe('frontmatter set', () => {
  test('updates existing field', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'phase', '--value', '02']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read back and verify
    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02');
  });

  test('adds new field', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'status', '--value', 'active']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.status, 'active');
  });

  test('handles JSON array value', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'tags', '--value', '["a","b"]']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.ok(Array.isArray(fm.tags), 'tags should be an array');
    assert.deepStrictEqual(fm.tags, ['a', 'b']);
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter set /nonexistent/file.md --field phase --value "01"');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('preserves body content after set', () => {
    const bodyText = '\n\n# My Heading\n\nSome paragraph with special chars: $, %, &.';
    const file = writeTempFile('---\nphase: 01\n---' + bodyText);
    runGsdTools(['frontmatter', 'set', file, '--field', 'phase', '--value', '02']);

    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(content.includes('# My Heading'), 'heading should be preserved');
    assert.ok(content.includes('Some paragraph with special chars: $, %, &.'), 'body content should be preserved');
  });
});

// ─── frontmatter merge ──────────────────────────────────────────────────────

describe('frontmatter merge', () => {
  test('merges multiple fields into frontmatter', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"plan":"02","type":"tdd"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '01', 'original field should be preserved');
    assert.strictEqual(fm.plan, '02', 'merged field should be present');
    assert.strictEqual(fm.type, 'tdd', 'merged field should be present');
  });

  test('overwrites existing fields on conflict', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"phase":"02"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02', 'conflicting field should be overwritten');
    assert.strictEqual(fm.type, 'execute', 'non-conflicting field should be preserved');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools(`frontmatter merge /nonexistent/file.md --data '{"phase":"01"}'`);
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('returns error for invalid JSON data', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', 'not json']);
    // cmdFrontmatterMerge calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Invalid JSON'), 'Error should mention invalid JSON');
  });
});

// ─── frontmatter validate ───────────────────────────────────────────────────

describe('frontmatter validate', () => {
  test('reports valid for complete plan frontmatter', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid');
    assert.deepStrictEqual(parsed.missing, [], 'No fields should be missing');
    assert.strictEqual(parsed.schema, 'plan');
  });

  test('reports invalid with missing fields', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'Should be invalid');
    assert.ok(parsed.missing.length > 0, 'Should have missing fields');
    // plan schema requires: phase, plan, type, wave, depends_on, files_modified, autonomous, must_haves
    // phase is present, so 7 should be missing
    assert.strictEqual(parsed.missing.length, 7, 'Should have 7 missing required fields');
    assert.ok(parsed.missing.includes('plan'), 'plan should be in missing');
    assert.ok(parsed.missing.includes('type'), 'type should be in missing');
    assert.ok(parsed.missing.includes('must_haves'), 'must_haves should be in missing');
  });

  test('validates against summary schema', () => {
    const content = `---
phase: 01
plan: 01
subsystem: testing
tags: [unit-tests, yaml]
duration: 5min
completed: 2026-02-25
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'summary']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for summary schema');
    assert.strictEqual(parsed.schema, 'summary');
  });

  test('validates against verification schema', () => {
    const content = `---
phase: 01
verified: 2026-02-25
status: passed
score: 5/5
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'verification']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for verification schema');
    assert.strictEqual(parsed.schema, 'verification');
  });

  test('returns error for unknown schema', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'unknown']);
    // cmdFrontmatterValidate calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Unknown schema'), 'Error should mention unknown schema');
  });

  // #2847 review finding: a bare FRONTMATTER_SCHEMAS[schemaName] lookup resolves
  // prototype-chain keys to Object.prototype members instead of undefined, so the
  // `!schema` guard never fires and the command crashes with an uncaught TypeError
  // ("Cannot read properties of undefined (reading 'filter')") and a stack trace
  // instead of reporting "Unknown schema". Now that --schema is an agent-bound
  // variable ($SCHEMA in agents/gsd-planner.md's validate_plan step) rather than a
  // fixed literal, this is reachable from prompt state.
  for (const schemaName of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    test(`--schema ${schemaName} reports Unknown schema, not a crash`, () => {
      const file = writeTempFile('---\nphase: 01\n---\n');
      const result = runGsdTools(['frontmatter', 'validate', file, '--schema', schemaName]);
      assert.ok(!result.success, `--schema ${schemaName} should fail with a non-zero exit code, not crash`);
      assert.ok(
        result.error.includes('Unknown schema'),
        `--schema ${schemaName} error should be "Unknown schema...", not a TypeError stack trace; got: ${result.error}`
      );
      assert.ok(
        !result.error.includes('TypeError') && !result.error.includes('Cannot read properties'),
        `--schema ${schemaName} must not surface a raw TypeError; got: ${result.error}`
      );
    });
  }

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter validate /nonexistent/file.md --schema plan');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });
});

// ─── frontmatter validate: plan-gap-closure schema (#2847) ───────────────────
//
// Regression coverage for #2847: "--gaps does not load planner-gap-closure.md,
// so generated gap plans may miss gap_closure metadata". A gap-closure plan
// with every other required field but no `gap_closure` used to report
// `valid: true` against the only schema the planner validated against
// (`plan`). Row 1 below is the failing-first regression test: it fails on
// pre-fix `FRONTMATTER_SCHEMAS` (no `plan-gap-closure` key exists — the CLI
// exits 1 with "Unknown schema: plan-gap-closure") and passes after the fix.

describe('frontmatter validate: plan-gap-closure schema (#2847)', () => {
  const PLAN_BODY_NO_GAP_CLOSURE = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
---
body`;

  // Row 1 — failing-first regression test.
  test('rejects plan-gap-closure frontmatter missing gap_closure (#2847)', () => {
    const file = writeTempFile(PLAN_BODY_NO_GAP_CLOSURE);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'Should be invalid: gap_closure is missing');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure should be reported missing');
    assert.strictEqual(parsed.missing.length, 1, 'Only gap_closure should be missing; all other fields are present');
    assert.deepStrictEqual(parsed.invalidValue, [], 'gap_closure is ABSENT here, not wrong-valued — invalidValue must stay empty');
    assert.strictEqual(parsed.schema, 'plan-gap-closure');
  });

  // Row 2 — happy path.
  test('accepts complete plan-gap-closure frontmatter', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
gap_closure: true
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid: gap_closure is present');
    assert.deepStrictEqual(parsed.missing, []);
    assert.ok(parsed.present.includes('gap_closure'));
    assert.deepStrictEqual(parsed.invalidValue, [], 'gap_closure has the correct value here — invalidValue must be empty');
    assert.strictEqual(parsed.schema, 'plan-gap-closure');
  });

  // Row 3 — empty/near-empty input boundary.
  test('reports all plan-gap-closure fields missing except phase for near-empty frontmatter', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false);
    // plan-gap-closure requires 9 fields; phase is present, so 8 should be missing.
    assert.strictEqual(parsed.missing.length, 8, 'Should have 8 missing required fields');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure should be among the missing fields');
  });

  // Row 4 — negative space: standard-mode ('plan' schema) plans are unaffected by #2847's fix.
  test('plan schema (standard/reviews mode) still reports valid without gap_closure — unaffected by #2847 fix', () => {
    const file = writeTempFile(PLAN_BODY_NO_GAP_CLOSURE);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'plan schema must not require gap_closure (AC(3): standard mode unaffected)');
    assert.deepStrictEqual(parsed.missing, []);
    assert.strictEqual(parsed.schema, 'plan');
  });

  // Row 5 — CRLF cross-platform newline handling.
  test('parses plan-gap-closure frontmatter with CRLF line endings', () => {
    const content = [
      '---',
      'phase: 01',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/auth.ts]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "All tests pass"',
      'gap_closure: true',
      '---',
      'body',
    ].join('\r\n');
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'CRLF frontmatter must parse identically to LF for plan-gap-closure');
    assert.ok(parsed.present.includes('gap_closure'));
  });

  // Row 6 — gap_closure: false must be REJECTED, not merely present.
  //
  // #2847 review finding: --gaps-only filters strictly on gap_closure === true
  // (execute-phase.md, partial-wave.md). A presence-only check (matching every
  // other required field) lets `gap_closure: false` validate as valid:true,
  // which is #2847's exact reported symptom — --gaps-only still spawns zero
  // executors — one value away. plan-gap-closure's requiredValues entry closes
  // this: gap_closure must be present AND equal "true" (extractFrontmatter
  // parses every scalar as a string; FrontmatterValue has no boolean member).
  test('gap_closure: false is rejected — plan-gap-closure requires the value true, not mere presence', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
gap_closure: false
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'gap_closure: false must NOT satisfy plan-gap-closure');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure must be reported missing when its value is false');
    assert.ok(!parsed.present.includes('gap_closure'), 'gap_closure must not be reported present when its value is false');
    // #2847 review: presence alone is not the whole story here — the field IS in the
    // file, just wrong-valued. invalidValue distinguishes that from a genuinely absent
    // field (Row 1) so a caller (or a human) gets an actionable "the value is wrong",
    // not "this field is missing" for a field they can plainly see in the plan.
    assert.ok(
      parsed.invalidValue.includes('gap_closure'),
      'gap_closure must be reported in invalidValue — present but wrong-valued, distinct from genuinely absent'
    );
  });

  // Row 7 — invalidValue vs missing distinction, spelled out directly (not just
  // implied by Rows 1/2/6 individually).
  test('invalidValue distinguishes "present but wrong value" from "absent" for the same missing-reporting field', () => {
    const absentResult = JSON.parse(
      runGsdTools(['frontmatter', 'validate', writeTempFile(PLAN_BODY_NO_GAP_CLOSURE), '--schema', 'plan-gap-closure']).output
    );
    const wrongValueContent = PLAN_BODY_NO_GAP_CLOSURE.replace('---\nbody', 'gap_closure: TRUE\n---\nbody');
    const wrongValueResult = JSON.parse(
      runGsdTools(['frontmatter', 'validate', writeTempFile(wrongValueContent), '--schema', 'plan-gap-closure']).output
    );

    // Both report gap_closure as missing (the field does not satisfy the schema either way)...
    assert.ok(absentResult.missing.includes('gap_closure'));
    assert.ok(wrongValueResult.missing.includes('gap_closure'));
    // ...but only the wrong-VALUE case appears in invalidValue.
    assert.deepStrictEqual(absentResult.invalidValue, [], 'a genuinely absent field must not appear in invalidValue');
    assert.ok(
      wrongValueResult.invalidValue.includes('gap_closure'),
      'gap_closure: TRUE (capitalized YAML boolean, rejected — the validator requires the exact literal lowercase true) must appear in invalidValue'
    );
  });
});

// ─── frontmatter set/merge: must_haves object-list preservation (#1572) ──────
// `frontmatter set`/`merge` round-tripped the WHOLE frontmatter through the lossy
// extractFrontmatter → reconstructFrontmatter pair, which flattens must_haves
// object-list items ({path, provides} maps) to scalar strings and re-emits them as a
// malformed inline array — destroying `provides:` whenever an UNRELATED field changed.
// The fix preserves the original raw text for any structurally-unchanged top-level key.
const { parseMustHavesBlock } = require('../gsd-core/bin/lib/frontmatter.cjs');

describe('frontmatter set/merge preserves must_haves object-lists (#1572)', () => {
  const ARTIFACTS_PLAN = [
    '---',
    'phase: 1',
    'wave: 1',
    'plan: 01-01',
    'type: implementation',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves:',
    '  artifacts:',
    '    - path: src/foo.ts',
    '      provides: the foo',
    '    - path: src/bar.ts',
    '      provides: the bar',
    '---',
    '# body',
    '',
  ].join('\n');

  const PROHIBITIONS_PLAN = [
    '---',
    'phase: 1',
    'wave: 1',
    'must_haves:',
    '  prohibitions:',
    '    - statement: no direct DB calls',
    '      status: enforced',
    '    - statement: no print statements',
    '      status: pending',
    '---',
    '# body',
    '',
  ].join('\n');

  function runAndParse(plan, cmdArgsForFile) {
    const file = writeTempFile(plan);
    runGsdTools(cmdArgsForFile(file));
    const after = fs.readFileSync(file, 'utf-8');
    return after;
  }

  test('set on an unrelated scalar preserves every must_haves.artifacts entry (path + provides)', () => {
    const after = runAndParse(ARTIFACTS_PLAN, f => ['frontmatter', 'set', f, '--field', 'wave', '--value', '2']);
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts object-list must survive a set on an unrelated field (#1572)',
    );
  });

  test('merge of an unrelated field preserves every must_haves.artifacts entry', () => {
    const after = runAndParse(ARTIFACTS_PLAN, f => ['frontmatter', 'merge', f, '--data', JSON.stringify({ wave: 2 })]);
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts object-list must survive a merge of an unrelated field (#1572)',
    );
  });

  test('must_haves.prohibitions object-list is preserved on an unrelated set (same code path)', () => {
    const after = runAndParse(PROHIBITIONS_PLAN, f => ['frontmatter', 'set', f, '--field', 'wave', '--value', '2']);
    assert.deepEqual(
      parseMustHavesBlock(after, 'prohibitions'),
      [
        { statement: 'no direct DB calls', status: 'enforced' },
        { statement: 'no print statements', status: 'pending' },
      ],
      'must_haves.prohibitions object-list must survive a set on an unrelated field (#1572)',
    );
  });

  test('round-trip is stable: setting wave twice still preserves artifacts (per-key preservation is idempotent)', () => {
    const file = writeTempFile(ARTIFACTS_PLAN);
    runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '2']);
    runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '3']);
    const after = fs.readFileSync(file, 'utf-8');
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts must survive repeated sets on an unrelated field',
    );
  });

  test('directly setting must_haves to a new object-list fails closed instead of emitting [object Object] (#1572 codex review)', () => {
    // A CHANGED key whose value is an object-list cannot be faithfully serialized by the
    // lossy writer (it would emit "[object Object]"). Rather than silently destroy the
    // data, spliceFrontmatter throws — the command fails and the file is left unchanged.
    const file = writeTempFile(ARTIFACTS_PLAN);
    const result = runGsdTools([
      'frontmatter', 'set', file, '--field', 'must_haves',
      '--value', JSON.stringify({ artifacts: [{ path: 'src/new.ts', provides: 'new thing' }] }),
    ]);
    assert.ok(
      !result.success,
      'frontmatter set of a must_haves object-list must fail closed (refuse to emit "[object Object]")',
    );
    const after = fs.readFileSync(file, 'utf-8');
    assert.ok(!/\[object Object\]/.test(after), 'the file must not contain "[object Object]" after a refused set');
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'the original must_haves.artifacts must be intact after the refused set',
    );
  });
});

// Bug #1660 — frontmatter set of an object-list field (e.g. must_haves) is a silent no-op
// when the new value's lossy parse projection equals the original's. Folded into the owning
// frontmatter-cli test (no new top-level bug-NNNN file).
describe('Bug #1660: frontmatter set of an object-list field fails closed instead of a silent no-op', () => {
  const PLAN_WITH_MUST_HAVES = [
    '---', 'phase: 1', 'wave: 1',
    'must_haves:', '  artifacts:', '    - path: src/foo.ts', '      provides: the foo',
    '---', '# body', '',
  ].join('\n');

  test('setting must_haves to a value that flattens to the original projection fails closed (no silent no-op)', () => {
    const file = writeTempFile(PLAN_WITH_MUST_HAVES);
    const before = fs.readFileSync(file, 'utf-8');
    // New value {artifacts:["path: src/foo.ts"]} — its extractFrontmatter projection equals
    // the original's flattened projection, so the set would otherwise be a silent no-op.
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'must_haves', '--value', JSON.stringify({ artifacts: ['path: src/foo.ts'] })]);
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'a no-op set of an object-list field must surface an error, not silent {updated:true}');
    const after = fs.readFileSync(file, 'utf-8');
    assert.equal(after, before, 'the file must be unchanged when the set is refused (no silent partial write)');
  });

  test('an idempotent set of a scalar (wave, same value) still reports updated (no false positive)', () => {
    const file = writeTempFile('---\nphase: 1\nwave: 1\n---\n# body\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '1']);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'an idempotent SCALAR set must still report {updated:true} (not fail-closed)');
    assert.ok(!parsed.error, 'an idempotent scalar set must not produce an error');
  });

  test('an idempotent set of a scalar array (tags, same value) still reports updated (no false positive)', () => {
    const file = writeTempFile('---\nphase: 1\ntags: ["a","b"]\n---\n# body\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'tags', '--value', '["a","b"]']);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'an idempotent scalar-ARRAY set must still report {updated:true} (arrays round-trip; not fail-closed)');
    assert.ok(!parsed.error, 'an idempotent scalar-array set must not produce an error');
  });
});

// ─── #1778: thread workflow must use the 1.6 named-flag frontmatter.set form ─
//
// The thread workflow's CLOSE and RESUME branches previously invoked the
// pre-1.6 positional shape (frontmatter.set <file> <field> <value>). Since 1.6
// the dispatcher (gsd-tools.cjs) reads field/value from the named --field/
// --value flags via parseNamedArgs; the positional form leaves field/value
// undefined, cmdFrontmatterSet errors `file, field, and value required`, and
// the status/updated writes are silently skipped — so closing a thread never
// marked it status: resolved and resuming never marked it status: in_progress.
describe('#1778: thread workflow uses the 1.6 named-flag frontmatter.set form', () => {
  test('behavioral: named-flag form writes the field; positional form errors and does not mutate', () => {
    // 1.6 named-flag form — must succeed and write status: resolved.
    const goodFile = writeTempFile('---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n');
    const good = runGsdTools(['frontmatter', 'set', goodFile, '--field', 'status', '--value', 'resolved']);
    assert.ok(good.success, `named-flag form must succeed; stderr: ${good.error}`);
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(goodFile, 'utf-8')).status,
      'resolved',
      'named-flag form must write status: resolved into the file',
    );

    // Pre-1.6 positional form — must fail with the documented message and NOT mutate.
    const badFile = writeTempFile('---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n');
    const bad = runGsdTools(['frontmatter', 'set', badFile, 'status', 'resolved']);
    assert.ok(!bad.success, 'positional form must fail (it is the bug being guarded against)');
    assert.ok(
      (bad.error + bad.output).includes('file, field, and value required'),
      `positional form must error with the documented message; got:\n${bad.error}${bad.output}`,
    );
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(badFile, 'utf-8')).status,
      'open',
      'positional form must NOT mutate the file (the silent-failure bug)',
    );
  });

  test('workflow parity: no gsd-core/workflows/*.md emits the positional frontmatter.set form', () => {
    const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one workflow under gsd-core/workflows/');

    const offenders = [];
    for (const name of files) {
      const full = path.join(workflowsDir, name);
      const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Match any frontmatter.set invocation (dot or space form, with or
        // without the `gsd_run query` prefix). The 1.6 contract requires
        // --field AND --value on every set call; a set line missing --field
        // is the pre-1.6 positional form (#1778).
        if (!/frontmatter[.\s]+set\b/.test(line)) return;
        if (!/--field\b/.test(line) || !/--value\b/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `These workflow frontmatter.set invocations are missing the 1.6 --field/--value named flags (the #1778 positional-form bug):\n  ${offenders.join('\n  ')}\n\nUse: gsd_run query frontmatter.set <file> --field <field> --value <value>`,
    );
  });

  test('thread workflow CLOSE writes status: resolved and RESUME writes status: in_progress via named flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'thread.md'), 'utf-8');

    // CLOSE mode: status resolved + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+resolved\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value resolved',
    );
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+updated\s+--value\s+YYYY-MM-DD\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field updated --value YYYY-MM-DD',
    );

    // RESUME mode: status in_progress + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+in_progress\b/.test(src),
      'RESUME mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value in_progress',
    );
  });
});

// ─── #1882: the user-reachable surface actually distinguishes the two cases ───

describe('frontmatter get — truncated vs absent frontmatter (#1882)', () => {
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  function runCapturingStderr(file) {
    const r = runNode([TOOLS, 'frontmatter', 'get', file, '--raw'], {
      env: { ...process.env, GSD_TEST_MODE: '1' },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const legacy = toLegacyResult(r);
    return { status: legacy.status, stdout: legacy.stdout.trim(), stderr: legacy.stderr.trim() };
  }

  // This is the wired keystone for #1882: the diagnostic is only "delivered" if it reaches
  // the surface a user actually invokes. The assertion is a DIFFERENTIAL between two runs —
  // whether stderr is empty — which is a behavioural claim, not a match against the message
  // wording, so it stays inside CONTRIBUTING.md's ban on raw text matching.
  test('a truncated file is reported while an absent-frontmatter file stays silent', () => {
    const truncated = writeTempFile('---\nphase: 01\nplan: half-written\n');
    const absent = writeTempFile('plain body with no frontmatter\n');

    const bad = runCapturingStderr(truncated);
    const good = runCapturingStderr(absent);

    // The contract every one of the ~50 callers depends on is unchanged for both.
    assert.strictEqual(bad.status, 0, 'truncated file must not change the exit code');
    assert.strictEqual(good.status, 0);
    assert.deepStrictEqual(JSON.parse(bad.stdout), {}, 'return value must be preserved');
    assert.deepStrictEqual(JSON.parse(good.stdout), {});

    // ...and the only difference is that corruption is no longer silent.
    assert.notStrictEqual(bad.stderr, '', 'a truncated frontmatter must be reported');
    assert.strictEqual(good.stderr, '', 'a file with no frontmatter is not corrupt');
  });

  test('a Markdown thematic break at byte 0 is not reported as corruption', () => {
    const thematicBreak = writeTempFile('---\nSome heading text\n\nA paragraph, no more dashes.\n');
    const r = runCapturingStderr(thematicBreak);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), {});
    assert.strictEqual(r.stderr, '', 'a horizontal rule is valid Markdown, not a truncated file');
  });
});
