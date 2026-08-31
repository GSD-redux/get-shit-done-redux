'use strict';

/**
 * PR-2 (#2761 / epic #612) — convention-GATED heading-intro selection.
 *
 * The design this file pins, and why it replaced the previous one:
 *
 * PR-2 first widened every heading reader unconditionally, resting on the claim
 * that the newly-admitted shape — a `[CODE.MM]` bracket followed by a digit —
 * "cannot occur in a legacy ROADMAP". That claim is false. `### [RFC.2119] 5:`,
 * `### [v1.0] 2024:`, `### [ADR.612] 3:`, `### [SPEC.1] 3:` and
 * `### [ISO.8601] 2026:` are all ordinary headings a project that never heard of
 * this convention can contain, and every one of them was claimed as a phase:
 * `phase_count` and `total_phases` moved, and `validate health` grew W006s, on
 * repos that never opted in.
 *
 * No amount of narrowing rescues an ungated widening, because the argument it
 * needs — "no legacy document contains this" — is unprovable about documents we
 * do not control. So the widening is now SELECTED, not argued: a repo whose
 * resolved `phase_id_convention` is not 'bracket' compiles the same source
 * string it compiled before, and the question of what that string does or does
 * not match never arises.
 *
 * THE STRUCTURAL TEST is the load-bearing assertion here. It carries its own
 * transcription of each call site's base spelling — copied from
 * `git show d04592de:src/<file>.cts` — and asserts byte-equality against what
 * the selector returns. It deliberately does NOT compare the selector against a
 * constant the selector itself is built from: that would restate the
 * implementation and pass no matter what either side said. Byte-equality with an
 * independently transcribed literal is the whole proof, and it needs no corpus.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../gsd-core/bin/lib/phase-id.cjs');
const B = core.PHASE_HEADING_BASELINE;

// ─── Base spellings, transcribed by hand from d04592de ─────────────────────
// One entry per call site PR-2 converts. `src` is what that site's regex
// contains on the base commit, character for character. If a rebase moves a
// site's base spelling, this table is what fails.
const BASE_SITES = [
  // --- baseline: the site already tolerates `[anything] Phase N`
  { file: 'roadmap.cts', site: 'searchPhaseInContent headingPattern',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  { file: 'roadmap.cts', site: 'cmdRoadmapAnalyze phasePattern',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  { file: 'roadmap.cts', site: 'cmdRoadmapAnalyze nextHeader',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  { file: 'validate.cts', site: 'buildRoadmapPhaseVariants phasePattern',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  { file: 'roadmap-parser.cts', site: 'getMilestonePhaseFilter phaseHeadingPattern',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  { file: 'commands.cts', site: 'cmdStats headingPattern',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+' },
  // #2761 B2: BRACKET_PHASE_TAIL_RE (isBracketMilestoneBoundary's phase-tail
  // discriminator) always passes the literal 'bracket' convention — it is not
  // itself convention-gated (the CALLER, isBracketMilestoneBoundary, is only
  // ever consulted when bracketBoundaryActive is already true) — but it still
  // shares the SAME ANY_BRACKET baseline and produces the identical BASE
  // source on a non-bracket convention as every other ANY_BRACKET site, so it
  // is pinned here for count-exactness rather than left as an unpinned hole.
  //
  // #2761 round-3 Minor 1: `runtimeGated: true` below is the load-bearing
  // fact this row's STRUCTURAL IDENTITY assertion (the loop just below)
  // cannot see — that assertion is a property of `phaseHeadingPrefixSrcFor`
  // (the FUNCTION: "called with a non-bracket convention, it returns the
  // base source"), not of THIS site, and it would pass unchanged even if
  // this call were deleted entirely. Safety at this specific call site rests
  // ENTIRELY on a runtime gate the guard cannot see: `isBracketMilestoneBoundary`
  // has exactly two callers, both guarded — `computeSectionEnd`'s
  // `bracketBoundaryActive && isBracketMilestoneBoundary(...)` and the
  // preambleCutoff scan's own call, itself nested inside an
  // `if (bracketBoundaryActive) { … }` block (`src/roadmap-parser.cts`,
  // grep `isBracketMilestoneBoundary(` for current line numbers — both
  // round-3 fixes shifted them since this note was first written) — and
  // `BRACKET_PHASE_TAIL_RE` has TWO consumers as of #2761 round-4 (its own
  // use inside `isBracketMilestoneBoundary`, plus `bracketHeadingHasMatchingChild`'s
  // same-id-PHASE-child conjunct added by 65d257ce) — both still gated on
  // the same `bracketBoundaryActive` flag, but NOT both through the same
  // mechanism: `bracketHeadingHasMatchingChild` is reached only via its one
  // caller (`:593`, inside the `if (bracketBoundaryActive) { … }` block this
  // note names above), while `isBracketMilestoneBoundary` — see this row's
  // own "exactly two callers" paragraph above — is reached via TWO different
  // mechanisms, an inline `bracketBoundaryActive &&` conjunct at one call
  // site and that same block at the other. (round-5 Nit 1 first added this
  // sentence to note the consumer count was stale by one commit; round-6
  // Nit 2 corrected the mechanism claim that sentence introduced — the
  // CONCLUSION is unaffected either time: every consumer is still
  // runtime-gated on the same flag.)
  // `BRACKET_HEADING_INTRO_RE` has THREE consumers as of #2761 round-4
  // (`isBracketMilestoneBoundary` itself, plus two uses inside
  // `bracketHeadingHasMatchingChild` — its own id and its same-id-PHASE-child
  // scan) — all still nested inside the same `bracketBoundaryActive` runtime
  // gate this note is about (round-4 Nit 1: this sentence was stale by one
  // commit, claiming zero other consumers when 2e06aef5 had already added
  // two; the CONCLUSION is unaffected — every consumer is still
  // runtime-gated, and `BRACKET_HEADING_INTRO_RE` is built from
  // `BRACKET_ID_SRC`, not `phaseHeadingPrefixSrcFor`, so it was never a
  // selector site to begin with). The marker exists so a future reader does
  // not mistake this row for "selector-covered like the other 14."
  { file: 'roadmap-parser.cts', site: 'isBracketMilestoneBoundary BRACKET_PHASE_TAIL_RE',
    baseline: B.ANY_BRACKET, src: '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+', runtimeGated: true },
  // --- baseline: the site spells a BARE `Phase ` with no bracket tolerance
  { file: 'roadmap.cts', site: 'searchPhaseInContent checklistPattern',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'roadmap.cts', site: 'cmdRoadmapAnalyze checkboxPattern',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'roadmap.cts', site: 'cmdRoadmapAnalyze checklistPattern',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'validate.cts', site: 'buildRoadmapPhaseVariants checklistPattern',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'validate.cts', site: 'buildNotStartedPhaseVariants uncheckedPattern',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'state.cts', site: 'buildStateFrontmatter roadmapPhaseCount',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'state.cts', site: 'cmdStateSync roadmapPhaseCount', baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'state.cts', site: 'extractRetiredPhaseNumbers phaseRef',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  // #3309/#3310 moved the health reads out of verify.cts and into the parsed
  // planning snapshot consumed by the diagnostic rule table. Pin the same two
  // ROADMAP reads at their new owner so neither can silently narrow.
  { file: 'planning-snapshot.cts', site: 'buildCurrentMilestoneRoadmapPhaseIdsField (W026, ex-verify.cts B6)',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'planning-snapshot.cts', site: 'buildRoadmapPhaseCheckboxesField (W011/W006 not-started)',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'init.cts', site: 'cmdInitManager phaseHeadingPrefix',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
  { file: 'init.cts', site: 'cmdInitManager phaseHeadingPrefixNoCapture',
    baseline: B.LABEL_ONLY, src: 'Phase\\s+' },
];

// Every convention value that is NOT the bracket convention. A repo carrying any
// of these must read exactly as it did at base.
const NON_BRACKET = [undefined, null, '', 'milestone-prefixed', 'Bracket', 'BRACKET', 'brackets', 'bracket-ish'];

describe('#612 PR-2 STRUCTURAL IDENTITY: a non-bracket repo compiles the BASE pattern', () => {
  for (const { file, site, baseline, src, runtimeGated } of BASE_SITES) {
    // #2761 round-3 Minor 1: the title makes the gating mechanism visible in
    // test output, not just in a source comment — a row with no
    // `[runtime-gated]` suffix IS selector-covered by this test; one WITH it
    // is safe only because of a call-site guard this test cannot see.
    test(`${file} — ${site}${runtimeGated ? ' [runtime-gated, not selector-covered]' : ''}`, () => {
      for (const convention of NON_BRACKET) {
        assert.strictEqual(
          core.phaseHeadingPrefixSrcFor(baseline, convention),
          src,
          `convention ${JSON.stringify(convention)} must compile the base source byte-for-byte`,
        );
        assert.strictEqual(
          core.phaseHeadingPrefixSrcFor(baseline, convention, true),
          src,
          'the capturing variant adds no group when there is no bracket alternative',
        );
      }
    });
  }

  test('only the exact string "bracket" selects the widened form', () => {
    for (const convention of NON_BRACKET) {
      assert.ok(
        !core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, convention).includes('['),
        `${JSON.stringify(convention)} must not admit any bracket alternative`,
      );
    }
    assert.ok(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, 'bracket').includes('['));
  });

  test('an unknown baseline is treated as label-only, never as widened', () => {
    assert.strictEqual(
      core.phaseHeadingPrefixSrcFor('nonsense', null), core.BASE_PHASE_LABEL_PREFIX_SRC,
    );
  });
});

// ─── What the legacy counterexamples do under each convention ──────────────

const scan = (prefixSrc, doc) => {
  const re = new RegExp(`#{2,4}\\s*${prefixSrc}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(doc)) !== null) out.push(m[1]);
  return out;
};

describe('#612 PR-2: the reviewer counterexamples, under each convention', () => {
  // Every one of these was claimed as a phase by the ungated widening.
  const COUNTEREXAMPLES = [
    '### [RFC.2119] 5: Keyword definitions',
    '### [v1.0] 2024: Retrospective',
    '### [v1.0] 2026-01-15: Shipped release notes',
    '### [ADR.612] 3: Decisions to ratify',
    '### [SPEC.1] 3: Scope',
    '### [ISO.8601] 2026: Dates',
    '### [rev.2] 9: Revision nine notes',
    '### [Fig.3] 2: Diagram',
  ];

  test('a legacy repo claims NONE of them (this is the fix)', () => {
    for (const heading of COUNTEREXAMPLES) {
      for (const convention of NON_BRACKET) {
        assert.deepEqual(
          scan(core.phaseHeadingPrefixSrcFor(B.ANY_BRACKET, convention), heading), [],
          `${JSON.stringify(heading)} under ${JSON.stringify(convention)}`,
        );
      }
    }
  });

  test('a legacy repo still reads its own real headings', () => {
    const doc = '### Phase 5: Real\n### [GSD] Phase 2-01: Legacy\n#### Phase Details:';
    assert.deepEqual(scan(core.phaseHeadingPrefixSrcFor(B.ANY_BRACKET, null), doc), ['5', '2-01', 'Details']);
  });

  test('DISCLOSED: on a BRACKET repo some of them are still claimed', () => {
    // Gating removes the legacy blast radius; it does not make `[RFC.2119] 5:`
    // unambiguous. On a repo that HAS opted in, a citation-shaped bracket whose
    // milestone matches the emit width still reads as a phase. Pinned rather
    // than hidden — the coherence check surfaces it as a milestone mismatch.
    const src = core.phaseHeadingPrefixSrcFor(B.ANY_BRACKET, 'bracket');
    assert.deepEqual(scan(src, '### [RFC.2119] 5: Keyword definitions'), ['5']);
    // The emit-width rule does exclude the 1-digit-milestone family outright.
    assert.deepEqual(scan(src, '### [SPEC.1] 3: Scope'), []);
    assert.deepEqual(scan(src, '### [Fig.3] 2: Diagram'), []);
  });
});

// ─── The label-only sites keep their narrowness on bracket repos too ───────

describe('#612 PR-2: a label-only site never gains any-bracket tolerance', () => {
  const bullets = (prefixSrc, doc) => {
    const re = new RegExp(`-\\s*\\[[ xX]\\]\\s*\\*{0,2}${prefixSrc}([\\w][\\w.-]*)\\s*:`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(doc)) !== null) out.push(m[1]);
    return out;
  };

  test('`[GSD] Phase 2-01` stays unmatched under BOTH conventions', () => {
    const doc = '- [x] **[GSD] Phase 2-01: Legacy**';
    assert.deepEqual(bullets(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, null), doc), []);
    assert.deepEqual(bullets(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, 'bracket'), doc), [],
      'the bracket convention widens to bracket IDs, not to arbitrary bracket text');
  });

  test('`[v1.2] Phase 3` — the retro-grant counterexample — stays unmatched on legacy', () => {
    const doc = '- [ ] **[v1.2] Phase 3: Something legacy**';
    assert.deepEqual(bullets(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, null), doc), []);
  });

  test('a bracket repo does admit the bracket-ID form at a label-only site', () => {
    const doc = '- [ ] **[GSD.02] 05: Real**';
    assert.deepEqual(bullets(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, null), doc), []);
    assert.deepEqual(bullets(core.phaseHeadingPrefixSrcFor(B.LABEL_ONLY, 'bracket'), doc), ['05']);
  });
});

// ─── The one identity grammar (F3) ─────────────────────────────────────────

describe('#612 PR-2: one bracket identity grammar, one width rule', () => {
  test('the three former spellings now agree on the 1-digit-milestone family', () => {
    // `GSD.2-05-feature` used to have a qualified key and a token but not be a
    // phase directory, depending on which private spelling a caller reached.
    assert.equal(core.bracketQualifiedKey('GSD.2-05-feature', 'bracket'), null);
    assert.equal(core.extractPhaseToken('GSD.2-05-feature', 'bracket'), 'GSD.2-05-feature');
    assert.ok(!new RegExp(`^${core.BRACKET_DIR_PREFIX_SRC}`, 'i').test('GSD.2-05-feature'));
  });

  test('the canonical padded forms resolve identically everywhere', () => {
    assert.equal(core.bracketQualifiedKey('GSD.02-05-feature', 'bracket'), 'GSD.2-5');
    assert.equal(core.extractPhaseToken('GSD.02-05-feature', 'bracket'), '05');
    assert.ok(new RegExp(`^${core.BRACKET_DIR_PREFIX_SRC}`, 'i').test('GSD.02-05-feature'));
  });

  test('case folding: a lowercase bracket id passes every identity test', () => {
    assert.equal(core.isSentinelPhaseId('gsd.999-01', 'bracket'), true, 'lowercase icebox is a sentinel');
    assert.equal(core.isSentinelPhaseId('GSD.999-01', 'bracket'), true);
    assert.equal(core.isSentinelPhaseId('gsd.00-01', 'bracket'), true);
    assert.equal(core.isSentinelPhaseId('gsd.02-05', 'bracket'), false);
    assert.equal(core.getMilestoneFromPhaseId('gsd.02-05', 'bracket'), 'v2.0');
    assert.equal(core.bracketQualifiedKey('ck.03-02', 'bracket'), 'CK.3-2');
  });

  test('sentinel milestones and their neighbours', () => {
    for (const mm of ['00', '999']) {
      assert.equal(core.isSentinelPhaseId(`GSD.${mm}-01`, 'bracket'), true, mm);
    }
    for (const mm of ['01', '99', '100', '998', '1000']) {
      assert.equal(core.isSentinelPhaseId(`GSD.${mm}-01`, 'bracket'), false, mm);
    }
    // Widths toDir cannot emit are not bracket ids at all — pad2 never produces
    // a bare `0`, and the emit validator rejects a leading-zero 3+ run.
    for (const mm of ['0', '000', '0999', '002', '2']) {
      assert.equal(core.isSentinelPhaseId(`GSD.${mm}-01`, 'bracket'), false, `${mm} is malformed`);
    }
  });

  test('an out-of-range milestone integer is refused, not collapsed to Infinity', () => {
    const huge = 'A.' + '9'.repeat(400) + '-1';
    assert.equal(core.bracketQualifiedKey(huge, 'bracket'), null,
      'two 400-digit milestones must not share one key');
  });

  test('G3: the capturing variant captures the id in BOTH bracket forms', () => {
    // `### [GSD.999] Phase 07:` used to fall through to the base alternative,
    // which captures nothing — so the reader saw no bracket, applied the legacy
    // token rule, and counted a labeled icebox heading while excluding the
    // label-less one beside it.
    for (const baseline of [B.ANY_BRACKET, B.LABEL_ONLY]) {
      const re = new RegExp(
        `^${core.phaseHeadingPrefixSrcFor(baseline, 'bracket', true)}([\\w][\\w.-]*)\\s*:`, 'i');
      for (const heading of ['[GSD.999] Phase 07: Icebox', '[GSD.999] 07: Icebox']) {
        const m = heading.match(re);
        assert.ok(m, `${baseline}: ${heading}`);
        assert.equal(m[1], 'GSD.999', `${baseline}: ${heading} — bracket id must be captured`);
        assert.equal(m[2], '07');
      }
    }
  });

  test('G7: the qualified key shares the dir token boundary and width', () => {
    // A qualified hit returns UNCONDITIONALLY from phaseTokenMatches, so a key
    // that matches a directory isPhaseDirName rejects is a final wrong answer.
    assert.equal(core.bracketQualifiedKey('GSD.02-12A-hotfix', 'bracket'), null);
    assert.equal(core.bracketQualifiedKey('GSD.02-05.03.07-x', 'bracket'), null);
    assert.equal(core.bracketQualifiedKey('GSD.2-05', 'bracket'), null, 'unpadded is malformed');
    assert.equal(core.bracketQualifiedKey('GSD.02-05-slug', 'bracket'), 'GSD.2-5');
    assert.equal(core.bracketQualifiedKey('GSD.02-05.03', 'bracket'), 'GSD.2-5.3');
  });

  test('G7: the qualified branch resolves its own milestone and refuses malformed dirs', () => {
    // Kills the dead-branch mutant: deleting the qualified branch must fail here.
    assert.equal(core.phaseTokenMatches('CK.03-02-shell', 'CK.03-02', 'bracket'), true);
    assert.equal(core.phaseTokenMatches('CK.02-02-other', 'CK.03-02', 'bracket'), false,
      'must not resolve to another milestone same-numbered dir');
    assert.equal(core.phaseTokenMatches('GSD.02-12A-hotfix', 'GSD.02-12', 'bracket'), false,
      'a directory isPhaseDirName rejects must not satisfy a qualified query');
  });

  test('the bracket path stays OFF without an explicit signal', () => {
    assert.equal(core.bracketQualifiedKey('CK.03-02'), null);
    assert.equal(core.bracketQualifiedKey('CK.03-02', 'milestone-prefixed'), null);
    assert.equal(core.extractPhaseToken('GSD.02-05.03-01'), 'GSD.02-05.03-01');
    // The #2043 numeric-tail family keeps its convention-less reading.
    assert.equal(core.phaseTokenMatches('P0.03-02-tenant', 'P0.3-2'), false);
  });
});

// ─── `\s*` must not span newlines (NIT 12) ─────────────────────────────────

describe('#612 PR-2: the bracket alternative does not span lines', () => {
  test('prose on the line after a bracket-terminated heading is not a phase', () => {
    const doc = '### [GSD.02]\n\n05: Orphan digits\n';
    assert.deepEqual(scan(core.phaseHeadingPrefixSrcFor(B.ANY_BRACKET, 'bracket'), doc), [],
      'a heading that ends at the bracket claims nothing on later lines');
  });

  test('a tab between the bracket and the token is still one heading', () => {
    assert.deepEqual(
      scan(core.phaseHeadingPrefixSrcFor(B.ANY_BRACKET, 'bracket'), '### [GSD.02]\t05: Tabbed'),
      ['05'],
    );
  });
});

// ─── The federated convention resolver ─────────────────────────────────────

describe('#612 PR-2: phase_id_convention resolves workstream -> root', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { resolvePhaseIdConvention } = require('../gsd-core/bin/lib/planning-workspace.cjs');
  const { cleanup } = require('./helpers.cjs');

  let dir;
  const setup = ({ root, ws }) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-612-fed-'));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    if (root !== undefined) {
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
        JSON.stringify({ phase_id_convention: root }));
    }
    if (ws !== undefined) {
      fs.writeFileSync(path.join(dir, '.planning', 'workstreams', 'ws1', 'config.json'),
        JSON.stringify({ phase_id_convention: ws }));
    }
    return dir;
  };
  const withWs = (name, fn) => {
    const prev = process.env.GSD_WORKSTREAM;
    if (name === null) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = name;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = prev;
    }
  };
  const cleanupDir = () => cleanup(dir);

  test('config at ROOT only, no workstream active', () => {
    const d = setup({ root: 'bracket' });
    try { withWs(null, () => assert.equal(resolvePhaseIdConvention(d), 'bracket')); } finally { cleanupDir(); }
  });

  test('config at ROOT only, workstream active — falls back to root', () => {
    // This is the split that made a workstream repo report every bracket phase
    // missing from disk: the ROADMAP read resolved from one base, the directory
    // read from the other.
    const d = setup({ root: 'bracket' });
    try { withWs('ws1', () => assert.equal(resolvePhaseIdConvention(d), 'bracket')); } finally { cleanupDir(); }
  });

  test('config at WORKSTREAM only, workstream active', () => {
    const d = setup({ ws: 'bracket' });
    try { withWs('ws1', () => assert.equal(resolvePhaseIdConvention(d), 'bracket')); } finally { cleanupDir(); }
  });

  test('config at BOTH — the workstream wins', () => {
    // Governs the #612 bracket-selection reads ONLY. The shipped
    // milestone-prefixed W021 gate keeps its own root-only read: re-basing a
    // legacy convention's gate onto this resolver moved its answer in both
    // directions on workstream repos, and that is pinned at the CLI in
    // tests/adr-612-bracket-coherence.test.cjs.
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      withWs('ws1', () => assert.equal(resolvePhaseIdConvention(d), 'bracket'));
    } finally { cleanupDir(); }
  });

  test('a PROJECT-scoped config stands alone — no root fallback', () => {
    // config-loader falls back to the root config only under `if (ws)`, so a
    // project-only split must not inherit the root's value.
    const fsx = require('fs');
    const d = setup({ root: 'bracket' });
    try {
      fsx.mkdirSync(path.join(d, '.planning', 'proj1'), { recursive: true });
      const prev = process.env.GSD_PROJECT;
      process.env.GSD_PROJECT = 'proj1';
      try {
        assert.equal(resolvePhaseIdConvention(d), null, 'root must not leak into a project scope');
        fsx.writeFileSync(path.join(d, '.planning', 'proj1', 'config.json'),
          JSON.stringify({ phase_id_convention: 'bracket' }));
        assert.equal(resolvePhaseIdConvention(d), 'bracket');
      } finally {
        if (prev === undefined) delete process.env.GSD_PROJECT; else process.env.GSD_PROJECT = prev;
      }
    } finally { cleanupDir(); }
  });

  test('config at WORKSTREAM only, no workstream active — not visible', () => {
    const d = setup({ ws: 'bracket' });
    try { withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null)); } finally { cleanupDir(); }
  });

  test('absent, empty, and unparseable configs all resolve to null', () => {
    const d = setup({});
    try {
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null, 'absent'));
      fs.writeFileSync(path.join(d, '.planning', 'config.json'), '{}');
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null, 'empty object'));
      fs.writeFileSync(path.join(d, '.planning', 'config.json'), '{ not json');
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null, 'unparseable'));
      fs.writeFileSync(path.join(d, '.planning', 'config.json'), JSON.stringify({ phase_id_convention: '' }));
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null, 'empty string'));
      fs.writeFileSync(path.join(d, '.planning', 'config.json'), JSON.stringify({ phase_id_convention: true }));
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), null, 'non-string'));
    } finally { cleanupDir(); }
  });

  // ─── #2761 B1: the workstream is an ARGUMENT, not only an env var ────────

  test('the ws ARGUMENT selects the config, with no GSD_WORKSTREAM set', () => {
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      withWs(null, () => assert.equal(
        resolvePhaseIdConvention(d, 'ws1'), 'bracket',
        'a workstream passed by argument must resolve its OWN config, not the root',
      ));
    } finally { cleanupDir(); }
  });

  test('arg and env resolve identically — `--workstream ws1` === `GSD_WORKSTREAM=ws1`', () => {
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      const viaArg = withWs(null, () => resolvePhaseIdConvention(d, 'ws1'));
      const viaEnv = withWs('ws1', () => resolvePhaseIdConvention(d));
      assert.equal(viaArg, viaEnv, 'arg-driven and env-driven callers must agree');
      assert.equal(viaArg, 'bracket');
    } finally { cleanupDir(); }
  });

  test('an explicit ws overrides GSD_WORKSTREAM rather than being ignored', () => {
    const d = setup({ root: 'bracket' });
    try {
      fs.writeFileSync(path.join(d, '.planning', 'workstreams', 'ws1', 'config.json'),
        JSON.stringify({ phase_id_convention: 'milestone-prefixed' }));
      // env names ws1; the ARGUMENT names no workstream at all -> root scope.
      withWs('ws1', () => assert.equal(resolvePhaseIdConvention(d, null), 'bracket'));
      // env names nothing; the ARGUMENT names ws1 -> the workstream's own value.
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d, 'ws1'), 'milestone-prefixed'));
    } finally { cleanupDir(); }
  });

  test('omitting ws keeps the env fallback — pre-#2761 call sites are unchanged', () => {
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      withWs('ws1', () => assert.equal(resolvePhaseIdConvention(d), 'bracket'));
      withWs(null, () => assert.equal(resolvePhaseIdConvention(d), 'milestone-prefixed'));
    } finally { cleanupDir(); }
  });
});

// ─── #2761 B1: workstream isolation, end-to-end through the readers ─────────

describe('#2761 B1: a workstream\'s convention scopes ITS OWN roadmap read', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { extractCurrentMilestone, getMilestonePhaseFilter } =
    require('../gsd-core/bin/lib/roadmap-parser.cjs');
  const { cleanup } = require('./helpers.cjs');

  // Two bracket milestones, NEITHER carrying a version string. Under the
  // bracket convention STATE's `v2.0` selects `[GSD.02]` alone; under any other
  // convention nothing matches and the window is the whole document. So "which
  // convention did this read use" is directly observable in the window.
  const ROADMAP = [
    '# Roadmap', '',
    '## [GSD.01] Foundation', '',
    '### [GSD.01] 01: Alpha',
    '### [GSD.01] 02: Alpha2', '',
    '## [GSD.02] Second', '',
    '### [GSD.02] 01: Beta',
    '### [GSD.02] 02: Beta2',
    '### [GSD.02] 03: Beta3', '',
  ].join('\n');

  let dir;
  const setup = ({ root, ws }) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-612-b1-'));
    const wsDir = path.join(dir, '.planning', 'workstreams', 'foo');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    if (root !== undefined) {
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
        JSON.stringify({ phase_id_convention: root }));
    }
    if (ws !== undefined) {
      fs.writeFileSync(path.join(wsDir, 'config.json'),
        JSON.stringify({ phase_id_convention: ws }));
    }
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), ROADMAP);
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    return dir;
  };
  const withWs = (name, fn) => {
    const prev = process.env.GSD_WORKSTREAM;
    if (name === null) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = name;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = prev;
    }
  };
  const cleanupDir = () => cleanup(dir);

  const scopedToGsd02 = (window) =>
    window.includes('[GSD.02] 01: Beta') && !window.includes('[GSD.01] 01: Alpha');

  // Repro A (trek-e). The workstream declares milestone-prefixed. Flipping ONLY
  // the ROOT config used to change which milestone this workstream extracted,
  // because the convention was resolved from `planningDir(cwd)` — the root,
  // since no GSD_WORKSTREAM was set — while the DOCUMENT came from the
  // workstream. The workstream's own declaration was never consulted at all.
  test('repro A: flipping the ROOT config cannot move a workstream that owns its convention', () => {
    const windows = [];
    for (const root of ['bracket', 'milestone-prefixed']) {
      const d = setup({ root, ws: 'milestone-prefixed' });
      try {
        const content = fs.readFileSync(
          path.join(d, '.planning', 'workstreams', 'foo', 'ROADMAP.md'), 'utf-8');
        windows.push(withWs(null, () => extractCurrentMilestone(content, d, 'foo')));
      } finally { cleanupDir(); }
    }
    assert.equal(windows[0], windows[1],
      'root=bracket and root=milestone-prefixed must produce the SAME window for a ' +
      'workstream whose own config says milestone-prefixed');
    assert.ok(!scopedToGsd02(windows[0]),
      'a milestone-prefixed workstream must not take the bracket scoping path');
  });

  // The federation itself is preserved: a workstream that declares NOTHING
  // still inherits the root, exactly as config-loader does. That is inheritance,
  // not the leak — pinned so the B1 fix cannot be over-applied into isolation.
  test('a workstream that declares no convention still inherits the root', () => {
    const d = setup({ root: 'bracket', ws: undefined });
    try {
      const content = fs.readFileSync(
        path.join(d, '.planning', 'workstreams', 'foo', 'ROADMAP.md'), 'utf-8');
      assert.ok(scopedToGsd02(withWs(null, () => extractCurrentMilestone(content, d, 'foo'))));
    } finally { cleanupDir(); }
  });

  // Repro B (trek-e): `--workstream foo` vs `GSD_WORKSTREAM=foo`.
  test('repro B: the ws ARGUMENT and GSD_WORKSTREAM produce the same window', () => {
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      const content = fs.readFileSync(
        path.join(d, '.planning', 'workstreams', 'foo', 'ROADMAP.md'), 'utf-8');
      const viaArg = withWs(null, () => extractCurrentMilestone(content, d, 'foo'));
      const viaEnv = withWs('foo', () => extractCurrentMilestone(content, d, undefined));
      assert.equal(viaArg, viaEnv, 'arg-driven and env-driven reads must agree');
      assert.ok(scopedToGsd02(viaArg), 'both must take the workstream\'s own bracket scoping');
    } finally { cleanupDir(); }
  });

  test('repro B: arg/env parity holds through getMilestonePhaseFilter too', () => {
    const d = setup({ root: 'milestone-prefixed', ws: 'bracket' });
    try {
      const viaArg = withWs(null, () => getMilestonePhaseFilter(d, 'v2.0', undefined, 'foo'));
      const viaEnv = withWs('foo', () => getMilestonePhaseFilter(d, 'v2.0', undefined, undefined));
      assert.equal(viaArg.phaseCount, viaEnv.phaseCount);
      assert.equal(viaArg.phaseCount, 3, 'v2.0 declares exactly 3 bracket phases');
    } finally { cleanupDir(); }
  });

  // The workstream-inventory delta: those two sites passed a literal `null`
  // ("resolved, and it is not bracket") where they meant `undefined` ("resolve
  // it"). On a bracket workstream `null` collapsed the heading set to empty.
  test('undefined resolves the workstream convention where null pinned legacy', () => {
    const d = setup({ root: undefined, ws: 'bracket' });
    try {
      withWs(null, () => {
        assert.equal(getMilestonePhaseFilter(d, 'v2.0', undefined, 'foo').phaseCount, 3,
          'undefined must resolve foo\'s bracket convention');
        assert.equal(getMilestonePhaseFilter(d, 'v2.0', null, 'foo').phaseCount, 0,
          'null still means "explicitly not bracket" — the discriminator is intact');
      });
    } finally { cleanupDir(); }
  });

  test('a NON-bracket workstream counts identically under null and undefined', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-612-b1-legacy-'));
    const wsDir = path.join(dir, '.planning', 'workstreams', 'bar');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '## v2.0 — Second', '',
      '### Phase 01: Beta', '### Phase 02: Beta2', '',
    ].join('\n'));
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    try {
      withWs(null, () => {
        const asNull = getMilestonePhaseFilter(dir, 'v2.0', null, 'bar');
        const asUndef = getMilestonePhaseFilter(dir, 'v2.0', undefined, 'bar');
        assert.equal(asNull.phaseCount, asUndef.phaseCount);
        assert.equal(asUndef.phaseCount, 2);
      });
    } finally { cleanupDir(); }
  });
});

// ─── G8: the pin reads LIVE source, not a transcription ────────────────────

describe('#612 PR-2: every selector call site declares the right baseline (live src)', () => {
  // The structural table above pins transcription <-> selector. It cannot see a
  // call site whose BASELINE ARGUMENT is wrong: flipping the planning
  // snapshot's milestone-complete site from LABEL_ONLY to ANY_BRACKET grants a
  // fires-on-every-repo check `[anything] Phase N` tolerance it has never had,
  // and every behavioural test still passed. So the mode at each site is pinned
  // count-exact against the shipped sources.
  //
  // #2761 M4 (trek-e review): the source READING is no longer done here. This
  // block claimed the no-source-grep escape with a source-text-is-the-product
  // reason, but that escape (CONTEXT.md: RULESET.TESTS.no-source-grep.exemption)
  // is reserved for tests whose subject is a runtime CONTRACT FILE — STATE.md,
  // config.toml, hooks.json, agent .md — and `src/*.cts` is none of those.
  // Worse, the escape is FILE-level (eslint-rules/no-source-grep.cjs matches the
  // marker in any comment), so one block's claim disarmed the rule for all ~700
  // lines of this suite. Rather than widen the documented scope to fit the test,
  // the scan moved to the seam's own guard script
  // (`scripts/lint-phase-id-drift.cjs`, where source scanning is sanctioned and
  // already happens for the grammar rules) and is consumed here as STRUCTURED
  // DATA. No file text reaches this file and no marker remains, so the rule is
  // live again across the whole suite — the escape is gone, not relocated.
  const { scanSelectorBaselines } = require('../scripts/lint-phase-id-drift.cjs');
  const CENSUS = scanSelectorBaselines(require('path').join(__dirname, '..'));

  // file -> [ANY_BRACKET count, LABEL_ONLY count]
  const EXPECTED = {
    'commands.cts': [1, 0],
    'init.cts': [0, 2],
    'roadmap.cts': [3, 3],
    'validate.cts': [1, 2],
    'state.cts': [0, 3],
    'planning-snapshot.cts': [0, 2],
    'roadmap-parser.cts': [2, 0],
  };

  for (const [file, [anyBracket, labelOnly]] of Object.entries(EXPECTED)) {
    test(`${file}: ${anyBracket} any-bracket + ${labelOnly} label-only, and nothing else`, () => {
      const c = CENSUS[file];
      assert.ok(c, `${file} no longer consumes the selector at all — update EXPECTED`);
      assert.equal(c.ANY_BRACKET, anyBracket, `${file} any-bracket call count`);
      assert.equal(c.LABEL_ONLY, labelOnly, `${file} label-only call count`);
      assert.equal(
        c.total, anyBracket + labelOnly,
        `${file} has a phaseHeadingPrefixSrcFor call that does not name a PHASE_HEADING_BASELINE mode`,
      );
    });
  }

  test('no OTHER src file consumes the selector unpinned', () => {
    const unpinned = Object.keys(CENSUS).filter(f => !(f in EXPECTED)).sort();
    assert.deepEqual(unpinned, [], 'a new selector consumer must be added to EXPECTED');
  });

  test('the census is live — it found the consumers, not an empty scan', () => {
    // A census that silently returned {} would make every count assertion above
    // fail loudly, but the unpinned check would pass vacuously. Pin the floor.
    assert.deepEqual(Object.keys(CENSUS).sort(), Object.keys(EXPECTED).sort());
  });

  test('the transcription table covers exactly the live call sites', () => {
    const live = Object.values(EXPECTED).reduce((n, [a, l]) => n + a + l, 0);
    assert.equal(BASE_SITES.length, live, 'BASE_SITES row count must equal live call-site count');
  });
});
