'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Anti-divergence guard for the phase-identifier parsing seam
 * (epic #2121 Phase 4 / issue #2128, ADR-2121 Decision 7).
 *
 * `src/phase-id.cts` is the single canonical owner of phase-ID parsing. Two guards
 * keep it that way:
 *   1. DRIFT SCANNER (scripts/lint-phase-id-drift.cjs) — fails CI if any module
 *      outside phase-id.cts re-derives the canonical phase-number token as a
 *      literal without a `// phase-id-owner:` sanction.
 *   2. IDENTITY guard — phase-id.cjs exports the complete locked surface, and no
 *      consumer re-exports a DIVERGENT copy of a canonical function (re-export,
 *      never re-implement).
 *
 * Behavioral throughout: assertions drive `findPhaseIdRegexDrift` / `scanRepo`
 * and compare object identity — no `readFileSync().includes()` in a test body.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findPhaseIdRegexDrift, scanRepo } = require(
  path.join(ROOT, 'scripts', 'lint-phase-id-drift.cjs'),
);
const phaseId = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'phase-id.cjs'));

// The locked canonical surface (ADR-2121 Decision 1/2; PHASE_NUMBER_TOKEN_SOURCE
// added in Phase 4). Every name is exported by phase-id.cjs; the identity guard
// forbids any other module from re-exporting a divergent copy of one.
const CANONICAL = [
  'escapeRegex', 'OPTIONAL_PROJECT_CODE_PREFIX_SOURCE', 'OPTIONAL_PHASE_TAG_SOURCE',
  'PHASE_NUMBER_TOKEN_SOURCE', 'stripProjectCodePrefix', 'normalizePhaseName',
  'getMilestoneFromPhaseId', 'getPhaseDirFromPhaseId', 'phaseMarkdownRegexSource',
  'phaseMarkdownRegexSourceExact', 'comparePhaseNum', 'extractPhaseToken',
  'phaseTokenMatches', 'parsePhaseFromProse', 'stripConfiguredProjectCodePrefix',
  'isForeignPrefixedPhaseQuery', 'roadmapPhaseLookupSources',
  // #612 PR-2: the one bracket identity grammar + the gated heading-intro selector.
  'BRACKET_ID_SRC', 'BRACKET_MILESTONE_NUMERIC_SRC', 'BRACKET_DIR_PREFIX_SRC',
  'BASE_ANY_BRACKET_HEADING_PREFIX_SRC', 'BASE_PHASE_LABEL_PREFIX_SRC',
  'PHASE_HEADING_BASELINE', 'phaseHeadingPrefixSrcFor', 'foldBracketId',
  'bracketQualifiedKey',
];

describe('#2128 phase-id drift scanner: findPhaseIdRegexDrift (pure)', () => {
  test('a regex built from PHASE_NUMBER_TOKEN_SOURCE is NOT drift', () => {
    assert.deepEqual(
      findPhaseIdRegexDrift('const re = new RegExp(`Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`);'),
      [],
    );
  });

  test('a literal re-derivation of the canonical token IS flagged (fail-first)', () => {
    const v = findPhaseIdRegexDrift('const re = /Phase\\s+(\\d+[A-Z]?(?:\\.\\d+)*)/;');
    assert.equal(v.length, 1);
    assert.equal(v[0].found, '\\d+[A-Z]?(?:\\.\\d+)*');
  });

  test('a re-derivation inside a new RegExp template (\\\\d escaping) IS flagged', () => {
    const v = findPhaseIdRegexDrift('new RegExp(`Phase\\\\s+(\\\\d+[A-Z]?(?:\\\\.\\\\d+)*)`)');
    assert.equal(v.length, 1);
  });

  test('the [A-Za-z], [.-] and [0-9] near-variants ARE flagged (no trivial evasion)', () => {
    assert.equal(findPhaseIdRegexDrift('/(\\d+[A-Za-z]?(?:\\.\\d+)*)/').length, 1, '[A-Za-z] letter class');
    assert.equal(findPhaseIdRegexDrift('/(\\d+[A-Z]?(?:[.-]\\d+)*)/').length, 1, '[.-] separator');
    assert.equal(findPhaseIdRegexDrift('/([0-9]+[A-Z]?(?:\\.[0-9]+)*)/').length, 1, '[0-9] in place of \\d');
  });

  test('a dedicated preceding // phase-id-owner: comment line suppresses the flag', () => {
    assert.deepEqual(
      findPhaseIdRegexDrift('  // phase-id-owner: sanctioned exception\n  const re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;'),
      [],
    );
  });

  test('a blank line between the // phase-id-owner: comment and the regex still suppresses', () => {
    assert.deepEqual(
      findPhaseIdRegexDrift('  // phase-id-owner: sanctioned exception\n\n  const re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;'),
      [],
    );
  });

  test('a trailing same-line // phase-id-owner: is NOT a sanction (must be a dedicated line above)', () => {
    // The marker must lead its own comment line; a trailing comment on a code
    // line is not honored, so the regex is still flagged.
    const v = findPhaseIdRegexDrift('const re = /(\\d+[A-Z]?(?:\\.\\d+)*)/; // phase-id-owner: not honored here');
    assert.equal(v.length, 1);
  });

  test('a // phase-id-owner: embedded in a STRING literal does NOT suppress (decoy)', () => {
    // A `//` inside a string is not a comment — help/doc text that quotes the
    // sanction syntax must not silently suppress a real re-derivation.
    const decoyLine = findPhaseIdRegexDrift('const help = "use // phase-id-owner: <reason>"; const re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;');
    assert.equal(decoyLine.length, 1);
    const decoyPrev = findPhaseIdRegexDrift('const help = "use // phase-id-owner: <reason>";\nconst re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;');
    assert.equal(decoyPrev.length, 1);
  });

  test('a bare "phase-id-owner:" substring with no // does NOT suppress', () => {
    const v = findPhaseIdRegexDrift('const msg = "ping the phase-id-owner for review"; const re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;');
    assert.equal(v.length, 1);
  });

  test('non-token phase regexes are NOT flagged (no false positives)', () => {
    assert.deepEqual(findPhaseIdRegexDrift('/^Executing Phase\\s+\\d+/'), [], 'status-message bare \\d+');
    assert.deepEqual(findPhaseIdRegexDrift('/#{2,4}\\s*Phase\\s+(\\d+)[A-Z]?(?:\\.\\d+)*/'), [], 'digits-only capture is non-contiguous');
    assert.deepEqual(findPhaseIdRegexDrift('/Phase\\s+([\\w][\\w.-]*)/'), [], '\\w id grammar is not the canonical token');
    assert.deepEqual(findPhaseIdRegexDrift('/\\|\\s*Phase\\s*\\|\\s*Plans\\s*\\|/'), [], 'pipe-table structure');
  });

  test('reports 1-based line numbers', () => {
    const v = findPhaseIdRegexDrift('line1\nconst re = /(\\d+[A-Z]?(?:\\.\\d+)*)/;\nline3');
    assert.equal(v[0].line, 2);
  });
});

describe('#2128 phase-id drift scanner: the live repo is clean', () => {
  test('scanRepo finds zero unsanctioned phase-token re-derivations', () => {
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'unsanctioned phase-token re-derivation(s) — build from PHASE_NUMBER_TOKEN_SOURCE or add // phase-id-owner:\n' +
        violations.map((d) => `  ${d.file}:${d.line} ${d.found}`).join('\n'),
    );
  });
});

describe('#2128 phase-id single-owner identity guard', () => {
  test('phase-id.cjs exports the complete locked canonical surface', () => {
    for (const name of CANONICAL) {
      assert.ok(name in phaseId, `phase-id.cjs must export the canonical member '${name}'`);
    }
  });

  test('no consumer module re-exports a DIVERGENT copy of a canonical phase-id function', () => {
    // Forward guard: if any built lib module re-exports a name that phase-id.cjs
    // owns, it MUST be the identical reference — a re-export, never a local
    // re-implementation. All consumers pass today (none re-export); the guard
    // fails the moment a divergent copy ships.
    const libDir = path.join(ROOT, 'gsd-core', 'bin', 'lib');
    const consumers = fs.readdirSync(libDir).filter((f) => f.endsWith('.cjs') && f !== 'phase-id.cjs');
    let checked = 0;
    const requireFailures = [];
    for (const f of consumers) {
      let mod;
      try {
        mod = require(path.join(libDir, f));
      } catch (e) {
        // Surfaced, not silently skipped — a module that cannot be required
        // would otherwise erode the guard's coverage without any signal.
        requireFailures.push(`${f}: ${e.message}`);
        continue;
      }
      if (!mod || typeof mod !== 'object') continue; // bare-function exports carry no named canonical member
      checked++;
      for (const name of CANONICAL) {
        if (Object.prototype.hasOwnProperty.call(mod, name)) {
          assert.strictEqual(
            mod[name],
            phaseId[name],
            `${f} re-exports '${name}' but it is NOT the phase-id.cjs reference — re-export the canonical, do not re-implement`,
          );
        }
      }
    }
    assert.deepEqual(requireFailures, [], `consumer module(s) failed to require (guard coverage would silently degrade):\n  ${requireFailures.join('\n  ')}`);
    // Coverage floor: the vast majority of the ~150 built lib modules export an
    // object and must actually be inspected — not a token "at least one".
    assert.ok(checked > consumers.length * 0.75, `expected to inspect most of the ${consumers.length} consumer modules, only inspected ${checked}`);
  });
});
