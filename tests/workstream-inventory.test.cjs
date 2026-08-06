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
const { buildWorkstreamInventory, isCompletedInventory, pickRollupWinners } = require('../gsd-core/bin/lib/workstream-inventory-builder.cjs');
const { inspectWorkstream } = require('../gsd-core/bin/lib/workstream-inventory.cjs');
const { VERIFIER_STATUSES } = require('../gsd-core/bin/lib/verification.cjs');
const { phaseKeyFromDir, phaseKeyFromProse, phaseKeyFromToken } = require('../gsd-core/bin/lib/phase-id.cjs');
const fc = require('fast-check');

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

// #2562 review round 2 — every one of these is a DISTINCT way to reproduce this
// issue's own symptom ("milestone complete"/100% while phases are incomplete),
// introduced by deriving the two sides of the rollup from different phase-key
// derivations rather than from the phase-id owner module. Each test reddens when
// only its own fix is reverted.
describe('#2562 — milestone scoping boundaries (one phase-key derivation)', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  function writePhase(wsDir, slug, { plans = 0, summaries = 0, verification } = {}) {
    const dir = path.join(wsDir, 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= plans; i++) fs.writeFileSync(path.join(dir, `0${i}-PLAN.md`), '# plan\n');
    for (let i = 1; i <= summaries; i++) fs.writeFileSync(path.join(dir, `0${i}-SUMMARY.md`), '# summary\n');
    if (verification) fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), `---\nstatus: ${verification}\n---\n`);
  }

  function roadmapWithRows(rows) {
    return [
      '# Roadmap', '', '## Progress', '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
  }

  const V2_STATE = 'milestone: v2.0\nstatus: executing\n';

  // A zero-padded roadmap table against zero-padded directories. Deriving the
  // table key with one regex and the directory key with another put `01` and `1`
  // in different key spaces: NOTHING matched, every phase fell out of the
  // milestone, and the rollup reported 0% while listing both phases complete.
  test('zero-padded table rows match zero-padded directories', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-padded' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 01. Alpha | v2.0 | 1/1 | Complete | - |',
      '| 02. Beta | v2.0 | 1/1 | Complete | - |',
    ]));
    writePhase(wsDir, '01-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '02-beta', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-padded', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2);
    assert.equal(inv.completed_phases, 2, 'padded dirs must match padded table rows');
    assert.equal(inv.progress_percent, 100);
    assert.deepEqual(inv.phases.map(p => p.status), ['complete', 'complete'],
      'phases[] and the rollup must agree');
  });

  // The mirror image: an UNPADDED table against PADDED directories. Padding is a
  // presentation choice on either side; one key function makes it irrelevant.
  test('unpadded table rows match padded directories (and vice versa)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-mixed-pad' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
      '| 2. Beta | v2.0 | 0/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '01-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '02-beta', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-mixed-pad', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2, 'the two phases must not double-count as four');
    assert.equal(inv.completed_phases, 1);
    assert.equal(inv.progress_percent, 50);
  });

  // A project-code-prefixed directory (`PROJ-05-…`). The bespoke `^0*(\d+…)`
  // directory parser yielded null for these, excluding EVERY directory from the
  // milestone and pinning the workstream at 0% forever.
  test('project-code-prefixed directories are scoped, not excluded', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-projcode' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| PROJ-01. Shipped | v1.0 | 1/1 | Complete | - |',
      '| PROJ-05. Alpha | v2.0 | 1/1 | Complete | - |',
      '| PROJ-06. Beta | v2.0 | 0/1 | In Progress | - |',
    ]));
    // The prior-milestone directory is the discriminator: a phase key that never
    // resolves collapses scoping to the whole roadmap, and PROJ-01 sneaks into
    // the current rollup as a third completed phase.
    writePhase(wsDir, 'PROJ-01-shipped', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, 'PROJ-05-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, 'PROJ-06-beta', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-projcode', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2, 'denominator = v2.0 phases only');
    assert.equal(inv.completed_phases, 1, 'prefixed dirs must scope, not be excluded outright');
    assert.equal(inv.progress_percent, 50);
  });

  // The load-bearing invariant of the whole fix, stated directly: however a
  // roadmap decorates a phase reference (padding, project code, markdown
  // emphasis, a `Phase ` label, trailing prose), the key it yields must equal
  // the key its own directory yields. Every blocker above is an instance of
  // this property failing.
  test('property: a table cell and its directory always yield the same phase key', () => {
    // Padding and project code are decoration and vary INDEPENDENTLY on the two
    // sides — that independence is the point. Comparing an identically-decorated
    // token against itself would pass vacuously.
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 400 }),
      fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
      fc.constantFrom('', '0', '00'),
      fc.constantFrom('', '0', '00'),
      fc.constantFrom('', 'PROJ-', 'CK-', 'MEM-'),
      fc.constantFrom('', 'PROJ-', 'CK-', 'MEM-'),
      fc.constantFrom('', '**', '`'),
      fc.constantFrom('', 'Phase '),
      fc.stringMatching(/^[a-z][a-z-]{0,20}$/),
      (num, sub, cellPad, dirPad, cellCode, dirCode, emphasis, label, slug) => {
        const suffix = sub === null ? '' : `.${sub}`;
        const cell = `${emphasis}${label}${cellCode}${cellPad}${num}${suffix}. Some Name${emphasis}`;
        const dir = `${dirCode}${dirPad}${num}${suffix}-${slug}`;
        assert.equal(phaseKeyFromProse(cell), phaseKeyFromDir(dir),
          `cell ${JSON.stringify(cell)} and dir ${JSON.stringify(dir)} must share a key`);
      },
    ), { numRuns: 1000 });
  });

  // A blank Milestone cell must not silently delete the phase from BOTH sides of
  // the calculation — that is how an unstarted phase vanished and the remaining
  // completed one rounded the workstream to 100%.
  test('a blank Milestone cell keeps the phase in the denominator', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-blank-cell' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
      '| 2. Beta |  | 0/1 | Not started | - |',
      '| 3. Gamma | TBD | 0/1 | Not started | - |',
    ]));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-blank-cell', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 3, 'unattributable rows degrade over-inclusively');
    assert.equal(inv.completed_phases, 1);
    assert.equal(inv.progress_percent, 33);
    assert.notEqual(inv.progress_percent, 100);
  });

  // A bullet that merely NAMES the current version with a checkmark is prose
  // about a phase, not a milestone verdict. Reading it as a shipped signal
  // reproduces this issue's exact symptom.
  test('a checkmarked bullet naming the version does NOT mark the milestone shipped', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-bullet-tick' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      roadmapWithRows([
        '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
        '| 2. Beta | v2.0 | 0/1 | In Progress | - |',
      ]),
      '## Plans',
      '- [x] 03-01: Ship the v2.0 login endpoint ✅',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '2-beta', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-bullet-tick', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
    assert.equal(inv.progress_percent, 50);
  });

  // `\b` does not bound a version token: `.` is a non-word character, so a naive
  // `\bv2\.0\b` matches inside `v2.0.1`. A shipped SIBLING patch release must not
  // close the current milestone.
  test('a shipped v2.0.1 heading does NOT mark v2.0 shipped', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-version-boundary' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      roadmapWithRows(['| 1. Alpha | v2.0 | 0/1 | In Progress | - |']),
      '## v2.0.1 Patch — ✅ SHIPPED',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-version-boundary', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'executing');
    assert.equal(inv.progress_percent, 0);
  });

  // `phaseKeyFromToken` strips leading zeros per hyphen-separated segment before
  // `normalizePhaseName` runs — which is BEFORE that function strips the
  // project-code prefix. lint-phase-id-drift exempts phase-id.cts by design, so
  // it is silent here by construction; these cases are the coverage instead.
  test('key derivation is symmetric across project codes and hyphenated ids', () => {
    for (const [token, dir] of [
      ['CK-01', 'CK-01-x'],
      ['CK-1', 'CK-001-x'],   // padding differs across the prefix
      ['M1-2', 'M1-2-x'],
      ['P0.3-2', 'P0.3-2-x'], // letter-prefixed leading segment, preserved verbatim
      ['01-02', '01-02-x'],
    ]) {
      assert.equal(phaseKeyFromToken(token), phaseKeyFromDir(dir),
        `token ${token} and dir ${dir} must share a key`);
    }
    // Known, PRE-EXISTING asymmetry, pinned so it is not "fixed" by accident:
    // in a DIRECTORY a single-digit segment after the phase number is a slug
    // word, not a sub-phase (#2043/#2232 — `extractPhaseToken`), so `M1-46-6-rs`
    // is phase 46. A ROADMAP token `M1-46-6` has no slug and is phase 46-06.
    // Unchanged by #2562: both sides behaved this way before.
    assert.equal(phaseKeyFromToken('M1-46-6'), '46-06');
    assert.equal(phaseKeyFromDir('M1-46-6-rs-x'), '46');
  });

  // The Builder's invariant throw is a contract assertion for external callers.
  // `listWorkstreamInventories` loops every workstream with no try/catch, so a
  // reachable throw would take down `workstream list`/`status`/`progress` for
  // ALL workstreams — this pins that the real reader cannot construct one, with
  // every adversarial shape at once.
  test('inspectWorkstream cannot trip the Builder invariant', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-adversarial' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Prior | v1.0 | 2/2 | Complete | - |',
      '| 01. Dupe | v2.0 | 1/1 | Complete | - |',
      '| 2. Dirless | v2.0 | 0/1 | Not started | - |',
      '| 3. Unattributed |  | 0/1 | Not started | - |',
      '| PROJ-04. Prefixed | v2.0 | 1/1 | Complete | - |',
    ]));
    writePhase(wsDir, '1-prior', { plans: 2, summaries: 2, verification: 'passed' });
    writePhase(wsDir, '01-dupe', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '1-dupe-stale', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '001-dupe-staler', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, 'PROJ-04-prefixed', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '3.1-inserted', { plans: 1, summaries: 0 });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-adversarial', { active: null }); });
    assert.ok(inv);
    assert.ok(inv.completed_phases <= inv.roadmap_phase_count,
      `numerator ${inv.completed_phases} must not exceed denominator ${inv.roadmap_phase_count}`);
    assert.ok(inv.progress_percent < 100, 'incomplete phases must keep this below 100');
  });

  // A flat table earlier in the document must not shadow the milestone-grouped
  // table that carries the attribution: every row would come back unattributed,
  // be treated as current-milestone, and silently re-admit prior phases.
  test('a milestone-grouped table wins over an earlier flat table', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-two-tables' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '## Summary', '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Prior | 2/2 | Complete | - |',
      '| 2. Alpha | 1/1 | Complete | - |',
      '| 3. Beta | 0/1 | Not started | - |',
      '', '## Progress', '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |  --- |',
      '| 1. Prior | v1.0 | 2/2 | Complete | - |',
      '| 2. Alpha | v2.0 | 1/1 | Complete | - |',
      '| 3. Beta | v2.0 | 0/1 | Not started | - |',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-prior', { plans: 2, summaries: 2, verification: 'passed' });
    writePhase(wsDir, '2-alpha', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-two-tables', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2, 'denominator = v2.0 phases {2,3}');
    assert.equal(inv.completed_phases, 1, 'the shipped v1.0 phase must stay out');
    assert.equal(inv.progress_percent, 50);
  });

  // An in-progress marker on the milestone heading always wins over a checkmark
  // elsewhere on the same line — the active-wins rule the sectioniser applies.
  test('an in-progress marker on the milestone heading beats a checkmark', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-active-wins' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      roadmapWithRows(['| 1. Alpha | v2.0 | 0/1 | In Progress | - |']),
      '## v2.0 Launch — 🚧 IN PROGRESS (phase 1 scaffolded ✅)',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-active-wins', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
  });

  // The current milestone's OWN shipped heading is still honoured — the boundary
  // fix must not cost the signal it exists to carry.
  test('the current milestone\'s own shipped heading still marks it complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-own-heading' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      roadmapWithRows(['| 1. Alpha | v2.0 | 1/1 | Complete | - |']),
      '## v2.0 Launch — ✅ SHIPPED',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-own-heading', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
  });

  // Bug #2445's scenario: a stale directory colliding on phase number with a
  // current one. Counting the numerator per-DIRECTORY while the denominator
  // counts distinct PHASES pushed completed_phases past the denominator, where
  // the old Math.min cap reported 100% and hid the unstarted phase.
  test('a stale same-numbered directory does not double-count the numerator', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-dupe-dir' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
      '| 2. Beta | v2.0 | 0/1 | Not started | - |',
    ]));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '01-alpha-old', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-dupe-dir', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 2);
    assert.equal(inv.completed_phases, 1, 'two dirs, one phase');
    assert.equal(inv.progress_percent, 50, 'the unstarted phase 2 must stay visible');
  });

  // The builder is the pure seam: a caller that hands it an inconsistent pair
  // must fail loudly rather than have Math.min round the contradiction to 100%.
  test('builder: a numerator above the denominator throws instead of capping to 100%', () => {
    assert.throws(() => buildWorkstreamInventory({
      name: 'ws',
      projectDir: '/tmp/ws-proj',
      workstreamDir: '/tmp/ws-proj/.planning/workstreams/ws',
      activeWorkstreamName: '',
      stateProjection: { status: 'executing', current_phase: null, last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: true },
      milestoneShipped: false,
      phaseDirNames: ['1-a', '2-b', '3-c'],
      phaseFilesCounts: [
        { directory: '1-a', phaseKey: '01', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
        { directory: '2-b', phaseKey: '02', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
        { directory: '3-c', phaseKey: '03', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: 'passed' },
      ],
      roadmapPhaseCount: 3,
      currentMilestonePhaseCount: 2,
    }), /invariant violated/);
  });

  // The builder hand-lists the verdicts that disqualify a phase from `complete`.
  // Pin it to the verifier's own vocabulary so a new emitted status cannot land
  // without a decision here.
  test('parity: every verifier status other than passed blocks completeness', () => {
    const nonPassing = VERIFIER_STATUSES.filter(s => s !== 'passed');
    assert.ok(nonPassing.length > 0, 'guard: the verifier must emit a non-passing status');
    for (const status of nonPassing) {
      const inv = buildWorkstreamInventory({
        name: 'ws',
        projectDir: '/tmp/ws-proj',
        workstreamDir: '/tmp/ws-proj/.planning/workstreams/ws',
        activeWorkstreamName: '',
        stateProjection: { status: 'executing', current_phase: null, last_activity: null },
        filesExist: { roadmap: true, state: true, requirements: true },
        milestoneShipped: false,
        phaseDirNames: ['1-a'],
        phaseFilesCounts: [
          { directory: '1-a', phaseKey: '01', planCount: 1, summaryCount: 1, inMilestone: true, verificationStatus: status },
        ],
        roadmapPhaseCount: 1,
        currentMilestonePhaseCount: 1,
      });
      assert.equal(inv.phases[0].status, 'in_progress', `verifier status "${status}" must not count complete`);
    }
  });

  // The scoping reads the WORKSTREAM's ROADMAP/STATE pair, not the project root's.
  // getMilestonePhaseFilter resolves via planningDir(cwd, ws); without the ws
  // argument it falls back to GSD_WORKSTREAM, which a loop over workstreams
  // cannot set per iteration.
  test('scoping reads the workstream ROADMAP, not the project-root ROADMAP', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-not-root' });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Root Roadmap', '', '## v2.0 Root — ✅ SHIPPED', '', '### Phase 9: Root only', '**Goal:** root', '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'milestone: v2.0\nstatus: milestone complete\n');
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 0/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-not-root', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'executing', 'the ROOT roadmap\'s shipped v2.0 must not leak in');
    assert.equal(inv.roadmap_phase_count, 1, 'root-only phase 9 must not join the denominator');
    assert.equal(inv.progress_percent, 0);
  });

  // ─── The declared-but-empty current milestone ──────────────────────────────
  //
  // STATE.md's `milestone:` field updates the moment `/gsd-new-milestone` writes
  // the heading; the Progress table and phase sections land later. In that
  // window nothing attributes a phase to the current milestone. Scoping used to
  // switch OFF there, and the fallback counted the project's ENTIRE phase
  // history as both numerator and denominator — so a milestone with no work
  // done reported 100% off its predecessors'. #2562's own symptom, other route.
  //
  // Three ROADMAP shapes reach it and each needs its own witness; the fourth is
  // the legacy shape that must NOT be caught.
  const V3_STATE = 'milestone: v3.0\nstatus: executing\n';
  const PRIOR_ROWS = [
    '| 1. Alpha | v1.0 | 1/1 | Complete | - |',
    '| 2. Beta | v2.0 | 1/1 | Complete | - |',
  ];

  function seedTwoShippedPhases(name, roadmap) {
    const wsDir = seedWorkstream(tmpDir, { name });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V3_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmap);
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '2-beta', { plans: 1, summaries: 1, verification: 'passed' });
    return wsDir;
  }

  // The common shape: `## v3.0` exists but has no phases under it yet. The
  // milestone filter DOES locate the section (setting versionScoped), then the
  // zero-phase pass-all degrade resets versionScoped to false — erasing the only
  // evidence that the milestone exists. versionSectionFound survives that reset.
  test('a located-but-empty current milestone reports 0%, not its predecessors\' 100%', () => {
    const wsDir = seedTwoShippedPhases('ws-empty-section', [
      '# Roadmap', '',
      '## v1.0', '', '### Phase 1: Alpha', '',
      '## v2.0', '', '### Phase 2: Beta', '',
      '## v3.0 — Next', '',
      roadmapWithRows(PRIOR_ROWS),
    ].join('\n'));
    assert.ok(fs.existsSync(wsDir));

    const inv = inspectWorkstream(tmpDir, 'ws-empty-section', { active: null });
    assert.ok(inv);
    assert.equal(inv.completed_phases, 0, 'v1.0/v2.0 phases must not count toward v3.0');
    assert.equal(inv.roadmap_phase_count, 0, 'v3.0 declares no phases');
    assert.equal(inv.progress_percent, 0, 'an unstarted milestone must never report 100%');
  });

  // No v3.0 section at all, but the ROADMAP versions its other milestones — so
  // the filter reports missingExplicitVersion rather than a located section.
  test('a current milestone absent from a versioned roadmap reports 0%', () => {
    seedTwoShippedPhases('ws-absent-section', [
      '# Roadmap', '',
      '## v1.0', '', '### Phase 1: Alpha', '',
      '## v2.0', '', '### Phase 2: Beta', '',
      roadmapWithRows(PRIOR_ROWS),
    ].join('\n'));

    const inv = inspectWorkstream(tmpDir, 'ws-absent-section', { active: null });
    assert.ok(inv);
    assert.equal(inv.completed_phases, 0);
    assert.equal(inv.progress_percent, 0);
  });

  // Unversioned phase headings, but the Progress table attributes every row to
  // another milestone. Neither filter flag fires; the table is the only witness.
  test('a progress table attributing every row elsewhere reports 0%', () => {
    seedTwoShippedPhases('ws-rows-elsewhere', [
      '# Roadmap', '',
      '### Phase 1: Alpha', '', '### Phase 2: Beta', '',
      roadmapWithRows(PRIOR_ROWS),
    ].join('\n'));

    const inv = inspectWorkstream(tmpDir, 'ws-rows-elsewhere', { active: null });
    assert.ok(inv);
    assert.equal(inv.completed_phases, 0);
    assert.equal(inv.progress_percent, 0);
  });

  // The boundary. A free-form ROADMAP attributes no versions at all: its rows
  // parse unattributed, land in the current milestone, and must keep reporting
  // 100%. readCurrentMilestoneVersion hands back a non-null version for nearly
  // every project, so scoping on `currentVersion` alone would zero these out.
  test('a legacy roadmap with no version attribution keeps its whole-roadmap count', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-legacy-freeform' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V3_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '### Phase 1: Alpha', '', '### Phase 2: Beta', '',
      '## Progress', '',
      '| Phase | Plans Complete | Status |',
      '| --- | --- | --- |',
      '| 1. Alpha | 1/1 | Complete |',
      '| 2. Beta | 1/1 | Complete |', '',
    ].join('\n'));
    writePhase(wsDir, '1-alpha', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '2-beta', { plans: 1, summaries: 1, verification: 'passed' });

    const inv = inspectWorkstream(tmpDir, 'ws-legacy-freeform', { active: null });
    assert.ok(inv);
    assert.equal(inv.completed_phases, 2, 'unattributed phases belong to the current milestone');
    assert.equal(inv.progress_percent, 100, 'legacy free-form projects must not regress to 0%');
  });

  // Degrade direction: over-inclusive, never under. A phase scaffolded before
  // the ROADMAP caught up is claimed by NO milestone, so the empty current one
  // adopts it rather than dropping it from both sides of the rollup — hiding
  // real work would be the same class of defect as inventing it.
  test('a phase scaffolded before the roadmap catches up joins the empty milestone', () => {
    const wsDir = seedTwoShippedPhases('ws-scaffold-first', [
      '# Roadmap', '',
      '## v1.0', '', '### Phase 1: Alpha', '',
      '## v2.0', '', '### Phase 2: Beta', '',
      '## v3.0 — Next', '',
      roadmapWithRows(PRIOR_ROWS),
    ].join('\n'));
    writePhase(wsDir, '3-gamma', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-scaffold-first', { active: null });
    assert.ok(inv);
    assert.equal(inv.roadmap_phase_count, 1, 'the unclaimed phase 3 is v3.0\'s, and its only one');
    assert.equal(inv.completed_phases, 0, 'it is started, not finished');
    assert.equal(inv.progress_percent, 0);
  });

  // The invariant throw at the builder fires on `completedPhases > denominator`.
  // A scoped milestone with a zero denominator sits one bad exclusion away from
  // crashing `workstream list` on every freshly-declared milestone — a worse
  // failure than a wrong percentage. Pin that it stays a number.
  test('a zero-denominator scoped milestone does not trip the rollup invariant', () => {
    seedTwoShippedPhases('ws-zero-denominator', [
      '# Roadmap', '', '## v3.0 — Next', '', roadmapWithRows(PRIOR_ROWS),
    ].join('\n'));

    assert.doesNotThrow(() => inspectWorkstream(tmpDir, 'ws-zero-denominator', { active: null }));
    const inv = inspectWorkstream(tmpDir, 'ws-zero-denominator', { active: null });
    assert.equal(inv.progress_percent, 0);
    assert.equal(inv.phases.length, 2, 'the phases themselves stay listed, they just do not count');
  });
});

// #2562 review round 4 — `status` was the one field still asserted from an
// un-cross-validated shipped marker: `progress_percent` derived from artifacts
// while `status` echoed the marker, so the two could contradict each other in a
// single payload. That IS this issue's symptom, reached through `status`.
//
// The cross-check differs by signal strength, and using one check for both
// regresses the archived case — see the builder comment. These four pin both
// halves plus the window where the STATE field re-asserts the refused claim.
describe('#2562 — a shipped marker its own artifacts contradict is not asserted as status', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  const V2_STATE = 'milestone: v2.0\nstatus: executing\n';
  const V2_SHIPPED_STATE = 'milestone: v2.0\nstatus: milestone complete\n';
  // v2.0 declares phases 3 and 4. Rows survive archiving: `milestone complete`
  // COPIES ROADMAP.md to the snapshot (milestone.cts:671-674) and never
  // truncates the live file.
  const V2_ROADMAP = shipped => [
    '# Roadmap', '',
    `## Milestone v2.0 — Two${shipped ? ' — ✅ SHIPPED' : ''}`, '',
    '## Progress', '',
    '| Phase | Milestone | Plans | Status | Done |',
    '| --- | --- | --- | --- | --- |',
    '| 3. New A | v2.0 | 1/1 | Complete | - |',
    '| 4. New B | v2.0 | 0/1 | In Progress | - |',
    '',
  ].join('\n');

  function writePhase(wsDir, slug, { plans = 0, summaries = 0, verification } = {}) {
    const dir = path.join(wsDir, 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= plans; i++) fs.writeFileSync(path.join(dir, `0${i}-PLAN.md`), '# plan\n');
    for (let i = 1; i <= summaries; i++) fs.writeFileSync(path.join(dir, `0${i}-SUMMARY.md`), '# summary\n');
    if (verification) fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), `---\nstatus: ${verification}\n---\n`);
  }

  function writeSnapshot(wsDir) {
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v2.0-ROADMAP.md'), '# v2.0 archived\n');
  }

  test('a live-ROADMAP SHIPPED heading is refused while the milestone is incomplete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-heading-lies' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), V2_ROADMAP(true));
    writePhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '4-new-b', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-heading-lies', { active: null });
    assert.ok(inv);
    assert.notEqual(inv.status, 'milestone complete', 'phase 4 is unfinished — the heading is a claim, not a fact');
    assert.equal(inv.milestone_shipped_unverified, true);
    assert.equal(inv.progress_percent, 50, 'status and percent must agree');
  });

  // Nothing on disk contradicts the archive: `milestone complete` MOVES phase
  // dirs into `milestones/v2.0-phases/` (milestone.cts:755-762) while leaving
  // the Progress rows, so a correctly-archived milestone reads 0/2 by
  // construction. Gating this on the completeness ratio — the obvious single
  // fix — reddens here and strips `milestone complete` from every archived
  // milestone in every project.
  test('an archived snapshot survives its phase dirs being moved out (no ratio gate)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-archived-clean' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), V2_ROADMAP(false));
    writeSnapshot(wsDir); // phases/ is empty — the dirs are under milestones/v2.0-phases/

    const inv = inspectWorkstream(tmpDir, 'ws-archived-clean', { active: null });
    assert.ok(inv);
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.milestone_shipped_unverified, false);
  });

  // The narrow predicate "a live dir that is itself unfinished" was NOT enough:
  // here the live dir is COMPLETE and the unfinished phase 2 is declared with no
  // directory, so nothing is live-and-unfinished and the marker sailed through,
  // reproducing the reported symptom verbatim (`milestone complete` beside 50%).
  // What makes the ratio meaningful again is simply that the archive is dirty —
  // any in-milestone directory outliving it — so the check is the conjunction.
  test('an archived snapshot is refused when a COMPLETE live dir sits beside a dirless phase', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-archived-dirty' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), V2_ROADMAP(false));
    writeSnapshot(wsDir);
    writePhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' }); // complete, still live
    // phase 4 is declared in the Progress table with NO directory

    const inv = inspectWorkstream(tmpDir, 'ws-archived-dirty', { active: null });
    assert.ok(inv);
    assert.equal(inv.completed_phases, 1);
    assert.equal(inv.roadmap_phase_count, 2, 'the dirless phase 4 stays in the denominator');
    assert.equal(inv.progress_percent, 50);
    assert.notEqual(inv.status, 'milestone complete', 'status must not contradict the percentage');
    assert.equal(inv.milestone_shipped_unverified, true);
  });

  // `milestone complete` does not advance STATE's `milestone:` field
  // (state-transition.cts:1335 writes status/last_activity only; :1224 is the
  // separate new-milestone path), so a phase can be added or reopened while the
  // shipped version is still current. That live dir DOES contradict the archive.
  test('an archived snapshot is refused once a phase is reopened under it', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-archived-reopened' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), V2_ROADMAP(false));
    writeSnapshot(wsDir);
    writePhase(wsDir, '4-new-b', { plans: 2, summaries: 1 }); // reopened after the archive

    const inv = inspectWorkstream(tmpDir, 'ws-archived-reopened', { active: null });
    assert.ok(inv);
    assert.notEqual(inv.status, 'milestone complete');
    assert.equal(inv.milestone_shipped_unverified, true);
  });

  // The refusal must not leak back in through the STATE field, which is
  // operator-written and in this window commonly says the same thing.
  test('a refused marker is not re-asserted by a STATE field claiming the same', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-field-echo' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_SHIPPED_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), V2_ROADMAP(true));
    writePhase(wsDir, '3-new-a', { plans: 1, summaries: 1, verification: 'passed' });
    writePhase(wsDir, '4-new-b', { plans: 1, summaries: 0 });

    const inv = inspectWorkstream(tmpDir, 'ws-field-echo', { active: null });
    assert.ok(inv);
    assert.equal(isCompletedInventory(inv.status), false, 'neither source may assert completion here');
    assert.equal(inv.status_conflict, true, 'the field disagrees with the artifacts');
    assert.equal(inv.milestone_shipped_unverified, true);
  });
});

// #2645 — deleting a *-VERIFICATION.md must never raise reported completion.
// #2562 gated completeness on the verdict READ FRESH from disk every call:
// "verifier ran gaps_found, report later deleted" and "verifier never ran"
// both read as the internal 'missing' sentinel, and only the fresh read was
// consulted — so deleting the evidence file alone was enough to silently
// raise completed_phases/progress_percent. The fix persists the last REAL
// verdict observed per phase key in a ledger file living at the WORKSTREAM
// level (`.verification-ledger.json`, sibling to STATE.md/ROADMAP.md),
// consulted only when the live read comes back 'missing'.
describe('#2645 — deleting a verification report must not raise completeness', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  const FLAT_STATE = 'status: executing\n';
  function flatRoadmap(rows) {
    return [
      '# Roadmap', '', '## Progress', '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
  }

  function writePhase(wsDir, slug, { plans = 1, summaries = 1, verification } = {}) {
    const dir = path.join(wsDir, 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= plans; i++) fs.writeFileSync(path.join(dir, `0${i}-PLAN.md`), '# plan\n');
    for (let i = 1; i <= summaries; i++) fs.writeFileSync(path.join(dir, `0${i}-SUMMARY.md`), '# summary\n');
    if (verification) fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), `---\nstatus: ${verification}\n---\n`);
    return dir;
  }

  function verificationFilePath(wsDir, slug) {
    return path.join(wsDir, 'phases', slug, '01-VERIFICATION.md');
  }

  // Row 1 — failing-first regression, the issue's own reproduction sequence.
  test('deleting a gaps_found report after it was observed does not raise completeness (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-gaps' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });

    const before1 = inspectWorkstream(tmpDir, 'ws-2645-gaps', { active: null });
    assert.ok(before1);
    assert.equal(before1.phases[0].status, 'in_progress', 'gaps_found must not count as complete');
    assert.equal(before1.completed_phases, 0);
    assert.equal(before1.progress_percent, 0);

    fs.unlinkSync(verificationFilePath(wsDir, '1-foo'));

    const after1 = inspectWorkstream(tmpDir, 'ws-2645-gaps', { active: null });
    assert.ok(after1);
    assert.equal(after1.phases[0].status, 'in_progress',
      'deleting the failing report must not flip the phase to complete');
    assert.equal(after1.completed_phases, 0, 'deleting evidence must never raise completed_phases');
    assert.equal(after1.progress_percent, 0, 'deleting evidence must never raise progress_percent');
  });

  // Row 2 — the other FAILING_VERIFICATION_STATUSES member.
  test('deleting a human_needed report after it was observed does not raise completeness (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-human' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'human_needed' });

    inspectWorkstream(tmpDir, 'ws-2645-human', { active: null }); // observe while present
    fs.unlinkSync(verificationFilePath(wsDir, '1-foo'));

    const after = inspectWorkstream(tmpDir, 'ws-2645-human', { active: null });
    assert.ok(after);
    assert.equal(after.phases[0].status, 'in_progress');
    assert.equal(after.completed_phases, 0);
    assert.equal(after.progress_percent, 0);
  });

  // Row 3 — criterion 2: verifier-disabled projects (no report ever written)
  // must still be able to reach 100%.
  test('a phase that was never verified still reaches complete (#2645, criterion 2)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-never' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | Complete | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1 }); // no verification file, ever

    const inv = inspectWorkstream(tmpDir, 'ws-2645-never', { active: null });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'complete');
    assert.equal(inv.completed_phases, 1);
    assert.equal(inv.progress_percent, 100);
  });

  // Row 4 — criterion 3: same on-disk shape as row 3 (no file), across TWO
  // reads, must behave IDENTICALLY — the ledger must not newly gate a phase
  // that was simply never verified in the first place.
  test('a not-yet-verified phase is not newly gated by the ledger (#2645, criterion 3)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-not-yet' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | Complete | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1 });

    const first = inspectWorkstream(tmpDir, 'ws-2645-not-yet', { active: null });
    const second = inspectWorkstream(tmpDir, 'ws-2645-not-yet', { active: null });
    assert.equal(first.progress_percent, 100);
    assert.equal(second.progress_percent, 100, 'a second read must not change the outcome');
    assert.equal(second.phases[0].status, 'complete');
  });

  // Row 5 — recovery: a genuinely re-verified phase must not be pinned by an
  // earlier failing verdict the ledger remembers.
  test('a re-verified passed phase is not pinned by an earlier failing ledger entry (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-recover' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    inspectWorkstream(tmpDir, 'ws-2645-recover', { active: null }); // observe gaps_found

    // Re-verify: overwrite the report with a passing verdict.
    fs.writeFileSync(verificationFilePath(wsDir, '1-foo'), '---\nstatus: passed\n---\n');
    const reverified = inspectWorkstream(tmpDir, 'ws-2645-recover', { active: null });
    assert.equal(reverified.phases[0].status, 'complete', 'a genuine re-verify must count');

    // Delete the now-passing report — the ledger's newest real verdict is
    // 'passed', which is not in the failing set, so this must stay complete.
    fs.unlinkSync(verificationFilePath(wsDir, '1-foo'));
    const afterDelete = inspectWorkstream(tmpDir, 'ws-2645-recover', { active: null });
    assert.equal(afterDelete.phases[0].status, 'complete',
      'the ledger must hold the newest verdict, not an earlier failing one');
  });

  // Row 6 — criterion 4: the ledger must not live inside the phase directory
  // whose file is the one being deleted.
  test('ledger file lives outside the phase directory it protects (#2645, criterion 4)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-location' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    const phaseDir = writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    inspectWorkstream(tmpDir, 'ws-2645-location', { active: null });

    const ledgerPath = path.join(wsDir, '.verification-ledger.json');
    assert.ok(fs.existsSync(ledgerPath), 'the ledger must be persisted somewhere');
    assert.ok(!ledgerPath.startsWith(phaseDir + path.sep) && ledgerPath !== phaseDir,
      'the ledger must not live inside the phase directory');

    // Deleting the ENTIRE phase directory (not just the report) must not
    // touch the ledger — this is what "not the same file" is protecting
    // against in the realistic case.
    cleanup(phaseDir);
    assert.ok(fs.existsSync(ledgerPath), 'removing the phase directory must not remove the ledger');
  });

  // Row 7 — Bug #2445 dedup safety: a stale duplicate directory sharing the
  // same phase key must not be able to clobber the WINNING (newest)
  // directory's ledger entry with its own stale/leftover verdict.
  test('a stale duplicate directory cannot clobber the ledger entry of the live directory (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-dupe' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | Complete | - |',
      '| 2. Bar | 0/1 | Not started | - |',
    ]));
    // Stale leftover directory (older mtime), leftover gaps_found report.
    const staleDir = writePhase(wsDir, '01-foo-old', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const oldTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(staleDir, oldTime, oldTime);
    // Live/winning directory (newer mtime), currently passed.
    const liveDir = writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'passed' });
    const newTime = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(liveDir, newTime, newTime);

    const before7 = inspectWorkstream(tmpDir, 'ws-2645-dupe', { active: null });
    assert.ok(before7);
    assert.equal(before7.completed_phases, 1, 'the winning (newest) directory is passed');

    // Delete the WINNING directory's report. If the stale directory's
    // gaps_found had clobbered the ledger, this phase key would now
    // incorrectly read gaps_found and never recover. It must instead read
    // the winning directory's own remembered 'passed'.
    fs.unlinkSync(path.join(liveDir, '01-VERIFICATION.md'));

    const after7 = inspectWorkstream(tmpDir, 'ws-2645-dupe', { active: null });
    assert.ok(after7);
    assert.equal(after7.completed_phases, 1,
      "the ledger must remember the WINNING directory's passed verdict, not the stale duplicate's gaps_found");
  });

  // Row 8 — boundary: an EXACT mtime tie between two same-keyed directories.
  // The builder's own tie-break (`rollupDirByKey`) walks
  // `[...phaseDirNames].sort()` and keeps the incumbent on a tie
  // (first-in-sort-order wins, since only a STRICTLY newer mtime replaces
  // it). The ledger's winner selection must walk the SAME sorted order so
  // the two deterministically agree on which directory wins — not merely
  // "some directory wins" (a prior version of this test asserted only
  // `completed_phases === 0 || 1`, which is true regardless of agreement and
  // caught nothing; both `01-foo-a`/`01-foo-b` sort deterministically, so the
  // outcome here is not a coin flip).
  test('an exact mtime tie resolves the ledger winner by sort order, matching the builder (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-tie' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | Complete | - |',
    ]));
    const tieTime = new Date('2025-06-01T00:00:00Z');
    // '01-foo-a' sorts before '01-foo-b' — with equal mtimes, BOTH the
    // builder's rollup and the ledger's winner selection must keep the
    // incumbent '01-foo-a' (passed), never adopt '01-foo-b' (gaps_found).
    const dirA = writePhase(wsDir, '01-foo-a', { plans: 1, summaries: 1, verification: 'passed' });
    fs.utimesSync(dirA, tieTime, tieTime);
    const dirB = writePhase(wsDir, '01-foo-b', { plans: 1, summaries: 1, verification: 'gaps_found' });
    fs.utimesSync(dirB, tieTime, tieTime);

    assert.doesNotThrow(() => inspectWorkstream(tmpDir, 'ws-2645-tie', { active: null }));
    const inv = inspectWorkstream(tmpDir, 'ws-2645-tie', { active: null });
    assert.ok(inv);
    // Deterministic, not "either is fine": the builder's own rollup counts
    // exactly the sort-order incumbent (01-foo-a, passed) as complete.
    assert.equal(inv.completed_phases, 1,
      'the sort-order incumbent (01-foo-a, passed) must be the one the builder counts complete');

    // Concrete cross-check that the LEDGER's winner selection agrees with the
    // builder's, not just that this run's numbers happen to match: delete
    // 01-foo-a's report (unlink bumps the directory's mtime — restore it to
    // the exact tie value so the SECOND read still sees a genuine tie, not a
    // newest-mtime win). If the ledger's winner selection had instead picked
    // 01-foo-b (the bug this test guards — unsorted iteration disagreeing
    // with the builder's sorted `rollupDirByKey`), this phase key's
    // remembered verdict would be 'gaps_found' and the phase would flip to
    // in_progress. It must instead stay complete, because the ledger
    // remembers 01-foo-a's 'passed' — the same directory the builder uses.
    fs.unlinkSync(path.join(dirA, '01-VERIFICATION.md'));
    fs.utimesSync(dirA, tieTime, tieTime); // restore the tie the unlink disturbed
    const afterDelete = inspectWorkstream(tmpDir, 'ws-2645-tie', { active: null });
    assert.equal(afterDelete.completed_phases, 1,
      "the ledger must have remembered the sort-order incumbent's 'passed' verdict, not the other directory's gaps_found");
  });

  // Row 9 — property: whatever sequence of REAL verdicts is observed for a
  // phase key, once the file goes missing the ledger must replay exactly the
  // LAST one observed — never an earlier one, never a synthesized value.
  //
  // #2645 review: `'stale'` is deliberately EXCLUDED here, not merely
  // forgotten. Writing a literal `status: stale` frontmatter value does NOT
  // round-trip as `'stale'` — `readVerificationStatus`
  // (`src/verification.cts`) explicitly excludes `'stale'` from its raw-file
  // routing lookup (`rawStatus !== 'stale'`) and falls through to the
  // "Unknown value" branch, returning `'unknown'` instead. A genuine
  // `'stale'` verdict is only reachable via `findStaleVerificationSummary`'s
  // mtime comparison (a SUMMARY file newer than the VERIFICATION file), not
  // by writing the word into the file. Including `'stale'` in this array
  // without accounting for that would silently substitute `'unknown'` on
  // every iteration and still pass (both are non-failing) — a docstring
  // claiming "real verdicts" coverage it does not actually exercise.
  // `'stale'` handling is explicitly out of scope for this issue (#2348) and
  // is not gated by `FAILING_VERIFICATION_STATUSES` either way.
  test('property: the ledger always replays the most recently observed real verdict after deletion (#2645)', () => {
    const REAL_STATUSES = ['passed', 'gaps_found', 'human_needed', 'unknown'];
    const FAILING = new Set(['gaps_found', 'human_needed']);
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...REAL_STATUSES), { minLength: 1, maxLength: 6 }),
      (sequence) => {
        const wsName = `ws-2645-prop-${Math.random().toString(36).slice(2)}`;
        const wsDir = seedWorkstream(tmpDir, { name: wsName });
        fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
        fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
          '| 1. Foo | 1/1 | Complete | - |',
        ]));
        const dir = writePhase(wsDir, '1-foo', { plans: 1, summaries: 1 });
        const reportPath = path.join(dir, '01-VERIFICATION.md');

        let lastReal = null;
        for (const status of sequence) {
          fs.writeFileSync(reportPath, `---\nstatus: ${status}\n---\n`);
          inspectWorkstream(tmpDir, wsName, { active: null }); // observe
          lastReal = status;
        }
        fs.unlinkSync(reportPath);

        const inv = inspectWorkstream(tmpDir, wsName, { active: null });
        const expectComplete = !FAILING.has(lastReal);
        assert.equal(inv.phases[0].status === 'complete', expectComplete,
          `after observing ${JSON.stringify(sequence)} then deleting, status must reflect the last real verdict (${lastReal})`);

        cleanup(wsDir);
      },
    ), { numRuns: 25 });
  });

  // Row 10 — CONTRIBUTING.md "Filesystem writes and installers": code that
  // writes under `.planning` needs fault-injection coverage. A corrupted
  // `.verification-ledger.json` (bad JSON, or valid JSON of the wrong shape)
  // must degrade to "nothing remembered", never throw and never break the
  // read-only commands this ledger is a side effect of.
  test('a corrupted ledger file degrades to no memory instead of throwing (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-corrupt-ledger' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    // Not valid JSON at all.
    fs.writeFileSync(ledgerPath, 'not json{{{');
    assert.doesNotThrow(() => inspectWorkstream(tmpDir, 'ws-2645-corrupt-ledger', { active: null }));

    // Valid JSON, wrong shape (array instead of object) — must also degrade,
    // not partially trust it.
    fs.writeFileSync(ledgerPath, '["gaps_found"]');
    const inv = inspectWorkstream(tmpDir, 'ws-2645-corrupt-ledger', { active: null });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress', 'the live gaps_found read still governs regardless of ledger corruption');
  });

  // Row 10b — the path Row 10 does NOT exercise (a live report is present in
  // both its cases, so the live read governs regardless of ledger state).
  // With the report ALSO absent, a corrupt ledger must fail CLOSED — an
  // unreadable/malformed ledger for an ADOPTED workstream (the ledger file
  // exists) is treated as "present, no trustworthy entry", exactly like
  // "present, no entry for this phase", NOT as "absent" (pre-adoption). This
  // is the fail-open→fail-closed distinction the maintainer's review required.
  test('a corrupted ledger with no live report fails closed instead of completing (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-corrupt-no-report' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    // Adopt the ledger for real (a genuine observation), matching the shape
    // of an actually-used workstream, THEN corrupt it and remove the report —
    // this is the realistic "ledger existed, now can't be trusted, AND the
    // evidence that would let the live read cover for it is also gone" case.
    const before = inspectWorkstream(tmpDir, 'ws-2645-corrupt-no-report', { active: null });
    assert.equal(before.completed_phases, 0, 'guard: starts correctly gated by the live gaps_found verdict');

    fs.unlinkSync(path.join(wsDir, 'phases', '1-foo', '01-VERIFICATION.md'));
    fs.writeFileSync(ledgerPath, 'not json{{{');

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-corrupt-no-report', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress',
      'a corrupt ledger for an adopted workstream must fail closed, not silently permit completion');
    assert.equal(inv.completed_phases, 0, 'the percentage must not rise just because the ledger became unreadable');
  });

  // Row 13 — "delete the ledger" case #1: the ledger file is removed, but
  // the phase's report is STILL PRESENT and still fails verification. This
  // must never raise completeness (the live read governs regardless of
  // ledger presence), and the deletion must be SELF-HEALING: the very next
  // read that observes the still-present real verdict recreates the ledger.
  test('deleting only the ledger file (report still present) does not raise completeness and self-heals (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-delete-ledger-only' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    inspectWorkstream(tmpDir, 'ws-2645-delete-ledger-only', { active: null }); // adopt
    assert.ok(fs.existsSync(ledgerPath), 'guard: the ledger must exist before deleting it is meaningful');

    fs.unlinkSync(ledgerPath);
    const afterLedgerDelete = inspectWorkstream(tmpDir, 'ws-2645-delete-ledger-only', { active: null });
    assert.equal(afterLedgerDelete.completed_phases, 0,
      'the still-present gaps_found report must keep this gated regardless of the ledger');
    assert.ok(fs.existsSync(ledgerPath), 'a read that observes a real verdict must recreate/self-heal the ledger');
  });

  // Row 14 — the DISCLOSED, ACCEPTED residual gap, pinned deliberately so it
  // is never mistaken for a silent regression: deleting the report AND the
  // ledger TOGETHER, after a failing verdict was already observed and
  // recorded, returns this phase key to the pre-adoption `'absent'` ledger
  // state — indistinguishable, by design, from a workstream that never used
  // the verifier at all (criteria 2/3 require exactly that indistinguishability
  // for a workstream that HASN'T adopted the ledger). This is the "prospective
  // only" limitation named in the changeset: any durable store that must fail
  // OPEN when wholly absent (to avoid gating every pre-existing project on
  // upgrade) has this property at its own root. The bar is raised from "delete
  // one file" to "delete two files in two different directories, one of which
  // this issue's own reproduction never needed to touch" — not eliminated.
  test('deleting the report AND the ledger together reopens the pre-adoption window (documented, not a regression) (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-delete-both' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    inspectWorkstream(tmpDir, 'ws-2645-delete-both', { active: null }); // adopt + observe gaps_found
    assert.ok(fs.existsSync(ledgerPath));

    fs.unlinkSync(path.join(wsDir, 'phases', '1-foo', '01-VERIFICATION.md'));
    fs.unlinkSync(ledgerPath);

    const inv = inspectWorkstream(tmpDir, 'ws-2645-delete-both', { active: null });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'complete',
      'documented limitation: removing BOTH files returns this phase to the pre-adoption/never-verified state — ' +
      'this is the accepted "prospective only" boundary, not a bug in this fix');
  });

  // Row 11 — fault injection per CONTRIBUTING.md: read-only target directory
  // / partial write failure. Monkeypatch `fs.writeFileSync` to throw only for
  // the ledger's WRITE TARGET (delegating everything else to the real
  // implementation, since STATE.md/ROADMAP.md/phase files also go through
  // the same fs module) — `inspectWorkstream` must still return a valid
  // inventory rather than propagating the write failure. Restored via
  // `t.after()` (never `try/finally` in a test body — CONTRIBUTING.md:344 —
  // and never `chmod 0o000`, which root bypasses in CI).
  //
  // #2645 review: the write target is the ledger's TEMP file
  // (`<ledgerPath>.<pid>.tmp`), not `ledgerPath` itself — the write is
  // atomic (temp file + rename, #2645 review). Matching only the exact
  // final path here made this mock a no-op once atomicity landed (the real
  // write always succeeded, so the assertion that follows failed): fixed to
  // match anything starting with `ledgerPath`, which covers the temp file
  // regardless of its exact suffix.
  test('a write failure on the ledger file does not break inspectWorkstream (#2645)', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-write-fail' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (targetPath, ...rest) => {
      if (typeof targetPath === 'string' && targetPath.startsWith(ledgerPath)) {
        throw new Error('injected: simulated read-only target directory');
      }
      return originalWriteFileSync(targetPath, ...rest);
    };
    t.after(() => { fs.writeFileSync = originalWriteFileSync; });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-write-fail', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress', 'the inventory is still correct even though persistence failed');
    assert.ok(!fs.existsSync(ledgerPath), 'the failed write must not have left a partial/corrupt ledger file');
    const leftoverTmp = fs.readdirSync(wsDir).filter(name => name.startsWith('.verification-ledger.json.') && name.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, [], 'a failed temp-file write must not leave an orphaned temp file behind');
  });

  // Row 12 — the read-side counterpart: a read failure on the ledger path
  // specifically (e.g. permission denied) must also degrade rather than
  // throw, and must not mask the live on-disk verdict for THIS call.
  test('a read failure on the ledger file does not break inspectWorkstream (#2645)', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-read-fail' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | Complete | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');
    // Seed a ledger entry via a real (unmocked) observation first.
    inspectWorkstream(tmpDir, 'ws-2645-read-fail', { active: null });
    assert.ok(fs.existsSync(ledgerPath), 'guard: the ledger must exist before the read-failure case is meaningful');

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (targetPath, ...rest) => {
      if (typeof targetPath === 'string' && targetPath === ledgerPath) {
        throw new Error('injected: simulated permission denied');
      }
      return originalReadFileSync(targetPath, ...rest);
    };
    t.after(() => { fs.readFileSync = originalReadFileSync; });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-read-fail', { active: null }); });
    assert.ok(inv);
    // The ledger read failed (treated as 'corrupt', not 'absent', since the
    // file DOES exist) — this workstream has adopted the ledger, so this
    // falls CLOSED. The report is still live on disk with a real
    // (non-missing) gaps_found verdict though, so the phase is correctly
    // in_progress from the LIVE read regardless — the fail-closed path isn't
    // even reached for this phase (its live read isn't 'missing').
    assert.equal(inv.phases[0].status, 'in_progress');
  });

  // Row 15 — CONTRIBUTING.md fault-injection: broken symlink. `readFileSync`
  // FOLLOWS symlinks, so a broken symlink at the ledger path reports the
  // SAME `ENOENT` as genuine absence via errno alone — `readVerificationLedger`
  // disambiguates with `lstatSync` (which does NOT follow symlinks) before
  // concluding `'absent'`. This is the realistic worst case: the durable
  // memory is unreadable AND there is no live report to fall back on.
  test('a broken symlink at the ledger path fails closed instead of falling open to pre-adoption (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-broken-symlink' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    const before = inspectWorkstream(tmpDir, 'ws-2645-broken-symlink', { active: null }); // adopt
    assert.equal(before.completed_phases, 0, 'guard: gated by the live gaps_found verdict');

    fs.unlinkSync(path.join(wsDir, 'phases', '1-foo', '01-VERIFICATION.md'));
    fs.unlinkSync(ledgerPath);
    fs.symlinkSync(path.join(wsDir, 'does-not-exist-target'), ledgerPath);

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-broken-symlink', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress',
      'a broken symlink is evidence something existed — it must fail closed, not fall open to pre-adoption behavior');
    assert.equal(inv.completed_phases, 0, 'the percentage must not rise because the ledger became a broken symlink');
  });

  // Row 15b — pins the lstat fail-closed fix specifically. The broken-symlink
  // disambiguation in `readVerificationLedger` calls `fs.lstatSync` after
  // `fs.readFileSync` reports `ENOENT`, to tell "genuinely absent" from "a
  // symlink entry exists, its target does not". A REVIEW caught that the
  // `catch` around that `lstatSync` call originally treated ANY lstat
  // failure as proof of absence — but only `lstatSync` ITSELF reporting
  // `ENOENT` is genuine proof; a DIFFERENT lstat failure (a raced permission
  // change, a path component that became inaccessible between the two
  // calls, …) is not evidence the file was never there, and must fail
  // CLOSED like every other path in that function. Double-fault both calls
  // to pin this: `readFileSync` throws `ENOENT` (as it does for a genuinely
  // missing path or file), `lstatSync` throws something else (`EACCES`) —
  // this combination is impossible to produce with a real filesystem state
  // (if the path is genuinely gone, `lstatSync` reports `ENOENT` too), so it
  // is monkeypatched directly rather than constructed on disk; this is what
  // "a future edit could re-widen that catch and fall open again silently"
  // means without a test — the double-fault CANNOT be exercised any other
  // way. Restored via `t.after()`.
  test('a non-ENOENT lstat failure during broken-symlink disambiguation fails closed, not open (#2645)', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-lstat-double-fault' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    const before = inspectWorkstream(tmpDir, 'ws-2645-lstat-double-fault', { active: null }); // adopt
    assert.equal(before.completed_phases, 0, 'guard: gated by the live gaps_found verdict');
    fs.unlinkSync(path.join(wsDir, 'phases', '1-foo', '01-VERIFICATION.md'));

    const originalReadFileSync = fs.readFileSync;
    const originalLstatSync = fs.lstatSync;
    fs.readFileSync = (targetPath, ...rest) => {
      if (typeof targetPath === 'string' && targetPath === ledgerPath) {
        throw Object.assign(new Error('injected: simulated missing ledger'), { code: 'ENOENT' });
      }
      return originalReadFileSync(targetPath, ...rest);
    };
    fs.lstatSync = (targetPath, ...rest) => {
      if (typeof targetPath === 'string' && targetPath === ledgerPath) {
        throw Object.assign(new Error('injected: simulated raced permission fault'), { code: 'EACCES' });
      }
      return originalLstatSync(targetPath, ...rest);
    };
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
      fs.lstatSync = originalLstatSync;
    });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-lstat-double-fault', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress',
      'a non-ENOENT lstat failure is not proof of absence — it must fail closed (corrupt), not fall open (absent)');
    assert.equal(inv.completed_phases, 0, 'the percentage must not rise because of an ambiguous double-fault read');
  });

  // Row 16 — CONTRIBUTING.md fault-injection: missing/uncreatable parent
  // directory for the write side. Monkeypatch `fs.mkdirSync` to throw only
  // for the workstream directory (delegating everything else), simulating a
  // parent directory `writeVerificationLedger` cannot ensure exists.
  test('an uncreatable parent directory on write does not break inspectWorkstream (#2645)', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-no-parent-dir' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = (targetPath, ...rest) => {
      if (typeof targetPath === 'string' && targetPath === wsDir) {
        throw new Error('injected: simulated missing/uncreatable parent directory');
      }
      return originalMkdirSync(targetPath, ...rest);
    };
    t.after(() => { fs.mkdirSync = originalMkdirSync; });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-no-parent-dir', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress', 'the live report still governs even though persistence failed');
    assert.ok(!fs.existsSync(ledgerPath), 'a write that could not ensure its directory must not leave a ledger file');
  });

  // Row 17 — CONTRIBUTING.md fault-injection: rename failure and temp-file
  // cleanup, now applicable because the write is atomic (temp file + rename,
  // #2645 review). Monkeypatch `fs.renameSync` to throw only for the ledger's
  // rename — the temp file must be written, the rename must fail, and the
  // orphaned temp file must be cleaned up rather than accumulating.
  test('a rename failure during the atomic ledger write cleans up the temp file (#2645)', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-rename-fail' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), FLAT_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), flatRoadmap([
      '| 1. Foo | 1/1 | In Progress | - |',
    ]));
    writePhase(wsDir, '1-foo', { plans: 1, summaries: 1, verification: 'gaps_found' });
    const ledgerPath = path.join(wsDir, '.verification-ledger.json');

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (src, dest) => {
      if (typeof dest === 'string' && dest === ledgerPath) {
        throw Object.assign(new Error('injected: simulated rename failure'), { code: 'EPERM' });
      }
      return originalRenameSync(src, dest);
    };
    t.after(() => { fs.renameSync = originalRenameSync; });

    let inv;
    assert.doesNotThrow(() => { inv = inspectWorkstream(tmpDir, 'ws-2645-rename-fail', { active: null }); });
    assert.ok(inv);
    assert.equal(inv.phases[0].status, 'in_progress', 'the live report still governs even though persistence failed');
    assert.ok(!fs.existsSync(ledgerPath), 'a failed rename must not leave a ledger file at the final path');
    const leftoverTmp = fs.readdirSync(wsDir).filter(name => name.startsWith('.verification-ledger.json.') && name.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, [], 'a failed rename must not leave an orphaned temp file behind');
  });

  // Row 18 — BLOCKER regression, and THIS IS THE ONLY ROW THAT PROVES IT
  // END TO END. `pickRollupWinners` (`workstream-inventory-builder.cts`) is
  // the SINGLE shared implementation both `buildWorkstreamInventory`'s
  // `rollupDirByKey` and `inspectWorkstream`'s ledger-winner selection now
  // call. An earlier version of the ledger selection was a SEPARATE
  // hand-written copy that omitted the `includeItem` (milestone-scoping)
  // filter — so in a scoped workstream, a stale OUT-of-milestone directory
  // sharing a phase key with the live IN-milestone one, with a newer mtime
  // (plausible after a checkout/rebase resets mtimes), could win the
  // LEDGER's selection while losing the BUILDER's. `isLedgerWinner` would
  // then be false for the live directory, so deleting ITS
  // `*-VERIFICATION.md` would never consult the ledger — reopening #2645's
  // hole for the phase that actually counts toward `completed_phases`,
  // reachable with a plain `rm`, no ledger tampering.
  //
  // This test constructs that EXACT collision directly — one synthetic key
  // shared by two entries, one included (in-milestone) and one excluded
  // (out-of-milestone), the excluded one given the larger mtime — and
  // proves `pickRollupWinners` applies the filter BEFORE comparing mtimes.
  //
  // Row 19 (below) does NOT reproduce this same-key collision through the
  // real `phaseKeyFromDir` / `isDirInCurrentMilestone` pipeline — extensive
  // probing (documented in `10-diagnosis.md`'s "Fourth note") found no
  // directory-naming pair that shares a rollup key while diverging in
  // milestone membership under the CURRENT roadmap-parser implementation;
  // every membership-determining path collapses to the same phase-number
  // extraction the rollup key already uses. Row 19 instead pins a narrower,
  // real, DISTINCTLY-keyed guarantee (an out-of-milestone phase's verdict is
  // never written into the ledger at all) — genuinely useful coverage, but
  // NOT a substitute for this row: it does not exercise the collision path,
  // and the pre-fix code would have passed it too.
  test('pickRollupWinners: an excluded (out-of-milestone) item can never win over an included one, even with a newer mtime (#2645)', () => {
    const liveInMilestone = { key: 'shared', mtimeMs: 100, inMilestone: true, label: 'live' };
    const staleOutOfMilestone = { key: 'shared', mtimeMs: 999999, inMilestone: false, label: 'stale' }; // far newer mtime, but excluded
    const scoped = true;

    const winners = pickRollupWinners(
      [liveInMilestone, staleOutOfMilestone], // pre-sorted input, as both real call sites provide
      (item) => item.key,
      (item) => item.mtimeMs,
      (item) => !(scoped && item.inMilestone === false),
    );

    assert.equal(winners.get('shared'), liveInMilestone,
      'the excluded stale directory must never win the key, regardless of its mtime advantage');
    assert.equal(winners.get('shared').label, 'live');

    // The mirror image, sorted the OTHER way — order-of-iteration must not
    // matter once the filter is applied; only inclusion + mtime should.
    const winnersReversed = pickRollupWinners(
      [staleOutOfMilestone, liveInMilestone],
      (item) => item.key,
      (item) => item.mtimeMs,
      (item) => !(scoped && item.inMilestone === false),
    );
    assert.equal(winnersReversed.get('shared'), liveInMilestone);

    // Unscoped (scoped=false): the exclusion never engages, so the newer
    // mtime wins normally — pinning that the filter is scoping-conditional,
    // not an unconditional "in-milestone always wins" rule.
    const unscoped = false;
    const winnersUnscoped = pickRollupWinners(
      [liveInMilestone, staleOutOfMilestone],
      (item) => item.key,
      (item) => item.mtimeMs,
      (item) => !(unscoped && item.inMilestone === false),
    );
    assert.equal(winnersUnscoped.get('shared'), staleOutOfMilestone,
      'when scoping is off, the plain newest-mtime rule applies with no exclusion');
  });

  // Row 19 — NOT the collision blocker (see Row 18's comment — this does
  // not reproduce it and the pre-fix code would pass this too). What this
  // DOES cover: in a genuinely SCOPED workstream (roadmap has a Milestone
  // column, STATE.md carries `milestone:`), a DISTINCTLY-keyed
  // out-of-milestone phase's real verdict must never be written into the
  // ledger at all — proving the REAL `inspectWorkstream` read/write path
  // threads `scoped`/`inMilestone` into the ledger write gate correctly, end
  // to end, for the (much more common) non-colliding case. `1-old` (v1.0)
  // and `2-new` (v2.0) are DIFFERENT phase keys, not a shared one.
  test('milestone scoping: a distinctly-keyed out-of-milestone phase is never written into the ledger (#2645)', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-2645-scoped-ledger' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '## Progress', '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Old | v1.0 | 1/1 | Complete | - |',
      '| 2. New | v2.0 | 1/1 | In Progress | - |',
      '',
    ].join('\n'));
    writePhase(wsDir, '1-old', { plans: 1, summaries: 1, verification: 'gaps_found' }); // prior milestone
    writePhase(wsDir, '2-new', { plans: 1, summaries: 1, verification: 'gaps_found' }); // current milestone

    const inv = inspectWorkstream(tmpDir, 'ws-2645-scoped-ledger', { active: null });
    assert.ok(inv);
    // Guard: confirm scoping is actually active and phase 1 really is
    // excluded from the rollup — otherwise this test would not exercise
    // anything.
    assert.equal(inv.roadmap_phase_count, 1, 'guard: denominator = v2.0 phases only, scoping is active');

    const ledgerRaw = fs.readFileSync(path.join(wsDir, '.verification-ledger.json'), 'utf-8');
    const ledger = JSON.parse(ledgerRaw);
    assert.ok(!('01' in ledger) && !('1' in ledger),
      'the out-of-milestone phase (1-old) must never be written into the ledger, regardless of its key form');
    assert.ok(('02' in ledger) || ('2' in ledger),
      'the in-milestone phase (2-new) must be recorded normally');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3057 B3: inspectWorkstream surfaces an indeterminate staleness check
//
// readVerificationStatus's internal staleness check can fail (fs /
// scanPhasePlans / clock error). Pre-#3057 B3 wiring, that failure was
// dropped here — `liveVerificationStatus` used only `.status` — so nothing
// could ever distinguish "checked; nothing is stale" from "could not check".
// `WorkstreamInventory`'s own return shape has no per-phase verification
// detail to carry this on, so it is surfaced via the SAME injectable
// stderr-diagnostic seam #3057 B4 added to cmdGitBaseBranch (see
// tests/git-base-branch.test.cjs), never via a change to `phases[]`/
// `completed_phases` — the rollup routing must stay byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3057 B3: inspectWorkstream — verification staleness-check indeterminate is surfaced', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  const V2_STATE = 'milestone: v2.0\nstatus: executing\n';

  function roadmapWithRows(rows) {
    return [
      '# Roadmap', '', '## Progress', '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
  }

  /** Writes a verified phase directory with a deterministic (never-stale) mtime ordering. */
  function writeVerifiedPhase(wsDir, slug) {
    const dir = path.join(wsDir, 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    const summaryPath = path.join(dir, '01-SUMMARY.md');
    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# plan\n');
    fs.writeFileSync(summaryPath, '# summary\n');
    fs.writeFileSync(verificationPath, '---\nstatus: passed\n---\n');
    // Deterministic mtime ordering — never rely on write-order clock ties.
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:01:00.000Z');
    fs.utimesSync(summaryPath, older, older);
    fs.utimesSync(verificationPath, newer, newer);
    return { summaryPath, verificationPath };
  }

  test('an fs failure inside the staleness check writes a stderr diagnostic; the rollup is UNCHANGED', (t) => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-3057-b3-fault' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
    ]));
    const { summaryPath, verificationPath } = writeVerifiedPhase(wsDir, '1-alpha');
    const origStatSync = fs.statSync;

    t.mock.method(fs, 'statSync', function injectedStaleCheckFault(target, ...args) {
      const targetPath = String(target);
      if (targetPath === verificationPath || targetPath === summaryPath) {
        throw new Error('injected stat failure (#3057 B3)');
      }
      return origStatSync.call(fs, target, ...args);
    });

    const calls = [];
    const inv = inspectWorkstream(tmpDir, 'ws-3057-b3-fault', {
      active: null,
      writeDiagnostic: (message, meta) => { calls.push({ message, meta }); },
    });

    assert.ok(inv);
    // Pre-existing no-throw fail-open routing is UNCHANGED: the rollup counts
    // exactly what it would without the injected fault.
    assert.equal(inv.completed_phases, 1, 'rollup routing unchanged');
    assert.strictEqual(calls.length, 1, 'an indeterminate staleness check must write exactly one diagnostic');
    assert.strictEqual(calls[0].meta.phaseDir, '1-alpha', 'diagnostic meta should name the affected phase directory');
    assert.strictEqual(calls[0].meta.reason, 'staleCheckIndeterminate', 'diagnostic meta should carry a stable reason');
  });

  test('a completed staleness check that finds nothing stale writes NO diagnostic', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-3057-b3-ok' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), V2_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmapWithRows([
      '| 1. Alpha | v2.0 | 1/1 | Complete | - |',
    ]));
    writeVerifiedPhase(wsDir, '1-alpha');

    const calls = [];
    const inv = inspectWorkstream(tmpDir, 'ws-3057-b3-ok', {
      active: null,
      writeDiagnostic: (message, meta) => { calls.push({ message, meta }); },
    });

    assert.ok(inv);
    assert.equal(inv.completed_phases, 1);
    assert.strictEqual(calls.length, 0, 'a completed, non-stale check must not write any diagnostic');
  });
});
