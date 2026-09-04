'use strict';

// Phase 1 tests for the STATE.md Transition Module (ADR-1769).
// These are characterization tests: they pin the behavior the new
// `transitionCore` / `beginPhase` API must preserve as the old
// `cmdStateBeginPhase` callback in state.cts is migrated onto it.
//
// Discipline: TDD vertical slices. One behavior → one test → minimal code → repeat.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  transitionCore,
  applyStatePreservation,
  openStateTransaction,
  rebuildStateTransaction,
  FIELD_CLASSIFICATION,
  FRONTMATTER_BODY_SOURCE,
  getFieldClassification,
  getPreserveWhenUnchangedFields,
  STATE_MD_SECTIONS,
  sliceCurrentPositionSection,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');
const { STATE_FIELD_SCHEMA } = require('../gsd-core/bin/lib/state-md-schema.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-27',
  localToday: () => '2026-06-27',
  nowIso: () => '2026-06-27T12:00:00.000Z',
});

describe('ADR-1769 substrate: field-classification table', () => {
  const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
  const allowedPreservation = new Set([
    'derive',
    'preserve-when-unchanged',
    'preserve-always',
    'preserve-if-placeholder',
  ]);

  test('every classified field has a { source, preservation } row with known enum values', () => {
    for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
      assert.ok(
        allowedSources.has(cls.source),
        `field ${JSON.stringify(field)} has unknown source ${JSON.stringify(cls.source)}`,
      );
      assert.ok(
        allowedPreservation.has(cls.preservation),
        `field ${JSON.stringify(field)} has unknown preservation ${JSON.stringify(cls.preservation)}`,
      );
    }
  });

  test('current_phase_name is curated / preserve-when-unchanged (ADR-1769 §4 — kills #1743/#1695 by construction; ADR-3408 #3468 reclassified from preserve-always to match its long-standing delta-gated behavior)', () => {
    const cls = getFieldClassification('current_phase_name');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-when-unchanged');
  });

  test('progress is curated / preserve-always (ADR-1769 §4 — curated-progress ratchet)', () => {
    const cls = getFieldClassification('progress');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-always');
  });

  test('state_head is free / derive (ADR-1769 §4 — ambient git read, refreshed every write; #2573)', () => {
    // `state_head` records the commit STATE.md was written against. It is not
    // body-derived, disk-derived, or curated — it is an ambient external read
    // recomputed on every write, exactly like `last_updated` (realClock.nowIso()).
    // ADR-1769 §4: "Each STATE.md field has a row." The per-transition guard in
    // transitionCore only checks the keys a transition declares, so an
    // unregistered field would slip through silently — this test is the check.
    const cls = getFieldClassification('state_head');
    assert.strictEqual(cls && cls.source, 'free');
    assert.strictEqual(cls && cls.preservation, 'derive');
  });

  test('table covers every frontmatter key emitted by buildStateFrontmatter (codex Phase 1 review)', () => {
    // Verified against src/state.cts:1633-1653 (buildStateFrontmatter emit block).
    const requiredFields = [
      'gsd_state_version',
      'milestone',
      'milestone_name',
      'current_phase',
      'current_phase_name',
      'current_plan',
      'status',
      'stopped_at',
      'paused_at',
      'last_updated',
      'last_activity',
      'last_activity_desc',
      'state_head',
      'progress',
      'progress.total_phases',
      'progress.completed_phases',
      'progress.total_plans',
      'progress.completed_plans',
      'progress.percent',
    ];
    for (const f of requiredFields) {
      assert.ok(getFieldClassification(f) !== null,
        `frontmatter key ${JSON.stringify(f)} must have a classification row`);
    }
  });

  test('getFieldClassification returns null for unknown fields AND inherited prototype methods', () => {
    // Classic prototype-pollution guard: queries for 'toString' / 'valueOf' / '__proto__'
    // must return null, not inherited Object.prototype functions.
    assert.strictEqual(getFieldClassification('toString'), null);
    assert.strictEqual(getFieldClassification('valueOf'), null);
    assert.strictEqual(getFieldClassification('hasOwnProperty'), null);
    assert.strictEqual(getFieldClassification('__proto__'), null);
    assert.strictEqual(getFieldClassification('not-a-real-field'), null);
  });
});

// #3873 (ADR-3473 §8.8): `FIELD_CLASSIFICATION` and `FRONTMATTER_BODY_SOURCE`
// are now PROJECTIONS of `STATE_FIELD_SCHEMA` (src/state-md-schema.cts),
// derived at module load rather than hand-maintained beside it. The
// comparands below are today's literal tables, copied VERBATIM (not
// re-derived from the schema — a parity test that builds both sides from the
// same source proves nothing; see 50-test-matrix.md's "writer-seeded fixture
// trap" note), captured by direct read of `src/state-transition.cts` on this
// branch's base (pre-#3873) before the projection replaced them. Any drift
// here is a silently-changed preservation policy — the #3427 failure this
// epic is named after.
describe('ADR-3473 §8.8 (#3873): the three tables are byte-identical projections of STATE_FIELD_SCHEMA', () => {
  // Verbatim copy of `FIELD_CLASSIFICATION`'s pre-#3873 literal (19 rows, this
  // exact key order — key order is observable: the preservation dispatch loop
  // and `getPreserveWhenUnchangedFields` both iterate it).
  const TODAYS_FIELD_CLASSIFICATION = Object.freeze({
    gsd_state_version: { source: 'free', preservation: 'derive' },
    milestone: { source: 'external', preservation: 'preserve-if-placeholder' },
    milestone_name: { source: 'external', preservation: 'preserve-if-placeholder' },
    current_phase: { source: 'body', preservation: 'preserve-when-unchanged' },
    current_phase_name: { source: 'curated', preservation: 'preserve-when-unchanged' },
    current_plan: { source: 'body', preservation: 'preserve-when-unchanged' },
    status: { source: 'body', preservation: 'preserve-when-unchanged', guard: 'non-sentinel-unknown' },
    stopped_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    paused_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    last_updated: { source: 'free', preservation: 'derive' },
    last_activity: { source: 'body', preservation: 'derive' },
    last_activity_desc: { source: 'body', preservation: 'preserve-when-unchanged' },
    state_head: { source: 'free', preservation: 'derive' },
    progress: { source: 'curated', preservation: 'preserve-always', mergeStrategy: 'progress-ratchet' },
    'progress.total_phases': { source: 'disk', preservation: 'derive' },
    'progress.completed_phases': { source: 'disk', preservation: 'derive' },
    'progress.total_plans': { source: 'disk', preservation: 'derive' },
    'progress.completed_plans': { source: 'disk', preservation: 'derive' },
    'progress.percent': { source: 'disk', preservation: 'derive' },
  });

  // Verbatim copy of `FRONTMATTER_BODY_SOURCE`'s pre-#3873 literal (8 keys,
  // this exact key order — deliberately NOT the same order as
  // `FIELD_CLASSIFICATION` above, nor the same order as
  // `FRONTMATTER_KEY_TO_BODY_LABEL` in tests/state.test.cjs; the two
  // pre-existing tables disagreed with each other's order too).
  const TODAYS_FRONTMATTER_BODY_SOURCE = Object.freeze({
    current_phase: ['Current Phase'],
    current_phase_name: ['Current Phase Name'],
    current_plan: ['Current Plan'],
    status: ['Status'],
    stopped_at: ['Stopped At', 'Stopped at'],
    paused_at: ['Paused At'],
    last_activity: ['Last Activity', 'Last activity'],
    last_activity_desc: ['Last Activity Description'],
  });

  test('row 1 — fieldClassificationProjectionMatchesTodaysTable', () => {
    assert.deepStrictEqual(
      Object.keys(FIELD_CLASSIFICATION),
      Object.keys(TODAYS_FIELD_CLASSIFICATION),
      'FIELD_CLASSIFICATION key order must be unchanged',
    );
    for (const key of Object.keys(TODAYS_FIELD_CLASSIFICATION)) {
      assert.deepStrictEqual(
        FIELD_CLASSIFICATION[key],
        TODAYS_FIELD_CLASSIFICATION[key],
        `FIELD_CLASSIFICATION[${JSON.stringify(key)}] must be byte-identical to today's table`,
      );
    }
  });

  test('row 2 — bodySourceProjectionMatchesTodaysTable', () => {
    assert.deepStrictEqual(
      Object.keys(FRONTMATTER_BODY_SOURCE),
      Object.keys(TODAYS_FRONTMATTER_BODY_SOURCE),
      'FRONTMATTER_BODY_SOURCE key order must be unchanged',
    );
    for (const key of Object.keys(TODAYS_FRONTMATTER_BODY_SOURCE)) {
      assert.deepStrictEqual(
        [...FRONTMATTER_BODY_SOURCE[key]],
        TODAYS_FRONTMATTER_BODY_SOURCE[key],
        `FRONTMATTER_BODY_SOURCE[${JSON.stringify(key)}] must be byte-identical to today's table`,
      );
    }
  });

  test('row 5 — projectionIsFrozenAndNullPrototype (FIELD_CLASSIFICATION, FRONTMATTER_BODY_SOURCE)', () => {
    assert.ok(Object.isFrozen(FIELD_CLASSIFICATION));
    assert.strictEqual(FIELD_CLASSIFICATION['toString'], undefined);
    assert.ok(Object.isFrozen(FRONTMATTER_BODY_SOURCE));
    assert.strictEqual(FRONTMATTER_BODY_SOURCE['toString'], undefined);
    // Per-row objects/arrays keep their pre-#3873 shape too: FIELD_CLASSIFICATION's
    // rows were plain (non-frozen, non-null-prototype) literals, and this
    // projection reproduces that exactly rather than "improving" it.
    assert.strictEqual(Object.isFrozen(FIELD_CLASSIFICATION.status), false);
    assert.ok(Object.isFrozen(FRONTMATTER_BODY_SOURCE.stopped_at));
  });

  test('row 6 — everyClassificationRowStillResolves (including the five progress.* rows)', () => {
    for (const key of Object.keys(TODAYS_FIELD_CLASSIFICATION)) {
      assert.notStrictEqual(getFieldClassification(key), null, `${key} must still resolve`);
    }
    for (const leaf of ['progress.total_phases', 'progress.completed_phases', 'progress.total_plans', 'progress.completed_plans', 'progress.percent']) {
      const cls = getFieldClassification(leaf);
      assert.strictEqual(cls.source, 'disk');
      assert.strictEqual(cls.preservation, 'derive');
    }
  });

  test('row 7 — preserveWhenUnchangedProjectionUnchanged', () => {
    assert.deepStrictEqual(
      getPreserveWhenUnchangedFields(),
      ['current_phase', 'current_phase_name', 'current_plan', 'status', 'stopped_at', 'paused_at', 'last_activity_desc'],
    );
  });

  test('row 8 — schemaMayDeclareMoreThanAProjectionConsumes', () => {
    // `milestone` is a real STATE_FIELD_SCHEMA row (external/preserve-if-placeholder)
    // with no body source at all, so it is legitimately absent from
    // FRONTMATTER_BODY_SOURCE — projections are subsets by design (D4).
    assert.ok(Object.prototype.hasOwnProperty.call(STATE_FIELD_SCHEMA, 'milestone'));
    assert.strictEqual(STATE_FIELD_SCHEMA.milestone.bodySource, undefined);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(FRONTMATTER_BODY_SOURCE, 'milestone'),
      false,
      'a schema row with no bodySource must not appear in the FRONTMATTER_BODY_SOURCE projection',
    );
  });
});

describe('ADR-1769 substrate: STATE_MD_SECTIONS constants (aligned to gsd-core/templates/state.md)', () => {
  test('every section heading starts with "## "', () => {
    for (const [name, heading] of Object.entries(STATE_MD_SECTIONS)) {
      assert.ok(
        heading.startsWith('## '),
        `section ${name} heading ${JSON.stringify(heading)} must start with "## "`,
      );
    }
  });

  test('matches the six canonical top-level sections of the STATE.md template', () => {
    assert.strictEqual(STATE_MD_SECTIONS.projectReference, '## Project Reference');
    assert.strictEqual(STATE_MD_SECTIONS.currentPosition, '## Current Position');
    assert.strictEqual(STATE_MD_SECTIONS.performanceMetrics, '## Performance Metrics');
    assert.strictEqual(STATE_MD_SECTIONS.accumulatedContext, '## Accumulated Context');
    assert.strictEqual(STATE_MD_SECTIONS.deferredItems, '## Deferred Items');
    assert.strictEqual(STATE_MD_SECTIONS.sessionContinuity, '## Session Continuity');
  });
});

describe('ADR-1769 Phase 1: beginPhase transition — tracer bullet', () => {
  test('updates body Status field to "Executing Phase N" on first-time begin', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Planning',
      '',
      '## Current Position',
      '',
      'Phase: 2 — DONE',
      'Plan: —',
      'Status: Planning',
      '',
    ].join('\n');

    const result = transitionCore(
      input,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock: fixedClock },
    );

    assert.ok(result.updated.includes('Status'), `updated should include Status; got ${JSON.stringify(result.updated)}`);
    // The transition must produce a body Status field carrying "Executing Phase 3".
    // Use the same primitive the production code uses, not a source-grep.
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Executing Phase\s+3\b/.test(bodyStatus || ''),
      `body Status should match /Executing Phase 3/; got ${JSON.stringify(bodyStatus)}`,
    );
  });
});

// Shared fixture for first-time begin: a clean STATE.md body where no
// "Executing Phase N" status is present yet.
function firstTimeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Planning',
    '**Current Phase:** 02',
    '**Current Phase Name:** Previous Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 3',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** previous work',
    '**Current focus:** Phase 2 — Previous Phase',
    '',
    '## Current Position',
    '',
    'Phase: 2 (Previous Phase)',
    'Plan: 2 of 3',
    'Status: Planning',
    'Last activity: 2026-06-20 — context gathered',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: beginPhase first-time body field updates', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('updates Current Phase to N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase'), '3');
    assert.ok(result.updated.includes('Current Phase'));
  });

  test('updates Current Phase Name when phaseName is provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(result.updated.includes('Current Phase Name'));
  });

  test('sets Current Plan to 1 on first-time begin', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '1');
    assert.ok(result.updated.includes('Current Plan'));
  });

  test('updates Total Plans in Phase to planCount when provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(result.updated.includes('Total Plans in Phase'));
  });

  test('updates Last Activity to clock.today()', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('updates Last Activity Description to "Phase N execution started"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 execution started',
    );
    assert.ok(result.updated.includes('Last Activity Description'));
  });

  test('updates **Current focus:** body text line (#1104)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // The **Current focus:** line should now carry the new phase label.
    const focusMatch = result.content.match(/\*\*Current focus:\*\*\s*(.*)/i);
    assert.ok(focusMatch, '**Current focus:** line must still be present');
    assert.strictEqual(focusMatch[1].trim(), 'Phase 3 — Test Phase');
    assert.ok(result.updated.includes('Current focus'),
      `updated should include 'Current focus'; got ${JSON.stringify(result.updated)}`);
  });
});

// Fixture for resume: a STATE.md body where Status already contains
// "Executing Phase 3" — the #3127 idempotency guard must detect this and
// skip the first-time-only field writes.
function resumeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Executing Phase 3',
    '**Current Phase:** 03',
    '**Current Phase Name:** Test Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 5',
    '**Last Activity:** 2026-06-26',
    '**Last Activity Description:** mid-flight context from plan 3-02',
    '',
    '## Current Position',
    '',
    'Phase: 3 (Test Phase) — EXECUTING',
    'Plan: 2 of 5',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-26 — mid-flight context',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: #3127 idempotency guard — resume path', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Status is still refreshed on resume (Last Activity Date tracks execute-phase runs)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('Current Plan is NOT overwritten on resume (#3127 — preserves mid-flight plan number)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '02');
    assert.ok(!result.updated.includes('Current Plan'),
      `Current Plan must not be in updated on resume; got ${JSON.stringify(result.updated)}`);
  });

  test('Total Plans in Phase is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(!result.updated.includes('Total Plans in Phase'));
  });

  test('Last Activity Description is NOT overwritten on resume (#3127 — preserves mid-flight context)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'mid-flight context from plan 3-02',
    );
    assert.ok(!result.updated.includes('Last Activity Description'));
  });

  test('Current Phase Name is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(!result.updated.includes('Current Phase Name'));
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (first-time begin)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Current Position Phase line reflects the new phase (EXECUTING)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.ok(result.updated.includes('Current Position'),
      `updated should include Current Position; got ${JSON.stringify(result.updated)}`);
    // Verify by extracting Phase from the result content (covers both inline and pipe-table).
    // The transition writes "Phase: 3 (Test Phase) — EXECUTING" into ## Current Position.
    // stateExtractField returns the first match across the whole content, but the
    // **Current Phase:** frontmatter-style line is a different field, so 'Phase'
    // extraction finds the Current Position line.
    const posPhase = stateExtractField(result.content, 'Phase');
    assert.ok(
      /3.*Test Phase.*EXECUTING/.test(posPhase || ''),
      `Current Position Phase line should match /3.*Test Phase.*EXECUTING/; got ${JSON.stringify(posPhase)}`,
    );
  });

  test('Current Position Plan line shows "1 of N"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /1 of 5/.test(posPlan || ''),
      `Current Position Plan line should match /1 of 5/; got ${JSON.stringify(posPlan)}`,
    );
  });

  test('Current Position Status line reflects Executing Phase N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // 'Status' extraction returns the first match — which is the top-level
    // **Status:** line. The Current Position Status line is a different field
    // occurrence. Extract from the section to disambiguate.
    const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
    const body = result.content;
    const hs = tokenizeHeadings(body);
    const posIdx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
    assert.notStrictEqual(posIdx, -1, 'Current Position section must exist');
    // Slice the section body and look for the Status line within it.
    const h = hs[posIdx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const bodyStart = h.offset + hl.length + 1;
    let bodyEnd = body.length;
    for (let j = posIdx + 1; j < hs.length; j++) {
      if (hs[j].level >= 2) { bodyEnd = hs[j].offset - 1; break; }
    }
    const sectionBody = body.slice(bodyStart, bodyEnd);
    const sectionStatus = stateExtractField(sectionBody, 'Status');
    assert.ok(
      /Executing Phase\s+3/.test(sectionStatus || ''),
      `Current Position Status line should match /Executing Phase 3/; got ${JSON.stringify(sectionStatus)}`,
    );
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (resume path)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Resume updates only the Last activity line in Current Position (preserves Plan, Phase, Status)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.ok(result.updated.includes('Last activity (resume)') || result.updated.includes('Last Activity'),
      `resume should update Last activity; got ${JSON.stringify(result.updated)}`);
    // Plan line in Current Position should still say "2 of 5" (NOT reset to "1 of 5").
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /2 of 5/.test(posPlan || ''),
      `resume should preserve Plan "2 of 5"; got ${JSON.stringify(posPlan)}`,
    );
  });
});

describe('ADR-1769 Phase 1: property tests (RULESET.TESTS.property-based-testing)', () => {
  const deps = { clock: fixedClock };

  test('for any non-negative integer phaseNumber and any STATE.md body with a non-whitespace Status value, beginPhase produces content whose body Status carries "Executing Phase N"', () => {
    // Note: filters out whitespace-only statusSuffix because state-document.cjs's
    // bold stateReplaceField pattern uses greedy \s* that consumes the trailing
    // newline when the value is whitespace-only — a pre-existing bug surfaced
    // by this property test, not introduced by ADR-1769. Filed as a follow-up.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0 && !s.includes('\u0000')),
        (phaseNum, statusSuffix) => {
          const input = `# Project State\n\n**Status:** ${statusSuffix}\n`;
          const result = transitionCore(
            input,
            { kind: 'beginPhase', phaseNumber: phaseNum, phaseName: null, planCount: null },
            deps,
          );
          const bodyStatus = stateExtractField(result.content, 'Status') || '';
          return new RegExp(`Executing Phase\\s+${phaseNum}\\b`).test(bodyStatus);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('getFieldClassification own-property lookup always returns null or a valid {source, preservation} row', () => {
    const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
    const allowedPreservation = new Set([
      'derive',
      'preserve-when-unchanged',
      'preserve-always',
      'preserve-if-placeholder',
    ]);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cls = getFieldClassification(s);
        if (cls === null) return true;
        return allowedSources.has(cls.source) && allowedPreservation.has(cls.preservation);
      }),
      { numRuns: 200 },
    );
  });
});

describe('ADR-1769 Phase 2: advancePlan transition', () => {
  const deps = { clock: fixedClock };

  test('advances Current Plan from N to N+1 (legacy format)', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    // #3784: was '3'. The dropped zero-padding this used to pin is the defect
    // the issue reports, not behaviour worth preserving — a fixture written
    // "02" must not come back "3". The characterization is updated rather than
    // worked around, because the old value WAS the bug.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '03');
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
    assert.strictEqual(result.data && result.data.total_plans, 5);
  });

  test('phase-complete branch when currentPlan >= totalPlans', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 05',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.strictEqual(result.data && result.data.status, 'ready_for_verification');
  });

  test('error when plan fields are unparseable', () => {
    const input = '# Project State\n\nNo plan fields here.\n';
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.error, true);
    assert.deepStrictEqual(result.updated, []);
  });

  // Hybrid shape: the legacy field NAME carrying the compound VALUE, with no
  // `Total Plans in Phase` sibling. Neither documented branch handled it —
  // `legacyTotal` is null so the legacy branch fell through, and the compound
  // branch reads the `Plan` field through a `^Plan:` line-anchored pattern
  // that never matches `Current Plan:`. Both produced NaN, and the caller
  // reported a parse failure against a file whose plan numbers are plainly
  // readable.
  //
  // Not hypothetical: an agent wrote this exact shape unprompted, believing
  // it was the parseable form, and every later run inherited it.
  test('hybrid format: "Current Plan: 4 of 6" with no Total Plans sibling', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Current Plan: 4 of 6',
      'Status: Executing Phase 7',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.error, undefined);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 5);
    assert.strictEqual(result.data && result.data.total_plans, 6);
  });

  // AC1: the hybrid must write back to the SAME field with padding preserved,
  // not merely report the right numbers in `data`.
  test('hybrid format: writes back to Current Plan with padding preserved', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Current Plan: 04 of 06',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '05 of 06');
    // Identity, not a presence proxy: assert the whole section body, so a
    // spurious extra field or a dropped line is visible rather than merely
    // "no line starting with Plan:".
    const section = result.content.slice(result.content.indexOf('## Current Position'));
    assert.strictEqual(section.trimEnd(), ['## Current Position', '', 'Current Plan: 05 of 06'].join('\n'));
  });

  test('hybrid format: phase-complete branch still fires on the last plan', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Current Plan: 6 of 6',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
  });

  test('compound format preserves zero-padding on both halves', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 04 of 06',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '05 of 06');
  });

  test('padding widens rather than truncates when the plan number grows', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 09 of 12',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '10 of 12');
  });

  test('unpadded compound stays unpadded', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 2 of 6',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '3 of 6');
  });

  // AC6: the shared field reader must NOT be loosened to make the hybrid work.
  // Reading the hybrid is the transition's job; `stateExtractField('Plan')` is
  // line-anchored (`^Plan:`) and has 13+ callers, so teaching it to match a
  // field name that merely ENDS in "Plan" would be the wrong fix and would
  // silently change what those callers read. This test fails if anyone tries it.
  test('shared reader stays anchored: "Plan" does not match "Current Plan:"', () => {
    const content = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Current Plan: 04 of 06',
      '',
    ].join('\n');
    assert.strictEqual(stateExtractField(content, 'Plan'), null);
    assert.strictEqual(stateExtractField(content, 'Current Plan'), '04 of 06');
  });

  // The legacy pair must keep winning when both are present: a stray "of N"
  // inside the Current Plan value must not override an explicit Total Plans.
  test('legacy pair still takes precedence over an "of N" in Current Plan', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 2 of 99',
      '**Total Plans in Phase:** 5',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.total_plans, 5);
    // Assert the WRITE, not just the parse. Reading `data` alone cannot see a
    // lossy write-back, and a regression test that cannot observe the
    // regression is not coverage. The legacy branch used to write
    // `String(newPlan)`, which turned "2 of 99" into a bare "3" — silently
    // destroying the reader's own text on a branch nobody was looking at.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3 of 99');
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
  });

  test('legacy pair preserves zero-padding on write-back', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 04',
      '**Total Plans in Phase:** 06',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '05');
  });

  // Findings 2+3 are one defect seen twice: the body-level write is single-shot
  // and bold-preferring, so on a file carrying the field at BOTH the bold header
  // and the `## Current Position` line it updates the header only — and
  // `mutateCurrentPositionForAdvance` could not pick up the slack because its
  // plan arm only ever looked for `Plan:`, never `Current Plan:`. The earlier
  // hybrid write-back test passed only because its fixture was single-site.
  test('hybrid format: header and Current Position both advance, no drift', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 04 of 06',
      '**Status:** Executing Phase 7',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Current Plan: 04 of 06',
      'Status: Executing Phase 7',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const advanced = result.content.match(/05 of 06/g) || [];
    assert.strictEqual(advanced.length, 2, 'both sites must advance');
    assert.ok(!/04 of 06/.test(result.content), 'no site may be left behind');
  });

  // Review round 4, Blocker 1. The section fallback was guarded by the
  // FUNCTION-wide `mutated`, which the status/lastActivity arms had already set.
  // The discriminating shape needs BOTH a header `Status:` (to absorb the
  // body-level status write, so the section's own status is still a template
  // default when the section arm runs) AND a bold section plan line (so the
  // plain-line arm misses and only the fallback can write it). Without the
  // header Status this passes even on the broken build.
  test('B1: a bold section plan line advances when an unrelated field was also refreshed', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 04 of 06',
      '**Status:** Ready to plan',
      '',
      '## Current Position',
      '',
      '**Current Plan:** 01 of 06',
      'Status: Ready to plan',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const section = result.content.slice(result.content.indexOf('## Current Position'));
    assert.match(section, /\*\*Current Plan:\*\* 05 of 06/, 'the bold section line must advance');
    assert.ok(!/01 of 06/.test(result.content), 'no site may be left behind');
  });

  // Review round 4, Blocker 2. In the legacy shape BOTH plan values are
  // populated, so a fallback that picked one name by ternary always chose
  // `Current Plan` and never wrote a `**Plan:**` section line — which base did
  // write. The header `**Plan:**` absorbs the body-level write, so only the
  // section arm can advance the section copy.
  test('B2: a bold **Plan:** section line advances in the legacy pair shape', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 3',
      '**Total Plans in Phase:** 5',
      '**Plan:** 3 of 5',
      '**Status:** Ready to plan',
      '',
      '## Current Position',
      '',
      '**Plan:** 3 of 5',
      'Status: Ready to plan',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const section = result.content.slice(result.content.indexOf('## Current Position'));
    assert.match(section, /\*\*Plan:\*\* 4 of 5/, 'the section Plan line must advance');
    assert.ok(!/3 of 5/.test(result.content), 'no site may be left behind');
  });

  // Review round 4, Blocker 3. `PLAN_SHAPE_N` was anchored harder than
  // `PLAN_SHAPE_N_OF_M`, so annotated values base parsed via `parseInt` began to
  // hard-error. Narrowing what the transition ACCEPTS is out of scope for #3784.
  test('B3: annotated legacy values still parse, and keep their annotation', () => {
    const drive = (plan, total) => transitionCore([
      '# Project State', '',
      `**Current Plan:** ${plan}`,
      `**Total Plans in Phase:** ${total}`,
      '**Status:** Executing', '',
    ].join('\n'), { kind: 'advancePlan' }, deps);

    const annotatedTotal = drive('3', '5 phases');
    assert.strictEqual(annotatedTotal.data.advanced, true, '"5 phases" must still supply a total');
    assert.strictEqual(annotatedTotal.data.total_plans, 5);

    const annotatedPlan = drive('3 (blocked)', '5');
    assert.strictEqual(annotatedPlan.data.advanced, true, '"3 (blocked)" must still advance');
    assert.strictEqual(
      stateExtractField(annotatedPlan.content, 'Current Plan'), '4 (blocked)',
      'the annotation is the author\'s text and survives the advance',
    );

    // The prose case stays refused: the START anchor is what closes it, not the
    // absence of a suffix.
    const prose = transitionCore([
      '# Project State', '', '**Current Plan:** 4 — blocked on review of 2 PRs',
      '**Status:** Executing', '',
    ].join('\n'), { kind: 'advancePlan' }, deps);
    assert.strictEqual(prose.data.error, true, 'a total must never be read out of prose');
  });

  // Minor 1: the Number.isSafeInteger bound this PR introduces.
  test('boundary: the safe-integer limit', () => {
    const drive = (v) => transitionCore([
      '# Project State', '', `**Current Plan:** ${v}`, '**Status:** Executing', '',
    ].join('\n'), { kind: 'advancePlan' }, deps).data;
    const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991
    assert.strictEqual(drive(`${MAX - 1} of ${MAX}`).advanced, true, 'limit-1 advances');
    assert.strictEqual(drive(`${MAX} of ${MAX}`).reason, 'last_plan', 'limit itself is readable');
    assert.strictEqual(drive(`${MAX} of 9007199254740992`).error, true, 'limit+1 is refused, not rounded');
  });

  // Boundary coverage (RULESET.TESTS.boundary-coverage) around the
  // `currentPlan >= totalPlans` limit, on the newly readable hybrid shape.
  // limit itself ("6 of 6") is covered by the phase-complete test above.
  test('hybrid boundary: limit-1 advances', () => {
    const input = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Current Plan: 5 of 6',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 6);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '6 of 6');
  });

  test('hybrid boundary: limit+1 takes the phase-complete branch', () => {
    const input = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Current Plan: 7 of 6',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    // Mirrors the compound branch's existing `>= totalPlans` semantics — an
    // over-limit value is past the end, not a new advance.
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
  });

  // CRLF: regexes matching only \n are a recurring defect class here, and the
  // write path's `(.*)` capture eats a trailing \r. A file that arrives CRLF
  // must not leave with one line silently converted to LF.
  test('hybrid format: CRLF line endings survive the write-back', () => {
    const input = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Current Plan: 04 of 06',
      'Status: Executing Phase 7',
      '',
    ].join('\r\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.ok(/Current Plan: 05 of 06\r\n/.test(result.content),
      'the advanced line must keep its CRLF terminator');
    assert.ok(!/(^|[^\r])\n/.test(result.content), 'no line may be downgraded to bare LF');
  });

  // RULESET.TESTS.property-based-testing: this is a parsing/transformation with
  // a format-preserving contract, so the contract gets a property, not just
  // examples. Contract: advancing rewrites ONLY the leading integer, pads it to
  // at least the original digit width, and leaves the rest of the value byte-
  // identical.
  // Drives BOTH compound spellings — `Plan:` and the hybrid `Current Plan:`
  // this PR adds — because a property that only exercises the pre-existing
  // branch says nothing about the branch under review. `n` ranges past 99 so
  // the 99 -> 100 width transition is covered by the property rather than by a
  // single example.
  test('property: advancing preserves padding width and the " of M" remainder', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 150 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom('Plan', 'Current Plan'),
        (n, planWidth, totalWidth, fieldName) => {
          const total = n + 2; // strictly greater, so the advance branch is taken
          const planStr = String(n).padStart(planWidth, '0');
          const totalStr = String(total).padStart(totalWidth, '0');
          const input = [
            '# Project State',
            '',
            `**${fieldName}:** ${planStr} of ${totalStr}`,
            '**Status:** Executing Phase 7',
            '',
          ].join('\n');
          const result = transitionCore(input, { kind: 'advancePlan' }, deps);
          const expected = `${String(n + 1).padStart(planStr.length, '0')} of ${totalStr}`;
          assert.strictEqual(stateExtractField(result.content, fieldName), expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  // The legacy pair's own format-preserving contract: the ` of M` remainder and
  // the padding survive there too, and the sibling supplies the total.
  test('property: the legacy pair preserves the written Current Plan value shape', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 150 }),
        fc.integer({ min: 1, max: 4 }),
        fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
        (n, planWidth, inlineTotal) => {
          const total = n + 2;
          const planStr = String(n).padStart(planWidth, '0');
          const written = inlineTotal === null ? planStr : `${planStr} of ${inlineTotal}`;
          const input = [
            '# Project State',
            '',
            `**Current Plan:** ${written}`,
            `**Total Plans in Phase:** ${total}`,
            '**Status:** Executing Phase 7',
            '',
          ].join('\n');
          const result = transitionCore(input, { kind: 'advancePlan' }, deps);
          const bumped = String(n + 1).padStart(planStr.length, '0');
          const expected = inlineTotal === null ? bumped : `${bumped} of ${inlineTotal}`;
          assert.strictEqual(stateExtractField(result.content, 'Current Plan'), expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  // #3791 review round 6: the two properties above each exercise ONE spelling,
  // so neither could see a document carrying both — which is where B1 and M1
  // both lived. This one crosses the two contracts, with agreeing and
  // disagreeing numbers, and asserts the per-spelling contract on each half.
  test('property: two spellings — each keeps its own shape when they agree, and neither moves when they do not', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 150 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        // The `Plan:` line's OWN total, independent of the sibling field.
        fc.integer({ min: 200, max: 400 }),
        // 0 = the two spellings agree; anything else is the offset that makes
        // them disagree.
        fc.integer({ min: 0, max: 9 }),
        (n, legacyWidth, planWidth, planOwnTotal, disagreeBy) => {
          const siblingTotal = n + 2; // strictly greater, so the advance branch is taken
          const legacyStr = String(n).padStart(legacyWidth, '0');
          const planN = n + disagreeBy;
          const planStr = String(planN).padStart(planWidth, '0');
          const input = [
            '# Project State',
            '',
            `**Current Plan:** ${legacyStr}`,
            `**Total Plans in Phase:** ${siblingTotal}`,
            '**Status:** Executing Phase 7',
            '',
            '## Current Position',
            '',
            `Plan: ${planStr} of ${planOwnTotal}`,
            '',
          ].join('\n');
          const result = transitionCore(input, { kind: 'advancePlan' }, deps);

          if (disagreeBy !== 0) {
            // Refused, and nothing written — not one field, not the status.
            assert.strictEqual(result.data && result.data.error, true);
            assert.strictEqual(result.data && result.data.reason, 'ambiguous_plan_position');
            assert.strictEqual(stateExtractField(result.content, 'Current Plan'), legacyStr);
            assert.strictEqual(stateExtractField(result.content, 'Plan'), `${planStr} of ${planOwnTotal}`);
            return;
          }

          // They agree: both advance, and each keeps its OWN written shape —
          // the legacy field its padding and bare form, the `Plan:` line its
          // padding AND its own total, which is never the sibling's.
          assert.strictEqual(result.data && result.data.advanced, true);
          assert.strictEqual(
            stateExtractField(result.content, 'Current Plan'),
            String(n + 1).padStart(legacyStr.length, '0'),
          );
          assert.strictEqual(
            stateExtractField(result.content, 'Plan'),
            `${String(n + 1).padStart(planStr.length, '0')} of ${planOwnTotal}`,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  // m2: the degenerate end of the totalPlans threshold, and the shapes the
  // anchored grammar must refuse. `0 of 0` is `currentPlan >= totalPlans`, so
  // it is phase-complete rather than an error — pinned so the grammar
  // tightening cannot silently reclassify it.
  test('boundary: degenerate and malformed plan values', () => {
    const drive = (value) => {
      const input = ['# Project State', '', `**Current Plan:** ${value}`, '**Status:** Executing', ''].join('\n');
      return transitionCore(input, { kind: 'advancePlan' }, deps).data;
    };
    assert.strictEqual(drive('0 of 0').reason, 'last_plan', '"0 of 0" is past the end, not an error');
    assert.strictEqual(drive('0 of 3').advanced, true, '"0 of 3" advances to 1');
    for (const bad of ['-1 of 6', '+2 of 6', '\u0663 of \u0665', '3 of', 'of 5', 'x of 5']) {
      assert.strictEqual(drive(bad).error, true, `${JSON.stringify(bad)} must be refused`);
    }
  });

  test('compound format: "Plan: 2 of 6" preserves compound shape', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 2 of 6',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const plan = stateExtractField(result.content, 'Plan');
    assert.ok(/3 of 6/.test(plan || ''), `Plan should be "3 of 6"; got ${JSON.stringify(plan)}`);
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});

// ─── #3873 phase-3 test-matrix rows 23/24/25: parser accepts EXACTLY the ────
// schema-declared shapes — no more, no fewer.
//
// Table-driven over every STATE_FIELD_SCHEMA row carrying `acceptedShapes`
// (today: only `current_plan`), so declaring `acceptedShapes` on a future row
// gets gated automatically. A row with a driver missing from PARSER_DRIVERS
// fails loudly (row24/row23 below) rather than silently skipping — that is
// what keeps the table-driven claim honest as rows are added.
//
// The declaration itself was corrected against OBSERVED parser behavior
// (verified by executing `advancePlanCore`, not by reading its prior
// docstring's claim): `current_plan.acceptedShapes` is `['N']` only.
// `Current Plan: N of M` standalone does NOT parse today — `advancePlanCore`
// (`src/state-transition.cts:1306`) requires a `Total Plans in Phase`
// sibling for the bare-`N` path; with no sibling and no separate `Plan`
// field, it falls to its NaN/NaN error branch. #3784 is the open issue for
// teaching it the hybrid shape; **PR #3791** ("fix(#3784): read the hybrid
// `Current Plan: N of M` shape, keep zero-padding, and name the accepted
// shapes on failure") is the in-flight fix. When #3791 merges,
// `acceptedShapes` MUST widen to `['N', 'N of M']` — until then, this suite
// pins today's reality, and it is EXPECTED to go RED the moment the parser
// changes underneath it. That is the forcing function working as designed
// (§8.8 "checked, not generated"), not a broken test.
describe('#3791 review round 6 (B1/M1): every spelling advances from its own text', () => {
  const deps = { clock: fixedClock };
  const advance = (lines) => transitionCore(lines.join('\n'), { kind: 'advancePlan' }, deps);

  // ─── M1: a field keeps its OWN total, padding and annotation ───────────────
  //
  // The legacy pair wins precedence, but that only decides which numbers the
  // ADVANCE is computed from. It does not license re-rendering the `Plan:` line
  // from the legacy pair's numbers, which is what the previous revision did:
  // `planDisplayValue` fell back to a bare `${newPlan} of ${totalPlans}` built
  // from the sibling field.

  test('the Plan line keeps its own total when it differs from the sibling field', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '**Status:** Executing',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 9',
      'Status: Executing',
      '',
    ]);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    // Was '3 of 5' — the sibling's total silently overwrote the line's own.
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '3 of 9');
  });

  test('the Plan line keeps its own zero-padding when the legacy pair supplies the numbers', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 03',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing',
      '',
      '## Current Position',
      '',
      'Plan: 03 of 05',
      'Status: Executing',
      '',
    ]);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '04');
    // Was '4 of 5' — the changeset's "the zero-padding width and everything
    // after it survive" was true only for the parse-source field.
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '04 of 05');
  });

  test('a trailing annotation on the Plan line survives an advance driven by the legacy pair', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5 in current phase',
      '',
    ]);
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '3 of 5 in current phase');
  });

  // ─── B1: two spellings, different numbers — refuse, never fabricate ────────

  test('refuses when Current Plan and Plan carry different numbers', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 7',
      '**Status:** Executing',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      '',
    ]);
    assert.strictEqual(result.data && result.data.error, true);
    assert.strictEqual(result.data && result.data.reason, 'ambiguous_plan_position');
    assert.deepStrictEqual(result.data && result.data.plan_candidates,
      ['Current Plan: 7', 'Plan: 2 of 5']);
    // Nothing is written. The previous revision advanced `Plan` to `3 of 5` and
    // stamped `Current Plan: 3` — a number with no relationship to the 7 the
    // author wrote.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '7');
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '2 of 5');
  });

  test('the disagreement refusal runs BEFORE the phase-complete branch', () => {
    // `Plan: 5 of 5` alone would advance=false / last_plan and write a terminal
    // "Phase complete — ready for verification". Guarding only the normal
    // advance path would let it do that to a document whose two spellings never
    // agreed on where execution was.
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 7',
      '**Status:** Executing',
      '',
      '## Current Position',
      '',
      'Plan: 5 of 5',
      '',
    ]);
    assert.strictEqual(result.data && result.data.error, true);
    assert.strictEqual(result.data && result.data.reason, 'ambiguous_plan_position');
    assert.ok(!/Phase complete/.test(result.content),
      'a disagreeing document must not be marked phase-complete');
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '7');
  });

  test('agreeing spellings are not a disagreement, whatever their totals say', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 9',
      '',
    ]);
    assert.strictEqual(result.data && result.data.error, undefined);
    assert.strictEqual(result.data && result.data.advanced, true);
  });

  // ─── An unreadable sibling is left alone, not overwritten ──────────────────

  test('a Plan line with no readable number is left exactly as authored', () => {
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
      '## Current Position',
      '',
      'Plan: TBD',
      '',
    ]);
    // The advance still happens — refusing the whole document because an
    // unrelated line is unreadable would be a narrowing #3784 does not license.
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    // ...and the unreadable line is untouched rather than fabricated over.
    assert.strictEqual(stateExtractField(result.content, 'Plan'), 'TBD');
  });

  test('a Current Plan with no readable number is left alone, and not reported as updated', () => {
    // The mirror of the case above: `Plan` is the parse source and the legacy
    // field is the unreadable one. It exercises the other arm of the same skip,
    // and it is the fixture where an unconditional `updated.push('Current Plan')`
    // would claim a write that never happened.
    const result = advance([
      '# Project State',
      '',
      '**Current Plan:** TBD',
      '**Status:** Executing',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      '',
    ]);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(stateExtractField(result.content, 'Plan'), '3 of 5');
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), 'TBD');
    assert.ok(!result.updated.includes('Current Plan'),
      'must not report a field it did not write');
    assert.ok(result.updated.includes('Status'), 'the fields it did write are still reported');
  });

  // ─── M2: the bare `Plan: N` + sibling shape is not accepted ────────────────

  test('a bare Plan: N with a Total sibling and no Current Plan is refused', () => {
    const result = advance([
      '# Project State',
      '',
      '**Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
    ]);
    // Base refused this (its `else if (planField)` arm had no `of M` match and
    // errored via NaN). A revision of this PR accepted it; #3791 review round 6
    // (M2) is that it cannot be given the schema-row + forcing-test coupling
    // the other shapes have, because `Plan` is body-only.
    assert.strictEqual(result.data && result.data.error, true);
    assert.strictEqual(result.data && result.data.reason, undefined);
  });
});

describe('#3873 phase-3 rows 23/24/25: parser accepts exactly the schema-declared shapes', () => {
  const deps = { clock: fixedClock };

  // Bare `N` only ever appears in a real STATE.md paired with a sibling
  // `Total Plans in Phase` field (that pairing is what supplies the total
  // `advancePlanCore` needs). `N of M` / `N/M` are driven WITHOUT that
  // sibling, because the entire point of a hybrid shape is that it is
  // self-contained in the `Current Plan` field alone — pairing it with a
  // sibling would let the sibling's total paper over a value `parseInt`
  // cannot fully read, which is the exact coincidence row 25 exists to catch.
  function driveCurrentPlanShape(shapeValue, { withTotalSibling = false } = {}) {
    const lines = ['# Project State', '', `**Current Plan:** ${shapeValue}`];
    if (withTotalSibling) lines.push('**Total Plans in Phase:** 5');
    lines.push('**Status:** Executing Phase 3', '');
    const result = transitionCore(lines.join('\n'), { kind: 'advancePlan' }, deps);
    return !(result.data && result.data.error === true);
  }

  // field -> (shape value, drive opts) -> boolean "did it parse"
  const PARSER_DRIVERS = {
    current_plan: driveCurrentPlanShape,
  };

  // shape name -> [example value, drive opts]
  const SHAPE_EXAMPLES = {
    'N': ['3', { withTotalSibling: true }],
    'N of M': ['3 of 5', {}],
    'N/M': ['3/5', {}],
  };

  const rowsWithAcceptedShapes = Object.entries(STATE_FIELD_SCHEMA).filter(
    ([, row]) => Array.isArray(row.acceptedShapes),
  );

  test('sanity: at least one schema row declares acceptedShapes (else this suite is vacuous)', () => {
    assert.ok(rowsWithAcceptedShapes.length > 0, 'expected at least one acceptedShapes row to pin');
  });

  test('unsupportedDeclaredShapeFails: every declared shape parses via the real parser (row 24)', () => {
    for (const [field, row] of rowsWithAcceptedShapes) {
      const driver = PARSER_DRIVERS[field];
      assert.ok(driver, `no PARSER_DRIVERS entry for field ${JSON.stringify(field)} — register one before declaring acceptedShapes on it`);
      for (const shape of row.acceptedShapes) {
        const example = SHAPE_EXAMPLES[shape];
        assert.ok(example, `no SHAPE_EXAMPLES entry for shape ${JSON.stringify(shape)} (field ${JSON.stringify(field)})`);
        const [value, opts] = example;
        const parsed = driver(value, opts);
        assert.strictEqual(parsed, true, `declared shape ${JSON.stringify(shape)} for field ${JSON.stringify(field)} did not parse`);
      }
    }
  });

  test('undeclaredParserShapeFails: a shape outside the declared set is rejected (row 23)', () => {
    // 'N of M' is deliberately excluded from current_plan's declared set
    // today (the #3784/#3791 boundary); 'N/M' is a fourth spelling that has
    // never been declared for any row. Both must fail to parse.
    for (const [field, row] of rowsWithAcceptedShapes) {
      const driver = PARSER_DRIVERS[field];
      const undeclaredCandidates = Object.keys(SHAPE_EXAMPLES).filter((shape) => !row.acceptedShapes.includes(shape));
      assert.ok(undeclaredCandidates.length > 0, `no undeclared shape candidate available to probe field ${JSON.stringify(field)}`);
      for (const shape of undeclaredCandidates) {
        const [value, opts] = SHAPE_EXAMPLES[shape];
        const parsed = driver(value, opts);
        assert.strictEqual(parsed, false, `undeclared shape ${JSON.stringify(shape)} for field ${JSON.stringify(field)} was accepted by the parser`);
      }
    }
  });

  // The worked case (#3784's three spellings): current_plan specifically.
  test('planNofMShapesAreExactlyTheDeclaredSet', () => {
    // #3791 widened this row, exactly as the schema's own comment instructed.
    assert.deepStrictEqual(Array.from(STATE_FIELD_SCHEMA.current_plan.acceptedShapes), ['N', 'N of M']);

    // Declared shape parses.
    assert.strictEqual(driveCurrentPlanShape('3', { withTotalSibling: true }), true, '"N" (paired with Total Plans in Phase) should parse');

    // The hybrid shape is now declared AND parses standalone — #3784.
    assert.strictEqual(driveCurrentPlanShape('3 of 5'), true, '"N of M" standalone in Current Plan should parse');

    // A fourth, never-declared spelling fails rather than quietly joining.
    assert.strictEqual(driveCurrentPlanShape('3/5'), false, '"N/M" should NOT parse — it has never been declared');

    // Declaring "N of M" is a claim about an ANCHORED grammar, not about the
    // substring "of". Prose that merely contains it must still be refused —
    // otherwise `4 — blocked on review of 2 PRs` reads as "4 of 2", which is
    // `currentPlan >= totalPlans` and WRITES a terminal phase-complete status.
    for (const prose of [
      '4 — blocked on review of 2 PRs',
      '3 (waiting for refactor of 1 module)',
      '2roof 5',
      '+2 of 6',
      '-1 of 6',
    ]) {
      assert.strictEqual(
        driveCurrentPlanShape(prose), false,
        `${JSON.stringify(prose)} must NOT parse — the declared shape is anchored`,
      );
    }
  });
});

describe('#3830: advancePlan cross-checks prose plan position against the plan set on disk', () => {
  const clock = { clock: fixedClock };

  // The reproduction from the issue: twelve plans on disk, prose still says
  // "2 of 8". Pre-fix this returned { advanced: true, current_plan: 3,
  // total_plans: 8 } and wrote "Plan: 3 of 8" back.
  const COMPOUND_STALE = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Plan: 2 of 8',
    'Status: Ready to execute',
    'Last Activity: 2026-06-26',
    '',
  ].join('\n');

  const LEGACY_STALE = [
    '# Project State',
    '',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 08',
    '**Status:** Ready to execute',
    '**Last Activity:** 2026-06-26',
    '',
  ].join('\n');

  // Default shape: both disk counts agree with each other, so only a prose
  // total matching neither can diverge.
  const diskSays = (planCount, extra = {}) => ({
    ...clock,
    planSetProvider: () => ({
      ok: true,
      phase: '01',
      planCount,
      planCountAll: planCount,
      ...extra,
    }),
  });

  test('refuses to advance when the disk plan count diverges from the prose total (compound)', () => {
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'position_diverged');
    assert.deepStrictEqual(result.data && result.data.prose, { current_plan: 2, total_plans: 8 });
    assert.deepStrictEqual(result.data && result.data.disk, {
      phase: '01',
      plan_count: 12,
      plan_count_all: 12,
    });
  });

  test('the refusal reports NO updated fields and returns the input bytes untouched', () => {
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, diskSays(12));
    assert.deepStrictEqual(result.updated, []);
    // Byte-identical, not merely "Plan: still 2 of 8": a refusal that
    // normalizes frontmatter or reflows the section is still a mutation, and
    // this verb's whole defect is writing when it should not.
    assert.strictEqual(result.content, COMPOUND_STALE);
  });

  test('the legacy Current Plan / Total Plans in Phase shape goes through the same check', () => {
    const result = transitionCore(LEGACY_STALE, { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.reason, 'position_diverged');
    assert.strictEqual(result.content, LEGACY_STALE);
  });

  // #4067 landed on `next` mid-review and re-decides the phase-complete branch
  // from disk in cmdStateAdvancePlan (every plan summarized, or decline as
  // `plans_outstanding`). Its own fixture is a `7 of 7` carried into a 3-plan
  // phase — a total this check calls diverged — and it expects that branch to be
  // REACHED. So the core reports the divergence on the completion branch instead
  // of refusing there, and the command-layer tests in tests/state.test.cjs pin
  // what the disk then decides. The increment branch is unchanged: see
  // 'single-plan drift in either direction is still divergence' below.
  test('a diverged total on the phase-COMPLETION branch is reported, not refused', () => {
    const input = COMPOUND_STALE.replace('Plan: 2 of 8', 'Plan: 8 of 8');
    const result = transitionCore(input, { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.strictEqual(result.data && result.data.status, 'ready_for_verification');
    assert.deepStrictEqual(result.data && result.data.prose_diverged, {
      prose: { current_plan: 8, total_plans: 8 },
      disk: { phase: '01', plan_count: 12, plan_count_all: 12 },
    }, 'the completion answer must carry the divergence it did not refuse on');
    assert.notStrictEqual(result.content, input, 'the core still writes the completion; #4067 declines it at the command layer when plans are outstanding');
  });

  test('an in-range last plan carries no prose_diverged', () => {
    const input = COMPOUND_STALE.replace('Plan: 2 of 8', 'Plan: 8 of 8');
    const result = transitionCore(input, { kind: 'advancePlan' }, diskSays(8));
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.strictEqual(result.data && result.data.prose_diverged, undefined);
  });

  test('a position past its own total is reported on the completion branch, not refused', () => {
    // `20 of 12` is `rangeDiverged` with an agreeing total; it satisfies
    // currentPlan >= totalPlans, so it lands on the completion branch and #4067's
    // disk answer is the only thing that says anything true about the phase.
    const input = COMPOUND_STALE.replace('Plan: 2 of 8', 'Plan: 20 of 12');
    const result = transitionCore(input, { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.deepStrictEqual(result.data && result.data.prose_diverged && result.data.prose_diverged.prose,
      { current_plan: 20, total_plans: 12 });
  });

  test('a position BELOW the plan set is still refused — that is the increment branch', () => {
    const input = COMPOUND_STALE.replace('Plan: 2 of 8', 'Plan: 0 of 12');
    const result = transitionCore(input, { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.reason, 'position_diverged');
    assert.strictEqual(result.content, input);
  });

  test('advances exactly as before when the prose TOTAL matches the disk plan count', () => {
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, diskSays(8));
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
    assert.strictEqual(result.data && result.data.total_plans, 8);
    assert.ok(/3 of 8/.test(stateExtractField(result.content, 'Plan') || ''));
  });

  // The three "no evidence" shapes below must NOT be read as divergence.
  // Blocking on any of them would strand a project this check knows nothing
  // about (ADR-3180 Decision 2 / #3057 B1: a non-answer is not a zero).

  test('an ABSENT provider leaves behaviour exactly as it was (skip-clean)', () => {
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, clock);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
  });

  test('a scan that could not complete (ok:false) is unknown, not diverged', () => {
    const deps = { ...clock, planSetProvider: () => ({ ok: false, reason: 'phases directory not readable' }) };
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.reason, undefined);
  });

  test('a phase with no plan files on disk yet is not diverged and is not blocked', () => {
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, diskSays(0));
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
  });

  test('single-plan drift in either direction is still divergence', () => {
    for (const planCount of [7, 9]) {
      const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, diskSays(planCount));
      assert.strictEqual(
        result.data && result.data.reason,
        'position_diverged',
        `disk=${planCount} vs prose total 8 should diverge`,
      );
    }
  });

  // --- the two-writer supersession split (#2893 / plan_count vs plan_count_all) ---

  test('a prose total matching plan_count_all is NOT divergence, even when live plans are fewer', () => {
    // execute-phase writes the live count; plan-review-convergence writes
    // plan_count_all. A superseded plan makes them differ by design, and a
    // check that insisted on one would report that writer split as drift.
    const deps = diskSays(7, { planCountAll: 8 });
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, true, 'prose total 8 == plan_count_all 8');
    assert.strictEqual(result.data && result.data.reason, undefined);
  });

  test('a prose total matching NEITHER disk count is divergence', () => {
    const deps = diskSays(11, { planCountAll: 12 });
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.reason, 'position_diverged');
  });

  test('a phase whose plans are ALL superseded is EVIDENCE, not absence (#3862 review)', () => {
    // The presence test guarded on the LIVE count alone, which made this state
    // indistinguishable from "no plans written yet" — both report planCount 0 — so
    // the gate abstained and the stale prose was incremented, the very defect #3830
    // reports. Driven against the real binary before the fix: eight superseded
    // plans with prose `Plan: 2 of 7` returned `{"advanced": true, "current_plan": 3}`,
    // where the identical non-superseded fixture refused.
    const deps = diskSays(0, { planCountAll: 12 });
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.reason, 'position_diverged',
      'prose total 8 matches neither 0 live nor 12 including superseded');
    assert.strictEqual(result.data && result.data.advanced, false);
  });

  test('all-superseded whose prose total matches plan_count_all still advances', () => {
    // The other half: widening the presence test must not turn the accepted
    // two-writer split into drift just because the live count is zero.
    const deps = diskSays(0, { planCountAll: 8 });
    const result = transitionCore(COMPOUND_STALE, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, true, 'prose total 8 == plan_count_all 8');
    assert.strictEqual(result.data && result.data.reason, undefined);
  });

  test('the unparseable-prose error still wins over the disk check', () => {
    // No position to compare, so there is nothing for the cross-check to say.
    const result = transitionCore('# Project State\n\nNo plan fields here.\n', { kind: 'advancePlan' }, diskSays(12));
    assert.strictEqual(result.data && result.data.error, true);
  });
});

describe('ADR-1769 Phase 2: advancePlan with frontmatter (#1255 pattern — codex review)', () => {
  const deps = { clock: fixedClock };

  test('advances plan correctly when STATE.md has YAML frontmatter (body Status not YAML status)', () => {
    const input = [
      '---',
      'status: Executing Phase 3',
      'current_phase: "03"',
      '---',
      '',
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    // Body Current Plan must advance to 3, keeping the written width (#3784).
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '03');
    // Body Status must be updated (not the YAML status key).
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Ready to execute/.test(bodyStatus || ''),
      `body Status should be "Ready to execute"; got ${JSON.stringify(bodyStatus)}`,
    );
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});

// Shared fixture for completePhase: a STATE.md body mid-execution with the
// progress fields the cmdPhaseComplete transform touches. Mirrors the shape
// state.cts:buildStateFrontmatter emits.
function completePhaseBody() {
  return [
    '# Project State',
    '',
    '**Current Phase:** 3 of 5 (Old Name)',
    '**Current Phase Name:** Old Name',
    '**Current Plan:** 2',
    '**Status:** Executing Phase 3',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** mid-flight',
    '**Completed Phases:** 2',
    '**Total Phases:** 5',
    '**Progress:** 40%',
    'percent: 40',
    '',
  ].join('\n');
}

// A roadmap with a progress table: 3 of 5 phases Complete → deriveProgressFromRoadmap
// returns { completedPhases: 3, totalPhases: 5 }.
// ADR-2143 (epic #2143): deriveProgressFromRoadmap now resolves this table via the
// markdown-table schema registry (TABLE_SCHEMAS.RoadmapProgress), which requires the
// exact canonical header (gsd-core/templates/roadmap.md); the 2nd column is named
// "Plans Complete" to match (its cell values here are unused free text, not M/N
// counts — no test in this file asserts totalPlans).
const ROADMAP_3_OF_5 = [
  '## Roadmap',
  '',
  '| Phase | Plans Complete | Status | Completed |',
  '| --- | --- | --- | --- |',
  '| 1 | A | Complete | 2026-01-01 |',
  '| 2 | B | Complete | 2026-02-01 |',
  '| 3 | C | Complete | 2026-03-01 |',
  '| 4 | D | In Progress | - |',
  '| 5 | E | Pending | - |',
  '',
].join('\n');

describe('ADR-1769 Phase 3: completePhase transition — body field updates', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('Current Phase advances to nextPhaseNum, preserving "of total" and appending the next name', () => {
    const intent = {
      kind: 'completePhase',
      phaseNum: '3',
      nextPhaseNum: '4',
      nextPhaseName: 'Design Phase',
      isLastPhase: false,
      planCount: 3,
      summaryCount: 3,
    };
    const result = transitionCore(completePhaseBody(), intent, deps);
    const cp = stateExtractField(result.content, 'Current Phase');
    assert.ok(
      /^4 of 5 \(Design Phase\)$/.test(cp || ''),
      `Current Phase should be "4 of 5 (Design Phase)"; got ${JSON.stringify(cp)}`,
    );
    assert.ok(result.updated.includes('Current Phase'));
  });

  test('Current Phase Name is set to nextPhaseName when provided', () => {
    const intent = {
      kind: 'completePhase',
      phaseNum: '3',
      nextPhaseNum: '4',
      nextPhaseName: 'Design Phase',
      isLastPhase: false,
      planCount: 3,
      summaryCount: 3,
    };
    const result = transitionCore(completePhaseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Design Phase');
  });

  test('Status becomes "Ready to plan" when not the last phase', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: 'Design Phase', isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to plan');
  });

  test('Status becomes "All phases complete" when isLastPhase is true', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '5', nextPhaseNum: null, nextPhaseName: null, isLastPhase: true, planCount: 2, summaryCount: 2 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'All phases complete');
  });

  test('Current Plan resets to "Not started"', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), 'Not started');
  });

  test('Last Activity Description carries transition narrative', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 complete, transitioned to Phase 4',
    );
  });

  test('Last Activity Description has no transition clause when there is no next phase', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '5', nextPhaseNum: null, nextPhaseName: null, isLastPhase: true, planCount: 2, summaryCount: 2 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Last Activity Description'), 'Phase 5 complete');
  });
});

describe('ADR-1769 Phase 3: completePhase progress derivation (roadmap)', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('Completed Phases is re-derived from the roadmap progress table', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '3');
  });

  test('Progress percent is recomputed and the inline percent: token is updated', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '60%');
    assert.ok(/percent:\s*60/.test(result.content), `inline percent: token should be 60; content was:\n${result.content}`);
  });

  test('when roadmapProvider yields null, existing Completed Phases / Progress are preserved (no crash)', () => {
    const nullDeps = { clock: fixedClock, roadmapProvider: () => null };
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      nullDeps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '2');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '40%');
  });

  // #3057 B9: `result.updated` must let a caller tell "recomputed from the
  // roadmap" apart from "roadmap unavailable, left as-is". Before the fix,
  // `stateReplaceField`'s return was truthy whenever the field pattern
  // matched — regardless of whether the substituted text actually differed
  // from `body` — so 'Completed Phases' (and 'Progress') were marked
  // 'updated' even when nothing changed.

  test('FAILURE path (roadmap unavailable): Completed Phases / Progress are NOT marked updated — left-as-is is distinguishable from recomputed', () => {
    const nullDeps = { clock: fixedClock, roadmapProvider: () => null };
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      nullDeps,
    );
    assert.ok(!result.updated.includes('Completed Phases'),
      `left-as-is 'Completed Phases' must NOT appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.ok(!result.updated.includes('Progress'),
      `left-as-is 'Progress' must NOT appear in updated; got ${JSON.stringify(result.updated)}`);
    // Values are unchanged (the benign-preservation contract from the test above).
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '2');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '40%');
  });

  test('BENIGN path (roadmap recomputes a different value): Completed Phases / Progress ARE marked updated — recomputed is distinguishable from left-as-is', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps, // roadmapProvider => ROADMAP_3_OF_5, which recomputes Completed Phases 2 → 3
    );
    assert.ok(result.updated.includes('Completed Phases'),
      `recomputed 'Completed Phases' must appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.ok(result.updated.includes('Progress'),
      `recomputed 'Progress' must appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '3');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '60%');
  });
});

describe('ADR-1769 Phase 3: completePhase edge cases', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('falls back to the "Phase:" field when "Current Phase:" is absent (stateReplaceFieldWithFallback)', () => {
    const input = [
      '# Project State',
      '',
      'Phase: 3 of 5',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    const phase = stateExtractField(result.content, 'Phase');
    assert.ok(/^4 of 5/.test(phase || ''), `Phase should advance to "4 of 5"; got ${JSON.stringify(phase)}`);
  });

  test('updates body Status, not the YAML status key, when frontmatter is present (#1255)', () => {
    const input = [
      '---',
      'status: executing',
      'current_phase: "3"',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 3 of 5',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    // Body Status line must read "Ready to plan".
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.strictEqual(bodyStatus, 'Ready to plan');
    // Frontmatter must remain a block and keep its YAML keys (not be mangled).
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block must be preserved');
    const fmLine = result.content.split('\n').find((l) => /^status:/.test(l));
    assert.ok(fmLine && /executing/.test(fmLine), `YAML status key must be untouched; got ${JSON.stringify(fmLine)}`);
  });

  test('when nextPhaseName is absent and Current Phase had no "of total", value is the bare phase number', () => {
    const input = [
      '# Project State',
      '',
      '**Current Phase:** 3',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Current Phase'), '4');
  });
});

// ADR-1769 Phase 4: plannedPhase + milestoneSwitch

function plannedPhaseBody() {
  return [
    '# Project State',
    '',
    '**Status:** Planning',
    '**Total Plans in Phase:** 0',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** previous planning',
    '',
    '## Current Position',
    '',
    'Phase: 3 (Test Phase) — EXECUTING',
    'Plan: —',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-20 — mid-flight',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 4: plannedPhase transition — body field updates', () => {
  const deps = { clock: fixedClock };

  test('Status advances to "Ready to execute" when the existing value is a template default (Planning)', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to execute');
    assert.ok(result.updated.includes('Status'));
  });

  test('Total Plans in Phase is set to planCount', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '4');
    assert.ok(result.updated.includes('Total Plans in Phase'));
  });

  test('Last Activity is refreshed to clock.today() when the existing value is a date (template default)', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
  });

  test('Last Activity Description carries the planning-complete narrative', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 planning complete — 4 plans ready',
    );
  });

  test('Current Position Status + Last activity are updated', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.ok(result.updated.includes('Current Position'),
      `updated should include Current Position; got ${JSON.stringify(result.updated)}`);
    // The Current Position section should now carry the planning-complete narrative.
    assert.ok(/Phase 3 planning complete/.test(result.content));
  });

  test('executor-authored Status is preserved (Knuth invariant — non-template value not overwritten)', () => {
    const custom = plannedPhaseBody().replace('**Status:** Planning', '**Status:** Awaiting human design review');
    const result = transitionCore(custom, { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Awaiting human design review');
    assert.ok(!result.updated.includes('Status'),
      `Status must not be in updated for an executor-authored value; got ${JSON.stringify(result.updated)}`);
  });

  test('planCount=null leaves Total Plans in Phase untouched', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: null }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '0');
    assert.ok(!result.updated.includes('Total Plans in Phase'));
  });

  test('frontmatter is preserved and body Status (not YAML status) is updated (#1255)', () => {
    const input = [
      '---',
      'status: planning',
      '---',
      '',
      '# Project State',
      '',
      '**Status:** Planning',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** prev',
      '',
      '## Current Position',
      '',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'plannedPhase', phaseNumber: 3, planCount: 2 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to execute');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block preserved');
  });
});

describe('ADR-1769 Phase 4: milestoneSwitch transition — milestone reset', () => {
  const deps = { clock: fixedClock };

  function milestoneBody() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Old Milestone',
      'status: executing',
      'current_phase: "3"',
      'progress:',
      '  total_phases: 5',
      '  completed_phases: 2',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — EXECUTING',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid-flight',
      '',
    ].join('\n');
  }

  test('frontmatter milestone + milestone_name are reset to the new version', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    const fmLine = (key) => result.content.split('\n').find((l) => new RegExp(`^${key}:`).test(l));
    assert.strictEqual(fmLine('milestone'), 'milestone: v2.0');
    assert.strictEqual(fmLine('milestone_name'), 'milestone_name: New Milestone');
  });

  test('frontmatter status resets to planning and progress resets to zero', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.strictEqual(result.content.split('\n').find((l) => /^status:/.test(l)), 'status: planning');
    assert.ok(/total_phases:\s*0/.test(result.content), 'total_phases should reset to 0');
    assert.ok(/completed_phases:\s*0/.test(result.content), 'completed_phases should reset to 0');
    assert.ok(/percent:\s*0/.test(result.content), 'percent should reset to 0');
  });

  test('gsd_state_version is preserved across the reset', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/gsd_state_version:\s*"?1\.0"?/.test(result.content), 'gsd_state_version must be preserved');
  });

  test('Current Position section is reset to "Not started (defining requirements)"', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/Phase: Not started \(defining requirements\)/.test(result.content));
    assert.ok(/Status: Defining requirements/.test(result.content));
    assert.ok(new RegExp(`Last activity: 2026-06-27 — Milestone v2.0 started`).test(result.content));
  });

  test('Accumulated Context / body content outside Current Position is preserved', () => {
    const input = milestoneBody() +
      '\n## Accumulated Context\n\n- An important decision we must keep.\n';
    const result = transitionCore(input, { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/An important decision we must keep/.test(result.content),
      'Accumulated Context must survive the milestone reset');
  });

  test('blank name falls back to the "milestone" placeholder', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: '' }, deps);
    assert.strictEqual(
      result.content.split('\n').find((l) => /^milestone_name:/.test(l)),
      'milestone_name: milestone',
    );
  });
});

// ADR-1769 Phase 5: milestoneComplete

describe('ADR-1769 Phase 5: milestoneComplete transition — closure write', () => {
  const deps = { clock: fixedClock };
  const intent = { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd:new-milestone' };

  function preCloseBody() {
    return [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid-flight',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Plan: 2 of 3',
      'Status: Executing Phase 5',
      'Last activity: 2026-06-20 — running',
      '',
      '## Operator Next Steps',
      '',
      '- Re-run /gsd:complete-milestone v1.0',
      '',
    ].join('\n');
  }

  test('Status becomes "<version> milestone complete"', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'v1.0 milestone complete');
    assert.ok(result.updated.includes('Status'));
  });

  test('Last Activity is refreshed to clock.today()', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
  });

  test('Last Activity Description carries the archived narrative', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'v1.0 milestone completed and archived',
    );
  });

  test('Current Position resets to "Awaiting next milestone" with archived narrative', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.ok(/Phase: Milestone v1\.0 complete/.test(result.content));
    assert.ok(/Status: Awaiting next milestone/.test(result.content));
    assert.ok(/Last activity: 2026-06-27 — Milestone v1\.0 completed and archived/.test(result.content));
    assert.ok(result.updated.includes('Current Position'));
  });

  test('Operator Next Steps is rewritten to point at the next-milestone command', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.ok(/## Operator Next Steps/.test(result.content));
    assert.ok(/- Start the next milestone with \/gsd:new-milestone/.test(result.content));
    // The stale prior instruction must be gone.
    assert.ok(!/Re-run \/gsd:complete-milestone/.test(result.content),
      'stale Operator Next Steps tail must be replaced');
  });

  test('#2245 F7: CRLF blank line after a reset heading is preserved (byte-parity with LF)', () => {
    // resetSectionVerbatim's post-heading blank-swallow loop recognised only
    // a bare `\n` — on a CRLF document, a `\r\n` blank line right after the
    // heading fell into the DISCARDED span instead of the kept prefix,
    // silently dropping one blank line relative to the LF-equivalent output.
    const lfResult = transitionCore(preCloseBody(), intent, deps);
    const crlfResult = transitionCore(preCloseBody().replace(/\n/g, '\r\n'), intent, deps);

    assert.strictEqual(
      crlfResult.content.replace(/\r\n/g, '\n'),
      lfResult.content,
      'CRLF output, normalized back to LF, must match the LF output byte-for-byte',
    );
  });

  test('Operator Next Steps section is inserted when absent', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Status: Executing Phase 5',
      '',
    ].join('\n');
    const result = transitionCore(input, intent, deps);
    assert.ok(/## Operator Next Steps/.test(result.content));
    assert.ok(/- Start the next milestone with \/gsd:new-milestone/.test(result.content));
  });

  test('Current Position section is inserted when absent', () => {
    const input = '# Project State\n\n**Status:** Executing\n**Last Activity:** 2026-06-20\n';
    const result = transitionCore(input, intent, deps);
    assert.ok(/## Current Position/.test(result.content));
    assert.ok(/Status: Awaiting next milestone/.test(result.content));
  });

  test('frontmatter is preserved across the closure write (#1255)', () => {
    const input = [
      '---',
      'status: executing',
      'milestone: v1.0',
      '---',
      '',
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Status: Executing Phase 5',
      '',
    ].join('\n');
    const result = transitionCore(input, intent, deps);
    // Body Status must be the closure value, not the YAML status key.
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'v1.0 milestone complete');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block preserved');
    assert.ok(/^milestone: v1\.0/m.test(result.content), 'frontmatter milestone preserved');
  });
});

// ADR-1769 Phase 6: patch

describe('ADR-1769 Phase 6: patch transition — field updates', () => {
  const deps = { clock: fixedClock };

  test('applies each patched field and reports the updated set', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Planning',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'patch', patches: { Status: 'Paused', 'Current Plan': '3' } },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Paused');
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.deepStrictEqual(result.data && result.data.updated, ['Status', 'Current Plan']);
  });

  test('reports failed fields (no matching field in content)', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(
      input,
      { kind: 'patch', patches: { Status: 'Paused', Nonexistent: 'x' } },
      deps,
    );
    assert.deepStrictEqual(result.data && result.data.updated, ['Status']);
    assert.deepStrictEqual(result.data && result.data.failed, ['Nonexistent']);
  });

  test('leaves content unchanged when no patch matches (no-op)', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'patch', patches: { Nonexistent: 'x' } }, deps);
    assert.strictEqual(result.content, input);
    assert.deepStrictEqual(result.data && result.data.updated, []);
    assert.deepStrictEqual(result.data && result.data.failed, ['Nonexistent']);
  });

  // ADR-3408 §8.3(b) / #3469: STALE as of this phase — patch now strips
  // frontmatter FIRST (matching updateCore), so a lowercase frontmatter key
  // like `stopped_at` can no longer reach the YAML block through this path.
  // The old assertion here ("patch operates on the full content... a
  // lowercase frontmatter key is matched and replaced") is the exact bypass
  // ADR-3408 §8.3(b) closes: it let an arbitrary caller-supplied patch key
  // rewrite YAML frontmatter outside FIELD_CLASSIFICATION, undetected by the
  // write-seam guard's Axis 2 (every step called an owner). See the Matrix D
  // section below for the corrected contract.
  test('patching a frontmatter-shaped key no longer reaches the YAML line (ADR-3408 §8.3(b) / #3469)', () => {
    const input = ['---', 'status: executing', 'stopped_at: 2026-01-01', '---', '', '# State', ''].join('\n');
    const result = transitionCore(input, { kind: 'patch', patches: { stopped_at: '2026-06-27' } }, deps);
    assert.ok(!/^stopped_at: 2026-06-27$/m.test(result.content), 'YAML stopped_at must NOT be patched directly');
    assert.ok(/^stopped_at: 2026-01-01$/m.test(result.content), 'YAML stopped_at must survive unchanged');
    assert.deepStrictEqual(result.data && result.data.updated, []);
    assert.deepStrictEqual(result.data && result.data.failed, ['stopped_at']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3408 §8.3(b) Matrix D (#3469): patchCore strips frontmatter first,
// matching updateCore — closes Phase 1's declared known gap (a
// frontmatter-shaped patch key could rewrite the YAML block outside
// FIELD_CLASSIFICATION). Test matrix: .gsd/phase/refactor-3469-one-write-seam/50-test-matrix.md
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-3408 §8.3(b) Matrix D: patchCore strips frontmatter first (#3469)', () => {
  const deps = { clock: fixedClock };

  // D1: a frontmatter-shaped key (snake_case, no Title-Case body counterpart)
  // can never match — patch is body-only now, so the write "routes through
  // the seam": a frontmatter change can only happen via FIELD_CLASSIFICATION's
  // own preservation/sync machinery, never via a direct patch bypass.
  test('D1: a frontmatter-shaped key (current_phase) is reported failed, and the frontmatter is untouched', () => {
    const input = [
      '---',
      'current_phase: "3"',
      '---',
      '',
      '# State',
      '',
      '## Current Position',
      '',
      'Phase: 3 (alpha)',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'patch', patches: { current_phase: '9' } }, deps);
    assert.deepStrictEqual(result.data && result.data.updated, []);
    assert.deepStrictEqual(result.data && result.data.failed, ['current_phase']);
    assert.ok(/^current_phase: "3"$/m.test(result.content), 'frontmatter current_phase must be unchanged');
    assert.strictEqual(result.content, input, 'no-op: content returned verbatim when nothing in the body matched');
  });

  // D2: a body-shaped key (Title-Case) is the legitimate case and is
  // unaffected by the strip-first fix — it was always matched against the
  // body, and still is.
  test('D2: a body-shaped key (Status) still updates the body — the legitimate, unaffected case', () => {
    const input = ['---', 'status: executing', '---', '', '# State', '', '**Status:** Planning', ''].join('\n');
    const result = transitionCore(input, { kind: 'patch', patches: { Status: 'Paused' } }, deps);
    assert.deepStrictEqual(result.data && result.data.updated, ['Status']);
    assert.deepStrictEqual(result.data && result.data.failed, []);
    assert.ok(result.content.includes('**Status:** Paused'), 'body Status must be updated');
    assert.ok(/^status: executing$/m.test(result.content), 'frontmatter status is untouched by patchCore itself');
  });

  // D3 (boundary, extend #3351 variants A/B): a display-cased key matching
  // the body field succeeds; the SAME field's lower-cased/frontmatter-shaped
  // spelling fails — same content, two spellings, two outcomes.
  test('D3: display-cased "Current Phase" succeeds; lower-cased "current_phase" fails, on the same content', () => {
    const input = [
      '---',
      'current_phase: "1"',
      '---',
      '',
      '# State',
      '',
      '**Current Phase:** 1',
      '',
    ].join('\n');
    const displayCased = transitionCore(input, { kind: 'patch', patches: { 'Current Phase': '2' } }, deps);
    assert.deepStrictEqual(displayCased.data && displayCased.data.updated, ['Current Phase']);
    assert.ok(displayCased.content.includes('**Current Phase:** 2'));

    const lowerCased = transitionCore(input, { kind: 'patch', patches: { current_phase: '2' } }, deps);
    assert.deepStrictEqual(lowerCased.data && lowerCased.data.updated, []);
    assert.deepStrictEqual(lowerCased.data && lowerCased.data.failed, ['current_phase']);
  });

  // D4 (hostile): a key that is simultaneously frontmatter-shaped AND
  // case-insensitively matches a body field (stateReplaceField's `^field:`
  // pattern is case-insensitive) — the body is the ONE deterministic winner,
  // asserted explicitly, because frontmatter is stripped out of the matching
  // surface before any pattern ever runs.
  test('D4: a key matching both a frontmatter key and a body field — body wins deterministically, frontmatter inert', () => {
    const input = ['---', 'status: executing', '---', '', '# State', '', '**Status:** In progress', ''].join('\n');
    const result = transitionCore(input, { kind: 'patch', patches: { status: 'Aborted' } }, deps);
    assert.deepStrictEqual(result.data && result.data.updated, ['status']);
    assert.ok(result.content.includes('**Status:** Aborted'), 'body Status must be the one that changed');
    assert.ok(/^status: executing$/m.test(result.content), 'frontmatter status key must never be touched by patchCore');
  });

  // D5 (boundary, extend): an empty patch is a true no-op — no write, both
  // report arrays empty.
  test('D5: an empty patch {} is a no-op — content returned verbatim, both arrays empty', () => {
    const input = '# State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'patch', patches: {} }, deps);
    assert.strictEqual(result.content, input);
    assert.deepStrictEqual(result.data && result.data.updated, []);
    assert.deepStrictEqual(result.data && result.data.failed, []);
  });

  // D6 (hostile): __proto__ / constructor as patch keys must not pollute
  // Object.prototype. `intent.patches` is built via JSON.parse (the shape a
  // real `state.patch` JSON payload takes) specifically because object-
  // literal syntax special-cases `__proto__` — JSON.parse does not, and is
  // the classic prototype-pollution vector this test must exercise for real.
  test('D6: __proto__ / constructor patch keys do not pollute Object.prototype', () => {
    const patches = JSON.parse('{"__proto__":"evil","constructor":"evil2"}');
    const input = '# State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'patch', patches }, deps);

    // Object.prototype itself must be untouched.
    assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(typeof ({}).constructor, 'function');

    // Behaves like any other unmatched field — no body line named
    // `__proto__` or `constructor` exists, so both are reported failed.
    assert.deepStrictEqual((result.data && result.data.updated) || [], []);
    assert.deepStrictEqual((result.data && result.data.failed || []).sort(), ['__proto__', 'constructor']);
    assert.strictEqual(result.content, input);
  });

  // D7 (independence, extend): updateCore strips frontmatter first — the correct
  // shape patchCore now matches — so a frontmatter-shaped `field` cannot reach
  // the YAML block by text replacement.
  //
  // NARROWED BY #3699, deliberately. The original assertion was "a
  // frontmatter-shaped field can NEVER reach the YAML block", which was a true
  // characterisation of updateCore when this test was written as an independence
  // guard for #3469 — but it is broader than the rule ADR-3408 actually states.
  // §8.3(b)'s invariant is "no transition core calls `stateReplaceField` on
  // unstripped content" (ADR-3408 line 318), and #3699's repair path honours it:
  // it strips frontmatter, edits the PARSED object, and re-serialises via
  // `reconstructFrontmatter` — it never runs the body-field text replacer over
  // YAML, which is the dangerous shape the rule exists to forbid.
  //
  // So the invariant is re-pinned here at the ADR's actual boundary, in both
  // directions, rather than deleted.
  test('D7: a frontmatter-shaped field cannot reach the YAML block while a body source exists', () => {
    // The body carries `Current Phase`, so the body IS the writable route and
    // the frontmatter key must be refused exactly as before.
    const input = [
      '---', 'current_phase: "3"', '---', '',
      '# State', '', '**Current Phase:** 3', '**Status:** Planning', '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'update', field: 'current_phase', value: '9' }, deps);
    assert.strictEqual(result.content, input, 'no write may occur through the frontmatter key');
    assert.strictEqual(result.data && result.data.updated, false);
    assert.ok(/^current_phase: "3"$/m.test(result.content));
  });

  test('D7b: the #3699 repair path is the ONLY way frontmatter is written, and it never text-replaces over YAML', () => {
    // Body source absent — the case-D repair shape. The write is permitted here,
    // and `updated` is the field name rather than `false`.
    const input = ['---', 'current_phase: "3"', '---', '', '# State', '', '**Status:** Planning', ''].join('\n');
    const result = transitionCore(input, { kind: 'update', field: 'current_phase', value: '9' }, deps);

    assert.strictEqual(result.data && result.data.updated, true);
    assert.strictEqual(result.data && result.data.wroteFrontmatter, true, 'the repair path must announce itself');
    assert.ok(/^current_phase: 9$/m.test(result.content), 'the frontmatter key carries the new value');

    // ADR-3408 §8.3(b) still holds: the body is untouched and the frontmatter
    // block was REBUILT from the parsed object, not text-patched in place. A
    // `stateReplaceField` pass over unstripped content would have left the rest
    // of the document's frontmatter formatting alone; re-serialisation is what
    // proves the parsed-object route was taken.
    assert.ok(result.content.includes('**Status:** Planning'), 'the body must be untouched');
    assert.ok(!/current_phase: "9"/.test(result.content), 'the value went through the YAML serialiser, not a text splice');
  });
});

// ADR-1769 Phase 7: update, prune, sync

describe('ADR-1769 Phase 7: update transition — single body field', () => {
  const deps = { clock: fixedClock };

  test('replaces a body field and reports updated:true', () => {
    const input = '# Project State\n\n**Status:** Planning\n**Current Plan:** 2\n';
    const result = transitionCore(input, { kind: 'update', field: 'Current Plan', value: '3' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.strictEqual(result.data && result.data.updated, true);
  });

  test('reports updated:false when the field is absent', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'update', field: 'Nonexistent', value: 'x' }, deps);
    assert.strictEqual(result.content, input);
    assert.strictEqual(result.data && result.data.updated, false);
  });

  test('preserves frontmatter across the body update', () => {
    const input = ['---', 'status: planning', '---', '', '# State', '', '**Status:** Planning', ''].join('\n');
    const result = transitionCore(input, { kind: 'update', field: 'Status', value: 'Paused' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Paused');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content));
  });
});

describe('ADR-1769 Phase 7: prune transition — section pruning', () => {
  const deps = { clock: fixedClock };

  test('archives Decisions entries at or below the cutoff phase', () => {
    const input = [
      '# Session State',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old',
      '- [Phase 3]: Older',
      '- [Phase 9]: Recent',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    const archived = (result.data && result.data.archivedSections) || [];
    assert.strictEqual(result.content.includes('[Phase 1]: Old'), false);
    assert.strictEqual(result.content.includes('[Phase 3]: Older'), false);
    assert.ok(result.content.includes('[Phase 9]: Recent'));
    const decisions = archived.find((s) => s.section === 'Decisions');
    assert.ok(decisions, 'Decisions archive entry must exist');
    assert.strictEqual(decisions.count, 2);
  });

  test('archives Performance Metrics table rows at or below the cutoff', () => {
    const input = [
      '# State',
      '',
      '## Performance Metrics',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '| --- | --- | --- | --- |',
      '| 1 | 4 | 8 | 2 |',
      '| 9 | 2 | 4 | 2 |',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    assert.ok(result.content.includes('| 9 | 2 | 4 | 2 |'), 'phase-9 row must remain');
    assert.strictEqual(result.content.includes('| 1 | 4 | 8 | 2 |'), false, 'phase-1 row must be archived');
    assert.ok(result.content.includes('| Phase | Plans |'), 'header row preserved');
  });

  test('no-op when nothing is old enough (totalPruned === 0)', () => {
    const input = '# State\n\n## Decisions\n\n- [Phase 9]: Recent\n';
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    assert.strictEqual(result.content, input);
    assert.strictEqual((result.data && result.data.totalPruned) || 0, 0);
  });
});

describe('ADR-1769 Phase 7: sync transition — body writes + #1761', () => {
  const deps = { clock: fixedClock };

  test('updates Total Plans in Phase + Progress bar + Last Activity when bounded', () => {
    const input = [
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Last Activity:** 2026-06-20',
      '**Progress:** [████░░░░░░] 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'sync', totalPlansInPhase: 5, percent: 60 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(/\[██████░░░░\] 60%/.test(result.content), 'Progress bar must be 60%');
  });

  test('#1761: leaves Progress untouched when percent is null (milestone unbounded)', () => {
    const input = [
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Last Activity:** 2026-06-20',
      '**Progress:** [█████░░░░░] 50%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'sync', totalPlansInPhase: 5, percent: null },
      deps,
    );
    // Total Plans + Last Activity still advance; Progress bar is left untouched.
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(/\[█████░░░░░\] 50%/.test(result.content), 'Progress bar must be unchanged when percent is null');
  });

  test('skips Total Plans write when totalPlansInPhase is null', () => {
    const input = '# Project State\n\n**Total Plans in Phase:** 2\n**Progress:** 40%\n';
    const result = transitionCore(input, { kind: 'sync', totalPlansInPhase: null, percent: null }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-1769 #1796: applyStatePreservation — table-driven post-sync consolidation
//
// Path A ("finish the consolidation"): the post-sync preservation block that
// lived inline in readModifyWriteStateMd (state.cts) is absorbed into the
// Transition Module as a pure, field-classification-table-driven function.
// Every preserved field (progress, status, stopped_at, current_phase_name) is
// governed by its FIELD_CLASSIFICATION row — one policy source, not three
// drifting encodings. Behavior is identical to the pre-consolidation block;
// these tests pin the table-driven contract. See issue #1796.
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-1769 #1796: applyStatePreservation — table-driven post-sync consolidation', () => {
  // Shared no-op deltas for tests that only exercise one field. #3468 folded
  // the three dedicated status/stopped_at/current_phase_name parameter pairs
  // into the single bodyDeltas channel every preserve-when-unchanged row now
  // uses — `neutralBodyDeltas()` (defined below, hoisted) wires every such
  // row to an "unchanged this write" delta so a test exercising ONE field
  // (e.g. progress) never trips the §8.2 unwired-row throw for another.
  const untouched = { bodyDeltas: neutralBodyDeltas() };

  test('progress: restores curated block when table=preserve-always and transition is not re-deriving (!resync)', () => {
    // Default behavior: wholesale curated restore. #3242 Bug A protection.
    const curated = { progress: { total_phases: 4, completed_phases: 3, percent: 75 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        ...untouched,
      }),
      postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } }  // disk-derived clobber,
    });
    assert.deepEqual(r.postFm.progress, { total_phases: 4, completed_phases: 3, percent: 75 });
    assert.equal(r.mutated, true);
  });

  test('#2440: deriveProgressKeys=true — total_plans takes derived value under !resync', () => {
    // The cmdStatePlannedPhase caller opts in via deriveProgressKeys. total_plans
    // and total_phases take the derived (post-sync) value; completed_plans and
    // completed_phases keep curated protection.
    const curated = { progress: { total_plans: 50, completed_plans: 50, total_phases: 2, completed_phases: 1, percent: 100 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        deriveProgressKeys: true,
        ...untouched,
      }),
      postFm: { progress: { total_plans: 64, completed_plans: 49, total_phases: 2, completed_phases: 1, percent: 77 } },
    });
    assert.equal(r.postFm.progress.total_plans, 64,
      'total_plans must take derived value (64) when deriveProgressKeys=true (#2440)');
    assert.equal(r.postFm.progress.completed_plans, 50,
      'completed_plans must keep curated value (50 > 49 triggers ratchet)');
    assert.equal(r.postFm.progress.total_phases, 2,
      'total_phases takes derived value (same as curated here — identity)');
    assert.equal(r.mutated, true);
  });

  test('#2440 boundary: deriveProgressKeys=true, total_plans derived == curated → identity', () => {
    const curated = { progress: { total_plans: 64, completed_plans: 49 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        deriveProgressKeys: true,
        ...untouched,
      }),
      postFm: { progress: { total_plans: 64, completed_plans: 49, percent: 77 } },
    });
    assert.equal(r.postFm.progress.total_plans, 64,
      'total_plans equality → derived value (identity)');
  });

  test('#2969: deriveProgressKeys=true — completed_plans ratchets UP when disk count exceeds curated (gap-closure plans completed)', () => {
    // Gap-closure scenario: a phase had 50 plans all summarized (completed_plans: 50),
    // then 4 gap-closure plans were added (total_plans -> 54) and all 4 got SUMMARYs.
    // Disk scan now counts 54 summaries. The curated completed_plans (50) must
    // ratchet UP to the derived value (54), not stay pinned at 50 — otherwise
    // completed_plans < total_plans forever even though every plan is summarized.
    const curated = { progress: { total_plans: 54, completed_plans: 50, total_phases: 2, completed_phases: 1, percent: 93 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        deriveProgressKeys: true,
        ...untouched,
      }),
      postFm: { progress: { total_plans: 54, completed_plans: 54, total_phases: 2, completed_phases: 1, percent: 100 } },
    });
    assert.equal(r.postFm.progress.total_plans, 54, 'total_plans takes derived value');
    assert.equal(r.postFm.progress.completed_plans, 54,
      'completed_plans must ratchet UP to derived (54 > curated 50 — gap-closure plans completed) (#2969)');
    assert.equal(r.postFm.progress.percent, 100,
      'percent must reflect the true completion fraction (54/54) (#2969)');
  });

  test('#2969 ratchet-down protection: deriveProgressKeys=true keeps curated when disk count < curated', () => {
    // The ratchet must only go UP. If the disk count is somehow LOWER than
    // curated (e.g. a SUMMARY was deleted), keep the curated value — do not
    // derive downward. (#3242 curated-progress protection, scoped to deriveProgressKeys.)
    const curated = { progress: { total_plans: 54, completed_plans: 50, percent: 93 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        deriveProgressKeys: true,
        ...untouched,
      }),
      postFm: { progress: { total_plans: 54, completed_plans: 47, percent: 87 } },
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'completed_plans must NOT derive downward (47 < curated 50) — ratchet-up only (#2969/#3242)');
  });

  test('#2969 body-only write protection: deriveProgressKeys absent keeps wholesale restore', () => {
    // state.update/patch (no deriveProgressKeys flag) must keep the full #3242
    // wholesale curated restore — completed_plans never moves for a body-only edit.
    const curated = { progress: { total_plans: 54, completed_plans: 50, percent: 93 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false, // deriveProgressKeys NOT set — body-only write path
        ...untouched,
      }),
      postFm: { progress: { total_plans: 54, completed_plans: 54, percent: 100 } },
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'body-only write must keep curated completed_plans (no deriveProgressKeys) (#2969/#3242)');
  });

  test('progress: NOT restored when transition re-derives from disk (resync=true) — sync/advancePlan/completePhase path', () => {
    const recomputed = { progress: { total_phases: 5, completed_phases: 1, percent: 20 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: {},
        resync: true,
        ...untouched,
      }),
      postFm: { ...recomputed },
    });
    assert.deepEqual(r.postFm.progress, { total_phases: 5, completed_phases: 1, percent: 20 });
    assert.equal(r.mutated, false);
  });

  test('status: preserves when body Status source is unchanged (preserve-when-unchanged) and snapshot holds a real status', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { status: 'completed' },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), status: { pre: 'Executing Phase 3', post: 'Executing Phase 3' } },
      }),
      postFm: { status: 'verifying' },
    });
    assert.equal(r.postFm.status, 'completed');
    assert.equal(r.mutated, true);
  });

  test('status: does NOT preserve when the body Status source line changed this write', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { status: 'completed' },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), status: { pre: 'Executing Phase 3', post: 'Completed Phase 3' } },
      }),
      postFm: { status: 'verifying' },
    });
    assert.equal(r.postFm.status, 'verifying');
    assert.equal(r.mutated, false);
  });

  test('current_phase_name: preserves curated value when body Phase source unchanged (preserve-when-unchanged, #3468 reclassified)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_phase_name: 'curated-name' },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '3' } },
      }),
      postFm: { current_phase_name: 'wrong-parenthetical-harvest' },
    });
    assert.equal(r.postFm.current_phase_name, 'curated-name');
    assert.equal(r.mutated, true);
  });

  test('returns mutated=false and untouched postFm when no preservation rule applies', () => {
    const postFm = { status: 'executing', progress: { percent: 10 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: {},
        resync: true,
        ...untouched,
      }),
      postFm: postFm,
    });
    assert.equal(r.mutated, false);
    assert.deepEqual(r.postFm, { status: 'executing', progress: { percent: 10 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3258: every FIELD_CLASSIFICATION row declaring a preservation policy must be
// honored by applyStatePreservation (the table-consuming pass). The table's own
// docstring promises "a policy change is a one-row table edit" — this invariant
// proves it: for every non-`derive` row, a minimal input where the
// declared policy would restore the snapshot value DOES restore it. Adding a
// new preservation row without an implementation branch makes this fail.
//
// Written FIRST and RED before the fix. Before the fix this fails for six rows:
// last_activity_desc, paused_at, current_phase, current_plan (preserve-when-
// unchanged, only approximated by the weaker #905 absent-fallback) and
// milestone, milestone_name (preserve-if-placeholder, enforced only by the
// #948/#2135 guard in syncStateFrontmatter). See issue #3258.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3258: applyStatePreservation honors every declared preservation row', () => {
  // Universal "body source unchanged this write" deltas. Every
  // preserve-when-unchanged probe reuses these so the delta condition (pre ===
  // post) is satisfied and the only variable is whether the branch exists.
  // #3468: current_phase_name folded into this same bodyDeltas channel
  // (reclassified from preserve-always to preserve-when-unchanged) — every
  // preserve-when-unchanged row must be present here or the §8.2 throw fires
  // for whichever row a probe does not itself supply.
  const SAME = { pre: 'unchanged-source', post: 'unchanged-source' };
  const unchangedBodyDeltas = {
    status: SAME,
    stopped_at: SAME,
    current_phase_name: SAME,
    paused_at: SAME,
    current_phase: SAME,
    current_plan: SAME,
    last_activity_desc: SAME,
  };

  // Per-policy probe. Returns whether applyStatePreservation restored the
  // field's snapshot value under an input crafted so the declared policy fires.
  function honored(field) {
    const cls = getFieldClassification(field);
    if (!cls) return false;
    const policy = cls.preservation;
    if (policy === 'derive') return true; // not a preservation policy

    const GOOD = 'preserved-by-table';
    const BAD = 'clobbered-by-derive';

    if (policy === 'preserve-always') {
      // Only `progress` carries this policy today (current_phase_name was
      // reclassified to preserve-when-unchanged in #3468 — ADR-3408 §8.1).
      const curated = { progress: { total_phases: 4, completed_phases: 3, percent: 75 } };
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: curated,
          resync: false,
          bodyDeltas: unchangedBodyDeltas,
        }),
        postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } },
      });
      return JSON.stringify(r.postFm.progress) === JSON.stringify(curated.progress);
    }

    if (policy === 'preserve-when-unchanged') {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { [field]: GOOD },
          resync: true,
          bodyDeltas: unchangedBodyDeltas,
        }),
        postFm: { [field]: BAD },
      });
      return r.postFm[field] === GOOD;
    }

    if (policy === 'preserve-if-placeholder') {
      // Derived name is the placeholder 'milestone'; snapshot holds a real
      // name+version. Mirrors the #948/#2135 contract: name restored to the
      // curated snapshot, version restored alongside it.
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { milestone: GOOD, milestone_name: GOOD },
          resync: true,
          bodyDeltas: unchangedBodyDeltas,
        }),
        postFm: { milestone: 'derived-version', milestone_name: 'milestone' },
      });
      return r.postFm[field] === GOOD;
    }

    return false;
  }

  test('every non-derive preservation row is honored (the one-row-table-edit contract)', () => {
    const expected = [];
    for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
      if (cls.preservation !== 'derive') {
        expected.push(field);
      }
    }
    const missing = expected.filter((f) => !honored(f));
    assert.deepEqual(
      missing,
      [],
      `applyStatePreservation does not honor these declared preservation rows (expected every ` +
        `non-derive row to restore its snapshot value): ${JSON.stringify(missing)}. ` +
        `Add a branch per ADR-1769 §4 so the table is the single policy source (#3258).`,
    );
  });

  const lastActivityDescChangedDeltas = {
    status: { pre: 'x', post: 'x' },
    stopped_at: { pre: 'x', post: 'x' },
    current_phase_name: { pre: 'x', post: 'x' },
    paused_at: { pre: 'x', post: 'x' },
    current_phase: { pre: 'x', post: 'x' },
    current_plan: { pre: 'x', post: 'x' },
    last_activity_desc: { pre: 'old description', post: 'new description from transition' }, // changed
  };

  test('a preserve-when-unchanged row with no wired bodyDeltas entry THROWS (ADR-3408 §8.2 — #3468 tightened from the pre-#3468 silent skip)', () => {
    // Pre-#3468 this row was a "sentinel" proving a missing implementation was
    // merely NOT restored (a silent `continue`). ADR-3408 §8.2 requires the
    // stronger invariant: an internal invariant violation — a declared row
    // the caller forgot to wire via bodyDeltas — THROWS with a structured
    // error, never a silent no-op indistinguishable from a correct skip.
    assert.throws(
      () => applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { current_plan: 'preserved-by-table' },
          resync: true,
          bodyDeltas: {},
        }),
        postFm: { current_plan: 'derived' },
      }),
      (err) => {
        assert.strictEqual(err.code, 'STATE_PRESERVATION_UNWIRED_ROW');
        assert.strictEqual(err.field, 'current_phase',
          'current_phase is the first preserve-when-unchanged field in FIELD_CLASSIFICATION\'s ' +
          'iteration order, so it is the field named by the throw when bodyDeltas is empty');
        return true;
      },
    );
  });

  // Per-field restore tests (clearer failure messages than the set-equality
  // invariant alone, and they document each row's declared semantics).

  test('last_activity_desc: preserve-when-unchanged restores snapshot when body source unchanged', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { last_activity_desc: 'authoritative description' },
        resync: true,
        bodyDeltas: { ...unchangedBodyDeltas },
      }),
      postFm: { last_activity_desc: 'stale derived description' },
    });
    assert.equal(r.postFm.last_activity_desc, 'authoritative description');
    assert.equal(r.mutated, true);
  });

  test('last_activity_desc: derived wins when the body source changed this write (no over-preservation)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { last_activity_desc: 'old description' },
        resync: true,
        bodyDeltas: { ...lastActivityDescChangedDeltas },
      }),
      postFm: { last_activity_desc: 'new description from transition' },
    });
    assert.equal(r.postFm.last_activity_desc, 'new description from transition');
    assert.equal(r.mutated, false);
  });

  test('paused_at: preserve-when-unchanged restores curated value over a stale-but-present derived value', () => {
    // Group 2: the declared #1230 delta heuristic beats the weaker #905
    // absent-fallback. Derived is PRESENT but stale; body source unchanged →
    // curated frontmatter value wins.
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { paused_at: '2026-02-02' },
        resync: true,
        bodyDeltas: { ...unchangedBodyDeltas },
      }),
      postFm: { paused_at: '2026-01-01' },
    });
    assert.equal(r.postFm.paused_at, '2026-02-02');
    assert.equal(r.mutated, true);
  });

  test('current_phase: preserve-when-unchanged restores curated value over a stale derived value', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_phase: '4' },
        resync: true,
        bodyDeltas: { ...unchangedBodyDeltas },
      }),
      postFm: { current_phase: '2' },
    });
    assert.equal(r.postFm.current_phase, '4');
    assert.equal(r.mutated, true);
  });

  test('current_plan: preserve-when-unchanged restores curated value over a stale derived value', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_plan: '5' },
        resync: true,
        bodyDeltas: { ...unchangedBodyDeltas },
      }),
      postFm: { current_plan: '3' },
    });
    assert.equal(r.postFm.current_plan, '5');
    assert.equal(r.mutated, true);
  });

  test('milestone / milestone_name: preserve-if-placeholder restores curated name when derived is placeholder', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { milestone: '0.1', milestone_name: 'Real Curated Name' },
        resync: true,
        bodyDeltas: { ...unchangedBodyDeltas },
      }),
      postFm: { milestone: '0.x', milestone_name: 'milestone' }  // placeholder derive,
    });
    assert.equal(r.postFm.milestone_name, 'Real Curated Name',
      'placeholder-derived milestone_name must yield to the curated snapshot (#948/#2135 contract)');
    assert.equal(r.postFm.milestone, '0.1',
      'milestone version must stay consistent with the preserved name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3468 (ADR-3408, Phase 1 test matrix 50-test-matrix.md, sections A/B/C):
// policy dispatch, the §8.2 unenforced-row invariant, and behavior identity
// across the refactor. Failing-first: several rows below are EXPECTED to
// fail against the current tree until the refactor lands (see each test's
// comment for which). Everything else characterizes behavior the refactor
// must preserve byte-for-byte.
// ─────────────────────────────────────────────────────────────────────────────

// Wires every currently-declared preserve-when-unchanged field with a neutral
// "unchanged this write" delta, so a test probing ONE field never trips over
// another field being unwired — forward-compatible with both today's tree
// (where an unwired row silently `continue`s) and the post-refactor tree
// (where an unwired row throws per §8.2 / matrix row B1).
function neutralBodyDeltas() {
  const deltas = {};
  for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
    if (cls.preservation === 'preserve-when-unchanged') {
      deltas[field] = { pre: 'unchanged-source', post: 'unchanged-source' };
    }
  }
  return deltas;
}

// #3468 folded status/stopped_at/current_phase_name's three dedicated
// pre/post parameter pairs into the single bodyDeltas channel and deleted
// them from StatePreservationInput — applyStatePreservation no longer reads
// these properties at all. Kept (rather than stripped from every call site
// below) as an inert, harmless spread: StatePreservationInput is a TypeScript
// type these plain-JS tests are not checked against, so an extra own
// property is silently ignored at runtime, and removing it from ~20 call
// sites would be pure churn with no behavior change. neutralBodyDeltas()
// already supplies the real (bodyDeltas-based) no-op deltas these fields
// need post-refactor.
const dedicatedNoop = {
  preBodyStatus: 'x', postBodyStatus: 'x',
  preBodyStoppedAt: 'x', postBodyStoppedAt: 'x',
  preBodyPhaseSource: 'x', postBodyPhaseSource: 'x',
};

describe('#3468 matrix A: executor policy dispatch (ADR-3408 §8.1) — new/boundary/hostile rows', () => {
  test('A3: preserve-when-unchanged — an empty-string snapshot is not restored', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_plan: '' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { current_plan: 'derived' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'derived');
    assert.equal(r.mutated, false);
  });

  // A4 (matrix: "likely gap today"): a whitespace-only snapshot passes the
  // current `.length > 0` check (3 > 0) and DOES get restored today. The
  // required behavior is skip. This is expected to FAIL against the current
  // tree until the refactor tightens the guard.
  test('A4: preserve-when-unchanged — a whitespace-only snapshot is not restored (".length > 0" is not enough)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_plan: '   ' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { current_plan: 'derived' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'derived',
      'a whitespace-only snapshot must not be treated as a real curated value');
    assert.equal(r.mutated, false);
  });

  test('A5: preserve-when-unchanged — a non-string snapshot is ignored (no throw)', () => {
    for (const snapshot of [42, true, null, { nested: 1 }, undefined]) {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { current_plan: snapshot },
          resync: true,
          bodyDeltas: neutralBodyDeltas(),
        }),
        postFm: { current_plan: 'derived' },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm.current_plan, 'derived', `snapshot=${JSON.stringify(snapshot)} must not be restored`);
    }
  });

  test('A6: preserve-when-unchanged — no-op when postFm already equals the snapshot', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_plan: 'same-value' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { current_plan: 'same-value' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'same-value');
    assert.equal(r.mutated, false);
  });

  test('A7: preserve-when-unchanged — a postFm missing the key entirely is restored (undefined !== snapshot)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_plan: 'curated' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: {}, // key absent entirely
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'curated');
    assert.equal(r.mutated, true);
  });

  test('A8: status — the "unknown" sentinel snapshot is never restored', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { status: 'unknown' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { status: 'verifying' },
      preBodyStatus: 'x',
      postBodyStatus: 'x',
      preBodyStoppedAt: 'x',
      postBodyStoppedAt: 'x',
      preBodyPhaseSource: 'x',
      postBodyPhaseSource: 'x',
    });
    assert.equal(r.postFm.status, 'verifying');
    assert.equal(r.mutated, false);
  });

  test('A9: status — the "unknown" sentinel guard is case-sensitive ("Unknown" is a real value, restored)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { status: 'Unknown' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { status: 'verifying' },
      preBodyStatus: 'x',
      postBodyStatus: 'x',
      preBodyStoppedAt: 'x',
      postBodyStoppedAt: 'x',
      preBodyPhaseSource: 'x',
      postBodyPhaseSource: 'x',
    });
    assert.equal(r.postFm.status, 'Unknown',
      'the sentinel is an exact-match on the lowercase literal "unknown" — a case variant is a real value');
    assert.equal(r.mutated, true);
  });

  test('A12: preserve-always progress — preFm===null under !resync does not throw (skip)', () => {
    assert.doesNotThrow(() => {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: {},
          resync: false,
          bodyDeltas: neutralBodyDeltas(),
        }),
        postFm: { progress: { total_phases: 5, completed_phases: 1, percent: 20 } },
        ...dedicatedNoop,
      });
      assert.deepEqual(r.postFm.progress, { total_phases: 5, completed_phases: 1, percent: 20 });
      assert.equal(r.mutated, false);
    });
  });

  test('A14: deriveProgressKeys — derived completed_plans === curated keeps curated (limit: ">" not ">=", #2969)', () => {
    const curated = { progress: { total_plans: 10, completed_plans: 7, percent: 70 } };
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        deriveProgressKeys: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { progress: { total_plans: 10, completed_plans: 7, percent: 70 } }, // derived === curated
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.progress.completed_plans, 7,
      'equal counts (derived === curated) must keep curated — the ratchet is ">" not ">="');
  });

  test('A18: preserve-if-placeholder — punctuation-led derived names are rejected for every delimiter', () => {
    for (const derived of ['— Foo', ': Foo', '-Foo']) {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { milestone: '1.0', milestone_name: 'Real Curated Name' },
          resync: true,
          bodyDeltas: neutralBodyDeltas(),
        }),
        postFm: { milestone: '1.1', milestone_name: derived },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm.milestone_name, 'Real Curated Name',
        `punctuation-led derived name ${JSON.stringify(derived)} must be rejected`);
    }
  });

  test('A19: preserve-if-placeholder — an empty-string derived name is rejected (restored)', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { milestone: '1.0', milestone_name: 'Real Curated Name' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { milestone: '1.1', milestone_name: '' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.milestone_name, 'Real Curated Name');
  });

  test('A20: preserve-if-placeholder — a placeholder snapshot is not restored over a placeholder derived value', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { milestone: '1.0', milestone_name: 'milestone' }, // snapshot IS the placeholder
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { milestone: '1.1', milestone_name: 'milestone' }, // derived is also the placeholder
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.milestone_name, 'milestone', 'nothing better to restore — value passes through unchanged');
    assert.equal(r.postFm.milestone, '1.1', 'milestone version passes through unchanged alongside it');
  });

  test('A21: preserve-if-placeholder — a real, different derived name wins over the curated snapshot', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { milestone: '1.0', milestone_name: 'Old Curated Name' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { milestone: '2.0', milestone_name: 'New Real Milestone Name' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.milestone_name, 'New Real Milestone Name');
    assert.equal(r.postFm.milestone, '2.0');
  });

  // A22 (design 40-design.md row 17 / matrix "new — row 17"): a `derive` row
  // must be an explicit no-op — untouched, no throw, mutated unaffected.
  // NOTE: as a black-box behavioral probe against the public
  // applyStatePreservation API (the only seam this test file can drive),
  // this currently ALREADY PASSES — today's loop filters every field to
  // `cls.preservation === 'preserve-when-unchanged'` before doing anything,
  // so a `derive` row is skipped by omission rather than by an explicit
  // branch. The matrix's "no branch exists" is a source-structure claim
  // (§8.1's "exactly one executor per policy") that this black-box test
  // cannot distinguish from "skipped by omission" — see report.
  test('A22: derive rows (last_updated, state_head, gsd_state_version, last_activity) are an explicit no-op', () => {
    for (const field of ['last_updated', 'state_head', 'gsd_state_version', 'last_activity']) {
      assert.doesNotThrow(() => {
        const r = applyStatePreservation({
          transaction: openStateTransaction({
            snapshot: { [field]: 'curated-value' },
            resync: true,
            bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
          }),
          postFm: { [field]: 'freshly-derived-value' },
          ...dedicatedNoop,
        });
        assert.equal(r.postFm[field], 'freshly-derived-value',
          `${field}: a derive row always takes the freshly-derived (postFm) value`);
      });
    }
  });

  test('A23: a field with no FIELD_CLASSIFICATION row passes through untouched', () => {
    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { totally_unclassified_field: 'curated' },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), totally_unclassified_field: { pre: 'x', post: 'y' } },
      }),
      postFm: { totally_unclassified_field: 'derived' },
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.totally_unclassified_field, 'derived');
    assert.equal(r.mutated, false);
  });

  test('A24: prototype-pollution — __proto__ / constructor / toString never resolve to inherited classifications', () => {
    for (const hostileKey of ['__proto__', 'constructor', 'toString']) {
      assert.strictEqual(getFieldClassification(hostileKey), null,
        `${hostileKey} must not resolve to an inherited Object member`);
    }
    // applyStatePreservation itself must not crash or misbehave when a
    // hostile field name rides along in postFm/preFmSnapshot/bodyDeltas.
    // Computed keys (not literal `__proto__:`) create genuine OWN properties
    // instead of mutating the object's prototype.
    assert.doesNotThrow(() => {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { ['__proto__']: 'x', ['constructor']: 'y', ['toString']: 'z' },
          resync: true,
          bodyDeltas: {
              ...neutralBodyDeltas(),
              ['__proto__']: { pre: 'x', post: 'y' },
              ['constructor']: { pre: 'x', post: 'y' },
              ['toString']: { pre: 'x', post: 'y' },
            },
        }),
        postFm: { ['__proto__']: 'a', ['constructor']: 'b', ['toString']: 'c' },
        ...dedicatedNoop,
      });
      assert.equal(typeof r.postFm, 'object');
      assert.equal(typeof r.mutated, 'boolean');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3468 matrix B: the §8.2 unenforced-row invariant.
//
// Structured error shape THIS TASK REQUIRES THE IMPLEMENTATION TO PROVIDE
// (CONTRIBUTING.md § Prohibited: Raw Text Matching — the thrown error must
// carry typed properties, never asserted via message-prose matching):
//   err.code === 'STATE_PRESERVATION_UNWIRED_ROW'
//   err.field === '<the FIELD_CLASSIFICATION key that was not wired>'
//
// B1-B3 are EXPECTED TO FAIL against the current tree: today's loop at
// src/state-transition.cts:314 does `if (!delta) continue;` — a silent skip,
// not a throw. This is the exact defect §8.2 requires fixing.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3468 matrix B: an unenforced preserve-when-unchanged row (ADR-3408 §8.2)', () => {
  test('B1: a declared preserve-when-unchanged row missing from bodyDeltas throws, naming the field', () => {
    const bodyDeltas = neutralBodyDeltas();
    delete bodyDeltas.current_plan; // the ONLY unwired row
    assert.throws(
      () => applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { current_plan: 'curated' },
          resync: true,
          bodyDeltas: bodyDeltas,
        }),
        postFm: { current_plan: 'derived' },
        ...dedicatedNoop,
      }),
      (err) => {
        assert.strictEqual(err.code, 'STATE_PRESERVATION_UNWIRED_ROW');
        assert.strictEqual(err.field, 'current_plan');
        return true;
      },
    );
  });

  test('B2: bodyDeltas entirely absent throws, naming the first unwired row', () => {
    assert.throws(
      () => applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: {},
          resync: true,
          // bodyDeltas omitted entirely
        }),
        postFm: {},
        ...dedicatedNoop,
      }),
      (err) => {
        assert.strictEqual(err.code, 'STATE_PRESERVATION_UNWIRED_ROW');
        // current_phase is the first preserve-when-unchanged field in
        // FIELD_CLASSIFICATION's insertion order — before current_phase_name,
        // current_plan, status, stopped_at, paused_at, last_activity_desc,
        // all of which share the same loop post-#3468 (no field stays on a
        // dedicated channel any more).
        assert.strictEqual(err.field, 'current_phase');
        return true;
      },
    );
  });

  test('B3: bodyDeltas present but {} throws, naming the first unwired row', () => {
    assert.throws(
      () => applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: {},
          resync: true,
          bodyDeltas: {},
        }),
        postFm: {},
        ...dedicatedNoop,
      }),
      (err) => {
        assert.strictEqual(err.code, 'STATE_PRESERVATION_UNWIRED_ROW');
        assert.strictEqual(err.field, 'current_phase');
        return true;
      },
    );
  });

  test('B4: a delta shaped {pre:null,post:null} is treated as WIRED, not missing (the boundary that separates B1 from A1)', () => {
    const bodyDeltas = {
      ...neutralBodyDeltas(),
      current_phase: { pre: null, post: null },
    };
    assert.doesNotThrow(() => {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: {}, // no snapshot — skip is a legitimate, non-throwing outcome
          resync: true,
          bodyDeltas: bodyDeltas,
        }),
        postFm: { current_phase: 'derived' },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm.current_phase, 'derived');
    });
  });

  test('B5: a partially-shaped delta ({post} with no pre key) does not throw — treated as wired', () => {
    const bodyDeltas = {
      ...neutralBodyDeltas(),
      current_phase: { post: 'x' }, // `pre` key entirely absent
    };
    assert.doesNotThrow(() => {
      applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { current_phase: 'curated' },
          resync: true,
          bodyDeltas: bodyDeltas,
        }),
        postFm: { current_phase: 'derived' },
        ...dedicatedNoop,
      });
    });
  });

  test('B6: only preserve-when-unchanged rows require wiring — derive/preserve-always/preserve-if-placeholder do not', () => {
    // Every preserve-when-unchanged row IS wired here; last_updated (derive),
    // progress (preserve-always), and milestone_name (preserve-if-placeholder)
    // are deliberately absent from bodyDeltas and must not trigger the throw.
    assert.doesNotThrow(() => {
      applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: {},
          resync: true,
          bodyDeltas: neutralBodyDeltas(),
        }),
        postFm: {},
        ...dedicatedNoop,
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3468 matrix C: behavior identity across the refactor (ADR-3408 §8.1).
//
// Literal, pinned expected values — not derived from a shared helper — per
// 40-design.md's "Known limits": the reclassification of current_phase_name
// is behavior-preserving by design, so the existing suite staying green
// proves nothing; only a pinned before/after comparison catches a silent
// drift (CONTRIBUTING.md § Fixture provenance #2371).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3468 matrix C1/C2: identity across the refactor — pinned literal outputs', () => {
  const GOOD = 'preserved-by-table';
  const BAD = 'clobbered-by-derive';

  // Four of the seven preserve-when-unchanged rows, pinned generically here;
  // status/stopped_at get their own pinned test above (their 'unknown'
  // sentinel guard has no analogue in these four), and current_phase_name
  // gets its own dedicated C2 test below (it needs BOTH an unchanged AND a
  // changed delta for the same field, which this generic loop cannot express).
  const LOOP_PWU_FIELDS = ['current_phase', 'current_plan', 'paused_at', 'last_activity_desc'];

  test('C1: shared preserve-when-unchanged loop — delta unchanged restores the snapshot (pinned)', () => {
    for (const field of LOOP_PWU_FIELDS) {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { [field]: GOOD },
          resync: true,
          bodyDeltas: neutralBodyDeltas(),
        }),
        postFm: { [field]: BAD },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm[field], GOOD, `${field}: pinned identity — restore-when-unchanged`);
    }
  });

  test('C1: shared preserve-when-unchanged loop — delta changed lets derived win (pinned)', () => {
    for (const field of LOOP_PWU_FIELDS) {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { [field]: GOOD },
          resync: true,
          bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
        }),
        postFm: { [field]: BAD },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm[field], BAD, `${field}: pinned identity — derived wins when body source changed`);
    }
  });

  test('C1: status / stopped_at (pinned)', () => {
    const rStatus = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { status: GOOD },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { status: BAD },
    });
    assert.equal(rStatus.postFm.status, GOOD);

    const rStopped = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { stopped_at: GOOD },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { stopped_at: BAD },
    });
    assert.equal(rStopped.postFm.stopped_at, GOOD);
  });

  test('C1: preserve-always progress and preserve-if-placeholder milestone/milestone_name (pinned)', () => {
    const curated = { progress: { total_phases: 4, completed_phases: 3, percent: 75 } };
    const rProgress = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curated,
        resync: false,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } },
      ...dedicatedNoop,
    });
    assert.deepEqual(rProgress.postFm.progress, curated.progress);

    const rMilestone = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { milestone: '1.0', milestone_name: GOOD },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
      }),
      postFm: { milestone: '1.1', milestone_name: 'milestone' },
      ...dedicatedNoop,
    });
    assert.equal(rMilestone.postFm.milestone_name, GOOD);
  });

  test('C1: derive-classified fields pass through untouched regardless of snapshot (pinned)', () => {
    for (const field of ['gsd_state_version', 'last_updated', 'last_activity', 'state_head']) {
      const r = applyStatePreservation({
        transaction: openStateTransaction({
          snapshot: { [field]: GOOD },
          resync: true,
          bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
        }),
        postFm: { [field]: BAD },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm[field], BAD, `${field}: derive rows always take the derived (postFm) value`);
    }
  });

  // C2: current_phase_name's row is reclassified preserve-always →
  // preserve-when-unchanged (#3468, ADR-3408 §8.1 amendment) as a
  // BEHAVIOR-PRESERVING change (40-design.md). Both outcomes are pinned
  // literally so a post-refactor drift is caught even though the existing
  // suite staying green would prove nothing. The delta now travels through
  // bodyDeltas.current_phase_name (folded from the pre-#3468 dedicated
  // preBodyPhaseSource/postBodyPhaseSource parameter pair, which #3468
  // deleted from StatePreservationInput) rather than through
  // neutralBodyDeltas()'s generic "unchanged" default, since this test needs
  // to drive both an unchanged AND a changed delta for the SAME field.
  test('C2: current_phase_name (reclassified preserve-always → preserve-when-unchanged) — pinned outputs', () => {
    const rEqual = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_phase_name: GOOD },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '3' } },
      }),
      postFm: { current_phase_name: BAD },
    });
    assert.equal(rEqual.postFm.current_phase_name, GOOD,
      'reclassification must not change this: unchanged body Phase source still restores the curated name');
    assert.equal(rEqual.mutated, true);

    const rDiffer = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: { current_phase_name: GOOD },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '4' } },
      }),
      postFm: { current_phase_name: BAD },
    });
    assert.equal(rDiffer.postFm.current_phase_name, BAD,
      'reclassification must not change this: changed body Phase source still lets derived win');
    assert.equal(rDiffer.mutated, false);
  });
});

describe('#3468 matrix C3: executor dispatch is a pure function of the row policy (property)', () => {
  // Every preserve-when-unchanged field EXCEPT status/stopped_at — excluded
  // because status carries the 'unknown' sentinel guard (a field-specific
  // exception this generic property does not model) and stopped_at is its
  // paired dedicated-channel sibling in the pre-#3468 design this comment
  // originally described; both get their own pinned coverage in C1 above.
  const LOOP_PWU_FIELDS = Object.keys(FIELD_CLASSIFICATION).filter((f) => {
    const cls = getFieldClassification(f);
    return cls !== null && cls.preservation === 'preserve-when-unchanged' && f !== 'status' && f !== 'stopped_at';
  });

  test('property: restore fires iff (wired AND non-empty snapshot AND unchanged delta AND postFm differs)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LOOP_PWU_FIELDS),
        fc.string({ maxLength: 20 }),
        fc.boolean(),
        fc.string({ maxLength: 20 }),
        fc.boolean(),
        fc.boolean(),
        (field, snapshotValue, snapshotPresent, postFmValue, deltaChanged, resync) => {
          const preFmSnapshot = snapshotPresent ? { [field]: snapshotValue } : {};
          const postFm = { [field]: postFmValue };
          const delta = { pre: 'source', post: deltaChanged ? 'source-changed' : 'source' };
          const r = applyStatePreservation({
            transaction: openStateTransaction({
              snapshot: preFmSnapshot,
              resync: resync,
              bodyDeltas: { ...neutralBodyDeltas(), [field]: delta },
            }),
            postFm: postFm,
            ...dedicatedNoop,
          });

          const snapshotUsable = snapshotPresent && snapshotValue.length > 0;
          const alreadyCorrect = postFmValue === snapshotValue;
          const expectRestore = snapshotUsable && !deltaChanged && !alreadyCorrect;

          const expectedValue = expectRestore ? snapshotValue : postFmValue;
          if (r.postFm[field] !== expectedValue || r.mutated !== expectRestore) {
            throw new Error(
              `dispatch mismatch: field=${field} snapshotPresent=${snapshotPresent} ` +
              `snapshotValue=${JSON.stringify(snapshotValue)} postFmValue=${JSON.stringify(postFmValue)} ` +
              `deltaChanged=${deltaChanged} resync=${resync} expectRestore=${expectRestore} ` +
              `got postFm[field]=${JSON.stringify(r.postFm[field])} mutated=${r.mutated}`,
            );
          }
          return true;
        },
      ),
      { seed: 3468, numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-21-state-md-template-frontmatter.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-21-state-md-template-frontmatter (consolidation epic #1969 B8 #1977)", () => {
/**
 * Regression guard — Bug #21
 *
 * Both STATE.md template files must include a YAML frontmatter block in their
 * "File Template" section so that an AI agent creating .planning/STATE.md from
 * the template produces a file that frontmatter consumers can read immediately
 * (before the first `state.*` mutation calls syncStateFrontmatter).
 *
 * Prior to the fix, the template's File Template section began with
 * `# Project State` (no frontmatter), leaving the init→first-write window
 * without `gsd_state_version`, `status`, or `progress` keys.
 *
 * Acceptance criteria:
 * 1. The template body extracted from each state.md file's File Template code
 *    block must begin with `---`.
 * 2. The frontmatter must contain at minimum: `gsd_state_version` and `status`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const TEMPLATE_PATHS = [
  path.join(REPO_ROOT, 'gsd-core', 'templates', 'state.md'),
];

/**
 * Extract the content of the first ```markdown ... ``` code block from a
 * template file. Returns the raw string (including any leading/trailing
 * whitespace within the block).
 *
 * @param {string} fileContent - Full text of the template file.
 * @returns {string} The extracted code block body.
 */
function extractFileTemplate(fileContent) {
  // Deliberately independent of the generator's own fence-handling — this is
  // the bug #21 regression guard that must not share the seam
  // gen-state-md-docs.cjs uses (see tests/gen-state-md-docs.test.cjs).
  const match = fileContent.match(/```markdown\r?\n([\s\S]*?)```/); // allow-adhoc-markdown: deliberately independent of the generator's fence-handling — regresses bug #21
  assert.ok(match, 'No ```markdown code block found in template file');
  return match[1];
}

/**
 * Minimal YAML frontmatter parser: returns the set of top-level keys present
 * in the first --- ... --- block at the start of `text`. Does not parse nested
 * keys — list-valued fields (e.g. `tags: [a, b]`) are recorded only by their
 * key name, not their value. Returns an empty Set when the text has no frontmatter.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function parseFrontmatterKeys(text) {
  const keys = new Set();
  if (!text.trimStart().startsWith('---')) return keys;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '---') { inBlock = true; continue; }
      break; // frontmatter must be at the very start
    }
    if (trimmed === '---') break; // end of block
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      keys.add(trimmed.slice(0, colonIdx).trim());
    }
  }
  return keys;
}

/**
 * Minimal YAML frontmatter parser: returns a plain object of top-level keys
 * and their scalar or nested-object values from the first --- ... --- block.
 * Handles one level of indented nesting (e.g. progress.total_plans).
 * Does not handle YAML lists or multi-line values.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseFrontmatter(text) {
  const result = {};
  if (!text.trimStart().startsWith('---')) return result;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let currentKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '---') { inBlock = true; continue; }
      break;
    }
    if (trimmed === '---') break;
    // Detect indented (nested) line: starts with whitespace
    if (line.match(/^\s+\S/) && currentKey !== null) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const subKey = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();
        const numVal = Number(rawVal);
        if (typeof result[currentKey] !== 'object') result[currentKey] = {};
        result[currentKey][subKey] = rawVal === '' ? null : (isNaN(numVal) ? rawVal : numVal);
      }
    } else {
      currentKey = null;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();
        if (rawVal === '') {
          result[key] = {};
          currentKey = key;
        } else {
          const numVal = Number(rawVal);
          result[key] = isNaN(numVal) ? rawVal.replace(/^'|'$/g, '') : numVal;
          currentKey = null;
        }
      }
    }
  }
  return result;
}

describe('bug #21 — STATE.md template must carry YAML frontmatter', () => {
  for (const templatePath of TEMPLATE_PATHS) {
    const label = path.relative(REPO_ROOT, templatePath);

    test(`${label} — File Template block starts with frontmatter`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);

      // The template body must open with a YAML frontmatter delimiter.
      assert.ok(
        body.trimStart().startsWith('---'),
        `${label}: File Template must start with '---' (YAML frontmatter), ` +
        `but starts with: ${JSON.stringify(body.slice(0, 60))}`,
      );
    });

    test(`${label} — frontmatter contains gsd_state_version`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('gsd_state_version'),
        `${label}: frontmatter must include 'gsd_state_version', found keys: ${[...keys].join(', ')}`,
      );
    });

    test(`${label} — frontmatter contains status`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('status'),
        `${label}: frontmatter must include 'status', found keys: ${[...keys].join(', ')}`,
      );
    });

    test(`${label} — progress sub-schema has zeroed total_plans and completed_plans`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const fm = parseFrontmatter(body.trimStart());

      assert.ok(
        fm.progress && typeof fm.progress === 'object',
        `${label}: frontmatter must include a 'progress' sub-object`,
      );
      assert.strictEqual(
        fm.progress.total_plans,
        0,
        `${label}: progress.total_plans must be 0 in the template`,
      );
      assert.strictEqual(
        fm.progress.completed_plans,
        0,
        `${label}: progress.completed_plans must be 0 in the template`,
      );
    });
  }

});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #3118: sliceCurrentPositionSection — locator characterization tests.
// ────────────────────────────────────────────────────────────────────────

describe('sliceCurrentPositionSection (#3118)', () => {
  test('slices the section up to the following heading', () => {
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 (Test Phase) — EXECUTING',
      '',
      '## Accumulated Context',
      '',
      '- A decision worth keeping.',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('Phase: 3 (Test Phase) — EXECUTING'));
    assert.ok(!result.includes('A decision worth keeping'));
  });

  test('slices to end of document for a trailing section', () => {
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '- Earlier decision.',
      '',
      '## Current Position',
      '',
      'Phase: 5 (Final Phase) — EXECUTING',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('Phase: 5 (Final Phase) — EXECUTING'));
  });

  test('returns null when the section is absent', () => {
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '- Some decision.',
      '',
      '## Deferred Items',
      '',
      '- Something deferred.',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('matches the heading case- and space-insensitively', () => {
    const body = [
      '# Project State',
      '',
      '##  CURRENT   POSITION',
      '',
      'Phase: 2 — EXECUTING',
      '',
    ].join('\n');
    assert.notStrictEqual(sliceCurrentPositionSection(body), null);
  });

  test('ignores a Current Position heading inside a code fence', () => {
    // The locator is fence-aware via `tokenizeHeadings` — a `##` line inside
    // a ``` fence is not a real heading, so this document has zero *real*
    // Current Position headings.
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '```markdown',
      '## Current Position',
      '',
      'Phase: 9 — should not be seen',
      '```',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('distinguishes an empty section from an absent one', () => {
    // An empty section and an absent one are different answers, and a caller
    // that folds them together reintroduces the collapse this epic removes.
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '## Accumulated Context',
      '',
      '- A decision.',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.strictEqual(typeof result, 'string');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.trim(), '');
  });

  test('does not match an H3 Current Position', () => {
    const body = [
      '# Project State',
      '',
      '### Current Position',
      '',
      'Phase: 2 — EXECUTING',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('slices the first Current Position when the document has two', () => {
    // `findIndex` picks the first heading match and nothing pinned that
    // behavior down before this test.
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — FIRST OCCURRENCE',
      '',
      '## Accumulated Context',
      '',
      '- unrelated',
      '',
      '## Current Position',
      '',
      'Phase: 9 — SECOND OCCURRENCE',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('FIRST OCCURRENCE'));
    assert.ok(!result.includes('SECOND OCCURRENCE'));
  });

  test('returns null for an empty document', () => {
    assert.strictEqual(sliceCurrentPositionSection(''), null);
  });

  test('slices a CRLF document identically', () => {
    // Only `\n` in a regex/split is the recurring CRLF defect class in this
    // repo (#1658 and successors) — verify the CRLF fixture, normalized back
    // to LF, matches the LF fixture's result byte-for-byte.
    const lines = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 (Test Phase) — EXECUTING',
      '',
      '## Accumulated Context',
      '',
      '- A decision worth keeping.',
      '',
    ];
    const lfResult = sliceCurrentPositionSection(lines.join('\n'));
    const crlfResult = sliceCurrentPositionSection(lines.join('\r\n'));
    // Strict form (#3118): normalize CRLF->LF and require exact equality with
    // the LF result. The looser `.replace(/\r/g, '')` form (previously used
    // here) strips ALL `\r` bytes including a stray unpaired trailing `\r`
    // left by the pre-fix `end = hs[j].offset - 1` slice — that loose
    // assertion is what let the CRLF-slice-defect ship undetected.
    assert.strictEqual(crlfResult.replace(/\r\n/g, '\n'), lfResult);
  });

  test('returns an empty string when the section is empty and the next heading follows immediately', () => {
    const body = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.strictEqual(result, '');
  });

  test('does not duplicate bytes when a transition mutates an empty adjacent section', () => {
    // Regression for #3118 review MAJOR: `locateCurrentPosition`'s newline
    // walk-back could land `end` before `start` when the section is empty
    // and the next heading follows with no blank line between. Every
    // mutator's `body.slice(0, start) + sectionBody + body.slice(end)`
    // reassembly then duplicated the bytes in the inverted `[end, start)`
    // range — a spurious blank line (LF) or `\r\n` (CRLF) inserted into
    // STATE.md on every transition.
    const lfBody = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\n');
    const lfResult = transitionCore(
      lfBody,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: null, planCount: null },
      { clock: fixedClock },
    );
    assert.ok(
      !lfResult.content.includes('## Current Position\n\n## Next Section'),
      `expected no inserted blank line; got ${JSON.stringify(lfResult.content)}`,
    );
    assert.strictEqual(
      lfResult.content,
      '# STATE\n\n## Current Position\n## Next Section\ncontent',
    );
    assert.strictEqual(lfResult.content.length, lfBody.length);

    const crlfBody = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\r\n');
    const crlfResult = transitionCore(
      crlfBody,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: null, planCount: null },
      { clock: fixedClock },
    );
    assert.ok(
      !crlfResult.content.includes('## Current Position\r\n\r\n## Next Section'),
      `expected no inserted CRLF; got ${JSON.stringify(crlfResult.content)}`,
    );
    assert.strictEqual(
      crlfResult.content,
      '# STATE\r\n\r\n## Current Position\r\n## Next Section\r\ncontent',
    );
    assert.strictEqual(crlfResult.content.length, crlfBody.length);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3118: deps.progressProvider is a required StateTransitionDeps field with
// 33 supply sites and zero call sites, and is being removed. Prove it
// behaviorally: no transition ever invokes it.
// ────────────────────────────────────────────────────────────────────────

describe('state transitions do not consult a progress provider (#3118)', () => {
  test('no transition invokes deps.progressProvider', () => {
    // An exploding stub is the behavioral form of "this field is inert";
    // asserting the declaration is absent would be source-grep theater.
    const exploding = () => { throw new Error('progressProvider must never be called'); };
    const clock = fixedClock;

    assert.doesNotThrow(() => transitionCore(
      firstTimeBody(),
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Current Plan:** 02',
        '**Total Plans in Phase:** 05',
        '**Status:** Executing Phase 3',
        '**Last Activity:** 2026-06-26',
        '',
        '## Current Position',
        '',
        'Plan: 2 of 5',
        'Status: Executing Phase 3',
        '',
      ].join('\n'),
      { kind: 'advancePlan' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: 'Design Phase', isLastPhase: false, planCount: 3, summaryCount: 3 },
      { clock, progressProvider: exploding, roadmapProvider: () => ROADMAP_3_OF_5 },
    ));

    assert.doesNotThrow(() => transitionCore(
      plannedPhaseBody(),
      { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 },
      { clock, progressProvider: exploding },
    ));

    const milestoneBody = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Old Milestone',
      'status: executing',
      'current_phase: "3"',
      'progress:',
      '  total_phases: 5',
      '  completed_phases: 2',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — EXECUTING',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid-flight',
      '',
    ].join('\n');
    assert.doesNotThrow(() => transitionCore(
      milestoneBody,
      { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' },
      { clock, progressProvider: exploding },
    ));

    const preCloseBody = [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid-flight',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Plan: 2 of 3',
      'Status: Executing Phase 5',
      'Last activity: 2026-06-20 — running',
      '',
      '## Operator Next Steps',
      '',
      '- Re-run /gsd:complete-milestone v1.0',
      '',
    ].join('\n');
    assert.doesNotThrow(() => transitionCore(
      preCloseBody,
      { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd:new-milestone' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Status:** Planning',
        '**Current Plan:** 2',
        '**Total Plans in Phase:** 5',
        '',
      ].join('\n'),
      { kind: 'patch', patches: { Status: 'Paused', 'Current Plan': '3' } },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      '# Project State\n\n**Status:** Planning\n**Current Plan:** 2\n',
      { kind: 'update', field: 'Current Plan', value: '3' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Session State',
        '',
        '## Decisions',
        '',
        '- [Phase 1]: Old',
        '- [Phase 3]: Older',
        '- [Phase 9]: Recent',
        '',
      ].join('\n'),
      { kind: 'prune', cutoff: 7 },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Total Plans in Phase:** 2',
        '**Last Activity:** 2026-06-20',
        '**Progress:** [████░░░░░░] 40%',
        '',
      ].join('\n'),
      { kind: 'sync', totalPlansInPhase: 5, percent: 60 },
      { clock, progressProvider: exploding },
    ));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3871 / #3756 (ADR-3473 §8.6): the `preserve-always` executor for `progress`
// (state-transition.cjs ~line 280) gates on `ctx.resync || !ctx.preFm ||
// !ctx.preFm[field]` — it reads `ctx.preFm`, never `ctx.preFmSnapshot`. But
// `applyPostSyncPreservation` (src/state.cts) computes
// `const preFm = resync ? null : extractFrontmatter(...)`, and
// `readModifyWriteStateMd` defaults `resync` to `true` — so on every
// resyncing write (record-session, add-decision, etc.) `ctx.preFm` is
// ALWAYS null and the preserve-always branch for `progress` returns
// immediately without ever consulting the curated snapshot, even though the
// snapshot (`ctx.preFmSnapshot`) still carries the pre-write curated block.
// This is the root cause of #3756 (progress zeroed on an archived milestone).
//
// Written against TODAY's `applyStatePreservation` signature
// (`{ preFm, postFm, preFmSnapshot, resync, bodyDeltas }`) so it fails for
// the RIGHT reason (the policy not running) rather than an import/signature
// mismatch. The signature is expected to change in the follow-up fix commit
// (the executor should consult `preFmSnapshot` when `preFm` is null due to
// resync), at which point this test migrates alongside it.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3871 / #3756: preserve-always must still run on a resyncing write', () => {
  test('preserveAlwaysRunsOnResyncingWrites', () => {
    // #3756's exact repro shape: STATE.md carries a curated progress block
    // (5/5/32/32/100%) but the post-sync disk-derived block from a
    // milestone-scoped scan that found NONE of the current milestone's
    // phases (they were archived to .planning/milestones/<v>-phases/) is
    // all STRING zeros with `percent` entirely ABSENT — exactly what the
    // real sync path emits (never numeric zeros).
    const curatedSnapshot = {
      progress: {
        total_phases: 5,
        completed_phases: 5,
        total_plans: 32,
        completed_plans: 32,
        percent: 100,
      },
    };
    const zeroedPostFm = {
      progress: {
        total_phases: '0',
        completed_phases: '0',
        total_plans: '0',
        completed_plans: '0',
      },
    };
    const unchangedBodyDeltas = {
      status: { pre: 'x', post: 'x' },
      stopped_at: { pre: 'x', post: 'x' },
      current_phase_name: { pre: 'x', post: 'x' },
      paused_at: { pre: 'x', post: 'x' },
      current_phase: { pre: 'x', post: 'x' },
      current_plan: { pre: 'x', post: 'x' },
      last_activity_desc: { pre: 'x', post: 'x' },
    };

    const r = applyStatePreservation({
      transaction: openStateTransaction({
        snapshot: curatedSnapshot,
        resync: true,
        bodyDeltas: unchangedBodyDeltas,
      }),
      postFm: zeroedPostFm,
    });

    // FAILS TODAY (#3756/#3871): the preserve-always executor for `progress`
    // only ever consults `ctx.preFm` (always null on a resyncing write, per
    // the root-cause comment above), so it returns immediately and the
    // curated block above is NOT restored — `r.postFm.progress` stays the
    // zeroed/percent-less disk-derived block instead.
    assert.deepStrictEqual(
      r.postFm.progress,
      curatedSnapshot.progress,
      'preserve-always for `progress` must restore the curated snapshot on a resyncing write, not just a non-resyncing one (#3756/#3871)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-3473 §8.6 test matrix (.gsd/phase/feat-3871-state-transaction-snapshot/
// 50-test-matrix.md), rows 13-27 and 36: construction failures for
// `openStateTransaction` / `rebuildStateTransaction`, the legal-empty /
// null-prototype / prototype-pollution snapshot boundary, the aliasing fix
// (cloneCurated), the mutated-only-on-real-change fix, and the
// measured-vs-unmeasured coercion boundary that `applyPreserveAlways`'s
// `scanMeasuredSomething` decides on. Every call below wires
// `neutralBodyDeltasForMatrix()` on the transaction (not on the
// `applyStatePreservation` input — `bodyDeltas` is a TRANSACTION field,
// read via `transaction.bodyDeltas`) so a probe of ONE field never trips
// the §8.2 unwired-row throw for an unrelated preserve-when-unchanged row.
// ─────────────────────────────────────────────────────────────────────────────

// Wires every currently-declared preserve-when-unchanged field with a
// neutral "unchanged this write" delta — local copy of the same pattern
// `neutralBodyDeltas()` (below, hoisted) already established in this file,
// kept separately named so this matrix block reads standalone.
function neutralBodyDeltasForMatrix() {
  const deltas = {};
  for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
    if (cls.preservation === 'preserve-when-unchanged') {
      deltas[field] = { pre: 'unchanged-source', post: 'unchanged-source' };
    }
  }
  return deltas;
}

describe('ADR-3473 §8.6 matrix rows 18-21: construction is a typed failure, distinct from a legal empty snapshot', () => {
  test('openWithoutSnapshotIsAConstructionFailure', () => {
    assert.throws(
      () => openStateTransaction({}),
      (err) => {
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(err, 'code'),
          true,
          'error must carry an own `code` property',
        );
        assert.strictEqual(err.code, 'STATE_TRANSACTION_SNAPSHOT_REQUIRED');
        assert.strictEqual(err.constructorName, 'openStateTransaction', 'the typed field must name the constructor, not just the message prose');
        return true;
      },
      'open({}) — no snapshot key at all — must throw the typed construction failure',
    );
  });

  test('openWithNullSnapshotIsAConstructionFailure', () => {
    for (const snapshot of [null, undefined]) {
      assert.throws(
        () => openStateTransaction({ snapshot }),
        (err) => {
          assert.strictEqual(err.code, 'STATE_TRANSACTION_SNAPSHOT_REQUIRED');
          assert.strictEqual(err.constructorName, 'openStateTransaction');
          return true;
        },
        `open({snapshot: ${JSON.stringify(snapshot)}}) must throw the typed construction failure`,
      );
    }
  });

  test('rebuildWithNullSnapshotIsAConstructionFailure', () => {
    // The ADR's explicit wording: BOTH constructors, not just open().
    for (const init of [{ snapshot: null }, { snapshot: undefined }, {}]) {
      assert.throws(
        () => rebuildStateTransaction(init),
        (err) => {
          assert.strictEqual(err.code, 'STATE_TRANSACTION_SNAPSHOT_REQUIRED');
          assert.strictEqual(err.constructorName, 'rebuildStateTransaction', 'rebuild()\'s own typed failure must name rebuildStateTransaction, not open');
          return true;
        },
        `rebuildStateTransaction(${JSON.stringify(init)}) must throw the typed construction failure`,
      );
    }
  });

  test('openRejectsNonObjectSnapshot', () => {
    for (const snapshot of [[], 'str', 42]) {
      assert.throws(
        () => openStateTransaction({ snapshot }),
        (err) => {
          assert.strictEqual(err.code, 'STATE_TRANSACTION_SNAPSHOT_REQUIRED');
          assert.strictEqual(err.constructorName, 'openStateTransaction');
          return true;
        },
        `open({snapshot: ${JSON.stringify(snapshot)}}) — a non-object (array/string/number) snapshot — must throw`,
      );
    }
  });
});

describe('ADR-3473 §8.6 matrix rows 22-24: an empty / null-prototype / pollution-carrying snapshot is LEGAL', () => {
  // This is as load-bearing as the throws above: it is what keeps
  // /gsd-health --repair working on a broken (frontmatter-less) STATE.md —
  // extractFrontmatter returns `{}` for such a document, never null, and
  // `{}` must be accepted, not rejected as "absent".
  test('emptySnapshotIsLegalAndRestoresNothing', () => {
    const tx = openStateTransaction({ snapshot: {}, bodyDeltas: neutralBodyDeltasForMatrix() });
    assert.strictEqual(tx.kind, 'open');
    const r = applyStatePreservation({ transaction: tx, postFm: { status: 'executing' } });
    assert.strictEqual(r.mutated, false, 'an empty snapshot must find nothing to restore — mutated stays false');
    assert.strictEqual(r.postFm.status, 'executing', 'the derived value is left exactly as it was');
  });

  test('nullPrototypeSnapshotIsAccepted', () => {
    const nullProtoSnapshot = Object.create(null);
    nullProtoSnapshot.status = 'executing';
    // Legal at construction — must not throw merely for lacking Object.prototype.
    const tx = openStateTransaction({ snapshot: nullProtoSnapshot, bodyDeltas: neutralBodyDeltasForMatrix() });
    assert.strictEqual(tx.snapshot.status, 'executing', 'a null-prototype snapshot must still support ordinary property lookup');
    // And it must not break hasOwnProperty-style lookups inside the dispatch
    // loop either — the call must complete and report what it did.
    const r = applyStatePreservation({ transaction: tx, postFm: {} });
    assert.strictEqual(typeof r.mutated, 'boolean');
  });

  test('snapshotWithPrototypeKeysDoesNotPollute', () => {
    // Parsed via JSON.parse (not an object literal) so `__proto__` really is
    // an OWN enumerable property of the snapshot, not the object's actual
    // prototype link — the hostile shape a malformed/adversarial frontmatter
    // parse could produce.
    const evilSnapshot = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "not-a-function", "toString": "not-a-method"}');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(evilSnapshot, '__proto__'),
      true,
      'precondition: __proto__ must be an OWN key of the parsed snapshot, not the prototype link',
    );

    const tx = openStateTransaction({ snapshot: evilSnapshot, bodyDeltas: neutralBodyDeltasForMatrix() });
    applyStatePreservation({ transaction: tx, postFm: {} });

    assert.strictEqual(({}).polluted, undefined, 'a fresh object literal must not have picked up a polluted prototype property');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
      false,
      'Object.prototype itself must not have gained an own `polluted` property',
    );
  });
});

describe('ADR-3473 §8.6 matrix row 27: the transaction object is frozen', () => {
  test('transactionSnapshotIsFrozen', () => {
    const tx = openStateTransaction({ snapshot: { status: 'executing' } });
    assert.strictEqual(Object.isFrozen(tx), true, 'the transaction object itself must be frozen');
    // NOTE (verified against the implementation, not assumed): only the
    // transaction OBJECT is frozen at construction — `createStateTransaction`
    // never calls Object.freeze on `snapshot` itself. So `tx.snapshot` is NOT
    // frozen (Object.isFrozen(tx.snapshot) === false); what independence the
    // snapshot enjoys against later mutation comes from `applyPreserveAlways`
    // cloning on restore (see restoreClonesSoTheSnapshotCannotBeMutatedThroughPostFm
    // below), not from freezing the snapshot object. Assigning `tx.snapshot`
    // itself throws because this test file runs in strict mode ('use strict'
    // at the top) and `tx` is frozen — a sloppy-mode module would instead
    // silently no-op the assignment.
    assert.strictEqual(Object.isFrozen(tx.snapshot), false, 'the snapshot OBJECT is not itself frozen by construction — only the transaction wrapper is');
    assert.throws(
      () => { tx.snapshot = { replaced: true }; },
      TypeError,
      'assigning to a frozen transaction\'s property must throw under strict mode, and must not take effect',
    );
    assert.strictEqual(tx.snapshot.status, 'executing', 'the original snapshot value must be unchanged after the failed assignment attempt');
  });
});

describe('ADR-3473 §8.6 matrix rows 25-26: restore mutation-reporting and aliasing independence', () => {
  test('identicalRestoreDoesNotReportMutation', () => {
    const curatedProgress = { total_phases: 5, completed_phases: 5, total_plans: 32, completed_plans: 32, percent: 100 };
    const tx = openStateTransaction({
      snapshot: { progress: { ...curatedProgress } },
      resync: false,
      bodyDeltas: neutralBodyDeltasForMatrix(),
    });
    const r = applyStatePreservation({ transaction: tx, postFm: { progress: { ...curatedProgress } } });
    assert.strictEqual(r.mutated, false, 'restoring a value already identical to what postFm held must not report mutated=true (no spurious no-op write)');
  });

  test('restoreClonesSoTheSnapshotCannotBeMutatedThroughPostFm', () => {
    const curatedSnapshot = { progress: { total_phases: 5, completed_phases: 5, total_plans: 32, completed_plans: 32, percent: 100 } };
    const tx = openStateTransaction({
      snapshot: curatedSnapshot,
      resync: true,
      bodyDeltas: neutralBodyDeltasForMatrix(),
    });
    // Derived measured NOTHING (all-string-zero, percent absent) — the
    // #3756 shape — so preserve-always restores the curated block wholesale.
    const postFm = { progress: { total_phases: '0', completed_phases: '0', total_plans: '0', completed_plans: '0' } };
    const r = applyStatePreservation({ transaction: tx, postFm });
    assert.strictEqual(r.mutated, true, 'precondition: the restore must actually have happened');
    assert.notStrictEqual(r.postFm.progress, tx.snapshot.progress, 'the restored value must be a CLONE, not the same object reference as the snapshot');

    // Mutate the restored postFm.progress block IN PLACE, as a later step
    // in the same write pipeline legitimately could.
    r.postFm.progress.total_phases = 999;
    r.postFm.progress.percent = 1;

    assert.strictEqual(tx.snapshot.progress.total_phases, 5, 'the transaction\'s OWN snapshot must be unaffected by a later in-place mutation of postFm.progress');
    assert.strictEqual(tx.snapshot.progress.percent, 100, 'same independence check on a second nested field');
  });
});

describe('ADR-3473 §8.6 matrix rows 13-17 (+10/11 pinned): the measured-vs-unmeasured coercion boundary', () => {
  // Every case here drives applyPreserveAlways through applyStatePreservation
  // with resync:true and a real curated `progress` block, varying ONLY the
  // derived totals — the boundary the design/matrix calls out as the
  // riskiest logic in the change (`scanMeasuredSomething`'s `toFiniteNumber`
  // coercion, never a raw `=== 0`).
  const curatedProgress = { total_phases: 5, completed_phases: 5, total_plans: 32, completed_plans: 32, percent: 100 };

  function restoreWithDerivedTotals(derivedProgress) {
    const tx = openStateTransaction({
      snapshot: { progress: { ...curatedProgress } },
      resync: true,
      bodyDeltas: neutralBodyDeltasForMatrix(),
    });
    return applyStatePreservation({ transaction: tx, postFm: { progress: derivedProgress } });
  }

  test('stringZeroTotalsAreTreatedAsUnmeasured', () => {
    // limit-1/limit/limit+1 triple on the STRING shape production actually
    // emits ("0", not 0) — numeric coercion, never `=== 0`.
    for (const zeroish of ['0', '00', '0.0']) {
      const r = restoreWithDerivedTotals({ total_phases: zeroish, total_plans: zeroish, completed_phases: '0', completed_plans: '0' });
      assert.deepStrictEqual(r.postFm.progress, curatedProgress, `derived totals ${JSON.stringify(zeroish)} must be treated as unmeasured — curated block stands`);
      assert.strictEqual(r.mutated, true);
    }
  });

  test('stringNonZeroTotalIsMeasured', () => {
    // #4129 superseded the observable: a measured resyncing write no longer
    // lets the derived block wholesale-replace the curated one — the
    // declared progress-ratchet now merges (totals derived both directions,
    // completed counters up-only, #2969). The measured/unmeasured BOUNDARY
    // this row pins is unchanged and still observable here: the derived
    // TOTALS stand (a wholesale curated restore would have written 5/32).
    const r = restoreWithDerivedTotals({ total_phases: '1', total_plans: '0', completed_phases: '0', completed_plans: '0' });
    assert.strictEqual(r.mutated, true, 'a measured scan (total_phases:"1") must not wholesale-restore the curated block — the #4129 ratchet merge runs');
    assert.deepStrictEqual(
      r.postFm.progress,
      { total_phases: '1', total_plans: '0', completed_phases: 5, completed_plans: 32 },
      'measured: totals take the derived value (#2440 both directions); completed counters keep curated ("0" < 5/#2969 up-only); derived carried no percent so none is invented',
    );
  });

  test('absentTotalsAreUnmeasured', () => {
    for (const derived of [{}, { total_phases: null, total_plans: null }, { total_phases: undefined, total_plans: undefined }, { total_phases: '', total_plans: '' }]) {
      const r = restoreWithDerivedTotals(derived);
      assert.deepStrictEqual(r.postFm.progress, curatedProgress, `derived ${JSON.stringify(derived)} (absent/null/undefined/empty totals) must be unmeasured — curated stands`);
    }
  });

  test('nonNumericTotalsDegradeToPreservation', () => {
    for (const derived of [
      { total_phases: 'abc', total_plans: 'abc' },
      { total_phases: NaN, total_plans: NaN },
      { total_phases: {}, total_plans: {} },
      { total_phases: [], total_plans: [] },
    ]) {
      const r = restoreWithDerivedTotals(derived);
      assert.deepStrictEqual(r.postFm.progress, curatedProgress, `hostile derived totals ${JSON.stringify(derived)} must degrade TOWARD preservation, never toward deletion`);
    }
  });

  test('negativeTotalsAreNotAMeasurement', () => {
    const r = restoreWithDerivedTotals({ total_phases: -1, total_plans: -1 });
    assert.deepStrictEqual(r.postFm.progress, curatedProgress, 'a negative total is not a valid count — unmeasured — curated stands');
  });

  // Pinned mirror pair from the design's row 11/the existing matrix's row
  // 10 — grouped here so the boundary (only both-zero is unmeasured) reads
  // legibly against the coercion cases above. #4129 superseded the observable
  // to the ratchet merge (see stringNonZeroTotalIsMeasured above): "measured"
  // is still decided by EITHER total being non-zero, and still observable
  // because the derived TOTALS stand rather than a curated wholesale restore.
  test('oneNonZeroTotalCountsAsMeasuredEitherDirection', () => {
    const r1 = restoreWithDerivedTotals({ total_phases: 1, total_plans: 0, completed_phases: 0, completed_plans: 0 });
    assert.strictEqual(r1.mutated, true, 'total_phases:1, total_plans:0 must count as measured (#4129 ratchet merge ran, not a curated restore)');
    assert.deepStrictEqual(r1.postFm.progress, { total_phases: 1, total_plans: 0, completed_phases: 5, completed_plans: 32 });

    const r2 = restoreWithDerivedTotals({ total_phases: 0, total_plans: 1, completed_phases: 0, completed_plans: 0 });
    assert.strictEqual(r2.mutated, true, 'total_phases:0, total_plans:1 must count as measured (the mirror) — only both-zero is unmeasured');
    assert.deepStrictEqual(r2.postFm.progress, { total_phases: 0, total_plans: 1, completed_phases: 5, completed_plans: 32 });
  });
});

describe('ADR-3473 §8.6 matrix row 36: property — preservation never drops a curated key the derived block lacks', () => {
  // Scoped to `progress`, the one preserve-always/progress-ratchet field
  // this phase's centerpiece logic governs (this file's other property test,
  // "#3468 matrix C3" above, already covers the generic preserve-when-
  // unchanged dispatch as a property — a whitespace/empty-string curated
  // value is deliberately NOT restored there, by long-standing design, so a
  // property phrased over that generic field set would produce a false
  // failure unrelated to this phase's change).
  const progressCounterArb = fc.oneof(
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }).map(String),
  );
  const progressBlockArb = fc.record({
    total_phases: progressCounterArb,
    completed_phases: progressCounterArb,
    total_plans: progressCounterArb,
    completed_plans: progressCounterArb,
    percent: progressCounterArb,
  });

  test('preservationNeverDropsACuratedKey', () => {
    fc.assert(
      fc.property(
        fc.option(progressBlockArb, { nil: undefined }),
        fc.option(progressBlockArb, { nil: undefined }),
        fc.boolean(),
        (curatedProgress, derivedProgress, resync) => {
          const snapshot = curatedProgress !== undefined ? { progress: curatedProgress } : {};
          const postFm = derivedProgress !== undefined ? { progress: derivedProgress } : {};
          const tx = openStateTransaction({ snapshot, resync, bodyDeltas: neutralBodyDeltasForMatrix() });
          const r = applyStatePreservation({ transaction: tx, postFm });

          if (curatedProgress !== undefined && derivedProgress === undefined) {
            if (!Object.prototype.hasOwnProperty.call(r.postFm, 'progress')) {
              throw new Error(
                `curated key 'progress' dropped: curated=${JSON.stringify(curatedProgress)} ` +
                `derived=${JSON.stringify(derivedProgress)} resync=${resync} result=${JSON.stringify(r.postFm)}`,
              );
            }
          }
          return true;
        },
      ),
      // Seeded and bounded per repo convention; replay data (the exact
      // curated/derived/resync triple) is printed via the thrown Error
      // above on any failure.
      { seed: 3871, numRuns: 300 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4129: the resync arm of `applyPreserveAlways` (rows 8-14 of .gsd/bug/
// fix-4129-completed-phases-recompute/50-test-matrix.md). A resyncing write
// whose scan MEASURED something now runs the declared `progress-ratchet`
// merge instead of wholesale-replacing the curated block — the write path
// finally enforces the same monotonic property the read path
// (`shouldPreserveExistingProgress`) always has. The #3756 unmeasured guard
// and the #3242/#3871 explicit-progress contract are unchanged (pinned by the
// blocks above and by tests/frontmatter.test.cjs).
// ─────────────────────────────────────────────────────────────────────────────

describe('#4129: resyncing measured write ratchets the progress block', () => {
  function resyncMerge(curatedProgress, derivedProgress, extra = {}) {
    const tx = openStateTransaction({
      snapshot: { progress: { ...curatedProgress } },
      resync: true,
      bodyDeltas: neutralBodyDeltasForMatrix(),
      ...extra,
    });
    return applyStatePreservation({ transaction: tx, postFm: { progress: { ...derivedProgress } } });
  }

  test('resyncRatchetKeepsCuratedCompletedWhenDerivedUnderCounts', () => {
    // The issue's exact shape: derived 2 (a stale-dated sibling verification)
    // vs curated 3 (the ROADMAP truth a hand-fix or earlier correct write left).
    const r = resyncMerge(
      { total_phases: 18, completed_phases: 3, total_plans: 6, completed_plans: 6, percent: 17 },
      { total_phases: 18, completed_phases: 2, total_plans: 6, completed_plans: 6, percent: 11 },
    );
    assert.deepStrictEqual(
      r.postFm.progress,
      { total_phases: 18, completed_phases: 3, total_plans: 6, completed_plans: 6, percent: 17 },
      '#4129: a measured resync must never move completed counters DOWN — totals derived, completed curated, percent recomputed from the merged counters (3/18=17)',
    );
    assert.strictEqual(r.mutated, true, 'the merge actually changed the derived block');
  });

  test('resyncRatchetStillLetsCompletedMoveUp', () => {
    // Genuine completion: derived ABOVE curated must ratchet up, and percent follows.
    const r = resyncMerge(
      { total_phases: 18, completed_phases: 2, total_plans: 6, completed_plans: 6, percent: 11 },
      { total_phases: 18, completed_phases: 3, total_plans: 6, completed_plans: 6, percent: 17 },
    );
    assert.deepStrictEqual(
      r.postFm.progress,
      { total_phases: 18, completed_phases: 3, total_plans: 6, completed_plans: 6, percent: 17 },
      '#4129: the ratchet is up-only, never a freeze — a genuine increment still lands',
    );
  });

  test('resyncRatchetMixedSidesRecomputePercentFromMergedCounters', () => {
    // Mixed: derived completed_plans ratchets up, curated completed_phases
    // survives — percent must be recomputed from the MERGED counters
    // (min(54/54 plans, 5/? phases capped by plan fraction), never either
    // side's stale stored percent.
    const r = resyncMerge(
      { total_plans: 54, completed_plans: 50, completed_phases: 5, percent: 93 },
      { total_plans: 54, completed_plans: 54, completed_phases: 1, percent: 50 },
    );
    assert.strictEqual(r.postFm.progress.completed_plans, 54, 'derived completed_plans (54 > 50) ratchets up');
    assert.strictEqual(r.postFm.progress.completed_phases, 5, 'curated completed_phases (5 > 1) survives — never down');
    // min(54/54, 5/5-with-no-total... completed_phases 5, total_phases absent) —
    // computeProgressPercent with only plan data present: min(1.0, plan)=100? No:
    // phase data absent → phaseFraction=1 → min(1, 1) = 100.
    assert.strictEqual(r.postFm.progress.percent, 100, 'percent is recomputed from the merged counters through the completion-ratio kernel');
  });

  test('resyncRatchetCoercesStringScalarsThroughToFiniteNumber', () => {
    // Frontmatter scalars arrive as STRINGS ("2", not 2) — the comparison
    // must coerce (scanMeasuredSomething's own convention), never `typeof`.
    const r = resyncMerge(
      { total_phases: 18, completed_phases: 3, percent: 17 },
      { total_phases: '18', total_plans: '6', completed_phases: '2', completed_plans: '6', percent: 11 },
    );
    assert.strictEqual(r.postFm.progress.completed_phases, 3, 'string "2" must compare numerically against curated 3 — curated survives');
    assert.strictEqual(r.postFm.progress.total_phases, '18', 'string totals take the derived value verbatim (both directions)');
    assert.strictEqual(r.postFm.progress.percent, 17, 'percent recomputed from merged counters (3/18)');
  });

  test('resyncRatchetIsANoOpWhenDerivedEqualsCurated', () => {
    // The #4094 withheld shape arrives here: the scan fell back to the stored
    // counters, so derived == curated and the merge must not report a
    // mutation (the #948 no-op-write family).
    const block = { total_phases: 18, completed_phases: 3, total_plans: 6, completed_plans: 6, percent: 17 };
    const r = resyncMerge(block, { ...block });
    assert.strictEqual(r.mutated, false, 'derived === curated → no mutation (withheld shape is untouched)');
    assert.deepStrictEqual(r.postFm.progress, block);
  });

  test('resyncRatchetDoesNotResurrectAWithheldPercent', () => {
    // Derived percent ABSENT (an upstream #1761/#3217 withhold nulled it) —
    // the merge must not recompute one over counters it was withheld for.
    // Percent follows the derived side (the deriveProgressKeys branch's own
    // convention) and recomputation is gated on the derived block HAVING
    // carried one — an absent percent stays absent, exactly as the
    // pre-#4129 wholesale replace left it.
    const r = resyncMerge(
      { total_phases: 5, completed_phases: 5, percent: 100 },
      { total_phases: 5, completed_phases: 2 },
    );
    assert.strictEqual(r.postFm.progress.completed_phases, 5, 'curated completed counter survives');
    assert.ok(!('percent' in r.postFm.progress), 'no recomputed percent may appear when the derived block carried none');
  });

  test('explicitProgressFieldStillWholesaleReplacesOnMeasuredScan', () => {
    // #3242/#3871 contract, unchanged by #4129: when the caller NAMED a
    // progress field, the resync they asked for wins outright — the escape
    // hatch for deliberate downward correction stays open.
    const r = resyncMerge(
      { total_phases: 18, completed_phases: 3, percent: 17 },
      { total_phases: 18, completed_phases: 2, percent: 11 },
      { explicitProgressField: true },
    );
    assert.strictEqual(r.mutated, false, 'explicit progress write: the derived block stands untouched');
    assert.deepStrictEqual(r.postFm.progress, { total_phases: 18, completed_phases: 2, percent: 11 });
  });
});
