'use strict';

/**
 * PR-2 (#2761 / epic #612) — the bracket-tolerant ROADMAP read path, at CLI level.
 *
 * Every reader here selects its heading grammar from the resolved
 * `phase_id_convention`. The two things that buys, both pinned below:
 *
 *   1. A project that has not opted in reads exactly as it did before. The
 *      counterexample corpus is the one that falsified the earlier ungated
 *      design — `### [RFC.2119] 5:`, `### [v1.0] 2026-01-15:`, `### [ADR.612] 3:`,
 *      `### [rev.2] 9:`, `### [Cluster B] Phase 26:` — each of which was claimed
 *      as a phase and moved `phase_count` / `total_phases` / W006 on legacy
 *      repos. They are asserted against the CLI, not against a regex.
 *
 *   2. A project that HAS opted in gets its bracket headings read, including the
 *      sentinel exclusion that the widening would otherwise break: under
 *      READING-B the sentinel milestone lives in the bracket, so a filter that
 *      tests the phase token is blind to `### [GSD.999] 01:` and counts an
 *      icebox item as a real phase (#1445 / #1580) — quietly, since #1446 took
 *      total_phases out of the ratchet.
 *
 * Fixtures are raw markdown strings, never rendered through renderPhaseId/toDir.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

let tmpDir;

const write = (roadmap, convention) => {
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify(convention === undefined ? {} : { phase_id_convention: convention }),
    'utf-8',
  );
};

const analyze = () => {
  const r = runGsdTools(['roadmap', 'analyze'], tmpDir);
  assert.ok(r.success, `roadmap analyze failed: ${r.error}`);
  return JSON.parse(r.output);
};

const BRACKET_ROADMAP = `# Roadmap

## [GSD.02] v2.0 — Foundation

- [x] **[GSD.02] 01: Setup**
- [ ] **[GSD.02] 05: Real work**
- [ ] **[GSD.02] 06: Follow-up**

### [GSD.02] 01: Setup
**Goal:** Lay the groundwork

### [GSD.02] 05: Real work
**Goal:** Build the thing

### [GSD.02] 06: Follow-up
**Goal:** Polish it
`;

// ─── The legacy no-op guarantee (the whole point of gating) ────────────────

describe('#612 PR-2: a non-bracket repo is untouched by the bracket read path', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-legacy-'); });
  afterEach(() => { cleanup(tmpDir); });

  // Each of these was claimed as a phase by the ungated design. `expect` is what
  // the base build reports, so a regression here is a visible number change.
  const COUNTEREXAMPLES = [
    ['### [RFC.2119] 5: Keyword definitions', 'RFC citation'],
    ['### [v1.0] 2026-01-15: Shipped release notes', 'version tag + date'],
    ['### [v1.0] 2024: Retrospective', 'version tag + year'],
    ['### [ADR.612] 3: Decisions to ratify', 'ADR citation'],
    ['### [rev.2] 9: Revision nine notes', 'lowercase tag'],
    ['### [ISO.8601] 2026: Dates', 'standard citation'],
    ['### [Cluster B] Phase 26: Clustered work', 'any-bracket + Phase label'],
    ['### [GSD] Phase 7: Bracketed legacy', 'project tag + Phase label'],
  ];

  for (const [heading, label] of COUNTEREXAMPLES) {
    for (const convention of [undefined, 'milestone-prefixed']) {
      test(`${label} adds no phase (convention=${convention ?? 'unset'})`, () => {
        write(`# Roadmap

## v1.0 — Foundation

### Phase 01: Setup
**Goal:** Groundwork

${heading}
**Goal:** Not a phase
`, convention);
        const out = analyze();
        // `[Cluster B] Phase 26` and `[GSD] Phase 7` DO match at base — the
        // any-bracket tolerance is pre-existing — so they legitimately count.
        const expected = /Phase \d/.test(heading) ? 2 : 1;
        assert.equal(
          out.phase_count, expected,
          `phase_count moved; phases=${JSON.stringify(out.phases.map(p => p.number))}`,
        );
      });
    }
  }

  test('a legacy roadmap reads its own headings, tags and checkboxes unchanged', () => {
    write(`# Roadmap

## v1.0 — Foundation

## Phase Overview:

- [x] **Phase 1: Foundation**
- [ ] **Phase 2-01: API**

### Phase 1: Foundation
**Goal:** Set up

### Phase 2-01 (INSERTED): API
**Goal:** Build it

#### Phase Details:
`, undefined);
    const out = analyze();
    assert.deepEqual(out.phases.map(p => [p.number, p.name]), [['1', 'Foundation'], ['2-01', 'API']]);
    assert.deepEqual(out.phases.map(p => p.roadmap_complete), [true, false]);
  });

  test('a bracket roadmap on a NON-bracket repo is invisible, not miscounted', () => {
    // Mid-migration disclosure: headings written in the new form before the
    // config is switched are not read. Silent invisibility is the deliberate
    // trade — the alternative is claiming phases on repos that never opted in.
    write(BRACKET_ROADMAP, undefined);
    const out = analyze();
    assert.equal(out.phase_count, 0, 'no phases, and no phantoms either');
  });
});

// ─── The bracket repo actually reads ───────────────────────────────────────

describe('#612 PR-2: a bracket repo reads its bracket headings', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-read-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('counts every phase and reads its NAME from the right capture group', () => {
    write(BRACKET_ROADMAP, 'bracket');
    const out = analyze();
    assert.equal(out.phase_count, 3);
    assert.deepEqual(
      out.phases.map(p => [p.number, p.name]),
      [['01', 'Setup'], ['05', 'Real work'], ['06', 'Follow-up']],
      'number AND name — a group-offset error garbles the name first',
    );
  });

  test('reads the Goal of each section (the heading is a section boundary)', () => {
    write(BRACKET_ROADMAP, 'bracket');
    assert.deepEqual(
      analyze().phases.map(p => p.goal),
      ['Lay the groundwork', 'Build the thing', 'Polish it'],
    );
  });

  test('reads summary-checkbox completion through a bracket bullet', () => {
    write(BRACKET_ROADMAP, 'bracket');
    assert.deepEqual(analyze().phases.map(p => p.roadmap_complete), [true, false, false]);
  });

  test('a legacy heading on a bracket repo still reads (migration window)', () => {
    write(`# Roadmap

## [GSD.02] v2.0

### [GSD.02] 05: Bracket form
**Goal:** a

### Phase 6: Legacy form
**Goal:** b
`, 'bracket');
    assert.deepEqual(analyze().phases.map(p => p.number), ['05', '6']);
  });

  test('get-phase resolves a bracket heading', () => {
    write(BRACKET_ROADMAP, 'bracket');
    const r = runGsdTools(['roadmap', 'get-phase', '05'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.found, true);
    assert.equal(out.phase_name, 'Real work');
    assert.equal(out.goal, 'Build the thing');
  });

  test('a checklist-only bracket phase reports malformed_roadmap', () => {
    write(`# Roadmap

## [GSD.02] v2.0

- [ ] **[GSD.02] 09: Summary only**

### [GSD.02] 05: Real work
**Goal:** a
`, 'bracket');
    const out = JSON.parse(runGsdTools(['roadmap', 'get-phase', '09'], tmpDir).output);
    assert.equal(out.found, false);
    assert.equal(out.error, 'malformed_roadmap');
    assert.equal(out.phase_name, 'Summary only');
  });
});

// ─── Sentinels (READING-B) ─────────────────────────────────────────────────

describe('#612 PR-2: bracket sentinel milestones never count', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-sentinel-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('999 and 00 bracket milestones are excluded from phase_count', () => {
    write(`# Roadmap

## [GSD.02] v2.0

### [GSD.999] 01: Icebox item
**Goal:** Someday

### [GSD.00] 02: Pre-milestone groundwork
**Goal:** Before v1

### [GSD.02] 05: Real work
**Goal:** Build it
`, 'bracket');
    const out = analyze();
    assert.deepEqual(out.phases.map(p => `${p.number}:${p.name}`), ['05:Real work']);
    assert.equal(out.phase_count, 1);
  });

  test('a LOWERCASE sentinel bracket is excluded too', () => {
    // Readers recognize `/i`; the identity helpers match `[A-Z]`. Without folding
    // the captured id, `[gsd.999]` failed every sentinel test and the icebox item
    // counted as a real phase.
    write(`# Roadmap

## [gsd.02] v2.0

### [gsd.999] 07: Icebox
**Goal:** Someday

### [gsd.00] 08: Pre-milestone
**Goal:** Before

### [gsd.02] 01: Real
**Goal:** Build
`, 'bracket');
    const out = analyze();
    assert.deepEqual(out.phases.map(p => p.number), ['01'], 'lowercase sentinels excluded');
  });

  test('a 999 bracket CHECKLIST entry is not a missing-detail phantom', () => {
    write(`# Roadmap

## [GSD.02] v2.0

- [ ] **[GSD.999] 01: Icebox item**
- [ ] **[GSD.02] 07: Genuinely missing**
- [ ] **[GSD.02] 05: Real work**

### [GSD.02] 05: Real work
**Goal:** Build it
`, 'bracket');
    assert.deepEqual(analyze().missing_phase_details, ['07']);
  });

  test('G5: a 999 token under a real milestone is STILL a backlog sentinel', () => {
    write(`# Roadmap

## [GSD.02] v2.0

### [GSD.02] 999: Late work
**Goal:** Build it
`, 'bracket');
    // READING-B adds the bracket rule; it does not repeal the engine-wide
    // 0/999 backlog convention (#1445/#1580). A bracketed heading is a sentinel
    // when EITHER its bracket milestone or its token is reserved.
    assert.deepEqual(analyze().phases.map(p => p.number), []);
  });

  test('legacy sentinel filtering is unchanged on a legacy repo', () => {
    write(`# Roadmap

## v2.0

### Phase 999.1: Icebox
**Goal:** a

### Phase 0: Pre-milestone
**Goal:** b

### Phase 5: Real
**Goal:** c
`, undefined);
    assert.deepEqual(analyze().phases.map(p => p.number), ['5']);
  });
});

// ─── validate.cts: the W006/W007 feeders and directory recognition ─────────

describe('#612 PR-2: validate.cts heading builders are convention-selected', () => {
  const validate = require('../gsd-core/bin/lib/validate.cjs');

  // The letter-tolerant `[\w][\w.-]*` capture lives here, so this is where an
  // ungated widening does the most damage: a phantom becomes a W007.
  const PHANTOM_HEADINGS = [
    '### [RFC.2119] 5: Keyword definitions',
    '### [v1.0] 2024: Retrospective',
    '### [ADR.612] 3: Decisions to ratify',
    '### [ISO.8601] 2026: Dates',
  ];

  test('a non-bracket repo admits none of the phantom headings', () => {
    const doc = ['### Phase 5: Real work', ...PHANTOM_HEADINGS].join('\n');
    for (const convention of [undefined, null, 'milestone-prefixed', 'Bracket']) {
      const { roadmapPhases } = validate.buildRoadmapPhaseVariants(doc, convention);
      assert.deepEqual([...roadmapPhases], ['5'], `convention=${convention}`);
    }
  });

  test('a bracket repo reads bracket headings', () => {
    const { roadmapPhases } = validate.buildRoadmapPhaseVariants(
      '### [GSD.02] 05: Real work\n### [GSD.02] 06: Follow-up\n', 'bracket',
    );
    assert.deepEqual([...roadmapPhases].sort(), ['05', '06']);
  });

  test('legacy headings and bullets are byte-identical either way', () => {
    const doc = [
      '### Phase 1: Foundation', '### Phase 2-01 (INSERTED): API', '### Phase 12A: Hotfix',
      '#### Phase Details:', '- [x] **Phase 3: Done**', '- [ ] **Phase 4: Todo**',
    ].join('\n');
    const legacy = [...validate.buildRoadmapPhaseVariants(doc).roadmapPhases].sort();
    assert.deepEqual(legacy, ['1', '12A', '2-01', '3', '4', 'Details'].sort());
    assert.deepEqual([...validate.buildRoadmapPhaseVariants(doc, 'bracket').roadmapPhases].sort(), legacy);
  });

  test('a label-only bullet site never gains any-bracket tolerance', () => {
    const doc = '- [x] **[GSD] Phase 2-01: Legacy**\n- [ ] **[GSD.02] 07: Bracket**\n';
    assert.deepEqual([...validate.buildRoadmapPhaseVariants(doc).roadmapPhases], []);
    assert.deepEqual([...validate.buildRoadmapPhaseVariants(doc, 'bracket').roadmapPhases], ['07']);
  });

  test('the unchecked-bullet site keeps its live W006 on a legacy repo', () => {
    // `[v1.0] Phase 05` in an unchecked bullet used to SUPPRESS a W006 that
    // fires at base — a vanishing warning, worse than an added one.
    const doc = '- [ ] **[v1.0] Phase 05: Thing**\n';
    assert.deepEqual([...validate.buildNotStartedPhaseVariants(doc)], [],
      'the bullet must not register phase 05 as not-started on a legacy repo');
    // `[v1.0]` is no longer a bracket id at all: the milestone width is now the
    // emit grammar's, and pad2 never produces a bare `0`. The residual this
    // previously disclosed is gone rather than merely gated.
    assert.deepEqual([...validate.buildNotStartedPhaseVariants(doc, 'bracket')], []);
  });

  test('a bracket repo picks up unchecked bracket bullets', () => {
    const notStarted = validate.buildNotStartedPhaseVariants(
      '- [ ] **[GSD.02] 05: Real work**\n- [x] **[GSD.02] 01: Done**\n', 'bracket');
    assert.ok(notStarted.has('05'));
    assert.ok(!notStarted.has('01'));
  });
});

describe('#612 PR-2: directory recognition is convention-gated', () => {
  const validate = require('../gsd-core/bin/lib/validate.cjs');
  const core = require('../gsd-core/bin/lib/phase-id.cjs');

  const LEGACY_DIRS = [
    '02-01-setup', '01-setup', 'GSD-02-01-setup', '999.1-backlog', '14-2026-photos',
    '02-04-01-deep', '12A-hotfix', 'not-a-phase', 'P0.34-56-name', 'P0.12-34-name',
    'P0.3-2-tenant', 'P0.16-gate',
  ];

  test('legacy dirs answer identically to the untouched constants', () => {
    for (const d of LEGACY_DIRS) {
      assert.equal(validate.isPhaseDirName(d), validate.phaseDirNameRe.test(d), d);
      const viaConst = d.match(validate.PHASE_TOKEN_FROM_DIR_RE);
      assert.equal(validate.phaseTokenFromDir(d), viaConst ? viaConst[1] : null, d);
    }
  });

  test('the default-off invariant, extended to the directory side', () => {
    for (const d of ['P0.34-56-name', 'P0.12-34-name']) {
      for (const convention of [undefined, null, 'milestone-prefixed', 'BRACKET']) {
        assert.equal(validate.isPhaseDirName(d, convention), false, `${d} / ${convention}`);
        assert.equal(validate.phaseTokenFromDir(d, convention), null);
      }
      assert.equal(validate.isPhaseDirName(d, 'bracket'), true, `${d} opted in`);
    }
  });

  test('bracket dirs resolve under the bracket convention', () => {
    for (const [dir, token] of [
      ['GSD.02-05-feature', '05'], ['GSD.02-05.03-feature', '05.03'],
      ['GSD.02-05', '05'], ['CK.01-12.04-feature', '12.04'], ['GSD_X2.100-05-feature', '05'],
    ]) {
      assert.equal(validate.isPhaseDirName(dir, 'bracket'), true, dir);
      assert.equal(validate.phaseTokenFromDir(dir, 'bracket'), token, dir);
      assert.equal(validate.isPhaseDirName(dir), false, `${dir} without the signal`);
    }
  });

  test('shapes outside the emit grammar are not bracket dirs', () => {
    // Admitting these would make the recognizer disagree with the resolver.
    for (const d of ['GSD.02-12A-hotfix', 'GSD.02-05.03.07-x', 'GSD.2-05-x', 'not-a-phase', 'GSD.02']) {
      assert.equal(validate.isPhaseDirName(d, 'bracket'), false, d);
    }
  });

  test('the two bracket dir readers agree on ACCEPTED and REJECTED input alike', () => {
    const corpus = [
      'GSD.02-05-feature', 'GSD.02-05.03-feature', 'GSD.02-05', 'CK.01-12.04-f',
      'GSD_X2.100-05-f', 'GSD.999-01-icebox', 'GSD.02-12A-hotfix', 'GSD.02-05.03.07-x',
      'GSD.2-05-x', '02-01-setup', 'GSD-02-01-setup', 'not-a-phase', 'P0.34-56-name',
    ];
    for (const dir of corpus) {
      const shaped = validate.BRACKET_PHASE_DIR_RE.test(dir);
      const viaOwner = core.extractPhaseToken(dir, 'bracket');
      if (shaped) {
        assert.equal(validate.phaseTokenFromDir(dir, 'bracket'), viaOwner, `accepted: ${dir}`);
      } else {
        // Rejected by the recognizer — the owner must NOT resolve it through the
        // bracket branch either, or W005 calls a directory malformed in the same
        // run that the milestone-complete check treats it as a real phase dir.
        const legacyToken = core.extractPhaseToken(dir);
        assert.equal(
          viaOwner, legacyToken,
          `rejected by the recognizer but bracket-resolved by the owner: ${dir}`,
        );
      }
    }
  });

  test('non-string input throws, matching the constants they wrap', () => {
    for (const bad of [42, undefined, null, {}, [], true]) {
      assert.throws(() => validate.isPhaseDirName(bad, 'bracket'), TypeError, String(bad));
      assert.throws(() => validate.phaseTokenFromDir(bad, 'bracket'), TypeError, String(bad));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-M1 — the DIRECTORY read inside `roadmap analyze`.
//
// `cmdRoadmapAnalyze` resolves the convention once and threads it into all four
// of its heading/checklist patterns, but the single `phaseTokenMatches` call
// that decides `disk_status` / `plan_count` / `summary_count` / `has_context` /
// `has_research` was left two-argument. Every canonical `{CODE}.{MM}-{PP}-slug`
// directory then read as `no_directory` with zero counts — while the SAME build
// resolved those same directories correctly in three other places on the same
// repo (W006/W007, `state json`, and the W021 milestone-complete read). Only the
// directory shape the convention exists to name failed; a mid-migration bracket
// repo carrying legacy `01-one` dirs resolved fine.
//
// Pinned the way the rest of this PR's gate is pinned: against the flat-legacy
// twin, computed in the same test run, PLUS exact literals so a shared wrong
// answer cannot pass. `grep disk_status tests/adr-612-*` was zero before this.
// ─────────────────────────────────────────────────────────────────────────────
describe('#612 PR-2: roadmap analyze resolves bracket phase DIRECTORIES', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-analyze-dir-'); });
  afterEach(() => { cleanup(tmpDir); });

  const BRK = `# Roadmap

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`;
  const LEG = `# Roadmap

## v2.0: Current

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`;

  /** Phase 01 complete (PLAN+SUMMARY), phase 02 planned (PLAN only). */
  const mkDirs = (specs) => {
    for (const [dir, stem, complete] of specs) {
      const q = path.join(tmpDir, '.planning', 'phases', dir);
      fs.mkdirSync(q, { recursive: true });
      fs.writeFileSync(path.join(q, `${stem}-01-PLAN.md`), '# plan\n', 'utf-8');
      if (complete) fs.writeFileSync(path.join(q, `${stem}-01-SUMMARY.md`), '# summary\n', 'utf-8');
    }
  };
  const diskShape = () => analyze().phases.map(
    p => [p.number, p.disk_status, p.plan_count, p.summary_count]);

  const BRK_DIRS = [['GSD.02-01-one', 'GSD.02-01', true], ['GSD.02-02-two', 'GSD.02-02', false]];
  const LEG_DIRS = [['01-one', '01', true], ['02-two', '02', false]];

  test('bracket dirs report complete/planned with real counts — not no_directory/0/0', () => {
    write(BRK, 'bracket');
    mkDirs(BRK_DIRS);
    assert.deepEqual(diskShape(), [['01', 'complete', 1, 1], ['02', 'planned', 1, 0]]);
  });

  test('and that shape equals its flat-legacy twin exactly', () => {
    write(BRK, 'bracket');
    mkDirs(BRK_DIRS);
    const bracket = diskShape();
    cleanup(tmpDir);
    tmpDir = createTempProject('adr-612-analyze-dir-leg-');
    write(LEG, undefined);
    mkDirs(LEG_DIRS);
    const legacy = diskShape();
    assert.deepEqual(bracket, legacy, 'bracket must read the disk exactly as the legacy twin does');
    assert.deepEqual(legacy, [['01', 'complete', 1, 1], ['02', 'planned', 1, 0]],
      'and the twin is the right answer, not a shared wrong one');
  });

  test('a bracket repo carrying LEGACY-shaped dirs still resolves (the read is additive)', () => {
    // This shape resolved even with the two-argument call, which is why the bug
    // was invisible: it failed ONLY for the canonical bracket directory name.
    write(BRK, 'bracket');
    mkDirs(LEG_DIRS);
    assert.deepEqual(diskShape(), [['01', 'complete', 1, 1], ['02', 'planned', 1, 0]]);
  });

  test('a NON-bracket repo is unaffected by the threaded convention', () => {
    write(LEG, undefined);
    mkDirs(LEG_DIRS);
    assert.deepEqual(diskShape(), [['01', 'complete', 1, 1], ['02', 'planned', 1, 0]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-m1 — the CHECKLIST scan in buildRoadmapPhaseVariants.
//
// The heading scan is sentinel-aware; its checklist twin was compiled
// non-capturing and called every token REAL. The occurrence-aware un-suppression
// loop then deleted the icebox token the heading scan had correctly marked
// sentinel, and `validate consistency` warned that a bracket ICEBOX phase had no
// directory — in the HOUSE ROADMAP shape, where the icebox appears as both a
// bold bullet and a detail heading. `validate health` stayed silent on the same
// repo, so the two verbs disagreed.
//
// Both directions are pinned here: the icebox must be silent, AND a REAL phase
// carrying the same token must still warn. A fix that over-suppresses fails the
// second test.
// ─────────────────────────────────────────────────────────────────────────────
describe('#612 PR-2: a bracket sentinel in the CHECKLIST index is suppressed too', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-checklist-sent-'); });
  afterEach(() => { cleanup(tmpDir); });

  const warnings = () => {
    const r = runGsdTools(['validate', 'consistency'], tmpDir);
    return (JSON.parse(r.output).warnings || []).filter(w => /no directory on disk/.test(w));
  };
  const realTwoOnDisk = () => fs.mkdirSync(
    path.join(tmpDir, '.planning', 'phases', 'GSD.02-02-real-two'), { recursive: true });

  test('house shape: icebox as BOTH a bold bullet and a heading is silent', () => {
    write(`# Roadmap

## [GSD.02] v2.0: Current

- [ ] **[GSD.999] 01: Icebox item**
- [ ] **[GSD.02] 02: Real two**

### [GSD.999] 01: Icebox item
**Goal:** z

### [GSD.02] 02: Real two
**Goal:** b
`, 'bracket');
    realTwoOnDisk();
    assert.deepEqual(warnings(), [], 'an icebox phase legitimately has no directory');
  });

  test('CONTROL: the same ROADMAP without the icebox lines is also silent', () => {
    // Makes the assertion above non-vacuous: silence must come from suppression,
    // not from the repo having nothing to say.
    write(`# Roadmap

## [GSD.02] v2.0: Current

- [ ] **[GSD.02] 02: Real two**

### [GSD.02] 02: Real two
**Goal:** b
`, 'bracket');
    realTwoOnDisk();
    assert.deepEqual(warnings(), []);
  });

  test('a REAL phase sharing the sentinel token still warns (no over-suppression)', () => {
    // The opposite direction. A checklist bullet for a REAL `[GSD.02] 01` must
    // un-suppress the token that the `[GSD.999] 01` heading marked sentinel.
    write(`# Roadmap

## [GSD.02] v2.0: Current

- [ ] **[GSD.02] 01: Real one**
- [ ] **[GSD.02] 02: Real two**

### [GSD.999] 01: Icebox item
**Goal:** z

### [GSD.02] 02: Real two
**Goal:** b
`, 'bracket');
    realTwoOnDisk();
    const w = warnings();
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /Phase 01/);
  });
});
