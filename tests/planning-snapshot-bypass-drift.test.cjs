/**
 * Tests for the planning-snapshot bypass drift guard (Phase 10, issue #3308,
 * ADR-3180 §8.1 rule 2) — `scripts/lint-planning-snapshot-bypass-drift.cjs`.
 *
 * ADR-3180 §8.1 rule 2: a diagnostic rule may see only PARSED values from
 * `src/planning-snapshot.cts`, never raw `.planning/` document text.
 * `cmdValidateHealth` (`src/verify.cts`) is the one diagnostic-rule-shaped
 * function in the repo today that has NOT yet been migrated onto the
 * snapshot (Phase 11, issue #3309) — this guard tracks that acknowledged
 * debt via a shrink-only ratchet baseline, keyed function-scoped through
 * `DIAGNOSTIC_RULE_FUNCTIONS` (mirroring
 * `lint-completion-ratio-drift.cjs`'s `FUNCTION_SCOPED_EXEMPTIONS`, inverted:
 * this registry names which functions the rule APPLIES TO, not which are
 * exempt from it).
 *
 * NOTE: `scripts/lint-planning-snapshot-bypass-drift.cjs` does not exist yet
 * (Phase 10 is TDD — this test file is written first and is expected to fail
 * with a require/MODULE_NOT_FOUND error until the guard script lands). This
 * mirrors `tests/planning-prompt-drift.test.cjs`'s structure and asserts
 * only the guard's PURE functions, driven with in-memory strings/objects —
 * no shelling out to the CLI.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const drift = require('../scripts/lint-planning-snapshot-bypass-drift.cjs');
const {
  findSnapshotBypassDrift,
  diffAgainstBaseline,
  writeBaseline,
  dedupeViolationsForBaseline,
  sortEntries,
  DIAGNOSTIC_RULE_FUNCTIONS,
} = drift;
const { createTempDir, cleanup } = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');

const REGISTERED_FILE = path.join('src', 'verify.cts');
// The guard's OWN output (found/file fields, baseline entries) is always
// POSIX-normalized via toPosixRel, regardless of the separator form its
// `relPath` input used — comparing against the platform-native
// REGISTERED_FILE is correct for the guard's INPUT (the DIAGNOSTIC_RULE_FUNCTIONS
// Map key is also path.join-constructed, so an exact Map.has() lookup needs
// this form) but wrong for anything the guard PRODUCED, which this constant
// is for.
const REGISTERED_FILE_POSIX = REGISTERED_FILE.replace(/\\/g, '/');
const REGISTERED_FN = 'cmdValidateHealth';

// A minimal fixture carrying one registered diagnostic-rule-shaped function
// (containing a raw-read primitive) and one unregistered function (carrying
// the identical raw-read line) — proves detection is function-SCOPED, not
// whole-file.
function fixtureSource() {
  return [
    'function cmdValidateHealth(cwd) {',
    '  const raw = platformReadSync(x);',
    '  return raw;',
    '}',
    '',
    'function cmdUnrelated(cwd) {',
    '  const raw = platformReadSync(x);',
    '  return raw;',
    '}',
    '',
  ].join('\n');
}

// ─── G1/G3: registered-function raw-read line, baseline mechanics ────────

describe('findSnapshotBypassDrift — G1/G3: registered function raw-read detection', () => {
  test('a raw-read line inside a DIAGNOSTIC_RULE_FUNCTIONS-registered function is detected', () => {
    const out = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    // Exactly ONE violation: the registered cmdValidateHealth copy, not the
    // unregistered cmdUnrelated copy (see G2 below for the direct negative).
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].found, 'platformReadSync(');
    assert.strictEqual(out[0].text, 'const raw = platformReadSync(x);');
    assert.strictEqual(out[0].file, REGISTERED_FILE_POSIX);
  });

  test('G1: a registered-function violation present in the baseline is KNOWN — neither fresh nor stale', () => {
    const violations = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    const baseline = [{ file: REGISTERED_FILE_POSIX, text: 'const raw = platformReadSync(x);' }];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });

  test('G3: a registered-function violation NOT in the baseline is reported under fresh', () => {
    const violations = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    const { fresh, stale } = diffAgainstBaseline(violations, []);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].text, 'const raw = platformReadSync(x);');
    assert.deepStrictEqual(stale, []);
  });
});

// ─── G2: function-scoped, not whole-file ──────────────────────────────────

describe('findSnapshotBypassDrift — G2: function-scoped detection (not whole-file)', () => {
  test('the identical raw-read line inside an UNREGISTERED function produces no violation for that line', () => {
    const out = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    const unregisteredLines = out.filter((v) => v.line === 7);
    assert.deepStrictEqual(unregisteredLines, [], 'cmdUnrelated (line 7) must not be flagged — it is not in DIAGNOSTIC_RULE_FUNCTIONS');
  });

  test('a registered function name in a file NOT listed in DIAGNOSTIC_RULE_FUNCTIONS is never flagged', () => {
    const out = findSnapshotBypassDrift(fixtureSource(), path.join('src', 'other-file.cts'));
    assert.deepStrictEqual(out, []);
  });

  test('DIAGNOSTIC_RULE_FUNCTIONS registers exactly src/verify.cts -> cmdValidateHealth today', () => {
    assert.ok(DIAGNOSTIC_RULE_FUNCTIONS.has(REGISTERED_FILE));
    assert.ok(DIAGNOSTIC_RULE_FUNCTIONS.get(REGISTERED_FILE).has(REGISTERED_FN));
  });
});

// ─── G4: stale ratchet entries ─────────────────────────────────────────────

describe('diffAgainstBaseline — G4: stale entries', () => {
  test('a baseline entry whose (file, text) pair no longer appears in a fresh scan is reported under stale', () => {
    const baseline = [{ file: REGISTERED_FILE_POSIX, text: 'const raw = platformReadSync(oldSite);' }];
    const violations = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    // The baseline's own (unmatched) entry is stale...
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].text, 'const raw = platformReadSync(oldSite);');
    // ...and the fixture's real, unacknowledged violation is separately fresh.
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].text, 'const raw = platformReadSync(x);');
  });
});

// ─── G5: writeBaseline / dedupeViolationsForBaseline regeneration ────────

describe('writeBaseline / dedupeViolationsForBaseline — G5: regeneration matches a fresh detection pass', () => {
  test('dedupeViolationsForBaseline collapses violations into sorted, deduped baseline rows matching the detection pass', () => {
    const violations = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    const deduped = dedupeViolationsForBaseline(violations);
    const sorted = sortEntries(deduped);
    assert.strictEqual(sorted.length, 1);
    assert.strictEqual(sorted[0].file, REGISTERED_FILE_POSIX);
    assert.strictEqual(sorted[0].text, 'const raw = platformReadSync(x);');
    assert.strictEqual(sorted[0].count, 1);
    // A freshly-written baseline must itself be immediately KNOWN (not
    // fresh/stale) against the SAME detection pass — the round-trip
    // invariant a ratchet baseline exists to guarantee.
    const { fresh, stale } = diffAgainstBaseline(violations, sorted);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });

  test('writeBaseline persists entries to disk that exactly match a fresh scanRepo/detection pass', (t) => {
    const root = createTempDir('gsd-planning-snapshot-bypass-drift-');
    t.after(() => cleanup(root));
    const violations = findSnapshotBypassDrift(fixtureSource(), REGISTERED_FILE);
    writeBaseline(root, violations);
    const writtenPath = path.join(root, 'scripts', 'baselines', 'planning-snapshot-bypass-baseline.json');
    const written = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
    assert.strictEqual(written.entries.length, 1);
    assert.strictEqual(written.entries[0].file, REGISTERED_FILE_POSIX);
    assert.strictEqual(written.entries[0].text, 'const raw = platformReadSync(x);');
    assert.strictEqual(written.entries[0].count, 1);
    // The written baseline immediately reconciles with the pass that produced
    // it — no fresh, no stale.
    const { fresh, stale } = diffAgainstBaseline(violations, written.entries);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
    // The baseline names its owner issue (#3309, Phase 11) and ADR §8.1, not
    // #3218 (the sibling prompt-drift guard's owner issue).
    assert.match(written.$comment, /#3309/);
    assert.doesNotMatch(written.$comment, /#3218/);
    assert.strictEqual(written.entries[0].owner_issue, '#3309');
  });
});

// ─── G6: owner functions (ADR-3180 §7) are never flagged ─────────────────

describe('findSnapshotBypassDrift — G6: ADR-3180 §7 owner-function calls never match the raw-read primitive regex', () => {
  test('a call to an ADR-3180 §7 owner (getMilestoneInfo) inside a registered function is never flagged', () => {
    const source = [
      'function cmdValidateHealth(cwd) {',
      '  const info = getMilestoneInfo(cwd);',
      '  return info;',
      '}',
      '',
    ].join('\n');
    const out = findSnapshotBypassDrift(source, REGISTERED_FILE);
    assert.deepStrictEqual(out, [], 'getMilestoneInfo(cwd) must not match platformReadSync(/readFileSync(/readdirSync(');
  });

  test('other ADR-3180 §7 owner calls (listMilestonePhaseDirs, isPhaseComplete, scanPhasePlans, stateFieldValue) also never match', () => {
    const source = [
      'function cmdValidateHealth(cwd) {',
      '  const dirs = listMilestonePhaseDirs(phasesDir, opts);',
      '  const done = isPhaseComplete(phaseDir, deps);',
      '  const scan = scanPhasePlans(phaseDir);',
      "  const label = stateFieldValue(fm, body, null, 'Phase', opts);",
      '  return { dirs, done, scan, label };',
      '}',
      '',
    ].join('\n');
    const out = findSnapshotBypassDrift(source, REGISTERED_FILE);
    assert.deepStrictEqual(out, []);
  });
});
