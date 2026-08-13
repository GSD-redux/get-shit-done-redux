'use strict';

/**
 * Tests for `scripts/lint-health-diagnostic-rule-table.cjs` — the guard
 * enforcing ADR-3180 §8.2's 1:1 rule-code invariant and §8.5's fixture-proof
 * invariant for `src/health-diagnostic.cts`'s RULES table (Phase 11, #3309).
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * ("The lint guard (§8.2 1:1 invariant + §8.5 fixture proof)").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const guard = require('../scripts/lint-health-diagnostic-rule-table.cjs');
const {
  checkOneToOneInvariant,
  checkFixtureProofInvariant,
  findHealthDiagnosticTestFiles,
  PERMANENTLY_INERT_CODES,
} = guard;

const FAKE_SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

function writeTempTestFile(dir, name, content) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content);
  return full;
}

// ─── Check 1 — §8.2 rule 1: 1:1 code invariant ─────────────────────────────

describe('checkOneToOneInvariant (§8.2 rule 1)', () => {
  test('flags a duplicated code', () => {
    const rules = [
      { code: 'W001', severity: FAKE_SEVERITY.WARNING },
      { code: 'W002', severity: FAKE_SEVERITY.WARNING },
      { code: 'W001', severity: FAKE_SEVERITY.WARNING },
    ];

    const { duplicates, badSeverities } = checkOneToOneInvariant(rules, FAKE_SEVERITY);

    assert.deepEqual(duplicates, [{ code: 'W001', count: 2 }]);
    assert.deepEqual(badSeverities, []);
  });

  test('passes when every code is unique', () => {
    const rules = [
      { code: 'W001', severity: FAKE_SEVERITY.WARNING },
      { code: 'W002', severity: FAKE_SEVERITY.ERROR },
      { code: 'W003', severity: FAKE_SEVERITY.INFO },
    ];

    const { duplicates, badSeverities } = checkOneToOneInvariant(rules, FAKE_SEVERITY);

    assert.deepEqual(duplicates, []);
    assert.deepEqual(badSeverities, []);
  });

  test('flags a severity that is not a member of SEVERITY (hand-edited artifact)', () => {
    const rules = [
      { code: 'W001', severity: 'critical' },
      { code: 'W002', severity: FAKE_SEVERITY.WARNING },
    ];

    const { duplicates, badSeverities } = checkOneToOneInvariant(rules, FAKE_SEVERITY);

    assert.deepEqual(duplicates, []);
    assert.deepEqual(badSeverities, [{ code: 'W001', severity: 'critical' }]);
  });
});

// ─── Check 2 — §8.5: fixture-proof invariant ───────────────────────────────

describe('checkFixtureProofInvariant (§8.5)', () => {
  test('flags a code with zero mentions anywhere in the scanned test files', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-nomention-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake.test.cjs',
      "describe('W001 — something', () => { test('fires', () => {}); });\n",
    );

    const rules = [{ code: 'W001' }, { code: 'W999' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, ['W999']);
  });

  test('flags a code mentioned only in a comment/string outside any describe/test title', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-comment-only-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake.test.cjs',
      [
        "// W002 is handled elsewhere, see notes",
        "const message = 'refers to W002 in a plain string, not a block title';",
        "describe('unrelated block', () => { test('does something', () => {}); });",
        '',
      ].join('\n'),
    );

    const rules = [{ code: 'W002' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, ['W002']);
  });

  test('passes a code named in a describe() block title', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-titled-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake.test.cjs',
      "describe('W003 — some finding', () => { test('fires when absent', () => {}); });\n",
    );

    const rules = [{ code: 'W003' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, []);
  });

  test('passes a code named in a test()-only title (no wrapping describe)', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-test-only-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake.test.cjs',
      "test('W010 fires on incomplete agent install', () => {});\n",
    );

    const rules = [{ code: 'W010' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, []);
  });

  test('passes for a real code (W001) against the real tests/ tree', () => {
    const testFiles = findHealthDiagnosticTestFiles();
    assert.ok(testFiles.length > 0, 'expected at least one health-diagnostic test file on disk');

    const { uncovered } = checkFixtureProofInvariant([{ code: 'W001' }], testFiles);

    assert.deepEqual(uncovered, []);
  });
});

// ─── Check 2b — §8.5 EXCEPTION: PERMANENTLY_INERT_CODES ────────────────────
//
// A code whose `check` is a documented permanent no-op (W024 — see
// `scripts/lint-health-diagnostic-rule-table.cjs`'s own `PERMANENTLY_INERT_CODES`
// comment) can never satisfy a real fixture-proof. It must be reported as
// `exempted`, separately from genuinely-covered codes, and must NEVER land in
// `uncovered` — regardless of whether any test file happens to mention it.

describe('checkFixtureProofInvariant — PERMANENTLY_INERT_CODES exemption (§8.5 exception)', () => {
  test('an exempted code with ZERO test coverage anywhere still passes (not uncovered), and is reported as exempted', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-exempt-nomention-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(dir, 'fake.test.cjs', "describe('unrelated', () => {});\n");

    const rules = [{ code: 'W024' }];
    const inertCodes = new Map([['W024', 'permanent no-op, real check lives outside the rule table']]);
    const { uncovered, exempted } = checkFixtureProofInvariant(rules, [file], inertCodes);

    assert.deepEqual(uncovered, [], 'an exempted code must never be reported as uncovered');
    assert.deepEqual(exempted, ['W024']);
  });

  test('a code NOT in the exemption map, with zero test coverage, still fails as uncovered', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-not-exempt-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(dir, 'fake.test.cjs', "describe('unrelated', () => {});\n");

    const rules = [{ code: 'W998' }];
    const inertCodes = new Map([['W024', 'permanent no-op']]); // W998 is NOT in this map
    const { uncovered, exempted } = checkFixtureProofInvariant(rules, [file], inertCodes);

    assert.deepEqual(uncovered, ['W998'], 'a non-exempted, uncovered code must still fail the guard');
    assert.deepEqual(exempted, []);
  });

  test('an exempted code is reported as exempted even when a test file DOES happen to mention it in a titled block', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-exempt-mentioned-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake.test.cjs',
      "test('exports exactly 1 rule: W024', () => {});\n",
    );

    const rules = [{ code: 'W024' }];
    const inertCodes = new Map([['W024', 'permanent no-op']]);
    const { uncovered, exempted } = checkFixtureProofInvariant(rules, [file], inertCodes);

    assert.deepEqual(uncovered, []);
    assert.deepEqual(exempted, ['W024'], 'must be classified as exempted, not folded into ordinary coverage');
  });

  test('W024 is exempted (not uncovered, not silently "covered") against the real tests/ tree and the real PERMANENTLY_INERT_CODES map', () => {
    const testFiles = findHealthDiagnosticTestFiles();
    const { uncovered, exempted } = checkFixtureProofInvariant([{ code: 'W024' }], testFiles);

    assert.deepEqual(uncovered, []);
    assert.deepEqual(exempted, ['W024']);
  });

  test('PERMANENTLY_INERT_CODES locks exactly W024 with a non-empty, auditable reason', () => {
    assert.deepEqual([...PERMANENTLY_INERT_CODES.keys()], ['W024']);
    const reason = PERMANENTLY_INERT_CODES.get('W024');
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 0);
    assert.ok(/ambient I\/O|§8\.1/i.test(reason), 'reason should explain the §8.1 rule 1 constraint');
  });
});

// ─── findHealthDiagnosticTestFiles ─────────────────────────────────────────

describe('findHealthDiagnosticTestFiles', () => {
  test('finds every *.test.cjs under tests/health-diagnostic-rules/ plus tests/health-diagnostic.test.cjs', () => {
    const files = findHealthDiagnosticTestFiles();

    assert.ok(files.some((f) => f.endsWith('root-existence.test.cjs')));
    assert.ok(files.some((f) => f.endsWith('state-consistency.test.cjs')));
    assert.ok(files.some((f) => f.endsWith(path.join('tests', 'health-diagnostic.test.cjs'))));
  });
});
