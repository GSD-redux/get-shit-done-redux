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
  for (const d of dirs) {
    const dir = path.join(planning, 'phases', d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-x-PLAN.md'), '# plan\n', 'utf-8');
    fs.writeFileSync(path.join(dir, '01-01-x-SUMMARY.md'), '# summary\n', 'utf-8');
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
