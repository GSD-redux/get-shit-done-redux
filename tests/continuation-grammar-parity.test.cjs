'use strict';
/**
 * continuation-grammar-parity.test.cjs — DEFECT.GENERATIVE-FIX parity gate (#2232)
 *
 * Proves that the phase-token CONTINUATION-segment grammar has a single owner
 * (`phase-id.cjs: PHASE_CONTINUATION_SEGMENT_SOURCE` / `isPhaseContinuationSegment`)
 * and that every consuming surface agrees with it on a shared digit-width corpus.
 *
 * Why this gate exists: #2043 fixed the same class of bug by hand-editing five
 * independent `/^\d{2,}/` copies; #2232 is the residual that survived because a
 * later reader could not tell the five copies were one rule. The rule is now
 * single-sourced, but a regex literal is easy to re-introduce and
 * `scripts/lint-phase-id-drift.cjs` only guards the OTHER constant
 * (`PHASE_NUMBER_TOKEN_SOURCE`) — a bare `\d{2,}` re-derivation would pass lint
 * and CI silently. This test is the behavioral backstop: it fails the moment any
 * consuming surface disagrees with the owner about which continuation widths are
 * absorbed.
 *
 * Contract: for every digit-width in the corpus, each surface's notion of
 * "is this segment absorbed as a continuation?" MUST equal
 * `isPhaseContinuationSegment(segment)`.
 *
 * Surfaces covered (the five #2043 sites, plus the #612 bracket read path):
 *   1. phase-id.cjs      extractPhaseToken
 *   2. validate.cjs      PHASE_TOKEN_FROM_DIR_RE
 *   3. validate.cjs      canonicalPlanStem
 *   4. core-utils.cjs    extractCanonicalPlanId (paired plan component)
 *   5. roadmap-parser.cjs getMilestonePhaseFilter → isDirInMilestone (hyphenated mode)
 *   6. phase-id.cjs      BRACKET_PHASE_TOKEN_SOURCE (slug-adjacent position only —
 *                        see the divergence block at the foot of this file)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const validate = require('../gsd-core/bin/lib/validate.cjs');
const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { getMilestonePhaseFilter } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

// The shared digit-width corpus. `absorbed` is stated independently of the
// implementation (it is the LOCKED POLICY, not a mirror of the regex): a
// continuation is exactly the 2-digit zero-padded form getPhaseDirFromPhaseId
// emits. 1-digit is a slug word (#2043); ≥3-digit is a slug word (#2232 — a
// year/count/version).
const WIDTH_CORPUS = [
  { width: 1, seg: '6', absorbed: false, note: '#2043 single-digit slug word' },
  { width: 2, seg: '02', absorbed: true, note: 'the zero-padded sub-phase — the cap' },
  { width: 3, seg: '100', absorbed: false, note: '#2232 limit+1 (policy: ≥100 out of grammar)' },
  { width: 4, seg: '2026', absorbed: false, note: '#2232 the reported case (a year)' },
  { width: 5, seg: '12345', absorbed: false, note: '#2232 far side of the cap' },
];

describe('#2232 continuation-grammar parity — owner vs. corpus', () => {
  test('the owner (isPhaseContinuationSegment) matches the locked policy', () => {
    for (const { seg, absorbed, note } of WIDTH_CORPUS) {
      assert.strictEqual(
        phaseId.isPhaseContinuationSegment(seg),
        absorbed,
        `isPhaseContinuationSegment(${JSON.stringify(seg)}) must be ${absorbed} — ${note}`,
      );
    }
  });

  test('PHASE_CONTINUATION_SEGMENT_SOURCE is exported and is the exactly-2 grammar', () => {
    assert.strictEqual(typeof phaseId.PHASE_CONTINUATION_SEGMENT_SOURCE, 'string');
    // Anchored at both ends so a consuming site can embed it verbatim.
    const re = new RegExp(`^${phaseId.PHASE_CONTINUATION_SEGMENT_SOURCE}$`);
    assert.ok(re.test('02'), 'the 2-digit form must match');
    assert.ok(!re.test('2026'), 'a 4-digit run must not match');
    assert.ok(!re.test('6'), 'a 1-digit run must not match');
    assert.ok(!re.test('10x'), 'a digit-plus-letter slug word must not match');
  });
});

describe('#2232 continuation-grammar parity — every consuming surface agrees', () => {
  for (const { seg, absorbed, note } of WIDTH_CORPUS) {
    test(`width ${seg.length} (${JSON.stringify(seg)}): all surfaces agree absorbed=${absorbed} — ${note}`, () => {
      const owner = phaseId.isPhaseContinuationSegment(seg);
      assert.strictEqual(owner, absorbed, 'precondition: owner matches policy');

      // ── Surface 1: extractPhaseToken ────────────────────────────────────
      const dir = `14-${seg}-photos-performance`;
      assert.strictEqual(
        phaseId.extractPhaseToken(dir) === `14-${seg}`,
        owner,
        `extractPhaseToken(${JSON.stringify(dir)}) diverged from the owner`,
      );

      // ── Surface 2: validate PHASE_TOKEN_FROM_DIR_RE ─────────────────────
      const reToken = validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1];
      assert.strictEqual(
        reToken === `14-${seg}`,
        owner,
        `PHASE_TOKEN_FROM_DIR_RE on ${JSON.stringify(dir)} gave ${JSON.stringify(reToken)} — diverged from the owner`,
      );

      // ── Surface 3: validate canonicalPlanStem ───────────────────────────
      const stem = `14-${seg}-photos-performance`;
      assert.strictEqual(
        validate.canonicalPlanStem(stem) === `14-${seg}`,
        owner,
        `canonicalPlanStem(${JSON.stringify(stem)}) diverged from the owner`,
      );

      // ── Surface 4: core-utils extractCanonicalPlanId (paired component) ──
      const planFile = `14-${seg}-photos-performance-PLAN.md`;
      assert.strictEqual(
        coreUtils.extractCanonicalPlanId(planFile) === `14-${seg}`,
        owner,
        `extractCanonicalPlanId(${JSON.stringify(planFile)}) diverged from the owner`,
      );

      // ── Surface 6: #612 BRACKET_PHASE_TOKEN_SOURCE (slug-adjacent position) ──
      // The bracket run is MM-PP[.SS][-LL]; `-LL` is the only position a slug
      // word can collide with, so it is the position #2232 owns. Same shape as
      // surface 1 with the bracket's extra milestone level: `01-14-<seg>-slug…`
      // puts <seg> at dash-2, exactly where a year over-collected before.
      const bracketDir = `01-14-${seg}-photos-performance`;
      const bracketToken = bracketDir.match(new RegExp(phaseId.BRACKET_PHASE_TOKEN_SOURCE))?.[0];
      assert.strictEqual(
        bracketToken === `01-14-${seg}`,
        owner,
        `BRACKET_PHASE_TOKEN_SOURCE on ${JSON.stringify(bracketDir)} collected ` +
          `${JSON.stringify(bracketToken)} — diverged from the owner at the slug-adjacent position`,
      );
    });
  }

  test('#2528: regex token extraction agrees on the literal reading at slug boundaries', () => {
    const cases = [
      // The reported shape and its indistinguishable twin read IDENTICALLY: no
      // surface may guess which of the two a `NN-NN-<digit>-…` name is, because
      // nothing in the name says. Phase 10 named "24/7 Autonomy" is reached by
      // the resolution-layer fallback (see phase-id.test.cjs), NOT by the
      // tokenizer re-reading its name.
      ['10-24-7-autonomy', '10-24'],
      ['10-24-7-zip', '10-24'],
      ['05-80-20-25abc', '05-80-20'],
      ['14-06-2026-photos-and-performance', '14-06'],
      ['14-10x-growth', '14'],
    ];
    for (const [dir, expected] of cases) {
      assert.strictEqual(phaseId.extractPhaseToken(dir), expected);
      assert.strictEqual(
        validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1],
        expected,
        `PHASE_TOKEN_FROM_DIR_RE diverged from extractPhaseToken for ${dir}`,
      );
    }
  });

  test('#2528: a one-digit terminator does not re-tokenize the name on any non-I/O surface', () => {
    // Every surface below is QUERY-LESS — it sees a name and nothing else — so
    // none of them may resolve the "24 is a sub-phase" / "24 is a slug word"
    // ambiguity. They agree on the literal reading, and the disambiguation is
    // left to matchPhaseDirs, which does have a query.
    for (const dir of ['10-24-7-autonomy', '10-24-7-zip']) {
      assert.strictEqual(phaseId.extractPhaseToken(dir), '10-24');
      assert.strictEqual(validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1], '10-24');
      assert.strictEqual(validate.canonicalPlanStem(dir), '10-24');
      assert.strictEqual(
        coreUtils.extractCanonicalPlanId(`${dir}-PLAN.md`),
        '10-24',
      );
    }

    const bracketDir = '01-10-24-7-autonomy';
    assert.strictEqual(
      bracketDir.match(new RegExp(phaseId.BRACKET_PHASE_TOKEN_SOURCE))?.[0],
      '01-10-24',
    );
  });

  test('letter-suffixed plan components and dotted sub-phases keep their established grammar', () => {
    assert.strictEqual(phaseId.isPhaseContinuationSegment('01A'), true);
    assert.strictEqual(validate.PHASE_TOKEN_FROM_DIR_RE.exec('10-01A-auth')?.[1], '10-01A');
    assert.strictEqual(validate.canonicalPlanStem('10-01A-auth-setup'), '10-01');
    assert.strictEqual(
      coreUtils.extractCanonicalPlanId('10-01A-auth-setup-PLAN.md'),
      '10-01A',
    );
    assert.strictEqual(phaseId.extractPhaseToken('10-01.2-auth'), '10-01.2');
    assert.strictEqual(
      phaseId.phaseTokenMatches('10-01.2-auth', phaseId.normalizePhaseName('10')),
      false,
    );
  });

  test('#2528: digit-plus-letter slug words preserve owner/regex parity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 10, max: 99 }),
        fc.string({
          unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'),
          minLength: 1,
          maxLength: 8,
        }),
        (phase, digits, letters) => {
          const expected = String(phase).padStart(2, '0');
          const dir = `${expected}-${digits}${letters}-growth`;
          assert.strictEqual(phaseId.extractPhaseToken(dir), expected);
          assert.strictEqual(
            validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1],
            expected,
            `PHASE_TOKEN_FROM_DIR_RE diverged from extractPhaseToken for ${dir}`,
          );
        },
      ),
    );
  });

  test('property: prefixed deep tokens stay identical across imperative and regex readers', () => {
    const prefixArb = fc.constantFrom('', 'CK-', 'M1-', 'v2-', 'APP1-', 'APP_1-', 'phase-');
    const phaseArb = fc.integer({ min: 0, max: 999 }).map(String);
    const continuationArb = fc.array(
      fc.integer({ min: 0, max: 99 }).map((n) => String(n).padStart(2, '0')),
      { minLength: 2, maxLength: 5 },
    );

    fc.assert(
      fc.property(prefixArb, phaseArb, continuationArb, (prefix, phase, continuations) => {
        const token = `${prefix}${phase}-${continuations.join('-')}`;
        const dir = `${token}-feature`;
        assert.strictEqual(
          validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1],
          phaseId.extractPhaseToken(dir),
          `prefixed/deep grammar diverged for ${dir}`,
        );
        assert.strictEqual(phaseId.extractPhaseToken(dir), token);
      }),
    );
  });

  // #2528 re-review: the boundary the earlier revision of this fix had no
  // coverage for. `minLength: 1` is the case that matters — EXACTLY one genuine
  // sub-phase level followed by a slug that starts with a bare digit ("10-24-7-zip",
  // sub-phase 10.24 named "7-Zip Integration"). A tokenizer that treats a
  // one-digit terminator as evidence that the preceding continuation was a slug
  // word cannot see the difference between that and "10-24-7-autonomy" (phase 10
  // named "24/7 Autonomy") — so it silently makes the well-formed sub-phase
  // unresolvable by its own id. The token therefore keeps EVERY absorbed
  // continuation regardless of what terminates the scan, at one level and at five.
  test('property: a digit-leading slug never shortens the absorbed continuation run', () => {
    const prefixArb = fc.constantFrom('', 'CK-', 'M1-', 'v2-', 'APP1-', 'APP_1-', 'phase-');
    const phaseArb = fc.integer({ min: 0, max: 999 }).map(String);
    const continuationArb = fc.array(
      fc.integer({ min: 0, max: 99 }).map((n) => String(n).padStart(2, '0')),
      { minLength: 1, maxLength: 5 },
    );
    const terminatorArb = fc.integer({ min: 0, max: 9 }).map(String);

    fc.assert(
      fc.property(
        prefixArb,
        phaseArb,
        continuationArb,
        terminatorArb,
        (prefix, phase, continuations, terminator) => {
          const expected = `${prefix}${phase}-${continuations.join('-')}`;
          const dir = `${prefix}${phase}-${continuations.join('-')}-${terminator}-feature`;
          assert.strictEqual(phaseId.extractPhaseToken(dir), expected);
          assert.strictEqual(
            validate.PHASE_TOKEN_FROM_DIR_RE.exec(dir)?.[1],
            expected,
            `deep continuation grammar diverged for ${dir}`,
          );
          // …and the directory stays reachable by that very token.
          assert.deepStrictEqual(
            phaseId.matchPhaseDirs([dir], expected).matches,
            [dir],
            `${dir} became unresolvable by its own id ${expected}`,
          );
        },
      ),
    );
  });
});

// Surface 5 needs a real ROADMAP/STATE on disk, so it gets its own block.
describe('#2232 continuation-grammar parity — roadmap isDirInMilestone (hyphenated mode)', () => {
  let tmpDir;

  function writeProject(roadmapLines) {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.mkdirSync(planning, { recursive: true });
    fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nmilestone: v1.0\n---\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapLines.join('\n'));
    return tmpDir;
  }

  for (const { seg, absorbed, note } of WIDTH_CORPUS) {
    test(`width ${seg.length} (${JSON.stringify(seg)}): isDirInMilestone agrees — ${note}`, () => {
      // A hyphenated phase id in the roadmap switches the filter into the
      // hyphenated-mode regex — the branch #2043/#2232 both live in.
      writeProject([
        '## v1.0: Current',
        '### Phase 2-01: Alpha',
        '**Goal:** first alpha phase',
        '',
        '### Phase 14: 2026 Photos And Performance',
        '**Goal:** the year-leading slug case',
      ]);
      const filter = getMilestonePhaseFilter(tmpDir);

      // When the segment is NOT absorbed, the dir's token is "14" → matches
      // roadmap Phase 14. When it IS absorbed (width 2), the token is "14-02",
      // which the roadmap does not list → correctly excluded.
      assert.strictEqual(
        filter(`14-${seg}-photos-performance`),
        !absorbed,
        `isDirInMilestone("14-${seg}-photos-performance") diverged from the owner ` +
          `(absorbed=${absorbed} → token ${absorbed ? `"14-${seg}" (not in roadmap)` : '"14" (Phase 14)'})`,
      );

      // Control: the genuine milestone-prefixed dir always matches.
      assert.strictEqual(filter('02-01-alpha'), true, '02-01-alpha must match Phase 2-01');
      cleanup(tmpDir);
      tmpDir = null;
    });
  }

  // #2528 RESIDUAL, pinned rather than left to prose. This filter is one of the
  // query-less surfaces: it compares a directory's own token against the roadmap
  // set, and the #2232 contract above already fixes what happens when that token
  // is an absorbed continuation the roadmap does not list — the dir is excluded.
  // A phase named "24/7 Autonomy" produces exactly that shape, so it is excluded
  // for the same reason and by the same rule as the width-2 case above, and
  // identically to the "05-80-20-cleanup" shape this fix documents. Widening the
  // filter would contradict the #2232 pin one screen up; the bare-integer
  // fallback lives where a query exists (matchPhaseDirs), and every phase-verb
  // path that takes a phase number resolves this directory correctly — see
  // tests/phase-resolution-parity.test.cjs.
  test('#2528 residual: a digit-leading phase NAME is scoped by its literal token', () => {
    writeProject([
      '## v1.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** force hyphenated mode',
      '',
      '### Phase 10: Autonomy',
      '**Goal:** the 24/7 name',
    ]);
    const filter = getMilestonePhaseFilter(tmpDir);
    // Token "10-24" — not a roadmap id, so out of milestone scope…
    assert.strictEqual(filter('10-24-7-autonomy'), false);
    // …exactly like the other member of the family, and unlike the plain form.
    assert.strictEqual(filter('05-80-20-cleanup'), false);
    assert.strictEqual(filter('10-autonomy'), true);
    cleanup(tmpDir);
    tmpDir = null;
  });
});

// ─── #612: the DELIBERATE divergence, pinned ────────────────────────────────
// Surface 6 consumes the owner at the slug-adjacent position (above), but is
// deliberately WIDER at the other positions. That is a divergence, so per the
// Generative Fix Divergence rule it gets pinned here rather than left to a
// comment: if someone later "unifies" the bracket run onto the exactly-2 cap,
// or re-widens the slug-adjacent position back to `\d+`, one of these fails and
// points them at the rationale in phase-id.cts.
//
// The policy is stated independently of the regex: bracket's non-slug-adjacent
// positions are DELIMITER-disambiguated (a grammar-required field separator; a
// dot no slug can contain), not heuristically recognized, so they carry the
// canonical width toDir emits — while #2232's cap defends the one position that
// sits against a slug.
describe('#612 bracket divergence — wider only where the delimiter disambiguates', () => {
  const tokenOf = (s) => s.match(new RegExp(phaseId.BRACKET_PHASE_TOKEN_SOURCE))?.[0];

  test('the #2232 repro cannot reopen on the bracket path', () => {
    // The review's scenario: roadmap phase "2026 Photos & Performance" at
    // phase 14 → slug leads with a year. The token is the phase, not the year.
    assert.strictEqual(tokenOf('01-14-2026-photos-performance'), '01-14');
    assert.strictEqual(tokenOf('01-14.03-2026-photos-performance'), '01-14.03');
  });

  test('3+-digit phase and sub-phase — widths toDir emits — stay recognized', () => {
    // Both are rejected by a verbatim exactly-2 cap; both are canonical per
    // CANONICAL_NUMERIC_RE, so under-collecting them would break the read path
    // against ids the emit path produces.
    assert.strictEqual(tokenOf('02-105-slug'), '02-105', '3-digit phase (dash-1)');
    assert.strictEqual(tokenOf('05.100'), '05.100', '3-digit sub-phase (dot)');
    assert.strictEqual(tokenOf('01-2026-photos'), '01-2026', 'a 4-digit phase is unambiguous at dash-1');
  });

  test('the divergence is bounded: a PLAN >=100 is out of the grammar (#2232 policy verbatim)', () => {
    // The accepted trade-off. Stated as a test so it is a decision on record,
    // not an accident: the slug-adjacent position cannot be widened without
    // reopening the year collision.
    assert.strictEqual(tokenOf('02-05-100'), '02-05', 'a 3-digit plan is not absorbed');
    assert.strictEqual(tokenOf('02-05-01'), '02-05-01', 'a canonical 2-digit plan is absorbed');
  });

  test('an over-padded field is not canonical, so it is not collected', () => {
    // `014` matches neither canonical branch (leading zero + 3 digits), which is
    // what parsePhaseId rejects too — the read side under-collects rather than
    // inventing a field the parser would refuse.
    assert.strictEqual(tokenOf('01-014-slug'), '01');
  });
});
