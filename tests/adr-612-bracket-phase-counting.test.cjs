'use strict';

/**
 * PR-2 (#2761 / epic #612) — total_phases counts bracket phase headings.
 *
 * `total_phases` is derived TWICE: buildStateFrontmatter feeds `state json`, and
 * cmdStateSync feeds `state sync`. The second carries the comment "Mirrors the
 * logic in buildStateFrontmatter so both report consistent percents (#3242 Bug
 * B)". Teaching one and not the other ships that divergence.
 *
 * TWO ORACLE HAZARDS this file is shaped around:
 *
 *   1. #1446 removed total_phases from the ratchet, so it corrects DOWNWARD
 *      silently. Every assertion here is an EXACT number; "no error" or ">= n"
 *      passes straight through the bug.
 *
 *   2. Reading `state json` after `state sync` measures the READ derivation
 *      twice — sync leaves STATE.md untouched when its computed total already
 *      matches, so the write-path guard is never observed and a mutation to it
 *      survives. The sync assertions below pre-write a WRONG total into the
 *      frontmatter, run sync, and then read THE FILE, so the number asserted is
 *      the one sync actually wrote.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

let tmpDir;

const stateMd = () => [
  '---',
  'gsd_state_version: 1.0',
  'milestone: v2.0',
  'milestone_name: Expansion',
  'status: executing',
  '---',
  '',
  '# Project State',
  '',
  '**Phase:** 05',
  '',
  // The body Progress line is what makes sync derive and WRITE the progress
  // block; without it sync has nothing to update and STATE.md is left untouched.
  '**Progress:** [░░░░░░░░░░] 0%',
  '',
].join('\n');

function writeProject(roadmap, convention, dirs = ['GSD.02-01-setup']) {
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(path.join(planning, 'STATE.md'), stateMd(), 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify(convention === undefined ? {} : { phase_id_convention: convention }), 'utf-8',
  );
  // `state sync` short-circuits with no phase directories, leaving STATE.md
  // byte-unchanged — which is exactly how a mutation to the write-path counter
  // survives a test that reads `state json` afterwards. Give it real work.
  // A dir spec is either `'name'` (a PLAN and its SUMMARY — a COMPLETE phase,
  // the shape every earlier fixture in this file wants) or `['name', false]`
  // (a PLAN with no SUMMARY — INCOMPLETE). The numerator assertions at the end
  // of this file need the mix: a fixture where every phase is complete cannot
  // tell `completed_phases` apart from `total_phases`.
  for (const spec of dirs) {
    const [d, complete = true] = Array.isArray(spec) ? spec : [spec, true];
    const dir = path.join(planning, 'phases', d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-x-PLAN.md'), '# plan\n', 'utf-8');
    if (complete) fs.writeFileSync(path.join(dir, '01-01-x-SUMMARY.md'), '# summary\n', 'utf-8');
  }
}

/** total_phases as the READ path derives it. */
function readTotal() {
  const r = runGsdTools(['state', 'json'], tmpDir);
  assert.ok(r.success, `state json failed: ${r.error}`);
  return JSON.parse(r.output).progress?.total_phases ?? null;
}

/**
 * total_phases as the WRITE path derives it — read back out of STATE.md, not out
 * of `state json`. This is the assertion that observes cmdStateSync at all.
 */
function syncedTotal() {
  const r = runGsdTools(['state', 'sync'], tmpDir);
  assert.ok(r.success, `state sync failed: ${r.error}`);
  const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  const m = raw.match(/^\s*total_phases:\s*(\d+)\s*$/m);
  assert.ok(m, 'state sync must have written a total_phases into STATE.md');
  return parseInt(m[1], 10);
}

/**
 * The PERCENT `state sync` wrote into the STATE.md body.
 *
 * This is the only observable of cmdStateSync's own counter. Its
 * `syncTotalPhases` never reaches the frontmatter `total_phases` field — that
 * one is written by the read derivation — it reaches `computeProgressPercent`
 * and nothing else. Asserting the frontmatter number after a sync therefore
 * measures the READ path twice and lets a mutation to the write-path counter
 * survive, which is exactly how this guard shipped untested the first time.
 * Percent is completed/total, so the denominator is visible here.
 */
function syncedPercent() {
  const r = runGsdTools(['state', 'sync'], tmpDir);
  assert.ok(r.success, `state sync failed: ${r.error}`);
  const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  const m = raw.match(/^\*\*Progress:\*\*[^\r\n]*?(\d+)%/m);
  assert.ok(m, `state sync must have written a Progress percent; got:\n${raw}`);
  return parseInt(m[1], 10);
}

const BRACKET_ROADMAP = `# Roadmap

## [GSD.02] v2.0

### [GSD.02] 01: Setup
**Goal:** a

### [GSD.02] 05: Real work
**Goal:** b

### [GSD.02] 06: Follow-up
**Goal:** c
`;

describe('#612 PR-2: bracket phase headings enter total_phases', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-count-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('the read path counts all three (exact)', () => {
    writeProject(BRACKET_ROADMAP, 'bracket');
    assert.equal(readTotal(), 3);
  });

  test('#3242: the WRITE path writes the same number, observed in STATE.md', () => {
    // Stale total forces sync to do real work, so the number in the file is the
    // one cmdStateSync computed rather than the one that was already there.
    writeProject(BRACKET_ROADMAP, 'bracket');
    assert.equal(syncedTotal(), 3, 'state sync must WRITE 3');
    assert.equal(readTotal(), 3, 'and the read path must agree');
  });

  test('a NON-bracket repo counts neither form of the same roadmap', () => {
    // One phase directory on disk, three bracket headings the reader cannot see:
    // the total falls back to the directory count, exactly as it did before.
    writeProject(BRACKET_ROADMAP, undefined);
    assert.equal(readTotal(), 1, 'bracket headings are invisible without the convention');
    assert.equal(syncedTotal(), 1);
  });

  test('a mixed legacy + bracket roadmap counts both on a bracket repo', () => {
    writeProject(`# Roadmap

## v2.0

### Phase 1: Legacy one
**Goal:** a

### [GSD.02] 05: Bracket one
**Goal:** b

### Phase Overview:
`, 'bracket',
    // #2761 Major 1: the default single dir ('GSD.02-01-setup') names a phase
    // number ("01") this roadmap never declares — only "1" (legacy-labelled)
    // and "05" (bracket) are real — so post-Major-1 the disk-side milestone
    // filter correctly excludes it and `state sync` becomes a no-op (nothing
    // to write). Naming the ACTUAL bracket-declared phase here keeps this
    // test about what it says it's about (mixed heading-style counting), not
    // an accidental side effect of the disk-scan gating fixed elsewhere.
    ['GSD.02-05-bracket-one']);
    assert.equal(readTotal(), 2, '`Phase Overview:` still excluded');
    assert.equal(syncedTotal(), 2);
  });
});

describe('#612 PR-2: bracket sentinels stay OUT of both derivations', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-count-sent-'); });
  afterEach(() => { cleanup(tmpDir); });

  const SENTINEL_ROADMAP = `# Roadmap

## [GSD.02] v2.0

### [GSD.999] 01: Icebox item
**Goal:** a

### [GSD.00] 02: Pre-milestone
**Goal:** b

### [GSD.02] 05: Real work
**Goal:** c

### [GSD.02] 06: Follow-up
**Goal:** d
`;

  test('999.x and 0.x are excluded from the READ derivation (exact)', () => {
    writeProject(SENTINEL_ROADMAP, 'bracket');
    assert.equal(readTotal(), 2);
  });

  test('999.x and 0.x are excluded from the WRITE derivation too (observed in STATE.md)', () => {
    // The assertion that actually exercises cmdStateSync's sentinel guard —
    // reading `state json` after sync would measure the read path a second time
    // and let a mutation to the write path survive.
    // One completed phase directory — named for the REAL "05" phase this
    // roadmap declares (#2761 Major 1: the default dir names phase "01",
    // which this roadmap never declares, and the disk-side milestone filter
    // now correctly excludes an undeclared phase number from the WRITE-path
    // scan too, making `state sync` a no-op on the default dir). With the
    // sentinel guard the denominator is 2 (05, 06) so the percent is 50;
    // without it the two sentinel headings inflate it to 4 and the percent
    // drops to 25.
    writeProject(SENTINEL_ROADMAP, 'bracket', ['GSD.02-05-real-work']);
    assert.equal(syncedPercent(), 50, 'sentinel headings must not inflate the sync denominator');
  });

  test('a LOWERCASE sentinel bracket is excluded from both', () => {
    const doc = SENTINEL_ROADMAP.replace(/GSD\./g, 'gsd.');
    writeProject(doc, 'bracket', ['gsd.02-05-real-work']);
    assert.equal(readTotal(), 2);
    assert.equal(syncedTotal(), 2);
  });

  test('G5: a 999 token under a real milestone is still a backlog sentinel', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0

### [GSD.02] 999: Late work
**Goal:** a

### [GSD.02] 05: Real
**Goal:** b
`, 'bracket', ['GSD.02-05-real']);
    // The composed rule: bracket-sentinel OR legacy 999 token.
    assert.equal(readTotal(), 1);
    assert.equal(syncedTotal(), 1);
  });
});

describe('#612 PR-2: #1514 retired bracket phases leave the denominator', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-retired-'); });
  afterEach(() => { cleanup(tmpDir); });

  // The canonical #1514 gesture, verbatim from the shipped legacy tests: strike
  // the checklist BULLET and leave the detail heading intact. A bracket-form
  // retirement went undetected, so the phase stayed in the denominator forever
  // and a shipped bracket milestone could never reach 100%.
  const retiredRoadmap = (bullet, heading) => `# Roadmap

## [GSD.02] v2.0

- [x] ${bullet} — folded into 05; number retired
- [ ] **[GSD.02] 05: Real work**
- [ ] **[GSD.02] 06: Follow-up**

${heading}
**Goal:** folded

### [GSD.02] 05: Real work
**Goal:** b

### [GSD.02] 06: Follow-up
**Goal:** c
`;

  test('bullet-only strike (the canonical gesture) excludes the phase', () => {
    writeProject(
      retiredRoadmap('~~**[GSD.02] 04: Delta**~~', '### [GSD.02] 04: Delta'), 'bracket',
      // #2761 Major 1: name one of the two REAL (non-retired) phases so the
      // WRITE-path milestone filter has something to admit — the retired "04"
      // itself is deliberately never used here (that's a separate dedicated
      // test below).
      ['GSD.02-05-real-work']);
    assert.equal(readTotal(), 2, 'the retired bracket phase must leave the denominator');
    assert.equal(syncedTotal(), 2);
  });

  test('unbolded bullet strike also excludes', () => {
    writeProject(
      retiredRoadmap('~~[GSD.02] 04: Delta~~', '### [GSD.02] 04: Delta'), 'bracket');
    assert.equal(readTotal(), 2);
  });

  test('a struck HEADING is excluded as well (it simply stops matching)', () => {
    writeProject(
      retiredRoadmap('~~**[GSD.02] 04: Delta**~~', '#### ~~**[GSD.02] 04: Delta**~~'), 'bracket');
    assert.equal(readTotal(), 2);
  });

  test('the legacy retirement gesture is unchanged', () => {
    writeProject(`# Roadmap

## v2.0

- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired
- [ ] **Phase 05: Real**

### Phase 04: Delta
**Goal:** folded

### Phase 05: Real
**Goal:** b

### Phase 06: Other
**Goal:** c
`, undefined);
    assert.equal(readTotal(), 2, 'legacy 04 retired, 05 and 06 remain');
  });

  test('a retired bracket phase DIRECTORY is skipped too', () => {
    // The other half of the same comparison: the retired key has to match the
    // directory's key, and phaseKeyFromDir needs the convention to produce one.
    writeProject(
      retiredRoadmap('~~**[GSD.02] 04: Delta**~~', '### [GSD.02] 04: Delta'), 'bracket',
      ['GSD.02-04-delta', 'GSD.02-05-real-work', 'GSD.02-06-follow-up']);
    // Three directories on disk, one of them retired. If phaseKeyFromDir cannot
    // key a bracket directory the retired one is counted anyway and the total is
    // 3 — the denominator a shipped bracket milestone could never work off.
    assert.equal(readTotal(), 2, 'the retired phase must not be re-added by its directory');
  });
});

describe('#612 PR-2: legacy counting is byte-identical', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-count-legacy-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('#549: pure-word section headings still excluded (exact)', () => {
    writeProject(`# Roadmap

## v2.0

## Phase Overview:

### Phase 1: One
**Goal:** a

### Phase 2.1: Two point one
**Goal:** b

### Phase 12A: Letter suffix
**Goal:** c

#### Phase Details:
`, undefined);
    assert.equal(readTotal(), 3);
    assert.equal(syncedTotal(), 3);
  });

  test('#1445: a legacy 999.x heading is still excluded from the read path', () => {
    writeProject(`# Roadmap

## v2.0

### Phase 999.1: Icebox
**Goal:** a

### Phase 5: Real
**Goal:** b
`, undefined);
    assert.equal(readTotal(), 1);
  });

  test('a project-code phase id still counts (exact)', () => {
    writeProject(`# Roadmap

## v2.0

### Phase PROJ-42: Coded
**Goal:** a

### Phase 5: Real
**Goal:** b
`, undefined);
    assert.equal(readTotal(), 2);
    assert.equal(syncedTotal(), 2);
  });
});

describe('#612 PR-2: the ADR-canonical milestone heading scopes the milestone', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-scope-'); });
  afterEach(() => { cleanup(tmpDir); });

  // ADR-612 Decision 1 pins the bracket milestone heading as `## [GSD.02] Foundation`
  // — a NAME, with no version. Milestone scoping matches STATE's `milestone: v2.0`
  // STRING against a heading, so the canonical form matched nothing, scoping was
  // lost, and total_phases fell back to the on-disk directory count. Every earlier
  // fixture in this file embeds `v2.0` in the heading and so never ran the form
  // the ADR actually specifies.
  const roadmap = (heading) => `# Roadmap

${heading}

### [GSD.02] 05: Real work
**Goal:** a

### [GSD.02] 06: Follow-up
**Goal:** b

### [GSD.02] 07: Third
**Goal:** c
`;

  test('name-only heading: total_phases comes from the ROADMAP, not the dir count', () => {
    writeProject(roadmap('## [GSD.02] Foundation'), 'bracket', ['GSD.02-05-real-work']);
    assert.equal(readTotal(), 3, 'three headings in scope, not one directory');
  });

  test('the dir count no longer drives the answer', () => {
    // The tell for the fallback: without scoping the total tracks the number of
    // directories instead of staying at the ROADMAP's phase count.
    writeProject(roadmap('## [GSD.02] Foundation'), 'bracket',
      ['GSD.02-05-real-work', 'GSD.02-06-follow-up']);
    assert.equal(readTotal(), 3);
  });

  test('the version-embedded heading still works', () => {
    writeProject(roadmap('## [GSD.02] v2.0 — Foundation'), 'bracket', ['GSD.02-05-real-work']);
    assert.equal(readTotal(), 3);
  });

  test('an unpadded bracket milestone scopes NOTHING (emit-grammar strict)', () => {
    // Post-unification an unpadded `[GSD.2]` is malformed: it is not a phase id,
    // so it must not bound or scope a milestone either. The tell is that the
    // bracket reading equals the null-convention reading — if either behaviour
    // flips, these two numbers diverge.
    // The tell is that the unpadded heading SCOPES NOTHING: with it, the reading
    // must equal the reading of a roadmap that has no milestone heading at all.
    // If `[GSD.2]` ever starts scoping again, these two diverge.
    const dirs = ['GSD.02-05-real-work'];
    writeProject(roadmap('## [GSD.2] Foundation'), 'bracket', dirs);
    const unpadded = readTotal();
    writeProject(roadmap('## Some heading with no milestone'), 'bracket', dirs);
    const unscoped = readTotal();
    assert.equal(unpadded, unscoped,
      'an unpadded bracket milestone must bound nothing, exactly like no milestone heading');
    // And the canonical spelling DOES scope, so the pair is not trivially equal.
    writeProject(roadmap('## [GSD.02] Foundation'), 'bracket', dirs);
    assert.equal(readTotal(), 3, 'the padded spelling scopes');
  });

  test('a milestone that does NOT match STATE is not scoped in', () => {
    writeProject(`# Roadmap

## [GSD.03] Later milestone

### [GSD.03] 09: Not this milestone
**Goal:** a
`, 'bracket', ['GSD.02-05-real-work']);
    // The disk-side milestone filter is convention-selected now, so a directory
    // whose phase is not in the scoped ROADMAP is excluded rather than counted:
    // STATE asserts v2.0 and the ROADMAP only describes milestone 03.
    assert.equal(readTotal(), 0, 'no phases for the asserted milestone');
  });

  test('a NON-bracket repo does not gain bracket scoping', () => {
    writeProject(roadmap('## [GSD.02] Foundation'), undefined, ['GSD.02-05-real-work']);
    assert.equal(readTotal(), 1, 'no scoping, no counting — invisible as designed');
  });
});

describe('#612 PR-2: labeled sentinels, composed sentinels, and the disk-side filter', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-g3g4g5-'); });
  afterEach(() => { cleanup(tmpDir); });

  const analyze = () => {
    const r = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(r.success, `roadmap analyze failed: ${r.error}`);
    return JSON.parse(r.output);
  };

  test('G3: a LABELED bracket sentinel is excluded from every counter', () => {
    // `### [GSD.999] Phase 07:` fell through to the base alternative, which
    // captures nothing — so analyze applied the legacy token rule and counted it
    // while state json excluded it. Two derivations of one ROADMAP disagreed.
    writeProject(`# Roadmap

## [GSD.02] v2.0

### [GSD.999] Phase 07: Icebox labeled
**Goal:** a

### [GSD.999] 08: Icebox bare
**Goal:** b

### [GSD.02] 01: Real
**Goal:** c
`, 'bracket');
    const out = analyze();
    assert.deepEqual(out.phases.map(p => p.number), ['01'], 'labeled and bare both excluded');
    assert.equal(readTotal(), 1);
    assert.equal(out.phase_count, readTotal(), 'analyze and state must agree');
  });

  test('G5: the legacy 999/0 token rule still applies to a bracketed heading', () => {
    // READING-B ADDS a rule; it does not replace one. A mid-migration ROADMAP
    // carrying a legacy backlog block under bracket headings must not gain
    // denominator entries.
    writeProject(`# Roadmap

## [GSD.02] v2.0

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 999: Backlog
**Goal:** b

### [GSD.02] 0: Zero
**Goal:** c
`, 'bracket');
    const out = analyze();
    assert.deepEqual(out.phases.map(p => p.number), ['01'],
      'analyze excludes both the 999 and the 0 token, as it does for legacy headings');
    // DISCLOSED, pre-existing: the state counter's legacy token rule is 999-only
    // — it has never excluded a bare `0` — so `[GSD.02] 0:` still reaches the
    // denominator there. Adding a 0 filter would move legacy totals, which is out
    // of scope; what this pin asserts is that the 999 rule was not DROPPED for
    // bracketed headings.
    // Under bracket the token rule composes as the full {0, 999} set, so this
    // counter now agrees with roadmap analyze. The LEGACY path keeps its
    // pre-existing 999-only rule — pinned separately.
    assert.equal(readTotal(), 1, 'both 999 and 0 excluded under bracket');
  });

  test('G4: the disk-side milestone filter does not count another milestone dirs', () => {
    // getMilestonePhaseFilter's heading scan collected nothing on a bracket
    // ROADMAP, so it degraded to pass-all and Math.max(dirs, roadmap) counted
    // the previous milestone's directories — making bracket strictly worse than
    // the M-NN convention it supersedes.
    writeProject(`# Roadmap

## [GSD.02] v2.0

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

### [GSD.02] 03: Three
**Goal:** c
`, 'bracket', ['GSD.01-01-prev', 'GSD.01-02-prev2', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.02-03-three']);
    assert.equal(readTotal(), 3, 'scoped to this milestone, not the whole disk');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four numbers `total_phases` was hiding.
//
// Every bracket counting assertion above reads `total_phases` and nothing else,
// and `total_phases` is the ONE number the disk-side milestone filter cannot
// move: `Math.max(phaseDirs.length, roadmapPhaseCount)` (state.cts) floors it at
// the ROADMAP count no matter how many directories the filter rejects. So a
// filter that rejects EVERY bracket directory leaves that number right and
// zeroes `completed_phases`, `total_plans`, `completed_plans` and `percent` —
// green suite, `state json` reporting 0% on a repo `state sync` calls 67% in the
// same second. These pin all five.
//
// THE ORACLE IS THE LEGACY TWIN, and it is computed in the same run rather than
// quoted: each test builds the identical repo in the flat legacy spelling and
// asserts the bracket reading equals it, number for number. Exact literals are
// asserted too — an equality alone would pass with both sides broken.
//
// WHY FLAT LEGACY AND NOT M-NN. The M-NN spelling of these shapes cannot serve
// as the oracle: buildStateFrontmatter's #2445 de-dup key is
// `dir.match(/^0*(\d+[A-Za-z]?(?:\.\d+)*)/)`, which captures only the LEADING
// integer, so `02-01-one`, `02-02-two` and `02-03-three` all key to `2` and two
// of the three directories are dropped before they are ever counted. Measured
// on the true base build (d04592de), the M-NN twin of the first shape below
// reads `[3,0,1,0,0]` where flat legacy reads `[3,2,3,2,67]`; the divergence is
// present identically at base and is untouched by this PR. It is a legacy defect
// in a key space bracket directories cannot enter — `GSD.02-01-one` does not
// match that regex at all, so each bracket dir keys to its own name. The
// source's own `phase-id-owner:` sanction at that line records the divergence.
// ─────────────────────────────────────────────────────────────────────────────

/** The whole progress block as the READ path derives it. */
function readProgress() {
  const r = runGsdTools(['state', 'json'], tmpDir);
  assert.ok(r.success, `state json failed: ${r.error}`);
  const p = JSON.parse(r.output).progress || {};
  return [p.total_phases, p.completed_phases, p.total_plans, p.completed_plans, p.percent];
}

/**
 * The progress block `state sync` WROTE into STATE.md.
 *
 * Labelled precisely: this is the READ derivation observed a second time (sync
 * rebuilds the frontmatter through buildStateFrontmatter). It is asserted
 * because a write that disagrees with `state json` is the #3242 Bug B artifact
 * this file exists to prevent — but it is NOT coverage of cmdStateSync's own
 * counter. That counter reaches `computeProgressPercent` and nothing else, so
 * `syncedPercent()` above is its only observable.
 *
 * `state json` echoes a `progress:` frontmatter block verbatim when one exists
 * and only derives when there is none, so this must be read out of the FILE and
 * `stateMd()` must stay block-free. (Measured: same repo, block-free `state
 * json` → 3/2/3/2/67; with a `progress: 99…` block → 99/99/99/99/99.)
 */
function syncedProgress() {
  const r = runGsdTools(['state', 'sync'], tmpDir);
  assert.ok(r.success, `state sync failed: ${r.error}`);
  const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  const m = raw.match(
    /total_phases:\s*(\d+)[\s\S]*?completed_phases:\s*(\d+)[\s\S]*?total_plans:\s*(\d+)[\s\S]*?completed_plans:\s*(\d+)[\s\S]*?percent:\s*(-?\d+)/);
  assert.ok(m, `state sync must have written a full progress block; got:\n${raw}`);
  return m.slice(1).map(Number);
}

describe('#612 PR-2: the disk-side filter scopes bracket dirs — all five numbers', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-fivenum-'); });
  afterEach(() => { cleanup(tmpDir); });

  // ── SHAPE 1: one milestone, three phases, three dirs, the first two complete ──
  const ONE_MILESTONE_BRACKET = `# Roadmap

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

### [GSD.02] 03: Three
**Goal:** c
`;
  const ONE_MILESTONE_LEGACY = `# Roadmap

## v2.0: Current

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b

### Phase 03: Three
**Goal:** c
`;
  // The M-NN spelling of the same shape — pinned as a CHARACTERIZATION at the end
  // of this block, not used as an oracle. See the comment there.
  const ONE_MILESTONE_MNN = `# Roadmap

## v2.0: Current

### Phase 2-01: One
**Goal:** a

### Phase 2-02: Two
**Goal:** b

### Phase 2-03: Three
**Goal:** c
`;
  const ONE_BRACKET_DIRS = ['GSD.02-01-one', 'GSD.02-02-two', ['GSD.02-03-three', false]];
  const ONE_LEGACY_DIRS = ['01-one', '02-two', ['03-three', false]];
  const ONE_MNN_DIRS = ['02-01-one', '02-02-two', ['02-03-three', false]];

  test('shape 1 READ: 3 phases, 2 complete, 3 plans, 2 done, 67% — not four zeros', () => {
    writeProject(ONE_MILESTONE_BRACKET, 'bracket', ONE_BRACKET_DIRS);
    assert.deepEqual(readProgress(), [3, 2, 3, 2, 67],
      'every bracket directory must satisfy the milestone filter');
  });

  test('shape 1 READ equals its flat-legacy twin exactly', () => {
    writeProject(ONE_MILESTONE_BRACKET, 'bracket', ONE_BRACKET_DIRS);
    const bracket = readProgress();
    writeProject(ONE_MILESTONE_LEGACY, undefined, ONE_LEGACY_DIRS);
    const legacy = readProgress();
    assert.deepEqual(bracket, legacy, 'bracket must read exactly what the legacy twin reads');
    assert.deepEqual(legacy, [3, 2, 3, 2, 67], 'and the twin is the right answer, not a shared wrong one');
  });

  test('shape 1 WRITE: sync writes 67%, and its frontmatter agrees with `state json`', () => {
    writeProject(ONE_MILESTONE_BRACKET, 'bracket', ONE_BRACKET_DIRS);
    // The write derivation's own observable.
    assert.equal(syncedPercent(), 67, 'state sync must write 67% into the body');
    // …and the block it wrote must not contradict it (#3242 Bug B).
    assert.deepEqual(syncedProgress(), [3, 2, 3, 2, 67]);
    assert.deepEqual(readProgress(), syncedProgress(), 'the two derivations must not disagree');
  });

  test('shape 1 WRITE percent equals its flat-legacy twin', () => {
    writeProject(ONE_MILESTONE_BRACKET, 'bracket', ONE_BRACKET_DIRS);
    const bracket = syncedPercent();
    writeProject(ONE_MILESTONE_LEGACY, undefined, ONE_LEGACY_DIRS);
    assert.equal(bracket, syncedPercent());
    assert.equal(bracket, 67);
  });

  // ── SHAPE 2: two milestones, scoped to v2.0, two stale prior-milestone dirs ──
  const TWO_MILESTONE_BRACKET = `# Roadmap

## [GSD.01] v1.0: Prior

### [GSD.01] 01: Old one
**Goal:** a

### [GSD.01] 02: Old two
**Goal:** b

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** c

### [GSD.02] 02: Two
**Goal:** d

### [GSD.02] 03: Three
**Goal:** e
`;
  const TWO_MILESTONE_LEGACY = `# Roadmap

## v1.0: Prior

### Phase 01: Old one
**Goal:** a

### Phase 02: Old two
**Goal:** b

## v2.0: Current

### Phase 03: One
**Goal:** c

### Phase 04: Two
**Goal:** d

### Phase 05: Three
**Goal:** e
`;
  const TWO_BRACKET_DIRS = ['GSD.01-01-old-one', 'GSD.01-02-old-two', 'GSD.02-01-one',
    ['GSD.02-02-two', false], ['GSD.02-03-three', false]];
  const TWO_LEGACY_DIRS = ['01-old-one', '02-old-two', '03-one', ['04-two', false], ['05-three', false]];

  test('shape 2 READ: the prior milestone dirs are excluded — 3/1/3/1/33', () => {
    // Both milestones number their phases 01/02/…, so the bare token cannot tell
    // `GSD.01-01-old-one` from `GSD.02-01-one`. Only the milestone-qualified key
    // separates them; matching on the token would read 5/3/5/3/60 instead.
    writeProject(TWO_MILESTONE_BRACKET, 'bracket', TWO_BRACKET_DIRS);
    assert.deepEqual(readProgress(), [3, 1, 3, 1, 33]);
  });

  test('shape 2 READ equals its flat-legacy twin exactly', () => {
    writeProject(TWO_MILESTONE_BRACKET, 'bracket', TWO_BRACKET_DIRS);
    const bracket = readProgress();
    writeProject(TWO_MILESTONE_LEGACY, undefined, TWO_LEGACY_DIRS);
    const legacy = readProgress();
    assert.deepEqual(bracket, legacy);
    assert.deepEqual(legacy, [3, 1, 3, 1, 33]);
  });

  test('shape 2 WRITE (#2761 Major 1 fix): bracket closes to 33% (matches read); legacy stays at the disclosed 60%', () => {
    // UPDATED by #2761 Major 1 — this test used to pin the BUG this fix
    // closes, titled "the DISCLOSED legacy gap, mirrored — not closed":
    // cmdStateSync did its own `fs.readdirSync` and never called the
    // milestone filter, so its denominator was the whole disk (3 summaries
    // over 5 plans = 60%) against the read path's scoped 33% — for BOTH
    // bracket and legacy alike, since the divergence was engine-wide, not
    // bracket-specific.
    //
    // Major 1 gates cmdStateSync's disk scan by getMilestonePhaseFilter under
    // `phase_id_convention === 'bracket'` ONLY — deliberately NOT
    // unconditionally: an unconditional filter would ALSO move every legacy
    // repo's persisted percent, which is out of this fix's scope (the
    // binding constraint is "legacy stays byte-identical"). So: bracket now
    // closes to 33% (agrees with the read path — repro3's fix, verified
    // here on a SECOND fixture with real prior-milestone noise dirs);
    // legacy stays at the pre-existing 60% (unchanged, deliberately).
    writeProject(TWO_MILESTONE_BRACKET, 'bracket', TWO_BRACKET_DIRS);
    assert.equal(syncedPercent(), 33, 'bracket: the gap is now closed, agrees with the read path');
    writeProject(TWO_MILESTONE_LEGACY, undefined, TWO_LEGACY_DIRS);
    assert.equal(syncedPercent(), 60, 'legacy: the gap remains — moving it is out of this fix\'s scope');
  });

  test('shape 2 WRITE frontmatter agrees with `state json` on both spellings', () => {
    writeProject(TWO_MILESTONE_BRACKET, 'bracket', TWO_BRACKET_DIRS);
    assert.deepEqual(syncedProgress(), [3, 1, 3, 1, 33]);
    assert.deepEqual(readProgress(), syncedProgress());
    writeProject(TWO_MILESTONE_LEGACY, undefined, TWO_LEGACY_DIRS);
    assert.deepEqual(syncedProgress(), [3, 1, 3, 1, 33]);
    assert.deepEqual(readProgress(), syncedProgress());
  });

  test('a bracket repo carrying LEGACY-shaped dirs is unaffected (the branch is additive)', () => {
    // The bracket branch tries the qualified key first and FALLS THROUGH on a
    // miss, so the three legacy dir checks still run on a bracket project. An
    // early `return false` there would silently drop this repo to zero.
    writeProject(ONE_MILESTONE_LEGACY, 'bracket', ONE_LEGACY_DIRS);
    assert.deepEqual(readProgress(), [3, 2, 3, 2, 67]);
  });

  test('CHARACTERIZATION: the M-NN twin of shape 1 counts ONE plan, not three', () => {
    // Holds the oracle substitution honest. The two "equals its flat-legacy
    // twin" tests above compare bracket against FLAT legacy; nothing else in the
    // suite pins the M-NN spelling, so the changeset's claim that the M-NN
    // divergence is pre-existing and untouched would go stale silently the first
    // time a sibling slice widens the de-dup key.
    //
    // buildStateFrontmatter's #2445 de-dup key captures only a directory's
    // LEADING integer (state.cts, under its own `phase-id-owner:` sanction), so
    // `02-01-one`, `02-02-two` and `02-03-three` all key to `2` and two of the
    // three are dropped before they are ever counted. Measured identical on the
    // true base build (d04592de), on the pre-fix HEAD, and here.
    //
    // The full reading measured on the base build is [3,0,1,0,0], but the two
    // numerator fields depend on WHICH directory wins, and the winner is the one
    // with the newest mtime among three created inside a single test — a tie on
    // a coarser-granularity filesystem than this was measured on would flip
    // completed_phases/completed_plans/percent without any behaviour changing.
    // So the pin is the two survivor-INDEPENDENT numbers: total_phases still
    // comes from the ROADMAP (3), and exactly one directory survives the de-dup,
    // carrying exactly one plan. If the de-dup key is ever widened, total_plans
    // goes to 3 and this fails — which is the whole point.
    writeProject(ONE_MILESTONE_MNN, undefined, ONE_MNN_DIRS);
    const mnn = readProgress();
    assert.equal(mnn[0], 3, 'M-NN: total_phases still tracks the ROADMAP');
    assert.equal(mnn[2], 1, 'M-NN: one plan counted, from the single de-duped dir');
    // …and the flat-legacy twin of the same repo does NOT collapse, which is why
    // it, not this, is the parity oracle for the bracket assertions above.
    writeProject(ONE_MILESTONE_LEGACY, undefined, ONE_LEGACY_DIRS);
    assert.deepEqual(readProgress(), [3, 2, 3, 2, 67]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-m3 — the milestone-qualified key is a string SPLICE, so a heading whose
// token carries its own hyphen mis-parses into the wrong directory.
//
// `### [GSD.02] Phase 02-01:` spliced to `GSD.02-02-01`, which the qualified-key
// grammar reads as milestone 02 / phase 02 — the trailing `-01` truncated, both
// such headings collapsing to one key, and the heading claiming
// `GSD.02-02-two` (the directory it does NOT name) while rejecting
// `GSD.02-01-one` (the one it does).
//
// The oracle is the SAME ROADMAP read under `milestone-prefixed`, which is
// base-identical on this shape — so the bracket acceptance vector must equal it.
// Scope note: only the ACCEPTANCE VECTOR is claimed base-equivalent.
// `total_phases` on this fixture does move 1 -> 2, because the bracket heading
// count is the feature this PR ships; measured, that move is identical with and
// without this guard, and identical to what the canonical `### [GSD.02] 01:`
// spelling does (both read 2 with zero directories on disk, where base reads 0).
// ─────────────────────────────────────────────────────────────────────────────
describe('#612 PR-2: a hyphenated heading token forms no qualified key', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-hyphen-tok-'); });
  afterEach(() => { cleanup(tmpDir); });

  const MIXED = `# Roadmap

## [GSD.02] v2.0: Current

### [GSD.02] Phase 02-01: One
**Goal:** a

### [GSD.02] Phase 02-02: Two
**Goal:** b
`;
  const DIRS = ['GSD.02-02-two', 'GSD.02-01-one', '02-01-mnn', '02-2026-photos', '46-6-rs-thing', '2-01-x'];

  /** The disk-side filter's own acceptance vector, read straight off the module. */
  const acceptance = () => {
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    return Object.fromEntries(DIRS.map(d => [d, !!f(d)]));
  };

  test('the heading does not claim the directory it does not name', () => {
    writeProject(MIXED, 'bracket', DIRS);
    const a = acceptance();
    assert.equal(a['GSD.02-02-two'], false,
      '`[GSD.02] Phase 02-01` must not claim GSD.02-02-two by a truncated key');
    assert.equal(a['GSD.02-01-one'], false,
      'and it does not resolve its own dir either — unqualified, exactly as at base');
    assert.equal(a['02-01-mnn'], true, 'the legacy fall-through is untouched');
  });

  test('the acceptance vector equals the milestone-prefixed control on the same ROADMAP', () => {
    writeProject(MIXED, 'bracket', DIRS);
    const bracket = acceptance();
    cleanup(tmpDir);
    tmpDir = createTempProject('adr-612-hyphen-tok-ctl-');
    writeProject(MIXED, 'milestone-prefixed', DIRS);
    const control = acceptance();
    assert.deepEqual(bracket, control,
      'a hyphenated token must read the disk identically under both conventions');
  });

  test('a CANONICAL bracket heading still forms its qualified key', () => {
    // Guards the guard: `!token.includes('-')` must not disable qualified
    // matching for the spelling the convention actually specifies.
    writeProject(`# Roadmap

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a
`, 'bracket', ['GSD.02-01-one', 'GSD.01-01-old-one']);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(f('GSD.02-01-one'), true, 'the canonical qualified key still resolves');
    assert.equal(f('GSD.01-01-old-one'), false, 'and still scopes out the foreign milestone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-m2 — extractCurrentMilestone must not throw.
//
// Its bracket-scoping fallback calls resolvePhaseIdConvention, which reaches
// planningDir, which throws a plain Error for a GSD_PROJECT/GSD_WORKSTREAM
// segment containing `/`, `\` or `..`. At base the only planningDir call in this
// function sits inside the STATE-read try, so the function returned normally;
// an unguarded call broke the never-throws invariant that getRoadmapPhaseInternal
// and getMilestoneInfo carry #2245 / ADR-227 notes about.
//
// Module level on purpose: the CLI rejects a bad GSD_WORKSTREAM up front, so
// this contract is only observable to an in-process embedder — which is exactly
// who the invariant protects.
// ─────────────────────────────────────────────────────────────────────────────
describe('#612 PR-2: extractCurrentMilestone never throws on a poisoned env', () => {
  const ROADMAP = `# Roadmap

## Milestones

- 🚧 **v1.0 Alpha** — in progress

## Alpha

### Phase 01: Setup
`;

  test('a traversal segment in GSD_WORKSTREAM degrades instead of escaping', () => {
    const dir = createTempProject('adr-612-envguard-');
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}', 'utf-8');
    const prior = process.env.GSD_WORKSTREAM;
    try {
      process.env.GSD_WORKSTREAM = '../evil';
      const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
      const out = rp.extractCurrentMilestone(ROADMAP, dir);
      assert.equal(typeof out, 'string', 'must return content, not throw');
      assert.ok(out.length > 0);
    } finally {
      // Restore before anything else in this chunk runs — a leaked
      // GSD_WORKSTREAM would poison every later test in the same process.
      if (prior === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = prior;
      cleanup(dir);
    }
  });
});

// ─── REGRESSION: the version-less bracket milestone heading now scopes ──────

/**
 * FIXED (#2761 B1, reviewer trek-e blocker). Every other bracket fixture in
 * this repo writes its milestone heading as `## [GSD.02] v2.0: Current` — with a
 * version. ADR-612's canonical form is a NAME and no version
 * (`## [GSD.02] Foundation`), which `isMilestoneBounded`'s own doc comment in
 * state.cts calls out as canonical. Until this fix, that form left the
 * disk-side filter unscoped: directories from BOTH the prior and the later
 * milestone were admitted into the current one.
 *
 * Mechanism, in `extractCurrentMilestone` (roadmap-parser.cts):
 *   - the bracket scope branch selects the right `currentSection`, but
 *   - `preambleCutoff` was driven only by `anyMilestonePattern`, which requires
 *     `v\d+\.\d+` or a status emoji. A version-less roadmap matches none, so the
 *     cutoff fell back to the CURRENT milestone's own offset and every PRIOR
 *     milestone landed in the preamble — whose phase-stripping regex only strips
 *     `Phase N:`-labelled headings, so bracket phase headings survived it; and
 *   - `computeSectionEnd` accepted a boundary only if the heading carried a
 *     version or emoji, so with none present the section ran to EOF and every
 *     LATER milestone was swept in too.
 *
 * The leak was bidirectional and had two sites. The fix: under the bracket
 * scope branch (`bracketScopeConvention === 'bracket'`), both
 * `computeSectionEnd` and the `preambleCutoff` scan ALSO accept a
 * `#{1,2}\s+\[CODE.MM\]` heading as a milestone boundary, built from
 * phase-id.cts's `BRACKET_ID_SRC` (the single owner of the bracket-id grammar)
 * rather than a re-typed literal. `#{1,2}` is the discriminator because bracket
 * PHASE headings are `###` and carry the same `[CODE.MM]` prefix (a `#{1,3}`
 * pattern would match both, which is why the scope branch's own matcher returns
 * the phase headings as well). Reachable ONLY when the bracket scope branch has
 * fired, so version-bearing/emoji repos and non-bracket conventions take the
 * exact pre-existing code path.
 *
 * These tests used to assert the pre-fix reading; they are inverted here as the
 * fix's regression proof, not deleted.
 */
describe('#612 PR-2 REGRESSION: a version-less bracket milestone scopes correctly', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-versionless-'); });
  afterEach(() => { cleanup(tmpDir); });

  const VERSIONLESS = `# Roadmap

## [GSD.01] Prior Milestone

### [GSD.01] 01: Old one
**Goal:** a

## [GSD.02] Current Milestone

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later Milestone

### [GSD.03] 01: Later one
**Goal:** d
`;
  // Same roadmap, milestone headings carrying their version — the shape every
  // other fixture in this file uses, and the control that proves the difference
  // is the VERSION STRING and nothing else.
  const VERSIONED = VERSIONLESS
    .replace('## [GSD.01] Prior Milestone', '## [GSD.01] v1.0: Prior Milestone')
    .replace('## [GSD.02] Current Milestone', '## [GSD.02] v2.0: Current Milestone')
    .replace('## [GSD.03] Later Milestone', '## [GSD.03] v3.0: Later Milestone');

  const DIRS = ['GSD.01-01-old-one', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later-one'];

  const accepts = () => {
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    return Object.fromEntries(DIRS.map(d => [d, !!f(d)]));
  };

  test('CONTROL: with a version in the heading, scoping works in both directions', () => {
    writeProject(VERSIONED, 'bracket', DIRS);
    assert.deepEqual(accepts(), {
      'GSD.01-01-old-one': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later-one': false,
    });
  });

  test('without a version, scoping ALSO works in both directions (regression proof)', () => {
    // Mirrors the CONTROL assertion exactly, on the version-less fixture — the
    // fix makes the two shapes agree.
    writeProject(VERSIONLESS, 'bracket', DIRS);
    assert.deepEqual(accepts(), {
      'GSD.01-01-old-one': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later-one': false,
    });
  });

  test('without a version, the PRIOR milestone no longer leaks in (preambleCutoff)', () => {
    writeProject(VERSIONLESS, 'bracket', DIRS);
    assert.equal(accepts()['GSD.01-01-old-one'], false,
      'regression proof — pinned true before the #2761 B1 scoping fix');
  });

  test('without a version, the LATER milestone no longer leaks in (computeSectionEnd)', () => {
    writeProject(VERSIONLESS, 'bracket', DIRS);
    assert.equal(accepts()['GSD.03-01-later-one'], false,
      'regression proof — pinned true before the #2761 B1 scoping fix');
  });

  test('total_phases counts only the asserted milestone, not the whole disk', () => {
    writeProject(VERSIONLESS, 'bracket', DIRS);
    // 4 directories on disk, 2 phases in the milestone STATE.md asserts.
    assert.equal(readTotal(), 2, 'regression proof — pinned 4 before the #2761 B1 scoping fix');
  });

  test('the current milestone\'s own dirs are admitted either way (no under-count)', () => {
    // Whatever else leaked before the fix, the milestone's real phases must
    // always resolve — that property held before and still holds after.
    writeProject(VERSIONLESS, 'bracket', DIRS);
    const a = accepts();
    assert.equal(a['GSD.02-01-one'], true);
    assert.equal(a['GSD.02-02-two'], true);
  });
});

// ─── #2761 B1 FOLLOW-UP: mixed heading shapes and boundary heading levels ───
//
// Two gaps flagged during self-review of the B1 fix above, closed here with
// deterministic fixtures:
//
//   1. The earliest-of-either comparison added to `preambleCutoff` (taking
//      whichever of the version/emoji match or the bracket match sits first in
//      the document) was only exercised where the two patterns happen to agree
//      on the same heading (every milestone in the REGRESSION block above is
//      uniformly version-bearing or uniformly version-less). A genuinely mixed
//      roadmap — one milestone version-bearing, its sibling version-less — was
//      untested.
//
//   2. `computeSectionEnd`'s `h.level <= 2` conjunct (added alongside the
//      pre-existing `h.level > level` skip) is REDUNDANT whenever the selected
//      milestone heading is level 2 — the ADR-canonical shape, and every
//      existing fixture in this repo: `h.level > level` alone already implies
//      `h.level <= 2` there, so a mutant deleting the conjunct would survive
//      every test written before this one. It is NOT redundant when the
//      selected heading is level 3 (or level 1) — see the fixtures below.
describe('#612 PR-2 B1 FOLLOW-UP: mixed heading shapes and boundary heading levels', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-mixed-'); });
  afterEach(() => { cleanup(tmpDir); });

  const acceptsFor = (dirs) => {
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    return Object.fromEntries(dirs.map((d) => [d, !!f(d)]));
  };

  test('mixed shape: version-bearing PRIOR + version-less CURRENT — prior stays out of the preamble leak set', () => {
    // The mid-migration shape: an already-versioned milestone sits before a
    // newer one that has not yet had its version added. anyMilestonePattern
    // alone already finds GSD.01 here — it's the first (and only) version-
    // bearing heading in the document — so this fixture pins that the
    // earliest-of-either comparison does not regress that pre-existing path
    // when the two patterns agree on the same heading, while computeSectionEnd
    // still needs the bracket-boundary fix to correctly exclude GSD.03 (which
    // remains version-less).
    const roadmap = `# Roadmap

## [GSD.01] v1.0: Prior Milestone

### [GSD.01] 01: Old one
**Goal:** a

## [GSD.02] Current Milestone

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later Milestone

### [GSD.03] 01: Later one
**Goal:** d
`;
    const dirs = ['GSD.01-01-old-one', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later-one'];
    writeProject(roadmap, 'bracket', dirs);
    assert.deepEqual(acceptsFor(dirs), {
      'GSD.01-01-old-one': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later-one': false,
    });
    assert.equal(readTotal(), 2);
  });

  test('boundary heading level: a level-3 CURRENT milestone heading still scopes correctly (kills the h.level<=2 equivalent-mutant)', () => {
    // The selected milestone heading is written with THREE hashes
    // (`### [GSD.02] Foundation`) — unusual, but syntactically admitted by the
    // same `#{1,3}` grammar every heading matcher in this function already
    // compiles. With level=3, `h.level > level` alone no longer excludes a
    // level-3 heading, so computeSectionEnd's own first phase heading
    // (`### [GSD.02] 01: One`) — itself bracket-shaped — would ALSO satisfy the
    // bracket-boundary test if the `h.level <= 2` conjunct were removed,
    // truncating the section to nothing but the bare milestone heading and
    // dropping BOTH of its own phases. A real PRIOR milestone precedes it so the
    // preamble side-channel cannot independently rescue the truncated phases —
    // confirmed by hand-mutating a throwaway build copy: without the guard this
    // fixture's own phases vanish from the returned scope entirely, and
    // getMilestonePhaseFilter's zero-token pass-all degrade then admits every
    // directory on disk instead (the exact pre-#612 symptom).
    const roadmap = `# Roadmap

## [GSD.01] v1.0: Prior Milestone

### [GSD.01] 01: Old
**Goal:** z

### [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

## [GSD.03] v3.0: Next Milestone

### [GSD.03] 01: Later
**Goal:** c
`;
    const dirs = ['GSD.01-01-old', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    writeProject(roadmap, 'bracket', dirs);
    assert.deepEqual(acceptsFor(dirs), {
      'GSD.01-01-old': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later': false,
    });
    assert.equal(readTotal(), 2);
  });

  test('boundary heading level: a level-1 CURRENT milestone heading also scopes correctly (#{1,2} tolerance, not just level 2)', () => {
    // A level-1/level-1 pairing (consistent heading-level convention across
    // sibling milestones) — distinct from the level-3 case above: this pins
    // that the `#{1,2}` bracket-boundary source tolerates level 1, not only the
    // ADR-canonical level 2.
    const roadmap = `# [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

# [GSD.03] v3.0: Next Milestone

### [GSD.03] 01: Later
**Goal:** c
`;
    const dirs = ['GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    writeProject(roadmap, 'bracket', dirs);
    assert.deepEqual(acceptsFor(dirs), {
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later': false,
    });
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 B1 (round-2 adversarial review, Blocker 1): a SAME-MILESTONE ──────
// ─── continuation heading is not mistaken for a DIFFERENT milestone's ───────
// ─── boundary ────────────────────────────────────────────────────────────────
//
// The B1 fix above (08d5b0c4) taught computeSectionEnd/preambleCutoff to
// recognise ANY `#{1,2} [CODE.MM]` heading as a milestone boundary. It did not
// distinguish "a heading for a DIFFERENT milestone" (a real boundary) from "a
// heading that merely CONTINUES the CURRENT milestone's own section" (e.g. a
// version-less checklist/detail split: `## [GSD.02] Foundation (Phase
// Details)`, or an ad-hoc continuation heading `## [GSD.02] Foundation —
// continued`) — the latter is not a boundary at all. The `(Phase Details)`
// re-append at `detailsMatch` below only searches `allMatches` (the
// VERSION-STRING matches from the top of this function), so a version-less
// continuation heading was cut out by the boundary and never re-appended: the
// milestone's OWN later phases silently vanished from the returned scope,
// while `getMilestonePhaseFilter`'s phaseCount stayed non-zero (unlike the
// original #612 defect), so the pass-all degrade never caught it either — a
// confidently wrong, non-degraded phase count for a still-incomplete
// milestone.
//
// Fixed here by teaching isBracketMilestoneBoundary a same-milestone
// exclusion: a candidate heading whose OWN bracket id (case-folded) equals the
// SELECTED milestone's bracket id is never a boundary.
describe('#612 PR-2 B1 round-2: a same-milestone continuation heading is not a boundary', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b1r2-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D = [['GSD.02-01-one', true], ['GSD.02-02-two', false]];

  /**
   * Per the file header's oracle-hazard #2: pre-write a WRONG total_phases
   * into STATE.md's frontmatter before calling `syncedTotal()`/
   * `syncedPercent()`, so `state sync` is forced to do real work rather than
   * silently no-op because its computed total already happens to match.
   */
  function poisonTotalPhases() {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }

  test('RED (repro8 case 1): version-bearing head + version-less "(Phase Details)" continuation — 2/1/50, not 1/1/100', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** b

## [GSD.02] Foundation (Phase Details)

### [GSD.02] 02: Two
**Goal:** c
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix — the continuation heading truncated the section');
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2, 'the WRITE path must agree with the READ path');
    assert.equal(syncedPercent(), 50, 'pinned 100 before this fix');
  });

  test('RED (repro5): fully version-less milestone split across two headings, no siblings — 2/1/50, not 1/1/100', () => {
    writeProject(`# Roadmap

## [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** b

## [GSD.02] Foundation — continued

### [GSD.02] 02: Two
**Goal:** c
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix');
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 100 before this fix');
  });

  test('PIN (repro8 case 3): a trailing DIFFERENT-id icebox section still terminates the primary section — unchanged at 2/1/50', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.999] Icebox

### [GSD.999] 07: Someday
**Goal:** z
`, 'bracket', D);
    assert.equal(readTotal(), 2);
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50);
  });

  test('PIN (repro10 A1): all-version-bearing + icebox + "(Phase Details)" — exact 2/1/50, no double-count', () => {
    // The same-milestone exclusion must not make the PRIMARY section swallow
    // the (Phase Details) section a second time on top of the pre-existing
    // detailsMatch re-append — total_phases must read EXACTLY 2, not 4.
    const dirs = [
      ['GSD.01-01-old', true],
      ['GSD.02-01-one', true],
      ['GSD.02-02-two', false],
      ['GSD.03-01-later', true],
    ];
    writeProject(`# Roadmap

## [GSD.01] v1.0: Prior

### [GSD.01] 01: Old
**Goal:** a

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** b

## [GSD.03] v3.0: Later

### [GSD.03] 01: Later
**Goal:** d

## [GSD.02] v2.0: Current (Phase Details)

### [GSD.02] 02: Two
**Goal:** c

## [GSD.999] Icebox

### [GSD.999] 07: Someday
**Goal:** z
`, 'bracket', dirs);
    assert.equal(readTotal(), 2, 'exact — a regression here would double-count to 4');
    // NOTE: no syncedTotal()/syncedPercent() assertions here — this fixture
    // carries dirs OUTSIDE the current milestone (GSD.01-01-old,
    // GSD.03-01-later), which is exactly the shape that exposes Major 1
    // (cmdStateSync's body percent is computed from an unfiltered whole-disk
    // scan). Asserting the synced percent here before Major 1's fix lands
    // would fail on a DIFFERENT, not-yet-fixed defect. Covered once Major 1 is
    // fixed (#2761 Major 1 commit), where this fixture's synced values are
    // asserted directly.
  });
});

// ─── #2761 B2 (round-2 adversarial review, Blocker 2): the heading ──────────
// ─── discriminator is CONTENT, not level ────────────────────────────────────
//
// Three sites disagreed about which heading levels are a bracket milestone:
// the selector (`^#{1,3}\s+\[CODE.MM\]`) and `isMilestoneBounded` (state.cts)
// both admit level 1-3, but the B1 boundary only admitted level 1-2
// (`h.level <= 2`). A `###`-level bracket milestone was therefore SELECTED and
// BOUNDED but never TERMINATED: computeSectionEnd ran with level=3, a level-3
// SIBLING milestone survived `h.level > level` (not deeper), failed the
// version/emoji test (version-less), then failed `h.level <= 2` — so the
// function fell through to `return content.length`, sweeping the sibling
// milestone's own phases into the current one. This reproduces trek-e's
// original #612 defect verbatim (a safe degrade became a confidently-wrong
// persisted number) on a heading level the selector and bounding predicate
// both already admit.
//
// ADR-612 Decision 1 (docs/adr/612-bracket-phase-id-convention.md:56)
// specifies the discriminator as CONTENT: "a phase heading is a bracket
// followed by a digit-then-colon; a milestone heading is a bracket followed
// by a name." Fixed by replacing the `level > 2` rejection with
// BRACKET_PHASE_TAIL_RE (built from phase-id.cts's single-owner
// phaseHeadingPrefixSrcFor, not a re-typed grammar), with the level check
// widened to a depth-sanity cap of 3 (mirroring the selector's own `#{1,3}`
// ceiling — NOT a phase/milestone discriminator itself).
describe('#612 PR-2 B2 round-2: the bracket boundary is a CONTENT discriminator, not a level cap', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b2r2-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('RED (repro2 case C): all milestones ###, all phases ####, version-less — total 2, TRUTHFUL percent 100', () => {
    // GSD.02 (asserted milestone) has 2 phases, both complete. isMilestoneBounded
    // already returns true at #{1,3} (state.cts, unaffected by this fix), so the
    // percent this fixture writes is directly observable — pinned 75 (4 dirs,
    // 3 complete, whole-disk fallback) before this fix.
    const dirs = [
      ['GSD.01-01-old', true],
      ['GSD.02-01-one', true],
      ['GSD.02-02-two', true],
      ['GSD.03-01-later', false],
    ];
    writeProject(`# Roadmap

### [GSD.01] Prior Milestone

#### [GSD.01] 01: Old one
**Goal:** a

### [GSD.02] Current Milestone

#### [GSD.02] 01: One
**Goal:** b

#### [GSD.02] 02: Two
**Goal:** c

### [GSD.03] Later Milestone

#### [GSD.03] 01: Later one
**Goal:** d
`, 'bracket', dirs);
    assert.equal(readTotal(), 2, 'pinned 4 before this fix (whole-doc fallback)');
    const r = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(r.success, `state json failed: ${r.error}`);
    assert.equal(JSON.parse(r.output).progress?.percent, 100, 'pinned 75 before this fix');
  });

  test('mechanism (repro7): extractCurrentMilestone actually scopes a level-3 milestone, not the whole document', () => {
    const dirs = ['GSD.01-01-old', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    const roadmap = `# Roadmap

### [GSD.01] Prior

#### [GSD.01] 01: Old
**Goal:** a

### [GSD.02] Current

#### [GSD.02] 01: One
**Goal:** b

#### [GSD.02] 02: Two
**Goal:** c

### [GSD.03] Later

#### [GSD.03] 01: Later
**Goal:** d
`;
    writeProject(roadmap, 'bracket', dirs);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const scope = rp.extractCurrentMilestone(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      tmpDir,
    );
    assert.ok(scope.length < roadmap.length, 'pinned scope === full document before this fix (fell through to content.length)');
    assert.ok(scope.includes('01: One') && scope.includes('02: Two'), 'the milestone\'s own phases must survive scoping');
    assert.ok(!scope.includes('Old') && !scope.includes('Later'), 'sibling milestones must not leak in');
  });

  test('PIN: a dotted sub-phase heading ([GSD.02] 05.03:) is phase-tail-shaped, not a boundary', () => {
    // The tail grammar must cover BOTH `05:` and the dotted `05.03:` forms —
    // this is precisely where a regex slip in the tail discriminator would
    // hide (a milestone-shaped false negative would truncate the section at
    // what is actually a real sub-phase heading).
    const dirs = ['GSD.02-01-one', 'GSD.02-05.03-sub', 'GSD.03-01-later'];
    writeProject(`# Roadmap

## [GSD.02] Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 05.03: Name
**Goal:** b

## [GSD.03] Later

### [GSD.03] 01: Later
**Goal:** c
`, 'bracket', dirs);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(!!f('GSD.02-01-one'), true);
    assert.equal(!!f('GSD.02-05.03-sub'), true, 'the dotted sub-phase heading must not be excluded as a boundary');
    assert.equal(!!f('GSD.03-01-later'), false);
    assert.equal(readTotal(), 2, 'both GSD.02 phases (01 and 05.03) must be counted');
  });

  test('PIN (repro8 case 3, content-discriminator mechanism): a trailing DIFFERENT-id icebox section still terminates — 2/1/50', () => {
    // Re-pins the same shape as the B1 round-2 block above, now that the
    // discriminator is CONTENT rather than level: [GSD.999] is bracket-shaped
    // and NOT phase-tail-shaped ("Icebox" carries no digit-colon), and its id
    // differs from the selected milestone's — a boundary either way.
    const D = [['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.999] Icebox

### [GSD.999] 07: Someday
**Goal:** z
`, 'bracket', D);
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 Blocker 3 (round-2 adversarial review): the preamble-cutoff ──────
// ─── bracket scan is now fence-aware ─────────────────────────────────────────
//
// `preambleCutoff`'s bracket branch used a raw `content.match`/`matchAll` —
// blind to fenced code blocks — while its sibling `computeSectionEnd` (a few
// lines above it) already consumed `tokenizeHeadings(content)`, which strips
// fences. A fenced markdown example in the preamble containing a bracket
// heading (ADR-612's own docs do exactly this) was textually the earliest
// `#{1,3} [CODE.MM]` match: `preambleCutoff` landed INSIDE the fence,
// `preamble = content.slice(0, preambleCutoff)` ended with an unclosed
// opener, and the unbalanced fence then blinded
// `getMilestonePhaseFilter`'s own `tokenizeHeadings(scope)` call — EVERY
// heading in the returned scope vanished, `phaseCount` degraded to 0, and the
// pass-all filter admitted every directory on disk (repro11's mechanism).
// Regression vs round-1, which had no bracket pattern to blind and so fell
// back to the correct (non-fenced) heading.
//
// Fixed by scanning the SAME `currentMilestoneHeadings` token list
// computeSectionEnd consumes, instead of a raw regex — closing the asymmetry
// between the two halves of one boundary semantic.
describe('#612 PR-2 Blocker 3 round-2: preambleCutoff is fence-aware (bracket branch only)', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b3fence-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D = [
    ['GSD.01-01-stray', true],
    ['GSD.02-01-one', true],
    ['GSD.02-02-two', false],
    ['GSD.03-01-stray', true],
  ];

  test('RED (repro12 bracket row): a fenced example bracket heading in the preamble no longer blinds the scan — 2/1/50', () => {
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
## [GSD.00] Example milestone heading
\`\`\`

## [GSD.02] Current

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 4 before this fix (fence-blind scan degraded phaseCount to 0)');
  });

  test('mechanism (repro11): the returned scope has an EVEN, balanced fence count and a non-degraded phaseCount', () => {
    const roadmap = `# Roadmap

Docs for authors:

\`\`\`markdown
## [GSD.00] Example milestone heading
### [GSD.00] 01: Example phase
\`\`\`

## [GSD.02] Current

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later

### [GSD.03] 01: Later
**Goal:** d
`;
    const dirs = ['GSD.01-01-old', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    writeProject(roadmap, 'bracket', dirs);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const ms = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
    const scope = rp.extractCurrentMilestone(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      tmpDir,
    );
    const fenceCount = (scope.match(/^```/gm) || []).length;
    assert.equal(fenceCount % 2, 0, 'pinned an ODD (unbalanced) fence count before this fix');
    const headings = ms.tokenizeHeadings(scope).map((h) => h.text);
    assert.ok(headings.some((t) => /GSD\.02.*01: One/.test(t)), 'real headings must survive tokenization, not collapse to just "Roadmap"');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.notEqual(f.phaseCount, 0, 'pinned 0 (pass-all degrade) before this fix');
    assert.deepEqual(
      Object.fromEntries(dirs.map((d) => [d, !!f(d)])),
      { 'GSD.01-01-old': false, 'GSD.02-01-one': true, 'GSD.02-02-two': true, 'GSD.03-01-later': false },
      'pinned every directory admitted (pass-all) before this fix',
    );
  });

  test('PIN (repro12 LEGACY control): a fenced version-bearing heading in the preamble is UNCHANGED (pre-existing, out of scope)', () => {
    // Disclosed, not fixed: the LEGACY (non-bracket) `anyMilestonePattern`
    // raw-match path shares the same fence-blindness hazard and stays
    // byte-identical — fixing it is out of scope for this bracket-only fix
    // (round-2 review's own minimal-fix note). This pin exists so a future
    // reviewer does not file the pre-existing legacy gap as a NEW regression.
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
## Milestone v9.0: Example
\`\`\`

## Milestone v2.0: Current

### Phase 01: One
**Goal:** b

### Phase 02: Two
**Goal:** c
`, undefined, [['03-stray', true], ['01-one', true], ['02-two', false], ['04-stray', true]]);
    assert.equal(readTotal(), 4, 'pre-existing legacy fence-blindness — deliberately unchanged, not a new regression');
  });

  test('PIN (repro10 A3): a fenced heading INSIDE the current section still must not terminate it', () => {
    const dirs = ['GSD.01-01-old', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    writeProject(`# Roadmap

## [GSD.02] Current

### [GSD.02] 01: One
**Goal:** b

\`\`\`markdown
## [GSD.03] Not a real heading
\`\`\`

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later

### [GSD.03] 01: Later
**Goal:** d
`, 'bracket', dirs);
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 B3 (self-caught, round-2 verification): CURRENT version-bearing, ──
// ─── a sibling milestone is not ──────────────────────────────────────────────
//
// The B1 fix (commit 08d5b0c4) resolved `bracketScopeConvention` only inside
// the `if (headingMatches.length === 0)` gate that also drives SELECTION's own
// bracket fallback. That gate is correct for SELECTION (only try the bracket
// heading shape when the version-string match found nothing), but
// `bracketScopeConvention` also feeds `computeSectionEnd`'s and
// `preambleCutoff`'s boundary-detection — which accidentally inherited
// SELECTION's gate instead of having its own.
//
// Trigger shape: the CURRENT milestone heading is ITSELF version-bearing
// (`## [GSD.02] v2.0: Current Milestone`), so the primary version-string
// `sectionPattern` matches it directly — `headingMatches.length !== 0` from the
// very first check — and the entire bracket-resolution branch is skipped. A
// sibling milestone (PRIOR or LATER) that is version-less then gets NEITHER
// the version/emoji boundary rule (it has no version) NOR the bracket boundary
// rule (never resolved) — reproducing the exact #612 defect symptom
// (total_phases falls back to the whole-disk count) through a structural
// shape B1's own fixtures never exercised (every B1 fixture is uniformly
// version-bearing or uniformly version-less across all three milestones).
describe('#612 PR-2 B3: bracket boundaries engage even when CURRENT is version-bearing but a sibling is not', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b3-'); });
  afterEach(() => { cleanup(tmpDir); });

  const ROADMAP = `# Roadmap

## [GSD.01] Prior Milestone

### [GSD.01] 01: Old one
**Goal:** a

## [GSD.02] v2.0: Current Milestone

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later Milestone

### [GSD.03] 01: Later one
**Goal:** d
`;
  const DIRS = ['GSD.01-01-old-one', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later-one'];

  const acceptsFor = (dirs) => {
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    return Object.fromEntries(dirs.map((d) => [d, !!f(d)]));
  };

  test('CURRENT version-bearing + both siblings version-less: scoping works in both directions', () => {
    writeProject(ROADMAP, 'bracket', DIRS);
    assert.deepEqual(acceptsFor(DIRS), {
      'GSD.01-01-old-one': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later-one': false,
    });
  });

  test('the PRIOR (version-less) milestone does not leak into the preamble (preambleCutoff twin)', () => {
    writeProject(ROADMAP, 'bracket', DIRS);
    assert.equal(acceptsFor(DIRS)['GSD.01-01-old-one'], false);
  });

  test('the LATER (version-less) milestone does not leak into scope (computeSectionEnd twin)', () => {
    writeProject(ROADMAP, 'bracket', DIRS);
    assert.equal(acceptsFor(DIRS)['GSD.03-01-later-one'], false);
  });

  test('total_phases counts only the asserted milestone, not the whole disk', () => {
    writeProject(ROADMAP, 'bracket', DIRS);
    // 4 directories on disk, 2 phases in the milestone STATE.md asserts.
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 Blocker 1 (round-3 adversarial re-verify): the preambleCutoff ────
// ─── scan drops current-milestone content whenever ANY bracket-shaped ──────
// ─── heading precedes the selected milestone heading ────────────────────────
//
// The round-2 fix (39c42a89) threaded `selectedBracketId` as the REAL value
// at computeSectionEnd but as bare `null` at the preambleCutoff scan — the
// deviation's own rationale ("the selected heading's own occurrence is
// always the correct earliest answer") was right, but `null` disables the
// same-milestone check for EVERY heading, not just the selected one. Any
// bracket-shaped heading earlier than the selected milestone — same id
// (cases A, B) or a DIFFERENT id with no children of its own (case D) — was
// wrongly accepted as the earliest boundary, and the region between it and
// the real `sectionStart` was silently dropped: a completed phase vanished
// and `state sync` persisted a confident 0% where base and round-1 both
// correctly wrote 50%.
//
// Fixed with two changes, both scoped to the preambleCutoff scan only
// (computeSectionEnd is untouched — it already threads the real
// `selectedBracketId`):
//   (a) `h.offset === sectionStart` bypasses BOTH the same-milestone check
//       and the same-id-child rule below — the selected heading's own
//       position is definitionally correct, and this is the one case where
//       neither discriminator should even run (rejecting it would be
//       rejecting the heading against ITSELF).
//   (b) every OTHER bracket-shaped, non-phase-tail-shaped candidate must
//       additionally have a matching-id CHILD (the next strictly-deeper
//       heading beneath it) to count as a boundary — `bracketHeadingHasMatchingChild`.
//       This is what distinguishes a genuine sibling milestone (whose own
//       phase children carry ITS bracket id) from an unrelated bracket-shaped
//       PROSE heading like `## [ADR.612] Heading convention used by this
//       roadmap` sitting above the current milestone's own content.
describe('#612 PR-2 Blocker 1 round-3: preambleCutoff identity is offset- and child-aware', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-b1r3-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D = [['GSD.02-01-one', true], ['GSD.02-02-two', false]];

  function poisonTotalPhases() {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }

  test('RED case A (rv-attack1): a same-milestone version-LESS heading earlier than the version-bearing selected heading — 2/1/50, not 1/0/0', () => {
    writeProject(`# Roadmap

## [GSD.02] Foundation

- [ ] **[GSD.02] 01: One**
- [ ] **[GSD.02] 02: Two**

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Foundation (Phase Details)

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix — the earlier checklist heading dropped everything before sectionStart');
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 0 before this fix — a confidently wrong persisted 0%');
  });

  test('RED case B (rv-attack1): a same-milestone OVERVIEW heading (no "(Phase Details)" spelling) earlier than the version-bearing selected heading — 2/1/50, not 1/0/0', () => {
    writeProject(`# Roadmap

## [GSD.02] Foundation (overview)

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Foundation

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix');
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 0 before this fix');
  });

  test('RED case D (rv-attack1b): a DIFFERENT-id bracket-shaped PROSE heading before the selected milestone — 2/1/50, not 1/0/0', () => {
    writeProject(`# Roadmap

## [ADR.612] Heading convention used by this roadmap

Phases are listed under their milestone.

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Foundation

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix — [ADR.612] read as a genuine boundary with no child-id check');
    poisonTotalPhases();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 0 before this fix');
  });

  test('PIN: a genuine prior sibling milestone (real children sharing its own id) is still excluded from the preamble', () => {
    const dirs = ['GSD.01-01-old-one', 'GSD.02-01-one', 'GSD.02-02-two'];
    writeProject(`# Roadmap

## [GSD.01] Prior Milestone

### [GSD.01] 01: Old one
**Goal:** a

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c
`, 'bracket', dirs.map((d, i) => [d, i !== 2]));
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(!!f('GSD.01-01-old-one'), false, 'the prior milestone must still be excluded — the child rule must not re-admit a genuine sibling');
    assert.equal(readTotal(), 2);
  });

  test('PIN: a CHILDLESS prior sibling milestone (no phases of its own) degrades to NOT cutting the preamble — over-inclusive, safe', () => {
    // "## [GSD.01] Empty Prior Milestone" has no deeper heading before the
    // next heading at its own level — the child rule rejects it as a
    // boundary, so its own heading TEXT stays in the preamble. That text is
    // not phase-shaped (no digit-colon), so it contributes nothing to any
    // count — over-inclusive, not under-inclusive, the safe direction.
    writeProject(`# Roadmap

## [GSD.01] Empty Prior Milestone

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'the current milestone\'s own two phases must still be counted, unpolluted by the childless sibling');
    poisonTotalPhases();
    assert.equal(syncedPercent(), 50);
  });

  test('Nit 2 PIN: a colon-less bracket heading ("[GSD.02] 05" with no trailing colon) does not spuriously terminate the preamble', () => {
    // A colon-less bracket heading is bracket-shaped but NOT phase-tail-shaped
    // (BRACKET_PHASE_TAIL_RE requires the trailing colon), so
    // isBracketMilestoneBoundary alone would read it as a boundary. It is
    // also — precisely because it is malformed/incomplete rather than a real
    // milestone — childless (nothing deeper follows it before the next
    // same-or-shallower heading), so the child rule neutralizes it here.
    writeProject(`# Roadmap

### [GSD.02] 05

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D);
    assert.equal(readTotal(), 2);
  });

  test('mechanism (rv-mech1): extractCurrentMilestone now scopes the FULL document for case A, phaseCount reflects both real phases', () => {
    const roadmap = `# Roadmap

## [GSD.02] Foundation

- [ ] **[GSD.02] 01: One**
- [ ] **[GSD.02] 02: Two**

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Foundation (Phase Details)

### [GSD.02] 02: Two
**Goal:** b
`;
    writeProject(roadmap, 'bracket', D);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const scope = rp.extractCurrentMilestone(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      tmpDir,
    );
    assert.equal(scope, roadmap, 'pinned a truncated scope (bytes [11,124) dropped) before this fix');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(f.phaseCount, 2, 'pinned phaseCount 1 before this fix');
    assert.equal(!!f('GSD.02-01-one'), true, 'pinned false before this fix — a real dir of the CURRENT milestone');
    assert.equal(!!f('GSD.02-02-two'), true);
  });
});

// ─── #2761 Major 1 (round-3 adversarial re-verify): the version/emoji half ──
// ─── of preambleCutoff's min() is now fence-aware too, on the bracket ───────
// ─── branch only ─────────────────────────────────────────────────────────────
//
// ff6bf0a8 (round-2 Blocker 3) made the BRACKET half of preambleCutoff's
// "earliest milestone-shaped heading" search fence-aware, but left the
// VERSION/emoji half a raw `content.match` even on the bracket branch. A
// fenced VERSION-BEARING example heading in a bracket repo's preamble
// (ADR-612's own docs illustrate the LEGACY heading shape this way, inside a
// fenced authoring-guide block) was still textually the earliest match for
// that raw regex, winning the min() and un-suppressing a wrong persisted 75%
// that base correctly suppressed.
describe('#612 PR-2 Major 1 round-3: preambleCutoff\'s version/emoji half is fence-aware on the bracket branch', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-m1r3-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D = [
    ['GSD.02-01-one', true], ['GSD.02-02-two', false],
    ['GSD.03-01-x', true], ['GSD.03-02-y', true],
  ];

  test('RED case C1 (rv-attack3c): a fenced VERSION-bearing example heading in a bracket repo\'s preamble — 2/1/50, not 4/3/75', () => {
    writeProject(`# Roadmap

Authoring guide — a milestone heading looks like:

\`\`\`markdown
## Milestone v9.0: Example
\`\`\`

## [GSD.02] Current

### [GSD.02] 01: One
### [GSD.02] 02: Two

## [GSD.03] Later

### [GSD.03] 01: X
### [GSD.03] 02: Y
`, 'bracket', D);
    assert.equal(readTotal(), 2, 'pinned 4 before this fix — the fenced VERSION heading won the min() and swallowed everything before it into the preamble unstripped');
    poisonTotalPhases();
    assert.equal(syncedPercent(), 50, 'pinned 75 before this fix — base correctly suppressed this percent, HEAD must not resurface it wrong');
  });

  test('PIN case C2: a fenced BRACKET-shaped heading in the same position (round-2\'s own fix target) stays unchanged at 2/1/50', () => {
    writeProject(`# Roadmap

Authoring guide — a milestone heading looks like:

\`\`\`markdown
## [GSD.00] Example
\`\`\`

## [GSD.02] Current

### [GSD.02] 01: One
### [GSD.02] 02: Two

## [GSD.03] Later

### [GSD.03] 01: X
### [GSD.03] 02: Y
`, 'bracket', D);
    assert.equal(readTotal(), 2);
  });

  function poisonTotalPhases() {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }
});

// ─── #2761 round-3 hardening (team-lead review of f87bba0e): two edges in ──
// ─── the new preambleCutoff code ────────────────────────────────────────────
//
// AMENDMENT 1 — bracketHeadingHasMatchingChild originally checked only
// `headings[index + 1]` (the IMMEDIATE next heading), not the candidate's
// whole subtree. A genuine prior sibling milestone whose section opens with
// a non-bracket subsection before its first phase (`## [GSD.01] Setup` /
// `### Notes` / `### [GSD.01] 01: Old`) was therefore wrongly rejected as a
// boundary — its own real phase heading is TWO headings deep, not one — and
// its entire section leaked into the preamble unstripped.
//
// CONFIRMED RED at f87bba0e before this fix (per the team lead's request to
// check observability, not just theory): the leak is NOT merely inert —
// `GSD.01-01-old`'s directory was wrongly admitted into the CURRENT
// milestone's filter via the leaked heading's qualified key
// (`GSD.01-01`), reading **3/2/67%** where truth is **2/1/50%**. Scope
// membership DOES drive the disk-side filter on this shape. Fixed by
// scanning the candidate's full SUBTREE (continue past a non-matching
// deeper heading instead of returning false immediately; only a
// same-or-shallower heading actually closes the subtree).
//
// AMENDMENT 2 — the round-3 Major 1 fix (c483552a) ported the version/emoji
// half of preambleCutoff to the token-based scan with no level cap; the raw
// `content.match(anyMilestonePattern)` it replaced was anchored `^#{1,3}\s+`.
// A level-4+ version-bearing heading in the preamble (`#### v2.0 notes`)
// therefore won the scan on the bracket branch where the raw pattern (and
// the legacy path, unaffected) ignores it outright — a heading neither the
// selector nor `isMilestoneBounded` would ever treat as a milestone marker.
// Fixed with `if (h.level > 3) continue;`, mirroring the depth-sanity cap
// `isBracketMilestoneBoundary` already applies to the bracket half.
describe('#612 PR-2 round-3 hardening: subtree child scan + level cap on preambleCutoff', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r3h-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('RED (rv2-amend1): a genuine prior sibling with an intervening non-bracket subsection is still excluded — 2/1/50, not 3/2/67', () => {
    const dirs = [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

## [GSD.01] Setup

### Notes

Some prose about the prior milestone.

### [GSD.01] 01: Old

## [GSD.02] v2.0: Current

### [GSD.02] 01: One

### [GSD.02] 02: Two
`, 'bracket', dirs);
    assert.equal(readTotal(), 2, 'pinned 3 before this fix — the immediate-next-heading-only check rejected [GSD.01] Setup as a boundary because its FIRST child (### Notes) is not bracket-shaped, even though its SECOND child (### [GSD.01] 01: Old) is');
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(!!f('GSD.01-01-old'), false, 'pinned true before this fix — the leaked heading\'s qualified key wrongly admitted the prior milestone\'s own directory');
    assert.equal(!!f('GSD.02-01-one'), true);
    assert.equal(!!f('GSD.02-02-two'), true);
  });

  test('PIN (rv2-amend2): a level-4 version-bearing preamble heading is NOT a cutoff on the bracket branch — the preamble text survives unstripped', () => {
    const roadmap = `# Roadmap

#### v2.0 notes

Some prose that happens to mention v2.0 in a deep heading.

## [GSD.02] Current

### [GSD.02] 01: One

### [GSD.02] 02: Two
`;
    writeProject(roadmap, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const scope = rp.extractCurrentMilestone(
      fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8'),
      tmpDir,
    );
    assert.ok(scope.includes('v2.0 notes'), 'pinned dropped before this fix — the level-4 heading wrongly won the earliest-of-either scan and truncated the preamble at itself');
    assert.equal(readTotal(), 2);
  });

  test('PIN: the LEGACY control for the level-4 preamble heading is unchanged (raw content.match path untouched)', () => {
    writeProject(`# Roadmap

#### v2.0 notes

Some prose that happens to mention v2.0 in a deep heading.

## Milestone v2.0: Current

### Phase 01: One

### Phase 02: Two
`, undefined, [['01-one', true], ['02-two', false]]);
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 round-4 (team-lead re-verify of fbfd0fca): the child rule must ──
// ─── require a same-id PHASE, not merely a same-id heading ──────────────────
//
// bracketHeadingHasMatchingChild's subtree scan (fbfd0fca) proved SAME-ID-NESS
// but never asked whether the matching child was PHASE-shaped. Case F1
// reopens round-3's case D one heading later: `## [ADR.612] Heading
// convention` is followed by its OWN sub-heading `### [ADR.612] Examples` —
// same bracket id as the candidate, but MILESTONE-shaped (a name, no
// digit-then-colon), not a phase. Same-id-ness alone satisfied the subtree
// scan, re-cutting the preamble at exactly the shape the round-3 hardening
// was written to close.
function poisonTotalPhasesR4(dir) {
  const statePath = path.join(dir, '.planning', 'STATE.md');
  const raw = fs.readFileSync(statePath, 'utf-8');
  fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
}

describe('#612 PR-2 round-4 Blocker 1: the same-id child must be PHASE-shaped', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r4b1-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('RED (F1): a same-id MILESTONE-shaped child on a prose heading no longer satisfies the child rule — 2/1/50, not 1/0/0', () => {
    writeProject(`# Roadmap

## [ADR.612] Heading convention

### [ADR.612] Examples

Prose about the convention.

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Foundation

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix — [ADR.612]\'s own MILESTONE-shaped sub-heading satisfied the same-id-only rule');
    poisonTotalPhasesR4(tmpDir);
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 0 before this fix — state sync reported "nothing to do" because its wrong 0% happened to equal the seed');
  });

  test('PIN (F11): a genuine prior sibling whose same-id child lacks the trailing colon is still correctly excluded (inert leak, not a boundary either way)', () => {
    const dirs = [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

## [GSD.01] Setup

### [GSD.01] 01 Old

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', dirs);
    assert.equal(readTotal(), 2);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(!!f('GSD.01-01-old'), false, 'the colon-less heading forms no qualified key either, so the childless-degrade leak is inert');
  });

  test('PIN (F11b): a genuine prior sibling whose phases exist only as bullets is still correctly excluded', () => {
    const dirs = [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

## [GSD.01] Setup

- [x] **[GSD.01] 01: Old**

### [GSD.01] Retrospective

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', dirs);
    assert.equal(readTotal(), 2);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.equal(!!f('GSD.01-01-old'), false, 'a bracket bullet never forms a qualified key (BULLET_PHASE_LINE_PATTERN needs a literal **Phase )');
  });

  test('re-verify: the four existing child-rule pins (F2-F5 shapes) are unaffected by the phase-shape requirement', () => {
    // F2: subtree closure — same-id child appears only after a same-level
    // heading closes the subtree; must not count (over-inclusive degrade).
    writeProject(`# Roadmap

## [GSD.01] Setup

Prose, no children.

## [DOC.99] Reference

### [GSD.01] 01: Old

### [GSD.02] 01: One
**Goal:** a

## [GSD.02] v2.0: Current

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    assert.equal(readTotal(), 3, 'unchanged — the declared over-inclusive/safe degrade (Minor 1), not a regression');

    // F3: deep wrong-id children then a same-id PHASE child inside the subtree — must count.
    writeProject(`# Roadmap

## [GSD.01] Setup

### Notes

#### Deep note

### [DOC.99] Aside

### [GSD.01] 01: Old

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    assert.equal(readTotal(), 2);

    // F4: the same-id PHASE child is itself level 4 — the child scan has no depth ceiling.
    writeProject(`# Roadmap

## [GSD.01] Setup

### Notes

#### [GSD.01] 01: Old

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    assert.equal(readTotal(), 2);

    // F5: trailing bracket sibling at document end (childless) — computeSectionEnd
    // excludes it without needing the child rule at all.
    writeProject(`# Roadmap

## [GSD.02] v2.0: Current

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

## [GSD.03] Later
`, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false], ['GSD.03-01-later', true]]);
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 round-4 Major 1: the four fence-blind sites known at round 4 ────
// ─── on the bracket path (a fifth — the retirement scan — was found at ────
// ─── round 5 and has its own block further below) ──────────────────────────
//
// The scope string extractCurrentMilestone returns is fence-BALANCED and
// fence-STRIPPED-by-tokenizeHeadings only when its CONSUMERS ask it that way.
// Four sites still read it (or the raw ROADMAP) with a plain regex `.exec`,
// blind to fences:
//
//   (a) roadmapPhaseCount — TWO independent copies, buildStateFrontmatter
//       (read path) and cmdStateSync (write path). A fenced EXAMPLE phase
//       heading in the preamble inflated total_phases (F10); on a
//       version-less roadmap the SAME fence-blindness compounds with (c)
//       below (F9).
//   (b) isMilestoneBounded — a raw `.test(roadmapRaw)`. A fenced-ONLY bracket
//       heading (no real section for the asserted milestone at all) wrongly
//       BOUNDED a milestone that isn't in the roadmap, un-suppressing a
//       percent that should stay suppressed (F12).
//   (c) the bracket-fallback SELECTOR (only reachable when the version-string
//       selection found nothing) — a raw `content.matchAll`. A fenced example
//       sharing the CURRENT project's own bracket id could be SELECTED as the
//       current milestone, landing `sectionStart` inside a fence (F9).
//
// Fixed by extracting ONE shared counter (countRoadmapPhaseHeadings, in
// src/state.cts, immediately above buildStateFrontmatter) used by both (a)
// copies, and converting (b) and (c) to tokenizeHeadings-based scans. The
// PRODUCER (extractCurrentMilestone's returned scope string) is deliberately
// UNCHANGED — every other consumer of that string needs its full content
// fidelity, and legacy identity forbids touching the shared string. Legacy
// (non-bracket) behavior at all four sites is byte-identical; this is the
// ONLY commit in this arc that touches SELECTION.
describe('#612 PR-2 round-4 Major 1: the four fence-blind sites known at round 4 (a fifth was found at round 5, see its own block below)', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r4m1-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D2 = [['GSD.02-01-one', true], ['GSD.02-02-two', false]];

  function poisonTotalPhasesR4M1() {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }

  test('RED (F10): a fenced SAME-id PHASE heading in the preamble no longer inflates roadmapPhaseCount — 2/1/50, not 3/1/33', () => {
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
### [GSD.02] 05: Example phase
\`\`\`

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D2);
    assert.equal(readTotal(), 2, 'pinned 3 before this fix — the fenced example phase heading was counted by the fence-blind raw .exec()');
    poisonTotalPhasesR4M1();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 33 before this fix');
  });

  test('PIN (F10 LEGACY control): the same fenced-phase shape on a non-bracket repo is unchanged (correct on every build)', () => {
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
### Phase 05: Example phase
\`\`\`

## Milestone v2.0: Foundation

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, undefined, [['01-one', true], ['02-two', false]]);
    assert.equal(readTotal(), 2);
  });

  test('PIN (F10c): same document, fenced line is NOT phase-shaped — unaffected either way', () => {
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
### [GSD.02] Example section
\`\`\`

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D2);
    assert.equal(readTotal(), 2);
  });

  test('RED (F9): version-LESS roadmap + a fenced example sharing the SAME milestone id — both the selector and the counter must be fence-aware — 2/1/50, not 3/1/33', () => {
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
## [GSD.02] Example milestone heading
### [GSD.02] 05: Example phase
\`\`\`

## [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D2);
    assert.equal(readTotal(), 2, 'pinned 3 before this fix');
    poisonTotalPhasesR4M1();
    assert.equal(syncedTotal(), 2);
    assert.equal(syncedPercent(), 50, 'pinned 33 before this fix');
  });

  test('RED (F12): a fenced-ONLY bracket heading no longer bounds a milestone absent from the roadmap — percent stays suppressed', () => {
    const dirs = [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

Authoring guide:

\`\`\`markdown
## [GSD.02] Example milestone heading
\`\`\`

## [GSD.01] v1.0: Prior

### [GSD.01] 01: Old
**Goal:** a
`, 'bracket', dirs);
    const r = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(r.success, `state json failed: ${r.error}`);
    const progress = JSON.parse(r.output).progress;
    assert.equal(progress?.percent, undefined, 'pinned 67 before this fix — a fenced-only [GSD.02] example wrongly bounded a milestone with no real section');
    // state sync must not persist a percent either — the body stays at its seed.
    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success);
    const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(raw, /\*\*Progress:\*\*[^\r\n]*?0%/, 'pinned 67% persisted before this fix');
  });

  test('PIN: unfenced bracket-fallback selection is byte-identical — first real milestone-shaped heading still wins', () => {
    // No version anywhere, no fences — the selector's plain first-match-wins
    // behavior over REAL headings must be completely unaffected by routing it
    // through tokenizeHeadings.
    const dirs = ['GSD.01-01-old', 'GSD.02-01-one', 'GSD.02-02-two', 'GSD.03-01-later'];
    writeProject(`# Roadmap

## [GSD.01] Prior Milestone

### [GSD.01] 01: Old
**Goal:** a

## [GSD.02] Current Milestone

### [GSD.02] 01: One
**Goal:** b

### [GSD.02] 02: Two
**Goal:** c

## [GSD.03] Later Milestone

### [GSD.03] 01: Later
**Goal:** d
`, 'bracket', dirs);
    const rp = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    const f = rp.getMilestonePhaseFilter(tmpDir);
    assert.deepEqual(Object.fromEntries(dirs.map((d) => [d, !!f(d)])), {
      'GSD.01-01-old': false,
      'GSD.02-01-one': true,
      'GSD.02-02-two': true,
      'GSD.03-01-later': false,
    });
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 round-5 Blocker 1: 3be5c412's merge dropped the `bracketId &&` ───
// ─── guard countRoadmapPhaseHeadings' bracket branch needs ──────────────────
//
// Every other isSentinelPhaseId call site in src/ (roadmap-parser.cts,
// roadmap.cts, validate.cts ×2, verify.cts) guards the call with
// `bracketId &&`. The shared counter's bracket branch omitted it: when the
// LEGACY alternative of the intro grammar matches (a `### Phase 00:` heading
// in a `phase_id_convention: "bracket"` repo — the mid-migration shape this
// PR exists for), `m[1]` (bracketId) is `undefined`, and the call becomes
// `isSentinelPhaseId("undefined-00", 'bracket')` — which is TRUE, silently
// dropping a real phase from the denominator. `getMilestonePhaseFilter`
// still counts it and admits its directory, so the filter and the counter
// disagree — a half-done milestone reads as 100% complete.
describe('#612 PR-2 round-5 Blocker 1: countRoadmapPhaseHeadings restores the bracketId guard', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r5b1-'); });
  afterEach(() => { cleanup(tmpDir); });

  function poisonTotalPhasesR5(dir) {
    const statePath = path.join(dir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }

  test('RED (G3): a legacy `### Phase 00:` heading in a bracket repo is no longer dropped — 3/2/67, not 2/2/100', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 00: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, 'bracket', [['00-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3, 'pinned 2 before this fix — "undefined-00" read as a sentinel');
    poisonTotalPhasesR5(tmpDir);
    assert.equal(syncedTotal(), 3);
    assert.equal(syncedPercent(), 67, 'pinned 100 before this fix — a half-done milestone read as shipped');
  });

  test('PIN (G3 LEGACY control): the identical document under the legacy convention is unaffected', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 00: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, undefined, [['00-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3);
  });

  test('RED (G3d, mixed mid-migration): bracket headings PLUS one legacy `### Phase 00:` — 3/2/67, not 2/2/100', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### Phase 00: Bootstrap
**Goal:** z

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['00-bootstrap', true], ['GSD.02-01-one', true]]);
    assert.equal(readTotal(), 3, 'pinned 2 before this fix');
    poisonTotalPhasesR5(tmpDir);
    assert.equal(syncedTotal(), 3);
    assert.equal(syncedPercent(), 67, 'pinned 100 before this fix');
  });

  test('PIN (G3b, isolates the counter): a `### Phase 000:` heading with no directory — total still 3, no dir to admit', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 000: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, 'bracket', [['01-one', true], ['02-two', false]]);
    assert.equal(readTotal(), 3, 'pinned 2 before this fix');
  });

  test('PIN (G3c control): legacy `### Phase 01:`/`02:` only, no sentinel-shaped token — unaffected', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, 'bracket', [['01-one', true], ['02-two', false]]);
    assert.equal(readTotal(), 2);
  });
});

// ─── #2761 round-5 Major 1: extractRetiredPhaseNumbers is a FIFTH ───────────
// ─── fence-blind site on the bracket path ───────────────────────────────────
//
// The retirement gesture's own line scan iterates `scope.split(/\r?\n/)`
// with no fence awareness. Once the bracket alternative is compiled into
// `introSrc` (this PR's own change), a FENCED authoring EXAMPLE showing the
// #1514 retirement gesture in bracket spelling is indistinguishable from a
// real one — it retires a genuine phase, shrinking the denominator and
// jumping the percent to a confident 100%.
describe('#612 PR-2 round-5 Major 1: extractRetiredPhaseNumbers is fence-aware on the bracket path', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r5m1-'); });
  afterEach(() => { cleanup(tmpDir); });

  const D2 = [['GSD.02-01-one', true], ['GSD.02-02-two', false]];

  test('RED (G2): a fenced retired-strikethrough bracket bullet in the preamble no longer retires a real phase — 2/1/50, not 1/1/100', () => {
    writeProject(`# Roadmap

Retiring a phase looks like this:

\`\`\`markdown
- [x] ~~**[GSD.02] 02: Two**~~ — folded into 03; number retired
\`\`\`

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D2);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix — the fenced EXAMPLE retirement gesture wrongly retired phase 02');
  });

  test('RED (G2b): the same fenced retirement example placed INSIDE the milestone section — not a preamble-scoping artifact', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

Retiring a phase looks like this:

\`\`\`markdown
- [x] ~~**[GSD.02] 02: Two**~~ — folded; number retired
\`\`\`

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', D2);
    assert.equal(readTotal(), 2, 'pinned 1 before this fix');
  });

  test('PIN (G2 LEGACY control): the same fenced-example shape on a non-bracket repo is unchanged (pre-existing, out of scope)', () => {
    writeProject(`# Roadmap

Retiring a phase looks like this:

\`\`\`markdown
- [x] ~~**Phase 02: Two**~~ — folded into 03; number retired
\`\`\`

## Milestone v2.0: Foundation

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, undefined, [['01-one', true], ['02-two', false]]);
    assert.equal(readTotal(), 1, 'pre-existing legacy hazard — deliberately unchanged, base is wrong here too');
  });
});

// ─── #2761 round-5 Major 2: state sync's own counter now excludes the ──────
// ─── bare `999` icebox token like the other two derivations ─────────────────
//
// Under bracket, READING-B puts the sentinel in the BRACKET
// (isSentinelPhaseId), so `/^999\b/` on the bare TOKEN is the only thing
// excluding a `### [GSD.02] 999:` icebox heading — and it ran on the read
// path (buildStateFrontmatter) and getMilestonePhaseFilter, but not on
// cmdStateSync's own counter. One `state sync` call could leave a single
// STATE.md with its frontmatter (percent 50, from the read-path re-sync) and
// its body (percent 33, from the write-path counter that still counted the
// icebox heading) disagreeing.
describe('#612 PR-2 round-5 Major 2: state sync excludes the bracket 999 icebox token like the read path', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r5m2-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('RED (G1): state sync\'s body percent now agrees with state json\'s percent on a bracket 999 icebox heading', () => {
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

### [GSD.02] 999: Backlog item
**Goal:** later
`, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false]]);
    const readPercent = (() => {
      const r = runGsdTools(['state', 'json'], tmpDir);
      assert.ok(r.success, `state json failed: ${r.error}`);
      return JSON.parse(r.output).progress?.percent;
    })();
    assert.equal(readPercent, 50);
    assert.equal(syncedPercent(), readPercent, 'pinned 33 (vs read-path 50) before this fix — one STATE.md, two disagreeing numbers');
  });

  test('PIN (G1 LEGACY control): the pre-existing legacy read/write divergence on the same shape is unchanged', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b

### Phase 999: Backlog item
**Goal:** later
`, undefined, [['01-one', true], ['02-two', false]]);
    const r = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(r.success, `state json failed: ${r.error}`);
    assert.equal(JSON.parse(r.output).progress?.percent, 50);
    assert.equal(syncedPercent(), 33, 'the legacy asymmetry is genuinely pre-existing — deliberately unchanged');
  });
});

// ─── #2761 round-5 Minor 1: the two tokenizeHeadings reconstructions ───────
// ─── (bracket-fallback selector, isMilestoneBounded) accept indented ───────
// ─── headings their raw line-start-anchored predecessors never did ─────────
//
// `HeadingToken.offset` is `tokenizeHeadings`' LINE-START offset. For a
// ≤3-space-indented heading that is NOT the `#` character's own offset, so
// a token the raw `^#{1,3}\s+\[...` regex never matched (indentation moves
// it off the line-start anchor) was still accepted by the reconstruction,
// which then mis-parses (selectedBracketId null, a sibling milestone's
// phases leaking into the scope).
describe('#612 PR-2 round-5 Minor 1: bracket-fallback selector skips indented headings (raw parity)', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r5min1-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('RED (G6): a 2-space-indented, version-less bracket milestone heading no longer leaks the NEXT milestone\'s phases in — 2/1/50, not 3/2/67', () => {
    writeProject(`# Roadmap

  ## [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

## [GSD.03] Later

### [GSD.03] 01: Later one
**Goal:** c
`, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false], ['GSD.03-01-later-one', true]]);
    assert.equal(readTotal(), 2, 'pinned 3 before this fix — GSD.03\'s phase leaked into scope');
    assert.equal(syncedPercent(), 50, 'pinned 67 before this fix');
  });

  test('PIN (G6c UNINDENTED control): the identical document with no leading indent is unaffected — 2/1/50', () => {
    writeProject(`# Roadmap

## [GSD.02] Foundation

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b

## [GSD.03] Later

### [GSD.03] 01: Later one
**Goal:** c
`, 'bracket', [['GSD.02-01-one', true], ['GSD.02-02-two', false], ['GSD.03-01-later-one', true]]);
    assert.equal(readTotal(), 2);
    assert.equal(syncedPercent(), 50);
  });

  // G6 above happens to leave isMilestoneBounded's own verdict unchanged
  // either way — the phase headings (`### [GSD.02] 01: One`, unindented)
  // already satisfy its loose bracket-prefix regex, so it returns bounded=true
  // both before and after this fix on that fixture. This second fixture
  // isolates isMilestoneBounded specifically: the ONLY `[GSD.02]`-shaped
  // heading anywhere in the document is indented, mirroring round-4's F12
  // (fenced-ONLY) shape but with indentation as the parity gap instead of a
  // fence.
  test('RED (isMilestoneBounded site, indented-ONLY): an indented-only bracket heading no longer bounds a milestone absent from the roadmap — percent stays suppressed', () => {
    const dirs = [['GSD.01-01-old', true], ['GSD.02-01-one', true], ['GSD.02-02-two', false]];
    writeProject(`# Roadmap

Authoring guide:

  ## [GSD.02] Example milestone heading

## [GSD.01] v1.0: Prior

### [GSD.01] 01: Old
**Goal:** a
`, 'bracket', dirs);
    const r = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(r.success, `state json failed: ${r.error}`);
    const progress = JSON.parse(r.output).progress;
    assert.equal(progress?.percent, undefined, 'pinned 100 before this fix — an indented-only [GSD.02] example wrongly bounded a milestone with no real section');
    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success);
    const raw = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(raw, /\*\*Progress:\*\*[^\r\n]*?0%/, 'pinned 100% persisted before this fix; body must stay at its seed');
  });
});

// ─── #2761 round-6 Blocker 1: countRoadmapPhaseHeadings' bracket-only ──────
// ─── `/^0\b/` sibling rule needs the SAME `bracketId &&` guard round-5's ───
// ─── Blocker 1 restored two lines above it ──────────────────────────────────
//
// Round-5's Blocker 1 was `isSentinelPhaseId("undefined-00")`. This is the
// identical failure one line down: when the phase-heading grammar's LEGACY
// alternative matches (`### Phase 0:` in a `phase_id_convention: "bracket"`
// repo — the mid-migration shape this PR exists for), `bracketId` is
// `undefined`, and the unguarded `/^0\b/` fires on the bare token anyway.
// Neither the LEGACY branch of this same function nor
// `getMilestonePhaseFilter` has a `/^0\b/` rule at all, so the filter counts
// the phase and admits its completed directory while the counter refuses to
// count its heading — a milestone with an unstarted phase 02 persists as a
// confident 100%. `/^0\b/` matches `0` and `0.5` (word boundary before the
// dot) but not `00` (no boundary between the two zeros) — which is exactly
// why round-5's G3/G3d fixtures (both spelled `Phase 00:`) never tripped
// this one.
describe('#612 PR-2 round-6 Blocker 1: countRoadmapPhaseHeadings\' bracket-only /^0\\b/ rule restores the bracketId guard', () => {
  beforeEach(() => { tmpDir = createTempProject('adr-612-r6b1-'); });
  afterEach(() => { cleanup(tmpDir); });

  function poisonTotalPhasesR6(dir) {
    const statePath = path.join(dir, '.planning', 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, raw.replace(/^---\r?\n/, '---\ntotal_phases: 999\n'), 'utf-8');
  }

  test('RED (T0): a legacy `### Phase 0:` heading in a bracket repo is no longer dropped — 3/2/67, not 2/2/100', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 0: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, 'bracket', [['0-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3, 'pinned 2 before this fix — "0" read as a sentinel with no bracketId guard');
    poisonTotalPhasesR6(tmpDir);
    assert.equal(syncedTotal(), 3);
    assert.equal(syncedPercent(), 67, 'pinned 100 before this fix — a milestone with an unstarted phase 02 read as shipped');
  });

  test('PIN (T0L LEGACY control): the identical document under the legacy convention is unaffected', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 0: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, undefined, [['0-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3);
  });

  test('RED (T05): a legacy `### Phase 0.5:` heading in a bracket repo — same defect, second spelling — 3/2/67, not 2/2/100', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 0.5: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, 'bracket', [['0.5-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3, 'pinned 2 before this fix');
    poisonTotalPhasesR6(tmpDir);
    assert.equal(syncedTotal(), 3);
    assert.equal(syncedPercent(), 67, 'pinned 100 before this fix');
  });

  test('PIN (T05L LEGACY control): the identical document under the legacy convention is unaffected', () => {
    writeProject(`# Roadmap

## Milestone v2.0: Foundation

### Phase 0.5: Bootstrap
**Goal:** z

### Phase 01: One
**Goal:** a

### Phase 02: Two
**Goal:** b
`, undefined, [['0.5-bootstrap', true], ['01-one', true]]);
    assert.equal(readTotal(), 3);
  });

  test('PIN (B0, bracket-spelled `0` token — Minor 1, NOT fixed this round): counter/filter disagreement is base-parity, deliberately unchanged', () => {
    // `### [GSD.02] 0: Bootstrap` — the SAME token shape, spelled in bracket
    // form rather than legacy form. `isSentinelPhaseId('GSD.02-0','bracket')`
    // is false (READING-B puts the sentinel in the bracket, not the token),
    // so `/^0\b/` is the only thing that could exclude it — and per round-6's
    // review this shape reads 2/2/100 on base AND HEAD (never closed by any
    // build in this arc), so it is a pre-existing gap, not a regression.
    // Disclosed in the changeset; pinned here as a base-parity characterization.
    writeProject(`# Roadmap

## [GSD.02] v2.0: Foundation

### [GSD.02] 0: Bootstrap
**Goal:** z

### [GSD.02] 01: One
**Goal:** a

### [GSD.02] 02: Two
**Goal:** b
`, 'bracket', [['GSD.02-0-bootstrap', true], ['GSD.02-01-one', true]]);
    assert.equal(readTotal(), 2, 'base-parity: this shape has never been closed by any build in this arc');
  });
});
