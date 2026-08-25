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
  FIELD_CLASSIFICATION,
  getFieldClassification,
  STATE_MD_SECTIONS,
  sliceCurrentPositionSection,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

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
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
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
    // Body Current Plan must advance to 3.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
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
    assert.ok(/gsd_state_version:\s*1\.0/.test(result.content), 'gsd_state_version must be preserved');
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
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } }, // disk-derived clobber
      resync: false,
      ...untouched,
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
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 64, completed_plans: 49, total_phases: 2, completed_phases: 1, percent: 77 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
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
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 64, completed_plans: 49, percent: 77 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
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
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 54, total_phases: 2, completed_phases: 1, percent: 100 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
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
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 47, percent: 87 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'completed_plans must NOT derive downward (47 < curated 50) — ratchet-up only (#2969/#3242)');
  });

  test('#2969 body-only write protection: deriveProgressKeys absent keeps wholesale restore', () => {
    // state.update/patch (no deriveProgressKeys flag) must keep the full #3242
    // wholesale curated restore — completed_plans never moves for a body-only edit.
    const curated = { progress: { total_plans: 54, completed_plans: 50, percent: 93 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 54, percent: 100 } },
      resync: false,
      // deriveProgressKeys NOT set — body-only write path
      ...untouched,
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'body-only write must keep curated completed_plans (no deriveProgressKeys) (#2969/#3242)');
  });

  test('progress: NOT restored when transition re-derives from disk (resync=true) — sync/advancePlan/completePhase path', () => {
    const recomputed = { progress: { total_phases: 5, completed_phases: 1, percent: 20 } };
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: {},
      postFm: { ...recomputed },
      resync: true,
      ...untouched,
    });
    assert.deepEqual(r.postFm.progress, { total_phases: 5, completed_phases: 1, percent: 20 });
    assert.equal(r.mutated, false);
  });

  test('status: preserves when body Status source is unchanged (preserve-when-unchanged) and snapshot holds a real status', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'completed' },
      postFm: { status: 'verifying' },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), status: { pre: 'Executing Phase 3', post: 'Executing Phase 3' } },
    });
    assert.equal(r.postFm.status, 'completed');
    assert.equal(r.mutated, true);
  });

  test('status: does NOT preserve when the body Status source line changed this write', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'completed' },
      postFm: { status: 'verifying' },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), status: { pre: 'Executing Phase 3', post: 'Completed Phase 3' } }, // changed
    });
    assert.equal(r.postFm.status, 'verifying');
    assert.equal(r.mutated, false);
  });

  test('current_phase_name: preserves curated value when body Phase source unchanged (preserve-when-unchanged, #3468 reclassified)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_phase_name: 'curated-name' },
      postFm: { current_phase_name: 'wrong-parenthetical-harvest' },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '3' } },
    });
    assert.equal(r.postFm.current_phase_name, 'curated-name');
    assert.equal(r.mutated, true);
  });

  test('returns mutated=false and untouched postFm when no preservation rule applies', () => {
    const postFm = { status: 'executing', progress: { percent: 10 } };
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: {},
      postFm,
      resync: true,
      ...untouched,
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
        preFm: curated, preFmSnapshot: curated,
        postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } },
        resync: false, bodyDeltas: unchangedBodyDeltas,
      });
      return JSON.stringify(r.postFm.progress) === JSON.stringify(curated.progress);
    }

    if (policy === 'preserve-when-unchanged') {
      const r = applyStatePreservation({
        preFm: null, preFmSnapshot: { [field]: GOOD },
        postFm: { [field]: BAD }, resync: true, bodyDeltas: unchangedBodyDeltas,
      });
      return r.postFm[field] === GOOD;
    }

    if (policy === 'preserve-if-placeholder') {
      // Derived name is the placeholder 'milestone'; snapshot holds a real
      // name+version. Mirrors the #948/#2135 contract: name restored to the
      // curated snapshot, version restored alongside it.
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: { milestone: GOOD, milestone_name: GOOD },
        postFm: { milestone: 'derived-version', milestone_name: 'milestone' },
        resync: true, bodyDeltas: unchangedBodyDeltas,
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
        preFm: null,
        preFmSnapshot: { current_plan: 'preserved-by-table' },
        postFm: { current_plan: 'derived' },
        resync: true,
        bodyDeltas: {}, // caller forgot to wire current_plan's body-source delta
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
      preFm: null,
      preFmSnapshot: { last_activity_desc: 'authoritative description' },
      postFm: { last_activity_desc: 'stale derived description' },
      resync: true,
      bodyDeltas: { ...unchangedBodyDeltas },
    });
    assert.equal(r.postFm.last_activity_desc, 'authoritative description');
    assert.equal(r.mutated, true);
  });

  test('last_activity_desc: derived wins when the body source changed this write (no over-preservation)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { last_activity_desc: 'old description' },
      postFm: { last_activity_desc: 'new description from transition' },
      resync: true,
      bodyDeltas: { ...lastActivityDescChangedDeltas }, // body 'Last Activity Description' moved
    });
    assert.equal(r.postFm.last_activity_desc, 'new description from transition');
    assert.equal(r.mutated, false);
  });

  test('paused_at: preserve-when-unchanged restores curated value over a stale-but-present derived value', () => {
    // Group 2: the declared #1230 delta heuristic beats the weaker #905
    // absent-fallback. Derived is PRESENT but stale; body source unchanged →
    // curated frontmatter value wins.
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { paused_at: '2026-02-02' },
      postFm: { paused_at: '2026-01-01' },
      resync: true,
      bodyDeltas: { ...unchangedBodyDeltas },
    });
    assert.equal(r.postFm.paused_at, '2026-02-02');
    assert.equal(r.mutated, true);
  });

  test('current_phase: preserve-when-unchanged restores curated value over a stale derived value', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_phase: '4' },
      postFm: { current_phase: '2' },
      resync: true,
      bodyDeltas: { ...unchangedBodyDeltas },
    });
    assert.equal(r.postFm.current_phase, '4');
    assert.equal(r.mutated, true);
  });

  test('current_plan: preserve-when-unchanged restores curated value over a stale derived value', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_plan: '5' },
      postFm: { current_plan: '3' },
      resync: true,
      bodyDeltas: { ...unchangedBodyDeltas },
    });
    assert.equal(r.postFm.current_plan, '5');
    assert.equal(r.mutated, true);
  });

  test('milestone / milestone_name: preserve-if-placeholder restores curated name when derived is placeholder', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { milestone: '0.1', milestone_name: 'Real Curated Name' },
      postFm: { milestone: '0.x', milestone_name: 'milestone' }, // placeholder derive
      resync: true,
      bodyDeltas: { ...unchangedBodyDeltas },
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
      preFm: null,
      preFmSnapshot: { current_plan: '' },
      postFm: { current_plan: 'derived' },
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
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
      preFm: null,
      preFmSnapshot: { current_plan: '   ' },
      postFm: { current_plan: 'derived' },
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'derived',
      'a whitespace-only snapshot must not be treated as a real curated value');
    assert.equal(r.mutated, false);
  });

  test('A5: preserve-when-unchanged — a non-string snapshot is ignored (no throw)', () => {
    for (const snapshot of [42, true, null, { nested: 1 }, undefined]) {
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: { current_plan: snapshot },
        postFm: { current_plan: 'derived' },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
        ...dedicatedNoop,
      });
      assert.equal(r.postFm.current_plan, 'derived', `snapshot=${JSON.stringify(snapshot)} must not be restored`);
    }
  });

  test('A6: preserve-when-unchanged — no-op when postFm already equals the snapshot', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_plan: 'same-value' },
      postFm: { current_plan: 'same-value' },
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'same-value');
    assert.equal(r.mutated, false);
  });

  test('A7: preserve-when-unchanged — a postFm missing the key entirely is restored (undefined !== snapshot)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_plan: 'curated' },
      postFm: {}, // key absent entirely
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.current_plan, 'curated');
    assert.equal(r.mutated, true);
  });

  test('A8: status — the "unknown" sentinel snapshot is never restored', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'unknown' },
      postFm: { status: 'verifying' },
      resync: true,
      preBodyStatus: 'x', postBodyStatus: 'x',
      preBodyStoppedAt: 'x', postBodyStoppedAt: 'x',
      preBodyPhaseSource: 'x', postBodyPhaseSource: 'x',
      bodyDeltas: neutralBodyDeltas(),
    });
    assert.equal(r.postFm.status, 'verifying');
    assert.equal(r.mutated, false);
  });

  test('A9: status — the "unknown" sentinel guard is case-sensitive ("Unknown" is a real value, restored)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'Unknown' },
      postFm: { status: 'verifying' },
      resync: true,
      preBodyStatus: 'x', postBodyStatus: 'x',
      preBodyStoppedAt: 'x', postBodyStoppedAt: 'x',
      preBodyPhaseSource: 'x', postBodyPhaseSource: 'x',
      bodyDeltas: neutralBodyDeltas(),
    });
    assert.equal(r.postFm.status, 'Unknown',
      'the sentinel is an exact-match on the lowercase literal "unknown" — a case variant is a real value');
    assert.equal(r.mutated, true);
  });

  test('A12: preserve-always progress — preFm===null under !resync does not throw (skip)', () => {
    assert.doesNotThrow(() => {
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: {},
        postFm: { progress: { total_phases: 5, completed_phases: 1, percent: 20 } },
        resync: false,
        bodyDeltas: neutralBodyDeltas(),
        ...dedicatedNoop,
      });
      assert.deepEqual(r.postFm.progress, { total_phases: 5, completed_phases: 1, percent: 20 });
      assert.equal(r.mutated, false);
    });
  });

  test('A14: deriveProgressKeys — derived completed_plans === curated keeps curated (limit: ">" not ">=", #2969)', () => {
    const curated = { progress: { total_plans: 10, completed_plans: 7, percent: 70 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 10, completed_plans: 7, percent: 70 } }, // derived === curated
      resync: false,
      deriveProgressKeys: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.progress.completed_plans, 7,
      'equal counts (derived === curated) must keep curated — the ratchet is ">" not ">="');
  });

  test('A18: preserve-if-placeholder — punctuation-led derived names are rejected for every delimiter', () => {
    for (const derived of ['— Foo', ': Foo', '-Foo']) {
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: { milestone: '1.0', milestone_name: 'Real Curated Name' },
        postFm: { milestone: '1.1', milestone_name: derived },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
        ...dedicatedNoop,
      });
      assert.equal(r.postFm.milestone_name, 'Real Curated Name',
        `punctuation-led derived name ${JSON.stringify(derived)} must be rejected`);
    }
  });

  test('A19: preserve-if-placeholder — an empty-string derived name is rejected (restored)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { milestone: '1.0', milestone_name: 'Real Curated Name' },
      postFm: { milestone: '1.1', milestone_name: '' },
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.milestone_name, 'Real Curated Name');
  });

  test('A20: preserve-if-placeholder — a placeholder snapshot is not restored over a placeholder derived value', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { milestone: '1.0', milestone_name: 'milestone' }, // snapshot IS the placeholder
      postFm: { milestone: '1.1', milestone_name: 'milestone' }, // derived is also the placeholder
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
      ...dedicatedNoop,
    });
    assert.equal(r.postFm.milestone_name, 'milestone', 'nothing better to restore — value passes through unchanged');
    assert.equal(r.postFm.milestone, '1.1', 'milestone version passes through unchanged alongside it');
  });

  test('A21: preserve-if-placeholder — a real, different derived name wins over the curated snapshot', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { milestone: '1.0', milestone_name: 'Old Curated Name' },
      postFm: { milestone: '2.0', milestone_name: 'New Real Milestone Name' },
      resync: true,
      bodyDeltas: neutralBodyDeltas(),
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
          preFm: null,
          preFmSnapshot: { [field]: 'curated-value' },
          postFm: { [field]: 'freshly-derived-value' },
          resync: true,
          bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
          ...dedicatedNoop,
        });
        assert.equal(r.postFm[field], 'freshly-derived-value',
          `${field}: a derive row always takes the freshly-derived (postFm) value`);
      });
    }
  });

  test('A23: a field with no FIELD_CLASSIFICATION row passes through untouched', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { totally_unclassified_field: 'curated' },
      postFm: { totally_unclassified_field: 'derived' },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), totally_unclassified_field: { pre: 'x', post: 'y' } },
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
        preFm: null,
        preFmSnapshot: { ['__proto__']: 'x', ['constructor']: 'y', ['toString']: 'z' },
        postFm: { ['__proto__']: 'a', ['constructor']: 'b', ['toString']: 'c' },
        resync: true,
        bodyDeltas: {
          ...neutralBodyDeltas(),
          ['__proto__']: { pre: 'x', post: 'y' },
          ['constructor']: { pre: 'x', post: 'y' },
          ['toString']: { pre: 'x', post: 'y' },
        },
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
        preFm: null,
        preFmSnapshot: { current_plan: 'curated' },
        postFm: { current_plan: 'derived' },
        resync: true,
        bodyDeltas,
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
        preFm: null,
        preFmSnapshot: {},
        postFm: {},
        resync: true,
        // bodyDeltas omitted entirely
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
        preFm: null,
        preFmSnapshot: {},
        postFm: {},
        resync: true,
        bodyDeltas: {},
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
        preFm: null,
        preFmSnapshot: {}, // no snapshot — skip is a legitimate, non-throwing outcome
        postFm: { current_phase: 'derived' },
        resync: true,
        bodyDeltas,
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
        preFm: null,
        preFmSnapshot: { current_phase: 'curated' },
        postFm: { current_phase: 'derived' },
        resync: true,
        bodyDeltas,
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
        preFm: null,
        preFmSnapshot: {},
        postFm: {},
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
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
        preFm: null,
        preFmSnapshot: { [field]: GOOD },
        postFm: { [field]: BAD },
        resync: true,
        bodyDeltas: neutralBodyDeltas(),
        ...dedicatedNoop,
      });
      assert.equal(r.postFm[field], GOOD, `${field}: pinned identity — restore-when-unchanged`);
    }
  });

  test('C1: shared preserve-when-unchanged loop — delta changed lets derived win (pinned)', () => {
    for (const field of LOOP_PWU_FIELDS) {
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: { [field]: GOOD },
        postFm: { [field]: BAD },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
        ...dedicatedNoop,
      });
      assert.equal(r.postFm[field], BAD, `${field}: pinned identity — derived wins when body source changed`);
    }
  });

  test('C1: status / stopped_at (pinned)', () => {
    const rStatus = applyStatePreservation({
      preFm: null, preFmSnapshot: { status: GOOD }, postFm: { status: BAD }, resync: true,
      bodyDeltas: neutralBodyDeltas(),
    });
    assert.equal(rStatus.postFm.status, GOOD);

    const rStopped = applyStatePreservation({
      preFm: null, preFmSnapshot: { stopped_at: GOOD }, postFm: { stopped_at: BAD }, resync: true,
      bodyDeltas: neutralBodyDeltas(),
    });
    assert.equal(rStopped.postFm.stopped_at, GOOD);
  });

  test('C1: preserve-always progress and preserve-if-placeholder milestone/milestone_name (pinned)', () => {
    const curated = { progress: { total_phases: 4, completed_phases: 3, percent: 75 } };
    const rProgress = applyStatePreservation({
      preFm: curated, preFmSnapshot: curated,
      postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } },
      resync: false, bodyDeltas: neutralBodyDeltas(), ...dedicatedNoop,
    });
    assert.deepEqual(rProgress.postFm.progress, curated.progress);

    const rMilestone = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { milestone: '1.0', milestone_name: GOOD },
      postFm: { milestone: '1.1', milestone_name: 'milestone' },
      resync: true, bodyDeltas: neutralBodyDeltas(), ...dedicatedNoop,
    });
    assert.equal(rMilestone.postFm.milestone_name, GOOD);
  });

  test('C1: derive-classified fields pass through untouched regardless of snapshot (pinned)', () => {
    for (const field of ['gsd_state_version', 'last_updated', 'last_activity', 'state_head']) {
      const r = applyStatePreservation({
        preFm: null,
        preFmSnapshot: { [field]: GOOD },
        postFm: { [field]: BAD },
        resync: true,
        bodyDeltas: { ...neutralBodyDeltas(), [field]: { pre: 'old', post: 'new' } },
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
      preFm: null,
      preFmSnapshot: { current_phase_name: GOOD },
      postFm: { current_phase_name: BAD },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '3' } }, // body Phase: source unchanged this write
    });
    assert.equal(rEqual.postFm.current_phase_name, GOOD,
      'reclassification must not change this: unchanged body Phase source still restores the curated name');
    assert.equal(rEqual.mutated, true);

    const rDiffer = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_phase_name: GOOD },
      postFm: { current_phase_name: BAD },
      resync: true,
      bodyDeltas: { ...neutralBodyDeltas(), current_phase_name: { pre: '3', post: '4' } }, // body Phase: source changed this write
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
            preFm: null,
            preFmSnapshot,
            postFm,
            resync,
            bodyDeltas: { ...neutralBodyDeltas(), [field]: delta },
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
  const match = fileContent.match(/```markdown\r?\n([\s\S]*?)```/);
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
      preFm: null,
      preFmSnapshot: curatedSnapshot,
      postFm: zeroedPostFm,
      resync: true,
      bodyDeltas: unchangedBodyDeltas,
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
