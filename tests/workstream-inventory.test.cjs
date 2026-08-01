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
