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

