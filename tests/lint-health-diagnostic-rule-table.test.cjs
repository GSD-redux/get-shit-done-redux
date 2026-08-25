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
  STATE_VALIDATE_TEST_FILE,
  STATE_VALIDATE_CODES,
  discoverStateValidateCodes,
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

// ─── Check 3 — S0NN pass (Phase 12, #3310): checkFixtureProofInvariant
// against the hardcoded STATE_VALIDATE_CODES list and tests/state.test.cjs.
// These codes are not Rule-table entries (cmdStateValidate builds
// Diagnostic[] inline), so this check exercises the SAME
// checkFixtureProofInvariant helper the C0NN pass uses, just fed a
// hardcoded code list instead of a Rule[] array — mirroring the original
// W/E/I test structure above (no code-source-specific behavior to test
// beyond that, since checkFixtureProofInvariant itself is already covered).

describe('checkFixtureProofInvariant (S0NN pass, #3310)', () => {
  test('flags a code with zero mentions anywhere in the scanned test files', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-s0nn-nomention-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake-state.test.cjs',
      "describe('S001: something', () => { test('fires', () => {}); });\n",
    );

    const rules = [{ code: 'S001' }, { code: 'S999' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, ['S999']);
  });

  test('passes a code named in a test() block title', (t) => {
    const dir = createTempDir('gsd-lint-hd-rt-s0nn-titled-');
    t.after(() => cleanup(dir));
    const file = writeTempTestFile(
      dir,
      'fake-state.test.cjs',
      "test('S001: STATE.md corrupt (NUL byte) fires with the verbatim textEncodingError message', () => {});\n",
    );

    const rules = [{ code: 'S001' }];
    const { uncovered } = checkFixtureProofInvariant(rules, [file]);

    assert.deepEqual(uncovered, []);
  });

  test('discoverStateValidateCodes reads the code set off stateDiagnostic() call sites', () => {
    // #3696: the guard's S0NN list used to be a frozen literal, and this test
    // used to be a second frozen literal mirroring it. Two copies of an
    // allowlist prove only that they agree with each other — which is exactly
    // what let S008/S009 be added while the guard reported a green
    // "7 code(s), all fixture-covered" (ADR-3180 Decision 4(a): a zero it did
    // not earn). The behaviour under test is now the DISCOVERY RULE, driven
    // against fixture source text rather than the real module.
    const fixture = [
      "warnings.push(stateDiagnostic('S002', SEVERITY.WARNING, 'a', 'b'));",
      'warnings.push(stateDiagnostic(',
      "  'S001',",
      '  SEVERITY.ERROR,',
      '));',
      'warnings.push(stateDiagnostic(`S002`, SEVERITY.WARNING, "dup", "b"));',
      "// stateDiagnostic('S404', ...) in a comment still counts — this is a",
      '// regex guard, and over-inclusion only ever demands MORE fixture cover.',
    ].join('\n');

    assert.deepEqual(
      discoverStateValidateCodes(fixture, 'fixture'),
      ['S001', 'S002', 'S404'],
      'codes are deduplicated and sorted, across single/double/backtick quoting and line breaks',
    );
  });

  test('discoverStateValidateCodes fails closed when the call shape changes', () => {
    // The branch that matters. If stateDiagnostic() is renamed, the honest
    // answer is "I can no longer see the codes", never "there are none, and they
    // are all covered".
    assert.throws(
      () => discoverStateValidateCodes('renamedHelper("S001", SEVERITY.WARNING);', 'fixture'),
      (err) => /found no stateDiagnostic\(\) call sites in fixture/.test(String(err.message)),
      'an unrecognised call shape must raise, not return []',
    );
  });

  test('every code cmdStateValidate can emit is fixture-covered against the real state test file', () => {
    assert.ok(fs.existsSync(STATE_VALIDATE_TEST_FILE), 'the state test file must exist');
    assert.ok(STATE_VALIDATE_CODES.length > 0, 'the real discovery pass must find at least one code');

    const rules = STATE_VALIDATE_CODES.map((code) => ({ code }));
    const { uncovered } = checkFixtureProofInvariant(rules, [STATE_VALIDATE_TEST_FILE], new Map());

    assert.deepEqual(uncovered, [], `uncovered S0NN codes: ${uncovered.join(', ')}`);
  });

  test('the fixture-proof pass still fails on a code with no test (the guard can actually fail)', () => {
    // A guard nobody has watched fail is a guard nobody knows works.
    const { uncovered } = checkFixtureProofInvariant(
      [...STATE_VALIDATE_CODES.map((code) => ({ code })), { code: 'S999' }],
      [STATE_VALIDATE_TEST_FILE],
      new Map(),
    );

    assert.deepEqual(uncovered, ['S999']);
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
