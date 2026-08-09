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
const { findPhaseIdRegexDrift, findBracketGrammarDrift, scanRepo } = require(
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
  // #2761 M3: the bracket project-code class and the two milestone-intro shapes
  // three readers used to re-type. Locked here so a consumer cannot re-export a
  // divergent copy of what it now imports.
  'BRACKET_PROJECT_CODE_SRC', 'bracketMilestoneIntroSrcFor',
  'BRACKET_MILESTONE_INTRO_CAPTURING_SRC',
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

// ─── #2761 M3: the BRACKET grammar rule ────────────────────────────────────
//
// trek-e's finding: the bracket grammar was re-typed in roadmap-parser, state
// and verify — a violation of #2761's own "no token literal outside
// src/phase-id.cts" gate — and `check:phase-id-drift` passed anyway, because
// its detector only knew the phase-NUMBER token. These are the guard's negative
// fixtures: the three literals AS THEY SHIPPED, transcribed here so the rule is
// proven against the real drift and not against a convenient stand-in.

describe('#2761 M3 bracket drift scanner: findBracketGrammarDrift (pure)', () => {
  const SHIPPED_DRIFT = [
    ['roadmap-parser.cts bracket-fallback selector',
      'const bracketMilestoneHeadingRe = new RegExp(`^\\\\[[A-Z][A-Z0-9_]*\\\\.${canonical}\\\\]`, \'i\');'],
    ['state.cts isMilestoneBounded',
      'const bracketMilestoneHeadingRe = new RegExp(`^\\\\[[A-Z][A-Z0-9_]*\\\\.${canonical}\\\\]`, \'i\');'],
    ['verify.cts checkBracketCoherence',
      'const bracketSectionRe = new RegExp(`^\\\\[[A-Z][A-Z0-9_]*\\\\.(${BRACKET_MILESTONE_NUMERIC_SRC})\\\\]`, \'i\');'],
  ];

  for (const [label, line] of SHIPPED_DRIFT) {
    test(`flags the literal that shipped in ${label}`, () => {
      const v = findBracketGrammarDrift(line);
      assert.equal(v.length, 1, `the guard must flag ${label}`);
      assert.equal(v[0].found, '[A-Z][A-Z0-9_]*');
    });
  }

  test('an owner reference on the SAME LINE does not excuse a re-typed class', () => {
    // The precise blind spot. verify.cts's copy referenced the owner for the
    // MILESTONE field while re-typing the PROJECT-CODE class, so a line-level
    // "mentions the owner, therefore clean" escape — which the phase-token rule
    // does carry — would wave the reported site straight through. Partial
    // ownership is the drift.
    assert.equal(
      findBracketGrammarDrift(
        'new RegExp(`[A-Z][A-Z0-9_]*\\\\.(${BRACKET_MILESTONE_NUMERIC_SRC})`)',
      ).length,
      1,
    );
  });

  test('the case-widened rewrite does not evade the rule', () => {
    assert.equal(findBracketGrammarDrift('/^\\\\[[A-Za-z][A-Za-z0-9_]*\\\\./').length, 1);
  });

  test('a dedicated phase-id-owner comment sanctions the site', () => {
    assert.deepEqual(
      findBracketGrammarDrift('  // phase-id-owner: deliberate\n  const re = /[A-Z][A-Z0-9_]*/;'),
      [],
    );
    // …but only as its own line, never trailing the code — same rule the
    // phase-token scanner enforces.
    assert.equal(
      findBracketGrammarDrift('const re = /[A-Z][A-Z0-9_]*/; // phase-id-owner: not honored here').length,
      1,
    );
  });

  test('the spellings that replaced the drift are clean', () => {
    for (const line of [
      'const re = new RegExp(`^${bracketMilestoneIntroSrcFor(milestoneInt)}`, \'i\');',
      'const re = new RegExp(`^${BRACKET_MILESTONE_INTRO_CAPTURING_SRC}`, \'i\');',
      'const re = new RegExp(`^\\\\[(${BRACKET_ID_SRC})\\\\]`, \'i\');',
    ]) {
      assert.deepEqual(findBracketGrammarDrift(line), [], line);
    }
  });

  test('reports the 1-indexed line', () => {
    assert.equal(findBracketGrammarDrift('a\nconst re = /[A-Z][A-Z0-9_]*/;\nc')[0].line, 2);
  });
});

// ─── #2761 M3: parity between the owner and what the call sites spelled ─────

describe('#2761 M3 bracket grammar: one owner, byte-identical to the sites it replaced', () => {
  // Transcribed by hand from the pre-fix sources, NOT assembled from the
  // constants under test — comparing the owner against something built from the
  // owner would restate the implementation and pass whatever either side said.
  // Byte-equality with an independent transcription is the whole proof.
  const PRE_FIX = {
    // roadmap-parser.cts and state.cts, character-identical to each other, with
    // `canonical` = String(milestoneInt).padStart(2, '0').
    pinned: (canonical) => `\\[[A-Z][A-Z0-9_]*\\.${canonical}\\]`,
    // verify.cts, with the milestone field captured.
    capturing: (numericSrc) => `\\[[A-Z][A-Z0-9_]*\\.(${numericSrc})\\]`,
  };

  test('bracketMilestoneIntroSrcFor reproduces both re-typed pinned copies', () => {
    for (const milestone of [0, 1, 2, 9, 10, 99, 100, 999]) {
      assert.equal(
        phaseId.bracketMilestoneIntroSrcFor(milestone),
        PRE_FIX.pinned(String(milestone).padStart(2, '0')),
        `milestone ${milestone}`,
      );
    }
  });

  test('BRACKET_MILESTONE_INTRO_CAPTURING_SRC reproduces the verify copy', () => {
    assert.equal(
      phaseId.BRACKET_MILESTONE_INTRO_CAPTURING_SRC,
      PRE_FIX.capturing(phaseId.BRACKET_MILESTONE_NUMERIC_SRC),
    );
  });

  test('the owner also composes BRACKET_ID_SRC, so the two cannot drift apart', () => {
    assert.ok(
      phaseId.BRACKET_ID_SRC.startsWith(phaseId.BRACKET_PROJECT_CODE_SRC),
      'BRACKET_ID_SRC must be built from BRACKET_PROJECT_CODE_SRC',
    );
    assert.equal(phaseId.BRACKET_PROJECT_CODE_SRC, '[A-Z][A-Z0-9_]*');
  });

  test('the pinned builder owns the pad2 rule, not just the grammar', () => {
    // "Canonical spelling only, not `0*N`" was restated beside each re-typed
    // regex. An unpadded `[GSD.2]` scopes a milestone no phase heading resolves
    // into, which is how total_phases fell back to the on-disk count.
    const re = new RegExp(`^${phaseId.bracketMilestoneIntroSrcFor(2)}`, 'i');
    assert.ok(re.test('[GSD.02] Foundation'), 'canonical pad2 spelling matches');
    assert.ok(!re.test('[GSD.2] Foundation'), 'unpadded is malformed');
    assert.ok(!re.test('[GSD.002] Foundation'), 'over-padded is malformed');
    assert.ok(re.test('[gsd.02] Foundation'), 'recognition is case-insensitive at the reader');
  });

  test('the capturing shape puts the milestone digits in group 1', () => {
    const re = new RegExp(`^${phaseId.BRACKET_MILESTONE_INTRO_CAPTURING_SRC}`, 'i');
    assert.equal('[GSD.02] Foundation'.match(re)[1], '02');
    assert.equal('[A_B9.100] Later'.match(re)[1], '100');
    assert.equal('[GSD.2] Foundation'.match(re), null, 'unpadded is not a milestone intro');
  });
});

describe('#2128 phase-id drift scanner: the live repo is clean', () => {
  test('scanRepo finds zero unsanctioned re-derivations (token AND bracket)', () => {
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'unsanctioned re-derivation(s) — build from the phase-id.cjs owner or add // phase-id-owner:\n' +
        violations.map((d) => `  [${d.kind}] ${d.file}:${d.line} ${d.found}`).join('\n'),
    );
  });

  test('scanRepo actually runs the bracket rule (coverage, not just a clean result)', () => {
    // A clean scan is also what a scanner that forgot to call the bracket rule
    // returns. Plant the shipped verify.cts literal into a temp tree and require
    // the scan to fail on it — the same end-to-end path `check:phase-id-drift`
    // takes, proving the rule is wired into scanRepo and not merely exported.
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-id-drift-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'src', 'planted.cts'),
        'const bracketSectionRe = new RegExp(`^\\\\[[A-Z][A-Z0-9_]*\\\\.(${BRACKET_MILESTONE_NUMERIC_SRC})\\\\]`, \'i\');\n',
      );
      const found = scanRepo(tmp);
      assert.equal(found.length, 1, 'scanRepo must report the planted bracket literal');
      assert.equal(found[0].kind, 'bracket');
      assert.equal(found[0].file, path.join('src', 'planted.cts'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
