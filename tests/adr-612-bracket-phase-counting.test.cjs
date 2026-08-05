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
`, 'bracket');
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
    // One completed phase directory. With the sentinel guard the denominator is
    // 2 (05, 06) so the percent is 50; without it the two sentinel headings
    // inflate it to 4 and the percent drops to 25.
    writeProject(SENTINEL_ROADMAP, 'bracket');
    assert.equal(syncedPercent(), 50, 'sentinel headings must not inflate the sync denominator');
  });

  test('a LOWERCASE sentinel bracket is excluded from both', () => {
    const doc = SENTINEL_ROADMAP.replace(/GSD\./g, 'gsd.');
    writeProject(doc, 'bracket');
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
`, 'bracket');
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
      retiredRoadmap('~~**[GSD.02] 04: Delta**~~', '### [GSD.02] 04: Delta'), 'bracket');
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

  test('shape 2 WRITE: 60%, the DISCLOSED legacy gap, mirrored — not closed', () => {
    // cmdStateSync does its own `fs.readdirSync` and never calls the milestone
    // filter, so its denominator is the whole disk: 3 summaries over 5 plans =
    // 60%, against the read path's scoped 33%. That divergence is PRE-EXISTING
    // and identical on the flat-legacy twin at the true base build — scoping the
    // sync counter here would fix legacy behaviour inside a bracket read-path PR
    // and move every legacy repo's percent. It is mirrored deliberately.
    writeProject(TWO_MILESTONE_BRACKET, 'bracket', TWO_BRACKET_DIRS);
    const bracket = syncedPercent();
    writeProject(TWO_MILESTONE_LEGACY, undefined, TWO_LEGACY_DIRS);
    assert.equal(bracket, syncedPercent(), 'the gap must be mirrored, not closed on one side');
    assert.equal(bracket, 60);
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
