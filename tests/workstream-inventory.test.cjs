'use strict';

// Regression + projection coverage for the workstream-inventory module.
// #1913: status must be derived from authoritative shipped signals (milestone
// archive snapshot / ROADMAP SHIPPED marker), not trusted from the mutable
// STATE.md `Status` field.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { createFixture, seedWorkstream } = require('./fixtures/index.cjs');
const { buildWorkstreamInventory, isCompletedInventory } = require('../gsd-core/bin/lib/workstream-inventory-builder.cjs');
const { inspectWorkstream } = require('../gsd-core/bin/lib/workstream-inventory.cjs');

const STALE_STATE = 'status: executing\n';
const IN_PROGRESS_ROADMAP =
  '# Roadmap\n## Milestones\n- v2.0 Test — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n';

describe('#1913 — workstream status derived from authoritative shipped signals', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  test('builder: milestoneShipped overrides a stale executing field (derived + conflict)', () => {
    const inv = buildWorkstreamInventory({
      name: 'ws-a',
      projectDir: tmpDir,
      workstreamDir: path.join(tmpDir, '.planning', 'workstreams', 'ws-a'),
      phaseDirNames: [],
      activeWorkstreamName: '',
      phaseFilesCounts: [],
      roadmapPhaseCount: 0,
      stateProjection: { status: 'executing', current_phase: null, last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: true },
      milestoneShipped: true,
    });
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('builder: no shipped signal → field status, no conflict', () => {
    const inv = buildWorkstreamInventory({
      name: 'ws-b',
      projectDir: tmpDir,
      workstreamDir: path.join(tmpDir, '.planning', 'workstreams', 'ws-b'),
      phaseDirNames: [],
      activeWorkstreamName: '',
      phaseFilesCounts: [],
      roadmapPhaseCount: 0,
      stateProjection: { status: 'executing', current_phase: null, last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: true },
      milestoneShipped: false,
    });
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
    assert.equal(inv.status_conflict, false);
  });

  test('inspectWorkstream: shipped archive snapshot + stale executing STATE → derived complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-archived' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), IN_PROGRESS_ROADMAP);
    // Authoritative shipped signal: an archived milestone snapshot.
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v1.0-ROADMAP.md'), '# v1.0 archived\n');

    const inv = inspectWorkstream(tmpDir, 'ws-archived', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('inspectWorkstream: ROADMAP SHIPPED marker + stale executing STATE → derived complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-shipped' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(
      path.join(wsDir, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n<details><summary>✅ v1.0 MVP - SHIPPED 2026-06-01</summary>\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n'
    );

    const inv = inspectWorkstream(tmpDir, 'ws-shipped', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('inspectWorkstream: no shipped signals + executing STATE → field status, no conflict', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-active' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), IN_PROGRESS_ROADMAP);

    const inv = inspectWorkstream(tmpDir, 'ws-active', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
    assert.equal(inv.status_conflict, false);
  });
});

describe('isCompletedInventory — ADR-2207 status lifecycle', () => {
  test('terminal "milestone complete" variants are completed', () => {
    assert.ok(isCompletedInventory('1.0 milestone complete'));
    assert.ok(isCompletedInventory('Milestone complete'));
    assert.ok(isCompletedInventory('milestone  complete'));
  });

  test('intermediate "All phases complete" is NOT completed (ADR-2207)', () => {
    assert.ok(!isCompletedInventory('All phases complete'),
      'All phases complete is an intermediate state — milestone not yet formally closed');
  });

  test('archived is completed', () => {
    assert.ok(isCompletedInventory('archived'));
  });

  test('active statuses are NOT completed', () => {
    assert.ok(!isCompletedInventory('Ready to plan'));
    assert.ok(!isCompletedInventory('In progress'));
    assert.ok(!isCompletedInventory('Executing'));
  });
});

// #2562: progress/status must be DERIVED from on-disk artifacts scoped to the
// CURRENT milestone — never a project-lifetime "ever shipped anything" signal,
// never a denominator that silently drops declared-but-unscaffolded phases, and
// never counting a phase with a failing VERIFICATION verdict as complete.
describe('#2562 — progress/status scoped to the current milestone (derived from artifacts)', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  const BUILDER_BASE = {
    projectDir: '/tmp/ws-proj',
    workstreamDir: '/tmp/ws-proj/.planning/workstreams/ws',
    activeWorkstreamName: '',
    stateProjection: { status: 'executing', current_phase: null, last_activity: null },
    filesExist: { roadmap: true, state: true, requirements: true },
    milestoneShipped: false,
  };

  // ── Defect 3: verification-gated completeness (builder unit) ─────────────────
  test('builder: SUMMARY≥PLAN but a human_needed verdict is NOT complete', () => {
    const inv = buildWorkstreamInventory({
      ...BUILDER_BASE,
      name: 'ws',
      phaseDirNames: ['1-a', '2-b'],
      phaseFilesCounts: [
        { directory: '1-a', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
        { directory: '2-b', planCount: 4, summaryCount: 4, inMilestone: true, verificationStatus: 'human_needed' },
      ],
      roadmapPhaseCount: 2,
      currentMilestonePhaseCount: 2,
    });
    assert.equal(inv.phases.find(p => p.directory === '2-b').status, 'in_progress');
    assert.equal(inv.completed_phases, 1);
    assert.equal(inv.progress_percent, 50);
  });

  test('builder: missing/unknown verdict still counts complete (no verifier-off regression)', () => {
    const inv = buildWorkstreamInventory({
      ...BUILDER_BASE,
      name: 'ws',
      phaseDirNames: ['1-a'],
      phaseFilesCounts: [
        { directory: '1-a', planCount: 2, summaryCount: 2, inMilestone: true, verificationStatus: 'missing' },
      ],
      roadmapPhaseCount: 1,
      currentMilestonePhaseCount: 1,
    });
    assert.equal(inv.phases[0].status, 'complete');
    assert.equal(inv.progress_percent, 100);
  });

  // ── Defect 2: denominator includes declared-but-unscaffolded phases (builder) ─
  test('builder: current-milestone denominator counts a phase with no directory', () => {
    const inv = buildWorkstreamInventory({
      ...BUILDER_BASE,
      name: 'ws',
      phaseDirNames: ['1-a', '2-b'], // phase 3 declared for the milestone but never scaffolded
      phaseFilesCounts: [
        { directory: '1-a', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
        { directory: '2-b', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
      ],
      roadmapPhaseCount: 2,
      currentMilestonePhaseCount: 3,
    });
    assert.equal(inv.roadmap_phase_count, 3);
    assert.equal(inv.completed_phases, 2);
    assert.equal(inv.progress_percent, 67, 'the dirless third phase keeps this below 100');
  });

  // ── Defect 1: prior-milestone phases must not inflate the numerator (builder) ─
  test('builder: completed prior-milestone dirs are excluded from the current rollup', () => {
    const inv = buildWorkstreamInventory({
      ...BUILDER_BASE,
      name: 'ws',
      phaseDirNames: ['1-old', '2-cur'],
      phaseFilesCounts: [
        { directory: '1-old', planCount: 3, summaryCount: 3, inMilestone: false, verificationStatus: 'passed' },
        { directory: '2-cur', planCount: 2, summaryCount: 0, inMilestone: true, verificationStatus: 'missing' },
      ],
      roadmapPhaseCount: 2,
      currentMilestonePhaseCount: 1,
    });
    assert.equal(inv.completed_phases, 0);
    assert.equal(inv.total_plans, 2, 'only the current-milestone directory contributes plans');
    assert.equal(inv.progress_percent, 0);
  });

  // ── inspectWorkstream integration (all three defects, end-to-end) ────────────
  function writeWsPhase(wsDir, slug, { plans = 0, summaries = 0, verification } = {}) {
    const dir = path.join(wsDir, 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= plans; i++) fs.writeFileSync(path.join(dir, `0${i}-PLAN.md`), '# plan\n');
    for (let i = 1; i <= summaries; i++) fs.writeFileSync(path.join(dir, `0${i}-SUMMARY.md`), '# summary\n');
    if (verification) fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), `---\nstatus: ${verification}\n---\n`);
  }

  const MS_STATE = 'milestone: v2.0\nstatus: executing\n';
  // Milestone-grouped Progress table: v2.0 declares phases 3,4,5; 1,2 are shipped v1.0.
  const MS_ROADMAP = [
    '# Roadmap', '', '## Progress', '',
    '| Phase | Milestone | Plans | Status | Done |',
    '| --- | --- | --- | --- | --- |',
    '| 1. Old A | v1.0 | 2/2 | Complete | - |',
    '| 2. Old B | v1.0 | 2/2 | Complete | - |',
    '| 3. New A | v2.0 | 1/1 | Complete | - |',
    '| 4. New B | v2.0 | 0/1 | In Progress | - |',
    '| 5. New C | v2.0 | 0/1 | Not started | - |',
    '',
  ].join('\n');

  test('inspectWorkstream: prior-milestone dirs + a dirless current phase → not complete, not 100%', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-scope' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), MS_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), MS_ROADMAP);
    writeWsPhase(wsDir, '1-old-a', { plans: 2, summaries: 2, verification: 'passed' });
    writeWsPhase(wsDir, '2-old-b', { plans: 2, summaries: 2, verification: 'passed' });
    writeWsPhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' });
    writeWsPhase(wsDir, '4-new-b', { plans: 1, summaries: 0 }); // in progress; phase 5 has NO dir

    const inv = inspectWorkstream(tmpDir, 'ws-scope', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 3, 'denominator = v2.0 phases {3,4,5}, incl. dirless 5');
    assert.equal(inv.completed_phases, 1, 'only phase 3; shipped v1.0 phases 1,2 excluded');
    assert.equal(inv.progress_percent, 33);
    assert.notEqual(inv.status, 'milestone complete');
    assert.equal(inv.status, 'executing');
  });

  // Reporter's minimal fixture (issue #2562): a FLAT Progress table (no Milestone
  // column, so milestone scoping cannot engage) where phase 2 is declared as a
  // table row only — no `### Phase 2` heading, no directory. The heading-only
  // count sees just phase 1 and silently drops phase 2 from the denominator.
  test('inspectWorkstream: flat Progress table — a table-only phase still counts in the denominator', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-flat' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), 'status: executing\n');
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '## Phases', '', '### Phase 1: Foo', '**Goal:** foo', '',
      '## Progress', '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Foo | 1/1 | Complete | - |',
      '| 2. Bar | 0/1 | Not started | - |',
      '',
    ].join('\n'));
    writeWsPhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });

    const inv = inspectWorkstream(tmpDir, 'ws-flat', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2, 'table-only phase 2 must not vanish from the denominator');
    assert.equal(inv.phases[0].status, 'in_progress', 'gaps_found verdict is not complete');
    assert.equal(inv.completed_phases, 0);
    assert.equal(inv.progress_percent, 0);
  });

  // A sub-phase inserted mid-milestone (`3.1-…`) has no Progress-table row. It
  // inherits its parent's milestone and must land on BOTH sides of the rollup:
  // numerator-only would let completed_phases exceed the denominator and cap
  // back to 100%, reintroducing the very defect this issue is about.
  test('inspectWorkstream: a dir-only sub-phase counts in BOTH numerator and denominator', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-subphase' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), MS_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), MS_ROADMAP);
    // v2.0 declares 3,4,5. All three complete, PLUS a dir-only 3.1 still in progress.
    writeWsPhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' });
    writeWsPhase(wsDir, '3.1-inserted', { plans: 2, summaries: 0 });
    writeWsPhase(wsDir, '4-new-b', { plans: 1, summaries: 1, verification: 'passed' });
    writeWsPhase(wsDir, '5-new-c', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-subphase', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 4, 'denominator = declared {3,4,5} + inherited 3.1');
    assert.equal(inv.completed_phases, 3);
    assert.equal(inv.progress_percent, 75, 'the in-progress sub-phase must hold this below 100');
    assert.equal(inv.total_plans, 5, 'the sub-phase contributes its plans too');
  });

  test('inspectWorkstream: a PRIOR-version snapshot does not mark the current milestone complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-prior-snap' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), MS_STATE); // current milestone = v2.0
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), MS_ROADMAP);
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v1.0-ROADMAP.md'), '# v1.0 archived\n');
    writeWsPhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-prior-snap', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'executing', 'v1.0 snapshot must not mark v2.0 complete');
    assert.equal(inv.status_source, 'field');
  });

  test('inspectWorkstream: the CURRENT-version snapshot marks the milestone complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-cur-snap' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), MS_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), MS_ROADMAP);
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v2.0-ROADMAP.md'), '# v2.0 archived\n');

    const inv = inspectWorkstream(tmpDir, 'ws-cur-snap', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
  });
});
