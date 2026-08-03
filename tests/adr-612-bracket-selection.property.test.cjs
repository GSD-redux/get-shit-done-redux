'use strict';

/**
 * PR-2 (#2761 / epic #612) — generative properties for the SELECTION/TOLERANCE
 * layer.
 *
 * Scope, and why this is not a second copy of PR-1's grammar properties:
 * PR-1 (#2258) owns the bracket grammar itself — `parsePhaseId`/`renderPhaseId`/
 * `toDir` and their round-trip/bijection properties, which live in
 * tests/adr-612-bracket-grammar.test.cjs. PR-2 owns a different contract: WHICH
 * pattern each reader compiles, decided by the project's resolved
 * `phase_id_convention`. That contract is what this file generates against.
 *
 * Four properties, one per claim the PR actually makes:
 *   P1  a repo that OPTED IN reads ADR-canonical bracket headings/dirs; a repo
 *       that did not is byte-blind to exactly the same input.
 *   P2  under a non-bracket convention every selected reader agrees with the
 *       hand-transcribed BASE source on generated content — including hostile
 *       legacy content that merely LOOKS bracketed (`[RFC.2119] 5:`).
 *   P3  a mutated bracket token is not silently accepted; a case-varied one is
 *       accepted and FOLDS to the same key.
 *   P4  both sides of a phase comparison derive the same key under the same
 *       convention, and convention-less call sites are byte-identical.
 *
 * Generator discipline (the lessons #2258 rounds 1-2 were burned by, applied):
 *   - Every input is TEMPLATED FROM RAW PRIMITIVES. Nothing is seeded through
 *     `renderPhaseId`/`toDir`, so the generator's domain is not defined by the
 *     code under test — the `p2()` tautology that made round 1's property test
 *     structurally unable to find B1.
 *   - The generator domain is >= the code domain: the milestone/token
 *     arbitraries reach past 99 into the 3+-digit branch (round 2's
 *     `numArb`-capped-at-99 miss) and hit both sentinels (`00`, `999`).
 *   - Sub-phases are FORCED IN at high weight rather than left to chance
 *     (round 2's missing sub-phase mutation).
 *   - P3 is a NEGATIVE property: canonical input is mutated per-field and
 *     rejection is asserted. Deterministic boundary literals for the same
 *     region live alongside, in adr-612-bracket-heading-selection.test.cjs.
 *
 * Deterministic per CONTRIBUTING.md: seed and numRuns are pinned by
 * tests/helpers/fast-check-setup.cjs (seed 42, numRuns 200); set GSD_FC_SEED to
 * explore locally.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fc = require('./helpers/fast-check-setup.cjs');
const core = require('../gsd-core/bin/lib/phase-id.cjs');

const B = core.PHASE_HEADING_BASELINE;
const {
  phaseHeadingPrefixSrcFor,
  extractPhaseToken,
  phaseKeyFromDir,
  phaseKeyFromToken,
  bracketQualifiedKey,
  foldBracketId,
  isSentinelPhaseId,
  phaseTokenMatches,
} = core;

// ─── Base spellings, transcribed by hand (NOT read from the selector) ────────
// These are what each call site's regex contained before PR-2. P2 compares the
// selector's non-bracket output against these over GENERATED CONTENT, which is
// what makes it a property rather than a restatement of the 14-site structural
// identity test in adr-612-bracket-heading-selection.test.cjs.
const BASE_SRC = {
  [B.ANY_BRACKET]: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+',
  [B.LABEL_ONLY]: 'Phase\\s+',
};

const NON_BRACKET_CONVENTIONS = [null, undefined, 'milestone-prefixed', 'legacy', ''];

/**
 * Compile a reader the way the shipped call sites do. The leading group is the
 * markdown FURNITURE those sites carry (`#{2,4}\s*` on the heading scanners,
 * `[\s*_]*` plus a checkbox on the checklist scanners); without it every
 * generated line that looks like real ROADMAP content would fail to match on
 * BOTH sides and the differential property below would hold vacuously.
 */
const compile = introSrc =>
  new RegExp(
    `^(?:#{2,4}[ \t]*|[-*+][ \t]*\\[[ xX]\\][ \t]*)?[*_]*${introSrc}([\\w][\\w.-]*)\\s*:`,
    'i',
  );

const heading = (baseline, convention) => compile(phaseHeadingPrefixSrcFor(baseline, convention));

// ─── Generators: raw primitives, hand-templated ──────────────────────────────

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_TAIL = UPPER + '0123456789_';

/** `GSD`, `A`, `CK2`, `PROJ_X` — the emit grammar's project-code shape. */
const codeArb = fc
  .tuple(
    fc.constantFrom(...UPPER),
    fc.string({ unit: fc.constantFrom(...CODE_TAIL), maxLength: 5 }),
  )
  .map(([head, tail]) => head + tail);

/**
 * Milestone integers the bracket grammar admits: EXACTLY two digits, or three
 * or more with no leading zero. Deliberately reaches past 99 and pins both
 * sentinel milestones (`00` pre-milestone, `999` icebox).
 */
const milestoneArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 99 }).map(n => String(n).padStart(2, '0')), weight: 4 },
  { arbitrary: fc.integer({ min: 100, max: 99999 }).map(String), weight: 3 },
  { arbitrary: fc.constantFrom('00', '01', '99', '100', '101', '998', '999', '1000'), weight: 2 },
);

/** Phase tokens: 2-digit, 3+-digit, and sub-phases FORCED IN at high weight. */
const tokenArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 99 }).map(n => String(n).padStart(2, '0')), weight: 4 },
  { arbitrary: fc.integer({ min: 100, max: 9999 }).map(String), weight: 2 },
  {
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }))
      .map(([p, s]) => `${String(p).padStart(2, '0')}.${String(s).padStart(2, '0')}`),
    weight: 3,
  },
  { arbitrary: fc.constantFrom('00', '01', '99', '100', '999', '01.01', '100.100'), weight: 1 },
);

const nameArb = fc
  .string({ unit: fc.constantFrom(...(UPPER + 'abcdefghijklmnopqrstuvwxyz ')), minLength: 1, maxLength: 20 })
  .map(s => s.trim() || 'Name');

/** Markdown furniture the real call sites tolerate ahead of the intro. */
const furnitureArb = fc.constantFrom('', '## ', '### ', '#### ', '- [ ] ', '- [x] ', '- [x] **');

/** The ADR-canonical, LABEL-LESS bracket heading — the shape only opt-in reads. */
const bracketHeadingArb = fc
  .record({ code: codeArb, milestone: milestoneArb, token: tokenArb, name: nameArb, furniture: furnitureArb })
  .map(r => ({ ...r, text: `${r.furniture}[${r.code}.${r.milestone}] ${r.token}: ${r.name}` }));

/** The bracket DIRECTORY shape `{CODE}.{MM}-{PP}[.{SS}]-slug`. */
const bracketDirArb = fc
  .record({ code: codeArb, milestone: milestoneArb, token: tokenArb, slug: fc.constantFrom('alpha', 'beta-two', 'x', 'a-b-c') })
  .map(r => ({ ...r, dir: `${r.code}.${r.milestone}-${r.token}-${r.slug}` }));

// ─── P1 — the selection gate ─────────────────────────────────────────────────

describe('#612 PR-2 property: the convention selects, and only the convention', () => {
  test('P1a a label-less bracket heading is read IFF the convention is bracket', () => {
    fc.assert(
      fc.property(bracketHeadingArb, fc.constantFrom(B.ANY_BRACKET, B.LABEL_ONLY), (h, baseline) => {
        const opted = heading(baseline, 'bracket').exec(h.text);
        assert.ok(opted, `opted-in repo failed to read ${JSON.stringify(h.text)}`);
        assert.equal(opted[1], h.token, 'the captured token must be the phase token, not the bracket');

        for (const convention of NON_BRACKET_CONVENTIONS) {
          assert.equal(
            heading(baseline, convention).test(h.text),
            false,
            `convention ${JSON.stringify(convention)} must stay blind to ${JSON.stringify(h.text)}`,
          );
        }
      }),
    );
  });

  test('P1b a bracket DIRECTORY yields its phase token IFF the convention is bracket', () => {
    fc.assert(
      fc.property(bracketDirArb, d => {
        assert.equal(extractPhaseToken(d.dir, 'bracket'), d.token);
        for (const convention of NON_BRACKET_CONVENTIONS) {
          assert.notEqual(
            extractPhaseToken(d.dir, convention),
            d.token,
            `convention ${JSON.stringify(convention)} must not read ${JSON.stringify(d.dir)} as a bracket dir`,
          );
        }
      }),
    );
  });

  test('P1c the bracket MILESTONE carries the sentinel, independent of the token', () => {
    // READING-B: `### [GSD.999] 01:` is an icebox item even though its token is
    // an ordinary `01`. The token alone can never decide this.
    fc.assert(
      fc.property(bracketHeadingArb, h => {
        const milestoneInt = parseInt(h.milestone, 10);
        const expected = milestoneInt === 0 || milestoneInt === 999;
        assert.equal(
          isSentinelPhaseId(`${h.code}.${h.milestone}-${h.token}`, 'bracket'),
          expected,
          `milestone ${h.milestone} sentinel classification`,
        );
      }),
    );
  });
});

// ─── P2 — differential invariance for every non-bracket convention ───────────

/** Legacy and hostile-but-plausible legacy lines. No bracket phase headings. */
const legacyLineArb = fc.oneof(
  {
    arbitrary: fc.record({ t: tokenArb, n: nameArb }).map(r => `### Phase ${r.t}: ${r.n}`),
    weight: 4,
  },
  {
    arbitrary: fc.record({ t: tokenArb, n: nameArb }).map(r => `- [x] **Phase ${r.t}: ${r.n}**`),
    weight: 3,
  },
  {
    // The refutation corpus: bracket-DOTTED prose headings that predate this
    // convention and must never be claimed as phases by a non-bracket repo.
    arbitrary: fc
      .record({
        tag: fc.constantFrom('RFC.2119', 'v1.0', 'ADR.612', 'SPEC.1', 'ISO.8601', 'GSD.02'),
        t: tokenArb,
        n: nameArb,
      })
      .map(r => `### [${r.tag}] ${r.t}: ${r.n}`),
    weight: 3,
  },
  {
    arbitrary: fc.record({ tag: fc.constantFrom('GSD.02', 'x'), t: tokenArb, n: nameArb })
      .map(r => `### [${r.tag}] Phase ${r.t}: ${r.n}`),
    weight: 2,
  },
  { arbitrary: nameArb.map(n => `Some prose about ${n}.`), weight: 1 },
);

describe('#612 PR-2 property: a repo that did not opt in compiles the base reader', () => {
  test('P2 every non-bracket convention agrees with the BASE source on generated content', () => {
    fc.assert(
      fc.property(
        fc.array(legacyLineArb, { minLength: 1, maxLength: 12 }),
        fc.constantFrom(B.ANY_BRACKET, B.LABEL_ONLY),
        (lines, baseline) => {
          const base = compile(BASE_SRC[baseline]);
          for (const convention of NON_BRACKET_CONVENTIONS) {
            const selected = heading(baseline, convention);
            for (const line of lines) {
              const a = base.exec(line);
              const b = selected.exec(line);
              assert.equal(
                a === null,
                b === null,
                `recognition diverged from base on ${JSON.stringify(line)} (convention ${JSON.stringify(convention)})`,
              );
              if (a && b) {
                assert.equal(b[1], a[1], `captured token diverged from base on ${JSON.stringify(line)}`);
              }
            }
          }
        },
      ),
    );
  });
});

// ─── P3 — negative properties: mutate every field, assert non-acceptance ─────

/**
 * Each mutation breaks ONE field of a canonical bracket heading. `folds` marks
 * the one mutation that must still be ACCEPTED (case is folded, not rejected) —
 * asserting rejection there would pin the wrong contract.
 */
const MUTATIONS = [
  { name: 'unpadded milestone', folds: false, apply: h => h.milestone.length === 2 && h.milestone[0] === '0' ? `${h.furniture}[${h.code}.${h.milestone.slice(1)}] ${h.token}: ${h.name}` : null },
  { name: 'overpadded milestone', folds: false, apply: h => `${h.furniture}[${h.code}.0${h.milestone}] ${h.token}: ${h.name}` },
  { name: 'non-numeric milestone', folds: false, apply: h => `${h.furniture}[${h.code}.AB] ${h.token}: ${h.name}` },
  { name: 'unclosed bracket', folds: false, apply: h => `${h.furniture}[${h.code}.${h.milestone} ${h.token}: ${h.name}` },
  { name: 'nested bracket', folds: false, apply: h => `${h.furniture}[${h.code}.[${h.milestone}]] ${h.token}: ${h.name}` },
  { name: 'hyphen for dot', folds: false, apply: h => `${h.furniture}[${h.code}-${h.milestone}] ${h.token}: ${h.name}` },
  { name: 'colon for dot', folds: false, apply: h => `${h.furniture}[${h.code}:${h.milestone}] ${h.token}: ${h.name}` },
  { name: 'paren for close bracket', folds: false, apply: h => `${h.furniture}[${h.code}.${h.milestone}) ${h.token}: ${h.name}` },
  { name: 'lowercased code', folds: true, apply: h => `${h.furniture}[${h.code.toLowerCase()}.${h.milestone}] ${h.token}: ${h.name}` },
];

describe('#612 PR-2 property: a broken bracket token is not silently accepted', () => {
  for (const mutation of MUTATIONS) {
    test(`P3 ${mutation.name} — ${mutation.folds ? 'folds to the same key' : 'is not read as a phase'}`, () => {
      fc.assert(
        fc.property(bracketHeadingArb, fc.constantFrom(B.ANY_BRACKET, B.LABEL_ONLY), (h, baseline) => {
          const mutated = mutation.apply(h);
          if (mutated === null) return; // mutation not applicable to this sample
          const reader = heading(baseline, 'bracket');

          if (mutation.folds) {
            assert.ok(reader.test(mutated), `case variation must still be read: ${JSON.stringify(mutated)}`);
            assert.equal(
              bracketQualifiedKey(`${h.code.toLowerCase()}.${h.milestone}-${h.token}`, 'bracket'),
              bracketQualifiedKey(`${h.code}.${h.milestone}-${h.token}`, 'bracket'),
              'a case variation must fold to the identical qualified key',
            );
            return;
          }

          assert.equal(
            reader.test(mutated),
            false,
            `${mutation.name} must not be read as a phase: ${JSON.stringify(mutated)}`,
          );
        }),
      );
    });
  }

  test('P3z a malformed bracket forms no qualified key, on any convention', () => {
    fc.assert(
      fc.property(bracketHeadingArb, fc.constantFrom(...MUTATIONS.filter(m => !m.folds).map(m => m.name)), (h, name) => {
        const mutation = MUTATIONS.find(m => m.name === name);
        const mutated = mutation.apply(h);
        if (mutated === null) return;
        // The id form of the same breakage: strip the heading furniture.
        const id = mutated.replace(/^(?:#{2,4}[ \t]*|[-*+][ \t]*\[[ xX]\][ \t]*)?[*_]*/, '').replace(/^\[/, '').replace(/\]\s*/, '-').replace(/:.*$/, '').trim();
        assert.equal(bracketQualifiedKey(id, 'bracket'), null, `${name} must form no key: ${JSON.stringify(id)}`);
        for (const convention of NON_BRACKET_CONVENTIONS) {
          assert.equal(bracketQualifiedKey(id, convention), null);
        }
      }),
    );
  });
});

// ─── P4 — both sides of a comparison, one convention ─────────────────────────

describe('#612 PR-2 property: comparison sides derive under the same convention', () => {
  test('P4a a bracket DIR and its ROADMAP TOKEN produce the identical key', () => {
    // The #2562 defect class reached from the other side: the promoted
    // `phaseKeyFromDir` derives both sides with the same FUNCTION, but a bracket
    // dir still needs the same CONVENTION or it keys to its own whole name.
    fc.assert(
      fc.property(bracketDirArb, d => {
        assert.equal(phaseKeyFromDir(d.dir, 'bracket'), phaseKeyFromToken(d.token));
      }),
    );
  });

  test('P4b a convention-less call site is byte-identical across all its spellings', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          bracketDirArb.map(d => d.dir),
          fc.record({ t: tokenArb, s: fc.constantFrom('alpha', 'beta-two', 'x') }).map(r => `${r.t}-${r.s}`),
          fc.record({ c: codeArb, t: tokenArb }).map(r => `${r.c}-${r.t}-slug`),
        ),
        dir => {
          const bare = phaseKeyFromDir(dir);
          assert.equal(phaseKeyFromDir(dir, undefined), bare);
          assert.equal(phaseKeyFromDir(dir, null), bare);
          assert.equal(phaseKeyFromDir(dir, 'milestone-prefixed'), bare);
        },
      ),
    );
  });

  test('P4c the qualified key separates same-token phases of different milestones', () => {
    fc.assert(
      fc.property(
        fc.record({ code: codeArb, a: milestoneArb, b: milestoneArb, token: tokenArb, slug: fc.constantFrom('one', 'two') }),
        r => {
          fc.pre(parseInt(r.a, 10) !== parseInt(r.b, 10));
          const dirA = `${r.code}.${r.a}-${r.token}-${r.slug}`;
          const qualifiedB = `${r.code}.${r.b}-${r.token}`;
          assert.equal(phaseTokenMatches(dirA, `${r.code}.${r.a}-${r.token}`, 'bracket'), true);
          assert.equal(
            phaseTokenMatches(dirA, qualifiedB, 'bracket'),
            false,
            `${dirA} must not answer to milestone ${r.b}`,
          );
          assert.notEqual(
            bracketQualifiedKey(`${r.code}.${r.a}-${r.token}`, 'bracket'),
            bracketQualifiedKey(qualifiedB, 'bracket'),
          );
        },
      ),
    );
  });

  test('P4d foldBracketId is idempotent and case-collapsing', () => {
    fc.assert(
      fc.property(bracketDirArb, d => {
        const id = `${d.code}.${d.milestone}-${d.token}`;
        const folded = foldBracketId(id);
        assert.equal(foldBracketId(folded), folded, 'fold must be idempotent');
        assert.equal(foldBracketId(id.toLowerCase()), folded);
        assert.equal(foldBracketId(id.toUpperCase()), folded);
      }),
    );
  });
});
