// allow-test-rule: source-text-is-the-product, see #3204
// Reads STATE.md/ROADMAP.md fixture files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * #3204 / #3185 — failing-first regression suite for `buildStateFrontmatter`'s
 * `total_phases` selection (`src/state.cts:1620`, guard at `:1795-1805`).
 *
 * `hasMilestoneSectioning` (`src/roadmap-parser.cts:195`) is
 *   /^#{2,3}\s+(?!Phase\s+\S)/mi
 * — true for ANY non-Phase level-2/3 heading, so a FLAT roadmap carrying an
 * ordinary structural heading (`## Progress`, `## Overview`, ...) is
 * misclassified as milestone-sectioned. `safeToUseRoadmapCount` then goes
 * false and the on-disk phase-directory count silently clobbers the
 * ROADMAP-declared count — a regression of #2828, reported in #3204 as
 * "roadmap declares 6 phases, 4 directories exist, state.record-session
 * writes total_phases: 4".
 *
 * DO NOT fix src/state.cts or src/roadmap-parser.cts from this file. Rows 2,
 * 3, and 14 below assert the CORRECT (post-fix) value and currently FAIL —
 * that is the point of a failing-first suite. Every other row asserts
 * behavior verified to already hold today (see phase-log for the manual CLI
 * probes that established each expected value before this file was written).
 *
 * Rows and naming follow `.gsd/phase/fix-3185-state-writer-phase-count/50-test-matrix.md`
 * verbatim (row numbers refer to that matrix, not the 8-row table in
 * `40-design.md`).
 *
 * Driven via `state record-session` (the shape #3204's own report used),
 * then read back with `state json --raw` — the product's own frontmatter
 * parser — so `progress.total_phases` is asserted as a NUMBER, never a
 * regex over rendered STATE.md text. `tests/helpers.cjs`'s `parseFrontmatter`
 * only reads flat top-level keys (it does not descend into the nested
 * `progress:` block), so `state json --raw` is the correct structured seam
 * for a nested field — it is what `tests/state.test.cjs`'s own '#1761
 * read-path' and 'milestone-scoped phase counting' suites already use for
 * this exact assertion shape.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed `.planning/phases/<padded>-phase-<n>` for each phase number in `nums`,
 * each with a single PLAN.md so the directory is a recognizable phase dir.
 */
function seedPhaseDirs(tmpDir, nums) {
  for (const n of nums) {
    const padded = String(n).padStart(2, '0');
    const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan\n');
  }
}

/** Seed one arbitrarily-named phase directory (sentinel / dup / pre-milestone cases). */
function seedNamedPhaseDir(tmpDir, dirName, planBase) {
  const dir = path.join(tmpDir, '.planning', 'phases', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planBase}-01-PLAN.md`), '# Plan\n');
}

/**
 * Build STATE.md frontmatter + minimal body. `milestone` is always set (the
 * #3204 fixture needs it truthy — `getMilestoneInfo` defaults an absent
 * `milestone:` field to 'v1.0' anyway, so this pins the same value
 * explicitly for every row rather than relying on that fallback).
 * Lines are joined with the caller-supplied `eol` (default '\n') — row 14
 * reuses this to build the CRLF variant without a second copy.
 */
function buildStateMd({ milestone = 'v1.0', milestoneName = 'Test', totalPhases, currentPhase = '01', eol = '\n' }) {
  const lines = [
    '---',
    'gsd_state_version: 1.0',
    `milestone: ${milestone}`,
    `milestone_name: ${milestoneName}`,
    `current_phase: "${currentPhase}"`,
    'status: executing',
    'progress:',
    `  total_phases: ${totalPhases}`,
    '  completed_phases: 0',
    '  total_plans: 0',
    '  completed_plans: 0',
    '  percent: 0',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Current Phase:** ${currentPhase}`,
    '**Status:** Executing',
    '',
  ];
  return lines.join(eol);
}

/** Invoke `state record-session` (the #3204 entry point) then read back `state json --raw`. */
function recordSessionAndReadTotalPhases(tmpDir) {
  const recordResult = runGsdTools(
    ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'],
    tmpDir,
  );
  assert.ok(recordResult.success, `state record-session failed: ${recordResult.error}`);

  const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
  assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
  return JSON.parse(jsonResult.output);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows 1-3, 14 — #3204 regression: flat roadmap + a structural heading
// ─────────────────────────────────────────────────────────────────────────────

describe('#3204 buildStateFrontmatter total_phases — flat roadmap misclassified as milestone-sectioned', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('flat roadmap with no structural headings keeps the roadmap count', () => {
    // Row 1 (happy path / control) — no non-Phase heading anywhere, so
    // hasMilestoneSectioning is false today and this already passes. Guards
    // against a fix that overcorrects and breaks the trivial flat case.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected roadmap count 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('#3204 flat roadmap with a Progress heading is not treated as milestone-sectioned', () => {
    // Row 2 — the crux repro, transcribed from #3204's own report: 6
    // declared phases, 4 directories, a flat '## Progress' heading. FAILS
    // TODAY: hasMilestoneSectioning misclassifies '## Progress' as
    // sectioning, safeToUseRoadmapCount goes false, and the write clobbers
    // total_phases down to the disk count (4) instead of 6.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Progress',
      '',
      'Some progress notes.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204: total_phases must stay 6 (roadmap-declared), not clobber to the disk count of 4. Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3204 multiple structural headings still count as flat', () => {
    // Row 3 — same shape as row 2 with TWO structural headings ('## Overview',
    // '## Phase Details'); '## Phase Details' is correctly excluded by the
    // heading's own '(?!Phase\s+\S)' lookahead, but '## Overview' still trips
    // the misclassification. FAILS TODAY for the same reason as row 2.
    const roadmap = [
      '# Roadmap',
      '',
      '## Overview',
      '',
      'Some overview text.',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Phase Details',
      '',
      'More detail prose.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204: multiple structural headings must still count as flat (6), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3204 repro under CRLF', () => {
    // Row 14 — row 2's exact repro, all fixture content authored with CRLF
    // line endings, proving the bug (and required fix) is not an artifact of
    // LF-only fixtures. FAILS TODAY for the same reason as row 2.
    const roadmapLines = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Progress',
      '',
      'Some progress notes.',
      '',
    ];
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapLines.join('\r\n'));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ totalPhases: 6, eol: '\r\n' }),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204 under CRLF: total_phases must stay 6, got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows 4-11 — negative space and boundaries (must hold both before and after the fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3204 buildStateFrontmatter total_phases — negative space / boundaries (must not regress)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bounded milestone uses its own section count', () => {
    // Row 4 — versioned roadmap with two sibling milestone sections ('## v1.0'
    // owning phases 1-2, '## v2.0' owning phases 3-5). The asserted milestone
    // ('v2.0') IS bound to its own heading, so `sliceMilestoneWindow`/
    // `extractCurrentMilestoneScoped` narrow to that section and
    // roadmapPhaseCount is the SECTION's count (3), not the whole-document
    // count (5) and not the disk count (2 dirs seeded).
    const roadmap = [
      '# Roadmap',
      '',
      '## v1.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '',
      '## v2.0',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v2.0', milestoneName: 'Second', totalPhases: 3 }),
    );
    seedPhaseDirs(tmpDir, [3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `a bounded milestone must use its own section's phase count (3), not the whole document (5) or the disk count (2). Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('a single milestone section cannot conflate siblings', () => {
    // Row 6 — exactly ONE '## v2.0' section owning phases, with the asserted
    // milestone ('v9.9') absent from the roadmap entirely. One milestone
    // heading can never satisfy hasMilestoneSectioning's >=2 threshold, so
    // this is NOT sectioned and the roadmap-declared count is still used.
    const roadmap = [
      '# Roadmap',
      '',
      '## v2.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Absent', totalPhases: 4 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `a single milestone section cannot conflate siblings; expected the roadmap count (4), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#1761 sibling milestone sections still fall back to the disk count', () => {
    // Row 5 — TWO sibling (unversioned) milestone sections, asserted
    // milestone ('v3.0') absent from either. This is genuinely
    // milestone-sectioned (2 phase-bearing sections would conflate if
    // whole-doc counted), so total_phases must stay the disk count. Passes
    // today; a fix that touches hasMilestoneSectioning must not break it.
    const roadmap = [
      '# Roadmap',
      '',
      '## Milestone 1: First Milestone',
      '### Phase 1: a',
      '### Phase 2: b',
      '### Phase 3: c',
      '### Phase 4: d',
      '',
      '## Milestone 2: Second Milestone',
      '### Phase 5: e',
      '### Phase 6: f',
      '### Phase 7: g',
      '### Phase 8: h',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v3.0', milestoneName: 'Third', totalPhases: 8 }),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `#1761: unbounded sibling milestones must fall back to the disk count (3), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('zero phase directories keeps the declared count', () => {
    // Row 7 — boundary limit-1: 0 dirs vs 6 declared.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    // No phase dirs seeded.

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('equal counts agree', () => {
    // Row 8 — boundary limit: 6 dirs vs 6 declared.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4, 5, 6]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('extra directories win via max()', () => {
    // Row 9 — boundary limit+1. 6 heading-declared phases + a 7th phase
    // declared only via the bullet-entry syntax ('- [ ] **Phase 7 — Extra**',
    // #2199 bullet house style), which the directory-membership filter
    // counts but the heading-only roadmapPhaseCount scan does not — so disk
    // (7, all pass the membership filter) legitimately exceeds the
    // heading-only roadmap count (6), and max() must pick 7.
    //
    // NOTE: a naive "N heading-declared phases + N+1 plain directories" does
    // NOT exercise this path — the directory-membership filter
    // (getMilestonePhaseFilter, roadmap-parser.cts) excludes any directory
    // whose phase number has no matching roadmap entry at all, so an
    // out-of-roadmap directory number is silently dropped from the disk
    // count rather than inflating it. Verified against the running CLI
    // before authoring this fixture.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '- [ ] **Phase 7 — Extra**',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4, 5, 6, 7]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      7,
      `expected max(7 dirs, 6 heading-declared) = 7, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('absent roadmap falls back to disk', () => {
    // Row 10 — no ROADMAP.md at all.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 4, `expected disk count 4, got ${out.progress && out.progress.total_phases}`);
  });

  test('roadmap with no phase headings falls back to disk', () => {
    // Row 11 — ROADMAP.md present but zero Phase headings anywhere.
    const roadmap = ['# Roadmap', '', '## Notes', '', 'No phases declared yet.', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 4, `expected disk count 4, got ${out.progress && out.progress.total_phases}`);
  });

  test('a phase heading carrying a version token is not a milestone heading', () => {
    // Row 12 (hostile, negative space) — '### Phase 3: Ship v2.0 gaps' carries
    // a version token in its own text, but hasMilestoneSectioning's
    // isPhaseHeading check excludes any heading matching '^Phase\s+\S' before
    // the vocabulary signal is ever tested, so this must NOT count as a
    // milestone heading. Otherwise-flat roadmap, so the roadmap-declared
    // count must be used, not the disk count.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '### Phase 3: Ship v2.0 gaps',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `a version token borne by a Phase heading must not trigger milestone sectioning; expected roadmap count 4, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('a version heading inside a fence is not sectioning', () => {
    // Row 13 (hostile, negative space) — '## v2.0' appears only inside a
    // fenced code block (a documentation example of the heading syntax) on an
    // otherwise flat roadmap. hasMilestoneSectioning is routed through
    // tokenizeHeadings (fence-aware), so a fenced heading is never tokenised
    // and must NOT count as sectioning. The roadmap-declared count must be
    // used, not the disk count.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
      'Example heading syntax:',
      '',
      '```',
      '## v2.0',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `a version heading inside a fence must not trigger milestone sectioning; expected roadmap count 4, got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3185 adversarial review — hasMilestoneSectioning ownership-model shapes
// missed by the original suite (BLOCKER + MAJOR findings against the #3184
// "strictly-deeper nesting" rewrite).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3185 review — hasMilestoneSectioning shapes the original suite missed', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('BLOCKER: same-level sibling milestones fall back to the disk count', () => {
    // Adversarial review BLOCKER (#1761 regression): the #3184 rewrite
    // required a candidate milestone heading's owned Phase heading to be
    // STRICTLY DEEPER (next.level > candidate.level). Real sibling
    // milestones are frequently at the SAME level as their own Phase
    // headings ('## v1.0' / '## Phase 1:' / '## v2.0' / '## Phase 3:'), so
    // that predicate answered false and the whole-document count conflated
    // both milestones. The asserted milestone ('v3.0') is unbound (matches
    // neither v1.0 nor v2.0), so this is genuinely sectioned and must fall
    // back to the disk count.
    const roadmap = [
      '# Roadmap',
      '',
      '## v1.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '',
      '## v2.0',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v3.0', milestoneName: 'Third', totalPhases: 4 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      2,
      `same-level sibling milestones must fall back to the disk count (2), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3185 repro: structural headings interleaved among flat phases keep the roadmap count', () => {
    // #3185's own reproduction of the adjacency model this suite's
    // predecessor shipped: '## Overview' sits immediately before
    // '## Phase 1:' and '## Notes' sits immediately before '## Phase 4:',
    // giving an adjacency-based predicate 2 "owning" candidates even though
    // neither heading carries any milestone vocabulary (no version token, no
    // status marker, no "Milestone" word) and the roadmap is genuinely flat.
    const roadmap = [
      '# Roadmap',
      '',
      '## Overview',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Notes',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Test', totalPhases: 6 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3185: structural headings adjacent to phase headings must not be treated as milestone sectioning; expected roadmap count 6, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('MAJOR: wrapper + single nested milestone keeps the roadmap count', () => {
    // Adversarial review MAJOR (#3204 reintroduction): every ancestor in a
    // nesting chain was counted as its own candidate section under the
    // #3184 rewrite, so a generic wrapper heading with only ONE real
    // milestone nested under it was misclassified as sectioned. Mirrors
    // this repo's own bundled template shape (gsd-core/templates/roadmap.md:
    // '## Phases' -> '### 🚧 v1.1 [Name] (In Progress)' -> '#### Phase N:').
    // The asserted milestone ('v9.9') is deliberately unbound so the
    // assertion exercises hasMilestoneSectioning itself, not
    // isMilestoneBoundedInRoadmap.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phases',
      '',
      '### 🚧 v1.1 [Name] (In Progress)',
      '',
      '#### Phase 1: One',
      '#### Phase 2: Two',
      '#### Phase 3: Three',
      '#### Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Unbound', totalPhases: 2 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `wrapper + single nested milestone must keep the roadmap-declared count (4), not clobber to the disk count of 2. Got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows 15-18 — #3185 consolidation independence checks
//
// These exercise the directory-enumeration owner (listMilestonePhaseDirs /
// getMilestonePhaseFilter), not hasMilestoneSectioning. Verified PASSING
// against the current build (manual CLI probe) before being added here —
// included per the dispatch brief's "include only if they pass today"
// condition. If a future change to the #3204 fix regresses one of these,
// that is a SEPARATE finding from the #3204 repro above, not folded into it.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3185 buildStateFrontmatter total_phases — directory-enumeration independence (currently passing)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sentinel directories are excluded by the canonical enumeration', () => {
    // Row 15 — a 999.x backlog directory alongside 3 real phase directories
    // must not inflate total_phases.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '999.1-backlog-idea', '999.1');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `sentinel 999.x directory must be excluded, expected 3, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('pre-milestone directories are excluded', () => {
    // Row 16 — a '0-*' pre-milestone directory must not be counted.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '0-premilestone', '0');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `pre-milestone '0-*' directory must be excluded, expected 3, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('duplicate phase-number directories count once', () => {
    // Row 17 — two directories both keyed to phase number 2 must dedup to a
    // single count.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '02-phase-2-dup', '02');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `duplicate phase-2 directories must dedup to a single count (3), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('re-running record-session does not move total_phases', () => {
    // Row 18 — idempotence: a second record-session call over an unchanged
    // tree, with the clock pinned so 'Last session' does not itself vary,
    // must produce a byte-identical STATE.md.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const sessionState = [
      '# GSD State',
      '',
      '## Session',
      '',
      '**Last session:** 2024-01-01T00:00:00.000Z',
      '**Stopped at:** None',
      '**Resume file:** None',
      '',
      '## Current Position',
      '',
      '**Current Phase:** 01',
      '**Status:** Executing',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionState);
    seedPhaseDirs(tmpDir, [1, 2, 3]);

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const pinnedEnv = { GSD_TEST_MODE: '1', GSD_NOW_MS: '1600000000000' };
    const args = ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'];

    const first = runGsdTools(args, tmpDir, pinnedEnv);
    assert.ok(first.success, `first record-session failed: ${first.error}`);
    const afterFirst = fs.readFileSync(statePath, 'utf8');

    const second = runGsdTools(args, tmpDir, pinnedEnv);
    assert.ok(second.success, `second record-session failed: ${second.error}`);
    const afterSecond = fs.readFileSync(statePath, 'utf8');

    assert.strictEqual(
      afterSecond,
      afterFirst,
      're-running record-session on an unchanged tree with a pinned clock must produce a byte-identical STATE.md',
    );
  });
});
